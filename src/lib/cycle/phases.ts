/**
 * 判定パイプラインの Tier 0-3 phase 関数群。
 *
 * 各 phase は CLI からの sequential 呼び出しと Inngest step.run() の両方から呼べる。
 *
 * 設計原則:
 *   - cycleId と少数の primitive で完結 (DB から最新状態 read)
 *   - 戻り値は小さい (Inngest step output の JSON serialize に乗る)
 *   - 冪等: 既に処理済みコインの行が DB にあれば skip
 *   - ALL-or-NOTHING: 1 コインでも retry 後失敗で phase throw → サイクル全体 abort
 *
 * Phase 構成:
 *   1. preflight       — exchange / running / coin list / period 計算
 *   2. tier0Snapshots  — 全コイン並列 fetchSnapshot + 保存
 *   3. tier1PreAnalyst — 全コイン Haiku 並列
 *   4. tier2Analyst    — skip_flag=false のコイン Opus 並列
 *   5. tier3Decisions  — Entry (全) + Exit (保有のみ) Sonnet 並列
 *
 * Phase 6 (finalize) は src/lib/cycle/finalize.ts、failure handling は failure.ts に分離。
 */

import { db } from "@/db/client";
import {
  analystOutputs,
  coins,
  cycles,
  decisions,
  marketSnapshots,
  portfolios,
  positions,
  preAnalystOutputs,
  systemState,
} from "@/db/schema";
import type { SizingMethod } from "@/lib/allocator";
import { getExchangeStatus } from "@/lib/clients/gmo";
import { PositionStatusValue } from "@/lib/constants/enums";
import { type CycleCoin, getCycleCoins } from "@/lib/cycle/coins";
import { assertNotEmergencyStop } from "@/lib/cycle/emergency-stop";
import { withRetry } from "@/lib/cycle/retry";
import { type SnapshotRow, getCycleSnapshot, loadSnapshotFromRow } from "@/lib/cycle/snapshot";
import { runEntryDecision } from "@/lib/decision/entry";
import { runExitDecision } from "@/lib/decision/exit";
import { createLogger } from "@/lib/logging";
import { notify } from "@/lib/notifications";
import { runPriceMonitor } from "@/lib/price-monitor";
import { fetchSnapshot } from "@/lib/tier0/fetch-snapshot";
import { runPreAnalyst } from "@/lib/tier1/pre-analyst";
import { runAnalyst } from "@/lib/tier2/analyst";
import { and, eq } from "drizzle-orm";

const logger = createLogger("cycle.phases");

export type CycleSkipReason = "exchange_closed" | "not_running" | "no_coins";

export interface PreflightInput {
  cycleId: string;
  strategyId: string;
  method: SizingMethod;
}

export interface PreflightResult {
  proceed: boolean;
  skipped?: CycleSkipReason;
  periodHours?: number;
  /** tier0Snapshots に渡す。system_state.cycleIntervalMinutes を伝播する */
  cycleIntervalMinutes?: number;
  coinIdsCount?: number;
}

