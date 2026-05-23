/**
 * 判定パイプラインの phase 関数群。
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
 *   6. finalize        — Exit dry-run (Allocator + Clipper) → Critic → safety 実行 (Exit → Entry) → state 更新
 */

import { db } from "@/db/client";
import {
  analystOutputs,
  coins,
  criticOutputs,
  cycles,
  decisions,
  marketSnapshots,
  portfolios,
  positions,
  preAnalystOutputs,
  systemEvents,
  systemState,
  trades,
} from "@/db/schema";
import type { SizingMethod } from "@/lib/allocator";
import { getExchangeStatus } from "@/lib/clients/gmo";
import { PositionStatusValue } from "@/lib/constants/enums";
import { runCritic } from "@/lib/critic";
import {
  applyModify,
  computeModifiedPositions,
  validateCriticModify,
} from "@/lib/cycle/critic-modify-validation";
import { assertNotEmergencyStop } from "@/lib/cycle/emergency-stop";
import {
  type ExecutionPlan,
  type ExecutionPlanSignal,
  buildExecutionPlan,
} from "@/lib/cycle/execution-plan";
import { withRetry } from "@/lib/cycle/retry";
import { buildSystemHealth } from "@/lib/cycle/system-health";
import { runEntryDecision } from "@/lib/decision/entry";
import { runExitDecision } from "@/lib/decision/exit";
import { executeEntry, executeExit } from "@/lib/executor";
import { checkAndTriggerKillSwitch } from "@/lib/kill-switch";
import { createLogger } from "@/lib/logging";
import { notify } from "@/lib/notifications";
import { runPriceMonitor } from "@/lib/price-monitor";
import { PER_COIN_MIN_JPY, TOTAL_MAX_RATIO, getRiskParams } from "@/lib/risk/params";
import { type Snapshot, fetchSnapshot } from "@/lib/tier0/fetch-snapshot";
import { runPreAnalyst } from "@/lib/tier1/pre-analyst";
import { runAnalyst } from "@/lib/tier2/analyst";
import { and, eq, gte, sql } from "drizzle-orm";

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

/**
 * サイクル行に凍結された coin_ids をもとに coins レコードを取得 (phase 間で共有)。
 * cycles テーブルから coin_ids を取って coins を引く 2 クエリではなく、
 * postgres の `id = ANY(coin_ids)` を 1 クエリで叩く。
 */