/** Phase 1: 事前チェック + price-monitor 実行 + state 更新の準備 */
export async function preflight(input: PreflightInput): Promise<PreflightResult> {
  await assertNotEmergencyStop("preflight");
  try {
    const exchangeStatus = await getExchangeStatus();
    if (exchangeStatus !== "OPEN") {
      logger.warn({ exchangeStatus }, "Exchange not OPEN, skipping cycle");
      await notify({
        level: "info",
        title: `⏸ GMO 取引所 ${exchangeStatus} のためサイクルスキップ`,
        fields: { ステータス: exchangeStatus },
      });
      return { proceed: false, skipped: "exchange_closed" };
    }
  } catch (err) {
    logger.warn({ err }, "Exchange status check failed, proceeding anyway");
  }

  const state = (
    await db.select().from(systemState).where(eq(systemState.id, "singleton")).limit(1)
  )[0];
  if (state?.state !== "running") {
    logger.info({ state: state?.state }, "System not running, skipping cycle");
    return { proceed: false, skipped: "not_running" };
  }

  // JJ: price-monitor 必須化 (ALL-or-NOTHING)。逆指値判定が落ちた状態で売買を進めると、
  // SL 監視抜きで Entry/Exit が動く非対称になる。0.1 の Critic 必須化と思想を揃えて
  // ここの try/catch を撤廃。失敗は上位 runPhase の catch → recordCycleFailure 経由で
  // 通常の failure path に乗せる (consecutiveFailures++ + Discord 通知)。
  const priceMonitorSince = state.lastCycleAt ?? new Date(Date.now() - 60 * 60_000);
  await runPriceMonitor({ since: priceMonitorSince });

  const portfolio = (
    await db.select().from(portfolios).where(eq(portfolios.strategyId, input.strategyId)).limit(1)
  )[0];
  if (!portfolio) throw new Error(`Portfolio not found: ${input.strategyId}`);

  const enabledCoins = await db.select().from(coins).where(eq(coins.enabled, true));
  if (enabledCoins.length === 0) {
    logger.warn("No enabled coins");
    return { proceed: false, skipped: "no_coins" };
  }

  // サイクル開始時点の有効銘柄を凍結 (cycle 進行中の coins.enabled 編集に影響されない)
  await db
    .insert(cycles)
    .values({
      id: input.cycleId,
      strategyId: input.strategyId,
      coinIds: enabledCoins.map((c) => c.id),
    })
    .onConflictDoNothing({ target: cycles.id });

  // Tier 0 の検索対象期間: サイクル間隔の 2 倍 (下限 1h, 上限 168h)。
  // 「直前サイクルが見落とした境界の取りこぼし防止」のため 2 倍のマージン。
  // 高頻度サイクル (例: 30 分) では 1h 検索、低頻度 (例: 24h) では 48h 検索になる。
  const cycleH = state.cycleIntervalMinutes / 60;
  const periodHours = Math.min(168, Math.max(1, Math.round(cycleH * 2)));

  return {
    proceed: true,
    periodHours,
    cycleIntervalMinutes: state.cycleIntervalMinutes,
    coinIdsCount: enabledCoins.length,
  };
}

/** Phase 2: Tier 0 全コイン snapshot 取得 (ALL-or-NOTHING) */
export async function tier0Snapshots(
  cycleId: string,
  periodHours: number,
  cycleIntervalMinutes: number,
): Promise<void> {
  await assertNotEmergencyStop("tier0-snapshots");
  const enabledCoins = await getCycleCoins(cycleId);

  await Promise.all(
    enabledCoins.map((coin) =>
      withRetry(
        async () => {
          // 冪等: 既に snapshot 行があれば skip
          if (await getCycleSnapshot(cycleId, coin.id)) return;

          const snap = await fetchSnapshot({
            symbol: coin.symbol,
            name: coin.name,
            periodHours,
            cycleIntervalMinutes,
          });
          await db.insert(marketSnapshots).values({
            cycleId,
            coinId: coin.id,
            ohlcv: snap.ohlcv,
            klineInterval: snap.klineInterval,
            ticker: snap.ticker,
            micro: snap.micro,
            perplexitySummary: snap.perplexitySummary,
            perplexityCitations: snap.perplexityCitations,
            grokSummary: snap.grokSummary,
            grokCitations: snap.grokCitations,
            fetchedAt: snap.fetchedAt,
          });
        },
        { label: `tier0:${coin.symbol}` },
      ),
    ),
  );
}

/** Phase 3: Tier 1 Pre-Analyst (ALL-or-NOTHING) */
export async function tier1PreAnalyst(
  cycleId: string,
  cycleIntervalMinutes: number,
): Promise<void> {
  await assertNotEmergencyStop("tier1-pre-analyst");
  const enabledCoins = await getCycleCoins(cycleId);

  await Promise.all(
    enabledCoins.map((coin) =>
      withRetry(
        async () => {
          const snapshot = await getCycleSnapshot(cycleId, coin.id);
          if (!snapshot) throw new Error(`No snapshot for coin ${coin.symbol}`);

          const existing = (
            await db
              .select({ id: preAnalystOutputs.id })
              .from(preAnalystOutputs)
              .where(eq(preAnalystOutputs.snapshotId, snapshot.id))
              .limit(1)
          )[0];
          if (existing) return;

          const snap = loadSnapshotFromRow(snapshot, coin);
          const preRes = await runPreAnalyst(snap, cycleIntervalMinutes);
          await db.insert(preAnalystOutputs).values({
            snapshotId: snapshot.id,
            llmModel: preRes.llmModel,
            summary: preRes.output.summary,
            relevanceScore: preRes.output.relevance_score.toFixed(3),
            skipFlag: preRes.output.skip_flag,
            reasoning: preRes.output.reasoning,
            promptVersion: preRes.promptVersion,
          });
        },
        { label: `tier1:${coin.symbol}` },
      ),
    ),
  );
}

/**
 * Phase 4: Tier 2 Analyst (§2 ポリシー: 保有中は skip_flag を無視して必ず実行)。
 *
 * - 未保有銘柄: skip_flag=true なら Analyst skip (コスト節約)
 * - 保有銘柄  : skip_flag に関わらず Analyst 実行 (Tier 3 Exit に渡すため必須)
 */
export async function tier2Analyst(
  cycleId: string,
  strategyId: string,
  cycleIntervalMinutes: number,
): Promise<void> {
  await assertNotEmergencyStop("tier2-analyst");
  const enabledCoins = await getCycleCoins(cycleId);

  await Promise.all(
    enabledCoins.map((coin) =>
      withRetry(
        async () => {
          const snapshot = await getCycleSnapshot(cycleId, coin.id);
          if (!snapshot) throw new Error(`No snapshot for coin ${coin.symbol}`);

          const pre = (
            await db
              .select()
              .from(preAnalystOutputs)
              .where(eq(preAnalystOutputs.snapshotId, snapshot.id))
              .limit(1)
          )[0];
          if (!pre) throw new Error(`No pre-analyst for coin ${coin.symbol}`);

          // skip_flag は **未保有銘柄のみ** 尊重。保有中の銘柄は Exit 判断のために必須。
          if (pre.skipFlag) {
            const openPos = (
              await db
                .select({ id: positions.id })
                .from(positions)
                .where(
                  and(
                    eq(positions.strategyId, strategyId),
                    eq(positions.coinId, coin.id),
                    eq(positions.status, PositionStatusValue.OPEN),
                  ),
                )
                .limit(1)
            )[0];
            if (!openPos) return;
            logger.info(
              { symbol: coin.symbol },
              "Tier 2 forced for held position despite skip_flag",
            );
          }

          const existing = (
            await db
              .select({ id: analystOutputs.id })
              .from(analystOutputs)
              .where(eq(analystOutputs.snapshotId, snapshot.id))
              .limit(1)
          )[0];
          if (existing) return;

          const snap = loadSnapshotFromRow(snapshot, coin);
          const preResLike = {
            output: {
              summary: pre.summary,
              relevance_score: Number(pre.relevanceScore),
              skip_flag: pre.skipFlag,
              reasoning: pre.reasoning ?? "",
            },
            promptVersion: pre.promptVersion,
            llmModel: pre.llmModel,
          };
          const analystRes = await runAnalyst(snap, preResLike, cycleIntervalMinutes);
          await db.insert(analystOutputs).values({
            snapshotId: snapshot.id,
            preAnalystId: pre.id,
            llmModel: analystRes.llmModel,
            fundamental: analystRes.output.fundamental,
            sentiment: analystRes.output.sentiment,
            technical: analystRes.output.technical,
            synthesis: analystRes.output.synthesis,
            promptVersion: analystRes.promptVersion,
          });
        },
        { label: `tier2:${coin.symbol}` },
      ),
    ),
  );
}

type AnalystRow = typeof analystOutputs.$inferSelect;

function asAnalystRunLike(analyst: AnalystRow) {
  return {
    output: {
      fundamental: analyst.fundamental,
      sentiment: analyst.sentiment,
      technical: analyst.technical,
      synthesis: analyst.synthesis,
    },
    promptVersion: analyst.promptVersion,
    llmModel: analyst.llmModel,
  };
}

async function runEntryForCoin(args: {
  coin: CycleCoin;
  analyst: AnalystRow;
  analystResLike: ReturnType<typeof asAnalystRunLike>;
  cycleIntervalMinutes: number;
}): Promise<void> {
  const existing = (
    await db
      .select({ id: decisions.id })
      .from(decisions)
      .where(and(eq(decisions.analystId, args.analyst.id), eq(decisions.kind, "entry")))
      .limit(1)
  )[0];
  if (existing) return;

  const entry = await runEntryDecision(
    args.coin.symbol,
    args.coin.name,
    args.analystResLike as Parameters<typeof runEntryDecision>[2],
    args.cycleIntervalMinutes,
  );
  await db.insert(decisions).values({
    analystId: args.analyst.id,
    coinId: args.coin.id,
    llmModel: entry.llmModel,
    kind: "entry",
    result: entry.output.decision,
    confidence: entry.output.confidence.toFixed(3),
    reasoning: entry.output.reasoning,
    promptVersion: entry.promptVersion,
    entryExpectedHoldingDaysMin:
      entry.output.expected_holding_days?.min !== undefined
        ? String(entry.output.expected_holding_days.min)
        : null,
    entryExpectedHoldingDaysMax:
      entry.output.expected_holding_days?.max !== undefined
        ? String(entry.output.expected_holding_days.max)
        : null,
    entryTargetPriceJpy: entry.output.target_price_jpy?.toFixed(4) ?? null,
    entryExitCondition: entry.output.exit_condition ?? null,
  });
}