async function getCycleCoins(cycleId: string) {
  const rows = await db
    .select({
      id: coins.id,
      symbol: coins.symbol,
      name: coins.name,
      minOrderSize: coins.minOrderSize,
      makerFeeRate: coins.makerFeeRate,
      takerFeeRate: coins.takerFeeRate,
      enabled: coins.enabled,
      createdAt: coins.createdAt,
      updatedAt: coins.updatedAt,
    })
    .from(coins)
    .innerJoin(
      cycles,
      sql`${coins.id}::text = ANY(SELECT jsonb_array_elements_text(${cycles.coinIds}))`,
    )
    .where(eq(cycles.id, cycleId));
  if (rows.length === 0) {
    // cycle 行が無い、もしくは coin_ids が空 → 区別したいので明示チェック
    const cycle = (
      await db.select({ id: cycles.id }).from(cycles).where(eq(cycles.id, cycleId)).limit(1)
    )[0];
    if (!cycle) throw new Error(`Cycle not found: ${cycleId}`);
  }
  return rows;
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
          const existing = (
            await db
              .select({ id: marketSnapshots.id })
              .from(marketSnapshots)
              .where(and(eq(marketSnapshots.cycleId, cycleId), eq(marketSnapshots.coinId, coin.id)))
              .limit(1)
          )[0];
          if (existing) return;

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

/** snapshot 行 + coin 情報を結合して Snapshot 型に復元 */
async function loadSnapshot(snapshotId: string, coin: { symbol: string; name: string }) {
  const row = (
    await db.select().from(marketSnapshots).where(eq(marketSnapshots.id, snapshotId)).limit(1)
  )[0];
  if (!row) throw new Error(`Snapshot not found: ${snapshotId}`);
  const ohlcv = (row.ohlcv as Snapshot["ohlcv"] | null) ?? [];
  const klineInterval = (row.klineInterval as Snapshot["klineInterval"] | null) ?? "1day";

  // ticker は新規行は DB に直接保存 (§31 根治)。旧行は最終 bar の close で再構成 fallback。
  const tickerRow = row.ticker as Snapshot["ticker"] | null;
  let ticker: Snapshot["ticker"];
  if (tickerRow) {
    ticker = tickerRow;
  } else {
    const lastClose = ohlcv.at(-1)?.close ?? "0";
    ticker = { last: lastClose, bid: lastClose, ask: lastClose, volume: "0" };
  }

  const snap: Snapshot = {
    symbol: coin.symbol,
    name: coin.name,
    fetchedAt: row.fetchedAt,
    perplexitySummary: row.perplexitySummary ?? "情報なし",
    perplexityCitations: row.perplexityCitations,
    grokSummary: row.grokSummary ?? "情報なし",
    grokCitations: row.grokCitations,
    ohlcv,
    klineInterval,
    ticker,
    micro: (row.micro as Snapshot["micro"] | null) ?? null,
  };
  return { snapshotRow: row, snap };
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
          const snapshot = (
            await db
              .select()
              .from(marketSnapshots)
              .where(and(eq(marketSnapshots.cycleId, cycleId), eq(marketSnapshots.coinId, coin.id)))
              .limit(1)
          )[0];
          if (!snapshot) throw new Error(`No snapshot for coin ${coin.symbol}`);

          const existing = (
            await db
              .select({ id: preAnalystOutputs.id })
              .from(preAnalystOutputs)
              .where(eq(preAnalystOutputs.snapshotId, snapshot.id))
              .limit(1)
          )[0];
          if (existing) return;

          const { snap } = await loadSnapshot(snapshot.id, coin);
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
          const snapshot = (
            await db
              .select()
              .from(marketSnapshots)
              .where(and(eq(marketSnapshots.cycleId, cycleId), eq(marketSnapshots.coinId, coin.id)))
              .limit(1)
          )[0];
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

          const { snap } = await loadSnapshot(snapshot.id, coin);
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

type CycleCoin = Awaited<ReturnType<typeof getCycleCoins>>[number];
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
  snapshotId: string;
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

  const { snap } = await loadSnapshot(args.snapshotId, args.coin);
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
          const snapshot = (
            await db
              .select()
              .from(marketSnapshots)
              .where(and(eq(marketSnapshots.cycleId, cycleId), eq(marketSnapshots.coinId, coin.id)))
              .limit(1)
          )[0];
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
            snapshotId: snapshot.id,
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

export interface FinalizeResult {
  cycleId: string;
  elapsedMs: number;
  symbolsProcessed: number;
  symbolsSkipped: number;
  symbolsFailed: number;
  buySignals: number;
  exitsTriggered: number;
  entriesExecuted: number;
  criticDecision?: string;
}

interface FinalizeInput {
  cycleId: string;
  strategyId: string;
  method: SizingMethod;
  startedAt: number;
  cycleIntervalMinutes: number;
}

type CoinCtx = {
  coin: CycleCoin;
  snap: Snapshot;
  analyst: typeof analystOutputs.$inferSelect | null;
  entry: typeof decisions.$inferSelect | null;
  exit: typeof decisions.$inferSelect | null;
  openPos: typeof positions.$inferSelect | null;
};

async function buildCoinContext(
  coin: CycleCoin,
  cycleId: string,
  strategyId: string,
): Promise<CoinCtx> {
  const snapshot = (
    await db
      .select()
      .from(marketSnapshots)
      .where(and(eq(marketSnapshots.cycleId, cycleId), eq(marketSnapshots.coinId, coin.id)))
      .limit(1)
  )[0];
  if (!snapshot) throw new Error(`No snapshot for coin ${coin.symbol} in finalize`);
  const { snap } = await loadSnapshot(snapshot.id, coin);

  const analyst =
    (
      await db
        .select()
        .from(analystOutputs)
        .where(eq(analystOutputs.snapshotId, snapshot.id))
        .limit(1)
    )[0] ?? null;

  let entry: typeof decisions.$inferSelect | null = null;
  let exit: typeof decisions.$inferSelect | null = null;
  if (analyst) {
    entry =
      (
        await db
          .select()
          .from(decisions)
          .where(and(eq(decisions.analystId, analyst.id), eq(decisions.kind, "entry")))
          .limit(1)
      )[0] ?? null;
    exit =
      (
        await db
          .select()
          .from(decisions)
          .where(and(eq(decisions.analystId, analyst.id), eq(decisions.kind, "exit")))
          .limit(1)
      )[0] ?? null;
  }

  const openPos =
    (
      await db
        .select()
        .from(positions)
        .where(
          and(
            eq(positions.strategyId, strategyId),
            eq(positions.coinId, coin.id),
            eq(positions.status, PositionStatusValue.OPEN),
          ),
        )
        .limit(1)
    )[0] ?? null;

  return { coin, snap, analyst, entry, exit, openPos };
}

function ctxToSignal(c: CoinCtx): ExecutionPlanSignal {
  const entry =
    c.entry?.result === "buy"
      ? ({ decision: "buy", confidence: Number(c.entry.confidence) } as const)
      : c.entry?.result === "no"
        ? ({ decision: "no", confidence: Number(c.entry.confidence) } as const)
        : null;
  const exit =
    c.exit?.result === "close"
      ? {
          decision: "close" as const,
          confidence: Number(c.exit.confidence),
          closePct: c.exit.closePct ? Number(c.exit.closePct) : 100,
        }
      : c.exit?.result === "hold"
        ? {
            decision: "hold" as const,
            confidence: Number(c.exit.confidence),
            closePct: c.exit.closePct ? Number(c.exit.closePct) : 100,
          }
        : null;
  return {
    symbol: c.coin.symbol,
    lastPriceJpy: Number(c.snap.ticker.last) || 0,
    takerFeeRate: Number(c.coin.takerFeeRate),
    entry,
    exit,
    openPosition: c.openPos
      ? {
          quantity: Number(c.openPos.quantity),
          avgEntryPrice: Number(c.openPos.avgEntryPrice),
        }
      : null,
  };
}

/**
 * 1 銘柄分の Critic 入力 (entry / exit + 現在価格)。
 * last_price_jpy は Critic の target_price_jpy スケール sanity check に使う。
 * target_price_jpy は Trader が出した「次サイクル後の緩い目標 (JPY)」。
 */
function criticDecisionForCtx(c: CoinCtx) {
  return {
    last_price_jpy: c.snap.ticker?.last ? Number(c.snap.ticker.last) : null,
    entry: c.entry
      ? {
          decision: c.entry.result,
          confidence: Number(c.entry.confidence),
          target_price_jpy: c.entry.entryTargetPriceJpy
            ? Number(c.entry.entryTargetPriceJpy)
            : null,
          expected_holding_days:
            c.entry.entryExpectedHoldingDaysMin && c.entry.entryExpectedHoldingDaysMax
              ? {
                  min: Number(c.entry.entryExpectedHoldingDaysMin),
                  max: Number(c.entry.entryExpectedHoldingDaysMax),
                }
              : null,
        }
      : null,
    exit: c.exit
      ? {
          decision: c.exit.result,
          confidence: Number(c.exit.confidence),
          close_pct: c.exit.closePct ? Number(c.exit.closePct) : 100,
        }
      : null,
  };
}

interface CriticDecisionResult {
  final: { entries: Record<string, number>; exits: ExecutionPlan["exits"] };
  modifiedPositions: Record<string, number> | null;
  criticOutput: Awaited<ReturnType<typeof runCritic>>;
}

async function processCriticDecision(args: {
  cycleId: string;
  strategyId: string;
  plan: ExecutionPlan;
  ctxs: CoinCtx[];
  buyCandidates: Set<string>;
  currentCashJpy: number;
  equityJpy: number;
  riskParams: Awaited<ReturnType<typeof getRiskParams>>;
  cycleIntervalMinutes: number;
}): Promise<CriticDecisionResult> {
  const { plan, ctxs, buyCandidates, currentCashJpy, equityJpy, riskParams } = args;

  const analystSummariesBySymbol = Object.fromEntries(
    ctxs.filter((c) => c.analyst).map((c) => [c.coin.symbol, c.analyst?.synthesis]),
  );
  const decisionsBySymbol = Object.fromEntries(
    ctxs.map((c) => [c.coin.symbol, criticDecisionForCtx(c)]),
  );
  const symbolToName = Object.fromEntries(ctxs.map((c) => [c.coin.symbol, c.coin.name]));
  const systemHealth = await buildSystemHealth({ strategyId: args.strategyId, ctxs });

  // Critic skip: 計画に何も無ければ Opus 呼び出しを節約
  const hasNothingToDo =
    Object.keys(plan.entries).length === 0 &&
    Object.keys(plan.exits).length === 0 &&
    buyCandidates.size === 0;
  let critic: Awaited<ReturnType<typeof runCritic>>;
  if (hasNothingToDo) {
    critic = {
      output: {
        decision: "approve",
        adjustments: null,
        reasoning:
          "No buy signals and no exits to evaluate — Critic auto-approved (skipped LLM call)",
      },
      promptVersion: null,
      llmModel: "auto-skip",
    };
    logger.info("Critic skipped (no buy / no exit) — Opus call saved");
  } else {
    // 0.1: Critic 必須化 (ALL-or-NOTHING)。失敗は通常 failure path 経由で consecutiveFailures++。
    critic = await runCritic({
      plan,
      analystSummariesBySymbol,
      decisionsBySymbol,
      symbolToName,
      currentCashJpy,
      equityJpy,
      riskParams: {
        perCoinMaxRatio: riskParams.perCoinMaxRatio,
        perCoinTotalMaxRatio: riskParams.perCoinTotalMaxRatio,
        killSwitchDdRatio: riskParams.portfolioDdTrigger,
      },
      systemHealth,
      cycleIntervalMinutes: args.cycleIntervalMinutes,
    });
  }

  // Critic modify の機械検算 (ALL-or-NOTHING)。違反は throw。
  if (critic.output.decision === "modify" && critic.output.adjustments) {
    const violation = validateCriticModify({
      plan,
      adjustments: critic.output.adjustments,
      buyCandidates,
      cashJpy: currentCashJpy,
      equityJpy,
      perCoinMaxRatio: riskParams.perCoinMaxRatio,
      perCoinTotalMaxRatio: riskParams.perCoinTotalMaxRatio,
    });
    if (violation) {
      logger.error({ violation, adjustments: critic.output.adjustments }, "Critic modify 違反");
      throw new Error(`critic_modify_invalid: ${violation}`);
    }
  }

  const final =
    critic.output.decision === "veto"
      ? { entries: {} as Record<string, number>, exits: {} as ExecutionPlan["exits"] }
      : critic.output.decision === "modify" && critic.output.adjustments
        ? applyModify(plan, critic.output.adjustments)
        : { entries: plan.entries, exits: plan.exits };

  const modifiedPositions =
    critic.output.decision === "modify" ? computeModifiedPositions(plan, final) : null;

  await db.insert(criticOutputs).values({
    cycleId: args.cycleId,
    llmModel: critic.llmModel,
    decision: critic.output.decision,
    executionPlan: plan,
    modifiedPositions,
    adjustments: critic.output.adjustments,
    reasoning: critic.output.reasoning,
    promptVersion: critic.promptVersion,
  });

  await notifyCriticDecision({
    cycleId: args.cycleId,
    strategyId: args.strategyId,
    critic,
    plan,
    final,
  });

  return { final, modifiedPositions, criticOutput: critic };
}

async function notifyCriticDecision(args: {
  cycleId: string;
  strategyId: string;
  critic: Awaited<ReturnType<typeof runCritic>>;
  plan: ExecutionPlan;
  final: { entries: Record<string, number>; exits: ExecutionPlan["exits"] };
}): Promise<void> {
  const { critic, plan, final, cycleId, strategyId } = args;
  if (critic.output.decision === "veto") {
    logger.warn({ reason: critic.output.reasoning }, "Critic vetoed this cycle");
    await db.insert(systemEvents).values({
      strategyId,
      kind: "critic_veto",
      severity: "warning",
      message: `Critic veto: ${critic.output.reasoning.slice(0, 200)}`,
      payload: { cycleId, plan },
      cycleId,
    });
    const vetoBuyList =
      Object.keys(plan.entries).length > 0
        ? Object.entries(plan.entries)
            .map(([sym, jpy]) => `${sym}: ¥${Math.round(jpy).toLocaleString()}`)
            .join(", ")
        : "なし";
    const vetoExitList =
      Object.keys(plan.exits).length > 0 ? Object.keys(plan.exits).join(", ") : "なし";
    await notify({
      level: "warning",
      title: "🛑 Critic 拒否 (VETO)",
      body: critic.output.reasoning.slice(0, 1000),
      fields: {
        拒否買い: vetoBuyList.slice(0, 200),
        拒否売り: vetoExitList.slice(0, 200),
      },
    });
    return;
  }
  if (critic.output.decision !== "modify" || !critic.output.adjustments) return;

  const buys = critic.output.adjustments.buys ?? {};
  const exits = critic.output.adjustments.exits ?? {};
  await db.insert(systemEvents).values({
    strategyId,
    kind: "critic_modify",
    severity: "info",
    message: `Critic modified: ${critic.output.reasoning.slice(0, 200)}`,
    payload: {
      cycleId,
      before: { entries: plan.entries, exits: plan.exits },
      after: { entries: final.entries, exits: final.exits },
    },
    cycleId,
  });
  await notify({
    level: "info",
    title: "✏️ Critic 修正 (MODIFY)",
    body: critic.output.reasoning.slice(0, 1000),
    fields: {
      買い修正: Object.keys(buys).length > 0 ? JSON.stringify(buys).slice(0, 200) : "なし",
      売り修正: Object.keys(exits).length > 0 ? JSON.stringify(exits).slice(0, 200) : "なし",
    },
  });
}

interface ExecutionResult {
  exitsExecuted: number;
  entriesExecuted: number;
  executedEntries: Array<{ symbol: string; budget: number }>;
  skippedEntries: Array<{ symbol: string; budget: number; reason: string }>;
}

async function executeOneExit(args: {
  strategyId: string;
  symbol: string;
  ctx: CoinCtx;
  closePct: number;
  modifiedByCritic: boolean;
}): Promise<boolean> {
  const { ctx, symbol, closePct, modifiedByCritic } = args;
  const lastPrice = Number(ctx.snap.ticker.last) || 0;
  if (lastPrice <= 0) return false;
  try {
    await executeExit({
      strategyId: args.strategyId,
      symbol,
      decisionId: ctx.exit?.id ?? null,
      marketPrice: lastPrice,
      takerFeeRate: Number(ctx.coin.takerFeeRate),
      quantityRatio: closePct / 100,
      reason: modifiedByCritic ? `llm decision (critic modified → ${closePct}%)` : "llm decision",
    });
    return true;
  } catch (err) {
    logger.error({ err, symbol }, "executeExit failed");
    await notify({
      level: "error",
      title: `🚨 Exit 失敗 ${symbol}`,
      body: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
      fields: {
        意図: `${closePct}% 決済`,
        参考価格: `¥${Math.round(lastPrice).toLocaleString()}`,
        影響: "ポジション保有継続、price-monitor SL に依存",
      },
    });
    return false;
  }
}

async function executeOneEntry(args: {
  strategyId: string;
  symbol: string;
  ctx: CoinCtx;
  budget: number;
}): Promise<{ ok: boolean; reason?: string }> {
  const { ctx, symbol, budget } = args;
  const lastPrice = Number(ctx.snap.ticker.last) || 0;
  if (lastPrice <= 0) {
    logger.warn({ symbol, budget }, "executeEntry skipped: lastPrice <= 0 (1m bar empty)");
    return { ok: false, reason: "1m bar 空で参考価格 0 円 (Tier 0 データ取得問題)" };
  }
  try {
    const minDays = ctx.entry?.entryExpectedHoldingDaysMin
      ? Number(ctx.entry.entryExpectedHoldingDaysMin)
      : null;
    const maxDays = ctx.entry?.entryExpectedHoldingDaysMax
      ? Number(ctx.entry.entryExpectedHoldingDaysMax)
      : null;
    await executeEntry({
      strategyId: args.strategyId,
      symbol,
      decisionId: ctx.entry?.id ?? null,
      marketPrice: lastPrice,
      budgetJpy: budget,
      takerFeeRate: Number(ctx.coin.takerFeeRate),
      entryReason: ctx.entry?.reasoning ?? null,
      expectedHoldingDays:
        minDays !== null && maxDays !== null ? { min: minDays, max: maxDays } : null,
      targetPriceJpy: ctx.entry?.entryTargetPriceJpy ? Number(ctx.entry.entryTargetPriceJpy) : null,
      exitCondition: ctx.entry?.entryExitCondition ?? null,
    });
    return { ok: true };
  } catch (err) {
    logger.error({ err, symbol }, "executeEntry failed");
    const msg = err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500);
    await notify({
      level: "error",
      title: `🚨 Entry 失敗 ${symbol}`,
      body: msg,
      fields: {
        配分: `¥${budget.toLocaleString()}`,
        参考価格: `¥${Math.round(lastPrice).toLocaleString()}`,
        影響: "この銘柄の Entry をスキップ、次サイクル待ち",
      },
    });
    return { ok: false, reason: msg.slice(0, 200) };
  }
}

/** Exit 後の実 cash で Entry 合計を比例縮小 (cash 不足ガード)。 */
async function safetyScaleEntries(args: {
  strategyId: string;
  entries: Record<string, number>;
}): Promise<Record<string, number>> {
  const refreshedPortfolio = (
    await db.select().from(portfolios).where(eq(portfolios.strategyId, args.strategyId)).limit(1)
  )[0];
  const cashAfterExits = Number(refreshedPortfolio?.cashJpy ?? 0);
  const cashRoom = cashAfterExits * TOTAL_MAX_RATIO;
  const plannedSum = Object.values(args.entries).reduce((s, v) => s + v, 0);
  if (plannedSum <= cashRoom || plannedSum === 0) return args.entries;
  const scale = cashRoom / plannedSum;
  logger.warn({ plannedSum, cashRoom, scale }, "Exit 部分失敗で実 cash 不足 — Entry を比例縮小");
  const scaled: Record<string, number> = {};
  for (const [sym, jpy] of Object.entries(args.entries)) {
    const v = Math.floor(jpy * scale);
    if (v >= PER_COIN_MIN_JPY) scaled[sym] = v;
  }
  return scaled;
}

async function executeExitsAndEntries(args: {
  strategyId: string;
  ctxBySymbol: Map<string, CoinCtx>;
  final: { entries: Record<string, number>; exits: ExecutionPlan["exits"] };
  critic: Awaited<ReturnType<typeof runCritic>>;
}): Promise<ExecutionResult> {
  const { strategyId, ctxBySymbol, final, critic } = args;
  const result: ExecutionResult = {
    exitsExecuted: 0,
    entriesExecuted: 0,
    executedEntries: [],
    skippedEntries: [],
  };
  if (critic.output.decision === "veto") return result;

  for (const [symbol, exitPlan] of Object.entries(final.exits)) {
    const c = ctxBySymbol.get(symbol);
    if (!c || !c.openPos) continue;
    const modified =
      critic.output.decision === "modify" &&
      critic.output.adjustments?.exits?.[symbol] !== undefined;
    const ok = await executeOneExit({
      strategyId,
      symbol,
      ctx: c,
      closePct: exitPlan.closePct,
      modifiedByCritic: modified,
    });
    if (ok) result.exitsExecuted++;
  }

  const finalEntries = await safetyScaleEntries({ strategyId, entries: final.entries });

  for (const [symbol, budget] of Object.entries(finalEntries)) {
    const c = ctxBySymbol.get(symbol);
    if (!c) continue;
    const res = await executeOneEntry({ strategyId, symbol, ctx: c, budget });
    if (res.ok) {
      result.executedEntries.push({ symbol, budget });
      result.entriesExecuted++;
    } else if (res.reason) {
      result.skippedEntries.push({ symbol, budget, reason: res.reason });
    }
  }
  return result;
}

async function sendCycleCompletionNotification(args: {
  strategyId: string;
  ctxs: CoinCtx[];
  enabledCoinsCount: number;
  startedAt: number;
  elapsedMs: number;
  symbolsProcessed: number;
  symbolsSkipped: number;
  execution: ExecutionResult;
  finalExits: ExecutionPlan["exits"];
  criticDecision: string;
}): Promise<void> {
  const { strategyId, ctxs, execution, finalExits, criticDecision } = args;
  const buys = execution.executedEntries.map((e) => `• ${e.symbol}: ¥${e.budget.toLocaleString()}`);
  const skippedBuys = execution.skippedEntries.map(
    (e) => `• ${e.symbol}: ¥${e.budget.toLocaleString()} — ${e.reason}`,
  );
  const closes = criticDecision === "veto" ? [] : Object.keys(finalExits).map((sym) => `• ${sym}`);

  const refreshedAfterEntries = (
    await db.select().from(portfolios).where(eq(portfolios.strategyId, strategyId)).limit(1)
  )[0];
  const cashAfter = Number(refreshedAfterEntries?.cashJpy ?? 0);
  const initialCash = Number(refreshedAfterEntries?.initialCashJpy ?? 0);
  const openPositions = await db
    .select()
    .from(positions)
    .where(
      and(eq(positions.strategyId, strategyId), eq(positions.status, PositionStatusValue.OPEN)),
    );

  const lastPriceByCoinId = new Map<string, number>(
    ctxs.map((c) => [c.coin.id, Number(c.snap.ticker.last) || 0]),
  );

  const positionLines = await Promise.all(
    openPositions.map(async (p) => {
      const c = (await db.select().from(coins).where(eq(coins.id, p.coinId)).limit(1))[0];
      const sym = c?.symbol ?? "?";
      const qtyNum = Number(p.quantity);
      const qty = qtyNum.toFixed(6);
      const avg = Math.round(Number(p.avgEntryPrice)).toLocaleString();
      const price = lastPriceByCoinId.get(p.coinId) ?? 0;
      const valueJpy = Math.round(qtyNum * price).toLocaleString();
      return `• ${sym}: ${qty} @ ¥${avg} (¥${valueJpy})`;
    }),
  );

  const marketValue = openPositions.reduce((sum, p) => {
    const price = lastPriceByCoinId.get(p.coinId) ?? 0;
    return sum + Number(p.quantity) * price;
  }, 0);
  const totalAssetJpy = cashAfter + marketValue;

  const cycleTrades = await db
    .select({ pnl: trades.pnlJpy })
    .from(trades)
    .where(
      and(eq(trades.strategyId, strategyId), gte(trades.executedAt, new Date(args.startedAt))),
    );
  const realizedPnlCycle = cycleTrades.reduce((s, t) => s + Number(t.pnl ?? 0), 0);
  const cumulativePnl = totalAssetJpy - initialCash;
  const fmtJpySigned = (v: number) =>
    `${v >= 0 ? "+" : "-"}¥${Math.abs(Math.round(v)).toLocaleString()}`;

  const bodyParts: string[] = [];
  if (buys.length > 0) bodyParts.push(`**📥 新規 Entry**\n${buys.join("\n")}`);
  if (skippedBuys.length > 0) bodyParts.push(`**⚠️ Entry 未実行**\n${skippedBuys.join("\n")}`);
  if (closes.length > 0) bodyParts.push(`**📕 Exit**\n${closes.join("\n")}`);
  if (positionLines.length > 0) {
    bodyParts.push(`**📊 保有ポジション (${positionLines.length})**\n${positionLines.join("\n")}`);
  }
  bodyParts.push(
    [
      `**💰 現金**: ¥${Math.round(cashAfter).toLocaleString()}`,
      `**🏦 資産時価総額**: ¥${Math.round(totalAssetJpy).toLocaleString()}`,
      `**📈 実現損益 (今回)**: ${fmtJpySigned(realizedPnlCycle)}`,
      `**🧮 累計損益**: ${fmtJpySigned(cumulativePnl)} (初期 ¥${Math.round(initialCash).toLocaleString()})`,
    ].join("\n"),
  );

  const CRITIC_JP: Record<string, string> = { approve: "承認", veto: "拒否", modify: "修正" };
  await notify({
    level: "info",
    title: "🔁 サイクル完了",
    body: bodyParts.join("\n\n"),
    fields: {
      処理銘柄: `${args.symbolsProcessed}/${args.enabledCoinsCount}`,
      Tier1スキップ: `${args.symbolsSkipped}/${args.enabledCoinsCount}`,
      entry: `${execution.entriesExecuted}件`,
      exit: `${execution.exitsExecuted}件`,
      Critic判定: CRITIC_JP[criticDecision] ?? criticDecision,
      所要時間: `${(args.elapsedMs / 1000).toFixed(1)}秒`,
    },
  });
}

/** Phase 6: Exit dry-run (Allocator + Clipper) → Critic → safety 実行 (Exit → Entry) → state 更新 → kill switch */
export async function finalize(input: FinalizeInput): Promise<FinalizeResult> {
  await assertNotEmergencyStop("finalize");
  const { cycleId, strategyId, method, startedAt } = input;
  const enabledCoins = await getCycleCoins(cycleId);
  const riskParams = await getRiskParams();

  const ctxs: CoinCtx[] = await Promise.all(
    enabledCoins.map((coin) => buildCoinContext(coin, cycleId, strategyId)),
  );

  const currentPortfolio = (
    await db.select().from(portfolios).where(eq(portfolios.strategyId, strategyId)).limit(1)
  )[0];
  const currentCashJpy = Number(currentPortfolio?.cashJpy ?? 0);
  const signals: ExecutionPlanSignal[] = ctxs.map(ctxToSignal);

  const plan = buildExecutionPlan({
    signals,
    currentCashJpy,
    method,
    riskParams: {
      perCoinMaxRatio: riskParams.perCoinMaxRatio,
      perCoinTotalMaxRatio: riskParams.perCoinTotalMaxRatio,
    },
  });

  const equityForCritic =
    currentCashJpy + Object.values(plan.currentPositions).reduce((s, v) => s + v, 0);
  // Allocator 候補 = Analyst が buy を出した銘柄 (Critic modify の whitelist)
  const buyCandidates = new Set(
    signals.filter((s) => s.entry?.decision === "buy").map((s) => s.symbol),
  );

  const { final, criticOutput: critic } = await processCriticDecision({
    cycleId,
    strategyId,
    plan,
    ctxs,
    buyCandidates,
    currentCashJpy,
    equityJpy: equityForCritic,
    riskParams,
    cycleIntervalMinutes: input.cycleIntervalMinutes,
  });

  const ctxBySymbol = new Map(ctxs.map((c) => [c.coin.symbol, c]));
  const execution = await executeExitsAndEntries({ strategyId, ctxBySymbol, final, critic });

  // system_state 更新 (連続失敗カウンタ + last_failure_kind をリセット)
  // EE: state は上書きしない。cycle 中にダッシュボードから「一時停止」を押した場合、
  // finalize が paused → running に巻き戻すと次サイクル :00 cron で勝手に再開する事故になる。
  // state 行が無い初期状態は preflight で `state !== 'running'` で弾かれているため、
  // ここで singleton row を新規作成するケースは存在しない (update のみ)。
  await db
    .update(systemState)
    .set({
      consecutiveFailures: 0,
      lastFailureKind: null,
      lastCycleId: cycleId,
      lastCycleAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(systemState.id, "singleton"));

  await db.update(cycles).set({ completedAt: new Date() }).where(eq(cycles.id, cycleId));
  await checkAndTriggerKillSwitch({ strategyId });

  const elapsedMs = Date.now() - startedAt;
  const symbolsSkipped = ctxs.filter((c) => c.analyst === null).length;
  const symbolsProcessed = ctxs.length;

  logger.info(
    {
      cycleId,
      elapsedMs,
      symbolsProcessed,
      symbolsSkipped,
      buySignals: buyCandidates.size,
      exitsTriggered: execution.exitsExecuted,
      entriesExecuted: execution.entriesExecuted,
      finalEntries: final.entries,
      criticDecision: critic.output.decision,
    },
    "Cycle done",
  );

  await sendCycleCompletionNotification({
    strategyId,
    ctxs,
    enabledCoinsCount: enabledCoins.length,
    startedAt,
    elapsedMs,
    symbolsProcessed,
    symbolsSkipped,
    execution,
    finalExits: final.exits,
    criticDecision: critic.output.decision,
  });

  return {
    cycleId,
    elapsedMs,
    symbolsProcessed,
    symbolsSkipped,
    symbolsFailed: 0,
    buySignals: buyCandidates.size,
    exitsTriggered: execution.exitsExecuted,
    entriesExecuted: execution.entriesExecuted,
    criticDecision: critic.output.decision,
  };
}

// failure handling は src/lib/cycle/failure.ts に分離 (§15 split)。
// 既存 import パス (phases.ts から recordCycleFailure を import している箇所) との互換のため re-export。
export { recordCycleFailure } from "./failure";