async function runExitForCoin(args: {
  coin: CycleCoin;
  snapshotRow: SnapshotRow;
  analyst: AnalystRow;
  analystResLike: ReturnType<typeof asAnalystRunLike>;
  strategyId: string;
  cycleIntervalMinutes: number;
}): Promise<void> {
  const openPos = (
    await db
      .select()
      .from(positions)
      .where(
        and(
          eq(positions.strategyId, args.strategyId),
          eq(positions.coinId, args.coin.id),
          eq(positions.status, PositionStatusValue.OPEN),
        ),
      )
      .limit(1)
  )[0];
  if (!openPos) return;

  const existing = (
    await db
      .select({ id: decisions.id })
      .from(decisions)
      .where(and(eq(decisions.analystId, args.analyst.id), eq(decisions.kind, "exit")))
      .limit(1)
  )[0];
  if (existing) return;

  const snap = loadSnapshotFromRow(args.snapshotRow, args.coin);
  const lastPrice = Number(snap.ticker.last) || 0;
  const qty = Number(openPos.quantity);
  const avg = Number(openPos.avgEntryPrice);
  const expHoldingDays =
    openPos.entryExpectedHoldingDaysMin && openPos.entryExpectedHoldingDaysMax
      ? {
          min: openPos.entryExpectedHoldingDaysMin,
          max: openPos.entryExpectedHoldingDaysMax,
        }
      : null;

  const exit = await runExitDecision(
    {
      symbol: args.coin.symbol,
      name: args.coin.name,
      avgEntryPrice: avg,
      quantity: qty,
      marketValueJpy: qty * lastPrice,
      unrealizedPnlJpy: (lastPrice - avg) * qty,
      holdingDays: Math.max(0, (Date.now() - openPos.openedAt.getTime()) / 86_400_000),
      entryReason: openPos.entryReason,
      peakPnlJpy: (Number(openPos.peakPrice) - avg) * qty,
      troughPnlJpy: (Number(openPos.troughPrice) - avg) * qty,
      entryExpectation: {
        expectedHoldingDays: expHoldingDays,
        targetPriceJpy: openPos.entryTargetPriceJpy ? Number(openPos.entryTargetPriceJpy) : null,
        exitCondition: openPos.entryExitCondition,
      },
    },
    args.analystResLike as Parameters<typeof runExitDecision>[1],
    args.cycleIntervalMinutes,
  );
  await db.insert(decisions).values({
    analystId: args.analyst.id,
    coinId: args.coin.id,
    llmModel: exit.llmModel,
    kind: "exit",
    result: exit.output.decision,
    confidence: exit.output.confidence.toFixed(3),
    closePct: exit.output.close_pct.toFixed(2),
    reasoning: exit.output.reasoning,
    promptVersion: exit.promptVersion,
  });
}

/** Phase 5: Tier 3 Entry/Exit Decision (ALL-or-NOTHING) */
export async function tier3Decisions(
  cycleId: string,
  strategyId: string,
  cycleIntervalMinutes: number,
): Promise<void> {
  await assertNotEmergencyStop("tier3-decisions");
  const enabledCoins = await getCycleCoins(cycleId);

  await Promise.all(
    enabledCoins.map((coin) =>
      withRetry(
        async () => {
          const snapshot = await getCycleSnapshot(cycleId, coin.id);
          if (!snapshot) throw new Error(`No snapshot for coin ${coin.symbol}`);

          const analyst = (
            await db
              .select()
              .from(analystOutputs)
              .where(eq(analystOutputs.snapshotId, snapshot.id))
              .limit(1)
          )[0];
          // analyst なし = Tier 2 が skip_flag で省略された (未保有銘柄のみ起こる、§2 ポリシー)
          // → Entry/Exit 両方スキップ。保有中の銘柄は Tier 2 で必ず analyst が作られる。
          if (!analyst) return;

          const analystResLike = asAnalystRunLike(analyst);
          await runEntryForCoin({ coin, analyst, analystResLike, cycleIntervalMinutes });
          await runExitForCoin({
            coin,
            snapshotRow: snapshot,
            analyst,
            analystResLike,
            strategyId,
            cycleIntervalMinutes,
          });
        },
        { label: `tier3:${coin.symbol}` },
      ),
    ),
  );
}
