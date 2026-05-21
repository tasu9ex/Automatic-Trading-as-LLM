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
 *   6. finalize        — Exit 約定 → Allocator → Critic → Risk Clipper → Entry 約定 → state 更新
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
import { type SizingMethod, allocate } from "@/lib/allocator";
import { getExchangeStatus } from "@/lib/clients/gmo";
import {
  PER_COIN_MAX_RATIO,
  PER_COIN_MIN_JPY,
  PORTFOLIO_DD_TRIGGER,
  TOTAL_MAX_RATIO,
} from "@/lib/constants/risk";
import { runCritic } from "@/lib/critic";
import { withRetry } from "@/lib/cycle/retry";
import { buildSystemHealth } from "@/lib/cycle/system-health";
import { runEntryDecision } from "@/lib/decision/entry";
import { runExitDecision } from "@/lib/decision/exit";
import { executeEntry, executeExit } from "@/lib/executor";
import { checkAndTriggerKillSwitch } from "@/lib/kill-switch";
import { createLogger } from "@/lib/logging";
import { notify } from "@/lib/notifications";
import { runPriceMonitor } from "@/lib/price-monitor";
import { applyRiskClipper } from "@/lib/risk/clipper";
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
  /** §32: tier0Snapshots に渡す。system_state.cycleIntervalHours を伝播する */
  cycleIntervalHours?: number;
  coinIdsCount?: number;
}

/** Phase 1: 事前チェック + price-monitor 実行 + state 更新の準備 */
export async function preflight(input: PreflightInput): Promise<PreflightResult> {
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

  // Price-monitor: 前回サイクル以降の 1m バー全部を見て逆指値判定。
  const priceMonitorSince = state.lastCycleAt ?? new Date(Date.now() - 60 * 60_000);
  try {
    await runPriceMonitor({ since: priceMonitorSince });
  } catch (err) {
    logger.error({ err }, "Price monitor failed (continuing cycle)");
    await notify({
      level: "error",
      title: "🚨 Price monitor 失敗 (サイクル継続)",
      body: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
      fields: {
        影響: "逆指値判定がスキップされた、ポジションは LLM Exit のみで判断",
      },
    });
  }

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

  // Tier 0 の検索対象期間: 前回サイクルから経過時間 (下限 6h、上限 168h)
  const hoursSinceLast = state.lastCycleAt
    ? (Date.now() - state.lastCycleAt.getTime()) / 3_600_000
    : 24;
  const periodHours = Math.round(Math.max(6, Math.min(168, hoursSinceLast)));

  return {
    proceed: true,
    periodHours,
    cycleIntervalHours: state.cycleIntervalHours,
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
  cycleIntervalHours: number,
): Promise<void> {
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
            cycleIntervalHours,
          });
          await db.insert(marketSnapshots).values({
            cycleId,
            coinId: coin.id,
            // §32: primary / long の新カラム (1m/1d はレガシー、新規行は null)
            ohlcvPrimary: snap.ohlcvPrimary,
            ohlcvLong: snap.ohlcvLong,
            primaryInterval: snap.primaryInterval,
            longInterval: snap.longInterval,
            ticker: snap.ticker,
            // §21: ohlcv_1h は notNull 制約があるため当面 [] で埋める (drop は次の clean-up)
            ohlcv1h: [],
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
  // §32: 新カラム (ohlcv_primary / ohlcv_long / primary_interval / long_interval / ticker) を優先。
  //   旧カラム (ohlcv_1m / ohlcv_1d) は古い行を読む場合のみ fallback で参照。
  const primary =
    (row.ohlcvPrimary as Snapshot["ohlcvPrimary"] | null) ??
    (row.ohlcv1m as Snapshot["ohlcvPrimary"] | null) ??
    [];
  const long =
    (row.ohlcvLong as Snapshot["ohlcvLong"] | null) ??
    (row.ohlcv1d as Snapshot["ohlcvLong"] | null) ??
    [];
  const primaryInterval = (row.primaryInterval as Snapshot["primaryInterval"] | null) ?? "1hour";
  const longInterval = (row.longInterval as Snapshot["longInterval"]) ?? "1day";

  // ticker は新規行は DB に直接保存 (§31 根治)。旧行は最終 bar の close で再構成 fallback。
  const tickerRow = row.ticker as Snapshot["ticker"] | null;
  let ticker: Snapshot["ticker"];
  if (tickerRow) {
    ticker = tickerRow;
  } else {
    const lastClose = primary.at(-1)?.close ?? "0";
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
    ohlcvPrimary: primary,
    primaryInterval,
    ohlcvLong: long,
    longInterval,
    ticker,
    micro: (row.micro as Snapshot["micro"] | null) ?? null,
  };
  return { snapshotRow: row, snap };
}

/** Phase 3: Tier 1 Pre-Analyst (ALL-or-NOTHING) */
export async function tier1PreAnalyst(cycleId: string): Promise<void> {
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
          const preRes = await runPreAnalyst(snap);
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
export async function tier2Analyst(cycleId: string, strategyId: string): Promise<void> {
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
                    eq(positions.status, "open"),
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
          const analystRes = await runAnalyst(snap, preResLike);
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

/** Phase 5: Tier 3 Entry/Exit Decision (ALL-or-NOTHING) */
export async function tier3Decisions(cycleId: string, strategyId: string): Promise<void> {
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

          const analystResLike = {
            output: {
              fundamental: analyst.fundamental,
              sentiment: analyst.sentiment,
              technical: analyst.technical,
              synthesis: analyst.synthesis,
            },
            promptVersion: analyst.promptVersion,
            llmModel: analyst.llmModel,
          };

          // Entry decision (常に)
          const existingEntry = (
            await db
              .select({ id: decisions.id })
              .from(decisions)
              .where(and(eq(decisions.analystId, analyst.id), eq(decisions.kind, "entry")))
              .limit(1)
          )[0];
          if (!existingEntry) {
            const entry = await runEntryDecision(
              coin.symbol,
              coin.name,
              analystResLike as Parameters<typeof runEntryDecision>[2],
            );
            await db.insert(decisions).values({
              analystId: analyst.id,
              coinId: coin.id,
              llmModel: entry.llmModel,
              kind: "entry",
              result: entry.output.decision,
              confidence: entry.output.confidence.toFixed(3),
              reasoning: entry.output.reasoning,
              promptVersion: entry.promptVersion,
              // §1: Entry 仮説 (Exit プロンプトが参考値として参照)
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

          // Exit decision (保有時のみ)
          const openPos = (
            await db
              .select()
              .from(positions)
              .where(
                and(
                  eq(positions.strategyId, strategyId),
                  eq(positions.coinId, coin.id),
                  eq(positions.status, "open"),
                ),
              )
              .limit(1)
          )[0];
          if (!openPos) return;

          const existingExit = (
            await db
              .select({ id: decisions.id })
              .from(decisions)
              .where(and(eq(decisions.analystId, analyst.id), eq(decisions.kind, "exit")))
              .limit(1)
          )[0];
          if (existingExit) return;

          const { snap } = await loadSnapshot(snapshot.id, coin);
          const lastPrice = Number(snap.ticker.last) || 0;
          const qty = Number(openPos.quantity);
          const avg = Number(openPos.avgEntryPrice);
          const mkt = qty * lastPrice;
          const pnl = (lastPrice - avg) * qty;
          const holdingDays = Math.max(0, (Date.now() - openPos.openedAt.getTime()) / 86_400_000);
          const expHoldingDays =
            openPos.entryExpectedHoldingDaysMin && openPos.entryExpectedHoldingDaysMax
              ? {
                  min: openPos.entryExpectedHoldingDaysMin,
                  max: openPos.entryExpectedHoldingDaysMax,
                }
              : null;

          const exit = await runExitDecision(
            {
              symbol: coin.symbol,
              name: coin.name,
              avgEntryPrice: avg,
              quantity: qty,
              marketValueJpy: mkt,
              unrealizedPnlJpy: pnl,
              holdingDays,
              entryReason: openPos.entryReason,
              peakPnlJpy: (Number(openPos.peakPrice) - avg) * qty,
              troughPnlJpy: (Number(openPos.troughPrice) - avg) * qty,
              entryExpectation: {
                expectedHoldingDays: expHoldingDays,
                targetPriceJpy: openPos.entryTargetPriceJpy
                  ? Number(openPos.entryTargetPriceJpy)
                  : null,
                exitCondition: openPos.entryExitCondition,
              },
            },
            analystResLike as Parameters<typeof runExitDecision>[1],
          );
          await db.insert(decisions).values({
            analystId: analyst.id,
            coinId: coin.id,
            llmModel: exit.llmModel,
            kind: "exit",
            result: exit.output.decision,
            confidence: exit.output.confidence.toFixed(3),
            closePct: exit.output.close_pct.toFixed(2),
            reasoning: exit.output.reasoning,
            promptVersion: exit.promptVersion,
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
}

/** Phase 6: Exit 実行 → Critic → Risk Clipper → Entry 実行 → state 更新 → kill switch */
export async function finalize(input: FinalizeInput): Promise<FinalizeResult> {
  const { cycleId, strategyId, method, startedAt } = input;
  const enabledCoins = await getCycleCoins(cycleId);

  // 全コインのコンテキストを DB から組み立て
  type CoinCtx = {
    coin: (typeof enabledCoins)[number];
    snap: Snapshot;
    analyst: typeof analystOutputs.$inferSelect | null;
    entry: typeof decisions.$inferSelect | null;
    exit: typeof decisions.$inferSelect | null;
    openPos: typeof positions.$inferSelect | null;
  };

  const ctxs: CoinCtx[] = await Promise.all(
    enabledCoins.map(async (coin) => {
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
                eq(positions.status, "open"),
              ),
            )
            .limit(1)
        )[0] ?? null;

      return { coin, snap, analyst, entry, exit, openPos };
    }),
  );

  // Exit 約定
  // === Critic 前段: Exit は **未実行**。Critic に Exit + Entry 両方の判断を委ねる ===
  // Exit が走った想定で cash が増える見込み額 (Allocator がそれ込みで配分計算)
  const currentPortfolio = (
    await db.select().from(portfolios).where(eq(portfolios.strategyId, strategyId)).limit(1)
  )[0];
  const currentCashJpy = Number(currentPortfolio?.cashJpy ?? 0);

  const exitsToRun = ctxs.filter((c) => c.exit?.result === "close" && c.openPos);
  // §10: taker fee を控除した手取りで cash を予測する (calculateFill と一致)。
  // 過大評価していると Allocator が大きく配って Risk Clipper で削られるロスが出やすい。
  const expectedCloseCash = exitsToRun.reduce((sum, c) => {
    const price = Number(c.snap.ticker.last) || 0;
    const qty = Number(c.openPos?.quantity ?? 0);
    const takerFee = Number(c.coin.takerFeeRate);
    const grossCash = qty * price;
    const netCash = grossCash * (1 - takerFee);
    return sum + netCash;
  }, 0);
  const projectedCashJpy = currentCashJpy + expectedCloseCash;

  const buySignals = ctxs
    .filter((c) => c.entry?.result === "buy")
    .map((c) => ({ symbol: c.coin.symbol, confidence: Number(c.entry?.confidence ?? 0) }));

  const proposal = allocate({
    buySignals,
    availableCashJpy: projectedCashJpy,
    maxAllocationRatio: 1.0,
    perCoinMaxRatio: PER_COIN_MAX_RATIO,
    perCoinMinJpy: PER_COIN_MIN_JPY,
    method,
  });

  const analystSummariesBySymbol = Object.fromEntries(
    ctxs.filter((c) => c.analyst).map((c) => [c.coin.symbol, c.analyst?.synthesis]),
  );
  const decisionsBySymbol = Object.fromEntries(
    ctxs.map((c) => [
      c.coin.symbol,
      {
        entry: c.entry
          ? { decision: c.entry.result, confidence: Number(c.entry.confidence) }
          : null,
        exit: c.exit
          ? {
              decision: c.exit.result,
              confidence: Number(c.exit.confidence),
              close_pct: c.exit.closePct ? Number(c.exit.closePct) : 100,
            }
          : null,
      },
    ]),
  );
  const currentPositions = ctxs
    .filter((c) => c.openPos)
    .map((c) => ({
      symbol: c.coin.symbol,
      qty: Number(c.openPos?.quantity ?? 0),
      avgPrice: Number(c.openPos?.avgEntryPrice ?? 0),
    }));
  const symbolToName = Object.fromEntries(ctxs.map((c) => [c.coin.symbol, c.coin.name]));

  // §33: システム健全性スナップを Critic に渡す (データ不全銘柄を modify で弾けるように)
  const systemHealth = await buildSystemHealth({ strategyId, ctxs });

  // Critic skip: 買い 0 + Exit 0 なら審査するものが無い → Opus 呼び出しを節約
  const hasNothingToDo = buySignals.length === 0 && exitsToRun.length === 0;
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
    // §3 フェイルオープン: Critic API が落ちてもサイクル全体を中断せず、
    // Allocator の提案をそのまま採用して進める (要件 §4.3.3.1)。
    try {
      critic = await runCritic({
        proposal,
        analystSummariesBySymbol,
        decisionsBySymbol,
        currentPositions,
        symbolToName,
        cashJpy: projectedCashJpy,
        riskParams: {
          perCoinMaxRatio: PER_COIN_MAX_RATIO,
          killSwitchDdRatio: PORTFOLIO_DD_TRIGGER,
        },
        systemHealth,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error({ err }, "Critic API failed — fail-open with allocator proposal");
      critic = {
        output: {
          decision: "approve",
          adjustments: null,
          reasoning: `Critic API failure → fail-open: ${errMsg.slice(0, 200)}`,
        },
        promptVersion: null,
        llmModel: "fail-open",
      };
      await db.insert(systemEvents).values({
        strategyId,
        kind: "llm_failure",
        severity: "warning",
        message: `Critic fail-open at cycle ${cycleId.slice(0, 8)}: ${errMsg.slice(0, 200)}`,
        payload: { cycleId, phase: "critic", errMsg: errMsg.slice(0, 500) },
      });
      await notify({
        level: "warning",
        title: "⚠️ Critic 失敗 — フェイルオープン",
        body: [
          "**エラー**",
          `\`\`\`\n${errMsg.slice(0, 600)}\n\`\`\``,
          "**挙動**: Allocator 提案をそのまま採用してサイクル続行",
          "**推奨**: Anthropic 状況 / Langfuse の Critic prompt 確認",
        ].join("\n"),
        fields: {
          サイクル: cycleId.slice(0, 8),
          採用配分:
            Object.keys(proposal).length > 0
              ? Object.entries(proposal)
                  .map(([s, v]) => `${s}: ¥${Math.round(v).toLocaleString()}`)
                  .join(", ")
                  .slice(0, 200)
              : "なし",
        },
      });
    }
  }

  await db.insert(criticOutputs).values({
    cycleId,
    llmModel: critic.llmModel,
    decision: critic.output.decision,
    allocationProposal: proposal,
    adjustments: critic.output.adjustments,
    reasoning: critic.output.reasoning,
    promptVersion: critic.promptVersion,
  });

  let finalProposal = proposal;
  const exitOverrides: Record<string, number> = {}; // symbol → close_pct (Critic 上書き値)
  if (critic.output.decision === "veto") {
    logger.warn({ reason: critic.output.reasoning }, "Critic vetoed this cycle");
    await db.insert(systemEvents).values({
      strategyId,
      kind: "critic_veto",
      severity: "warning",
      message: `Critic veto: ${critic.output.reasoning.slice(0, 200)}`,
      payload: { cycleId, proposal },
    });
    const vetoBuyList =
      Object.keys(proposal).length > 0
        ? Object.entries(proposal)
            .map(([sym, jpy]) => `${sym}: ¥${Math.round(jpy).toLocaleString()}`)
            .join(", ")
        : "なし";
    const vetoExitList =
      exitsToRun.length > 0 ? exitsToRun.map((c) => c.coin.symbol).join(", ") : "なし";
    await notify({
      level: "warning",
      title: "🛑 Critic 拒否 (VETO)",
      body: critic.output.reasoning.slice(0, 1000),
      fields: {
        拒否買い: vetoBuyList.slice(0, 200),
        拒否売り: vetoExitList.slice(0, 200),
      },
    });
    finalProposal = {};
  } else if (critic.output.decision === "modify" && critic.output.adjustments) {
    const buys = critic.output.adjustments.buys ?? {};
    const exits = critic.output.adjustments.exits ?? {};
    finalProposal = { ...proposal, ...buys };
    Object.assign(exitOverrides, exits);
    await db.insert(systemEvents).values({
      strategyId,
      kind: "critic_modify",
      severity: "info",
      message: `Critic modified: ${critic.output.reasoning.slice(0, 200)}`,
      payload: { cycleId, before: proposal, after: finalProposal, exitOverrides },
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

  // === Critic 後段 ===
  // veto: Exit / Entry 両方とも実行しない (Critic がポートフォリオ操作全体を拒否)
  // approve / modify: Exit 実行 → cash refresh → Risk Clipper + Entry 実行
  let exitsExecuted = 0;
  let entriesExecutedFinal = 0;
  const executedEntries: Array<{ symbol: string; budget: number }> = [];
  const skippedEntries: Array<{ symbol: string; budget: number; reason: string }> = [];
  let clipped: ReturnType<typeof applyRiskClipper> = {
    proposal: {},
    changes: [],
  };

  if (critic.output.decision !== "veto") {
    // Exit 実行 (close_pct: Critic 上書き > Tier 3 出力 > default 100)
    for (const c of exitsToRun) {
      const lastPrice = Number(c.snap.ticker.last) || 0;
      if (lastPrice <= 0) continue;
      const tier3Pct = c.exit?.closePct ? Number(c.exit.closePct) : 100;
      const overridePct = exitOverrides[c.coin.symbol];
      const effectivePct = overridePct ?? tier3Pct;
      try {
        await executeExit({
          strategyId,
          symbol: c.coin.symbol,
          decisionId: c.exit?.id ?? null,
          marketPrice: lastPrice,
          takerFeeRate: Number(c.coin.takerFeeRate),
          quantityRatio: effectivePct / 100,
          reason:
            overridePct !== undefined
              ? `llm decision (critic modified ${tier3Pct}%→${overridePct}%)`
              : "llm decision",
        });
        exitsExecuted++;
      } catch (err) {
        logger.error({ err, symbol: c.coin.symbol }, "executeExit failed");
        await notify({
          level: "error",
          title: `🚨 Exit 失敗 ${c.coin.symbol}`,
          body: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
          fields: {
            意図: `${effectivePct}% 決済`,
            参考価格: `¥${Math.round(lastPrice).toLocaleString()}`,
            影響: "ポジション保有継続、price-monitor SL に依存",
          },
        });
      }
    }

    // Exit 後の cash + positions refresh (§19)
    const refreshedPortfolio = (
      await db.select().from(portfolios).where(eq(portfolios.strategyId, strategyId)).limit(1)
    )[0];
    const cashAfterExits = Number(refreshedPortfolio?.cashJpy ?? 0);

    // §19: in-memory ctxs ではなく DB から再取得 (Exit 約定が反映済の状態)
    const refreshedPositions = await db
      .select()
      .from(positions)
      .where(and(eq(positions.strategyId, strategyId), eq(positions.status, "open")));

    // §11: 原価ベース (avgEntryPrice) ではなく mark-to-market (current price) で
    // 実エクスポージャを評価。lastPriceByCoinId は finalize の後段で構築するため
    // ここで先に作る (ctxs.snap.ticker.last ベース、fallback は建値)。
    const priceByCoinId = new Map<string, number>(
      ctxs.map((c) => [c.coin.id, Number(c.snap.ticker.last) || 0]),
    );
    const currentInvested = refreshedPositions.reduce((s, p) => {
      const qty = Number(p.quantity);
      const mtmPrice = priceByCoinId.get(p.coinId);
      const price = mtmPrice && mtmPrice > 0 ? mtmPrice : Number(p.avgEntryPrice);
      return s + qty * price;
    }, 0);
    clipped = applyRiskClipper({
      proposal: finalProposal,
      availableCashJpy: cashAfterExits,
      currentInvestedJpy: currentInvested,
      perCoinMaxRatio: PER_COIN_MAX_RATIO,
      perCoinMinJpy: PER_COIN_MIN_JPY,
      totalMaxRatio: TOTAL_MAX_RATIO,
    });
    if (clipped.changes.length > 0) {
      logger.info({ changes: clipped.changes }, "Risk Clipper applied");
    }

    // Entry 実行 (executedSymbols / skippedSymbols を集計して通知に反映)
    for (const c of ctxs) {
      const budget = clipped.proposal[c.coin.symbol];
      if (!budget) continue;
      const lastPrice = Number(c.snap.ticker.last) || 0;
      if (lastPrice <= 0) {
        skippedEntries.push({
          symbol: c.coin.symbol,
          budget,
          reason: "1m bar 空で参考価格 0 円 (Tier 0 データ取得問題)",
        });
        logger.warn(
          { symbol: c.coin.symbol, budget },
          "executeEntry skipped: lastPrice <= 0 (1m bar empty)",
        );
        continue;
      }
      try {
        // §1: Entry 仮説を decisions row から拾って executor に渡す。positions.entry_*
        // に書き込まれ、Exit プロンプトの reference として活用される。
        const minDays = c.entry?.entryExpectedHoldingDaysMin
          ? Number(c.entry.entryExpectedHoldingDaysMin)
          : null;
        const maxDays = c.entry?.entryExpectedHoldingDaysMax
          ? Number(c.entry.entryExpectedHoldingDaysMax)
          : null;
        await executeEntry({
          strategyId,
          symbol: c.coin.symbol,
          decisionId: c.entry?.id ?? null,
          marketPrice: lastPrice,
          budgetJpy: budget,
          takerFeeRate: Number(c.coin.takerFeeRate),
          entryReason: c.entry?.reasoning ?? null,
          expectedHoldingDays:
            minDays !== null && maxDays !== null ? { min: minDays, max: maxDays } : null,
          targetPriceJpy: c.entry?.entryTargetPriceJpy ? Number(c.entry.entryTargetPriceJpy) : null,
          exitCondition: c.entry?.entryExitCondition ?? null,
        });
        executedEntries.push({ symbol: c.coin.symbol, budget });
        entriesExecutedFinal++;
      } catch (err) {
        logger.error({ err, symbol: c.coin.symbol }, "executeEntry failed");
        skippedEntries.push({
          symbol: c.coin.symbol,
          budget,
          reason: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
        });
        await notify({
          level: "error",
          title: `🚨 Entry 失敗 ${c.coin.symbol}`,
          body: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
          fields: {
            配分: `¥${budget.toLocaleString()}`,
            参考価格: `¥${Math.round(lastPrice).toLocaleString()}`,
            影響: "この銘柄の Entry をスキップ、次サイクル待ち",
          },
        });
      }
    }
  }

  // system_state 更新 (連続失敗カウンタ + last_failure_kind をリセット)
  await db
    .insert(systemState)
    .values({
      id: "singleton",
      state: "running",
      consecutiveFailures: 0,
      lastFailureKind: null,
      lastCycleId: cycleId,
      lastCycleAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: systemState.id,
      set: {
        consecutiveFailures: 0,
        lastFailureKind: null,
        lastCycleId: cycleId,
        lastCycleAt: new Date(),
        updatedAt: new Date(),
      },
    });

  await db.update(cycles).set({ completedAt: new Date() }).where(eq(cycles.id, cycleId));

  await checkAndTriggerKillSwitch({ strategyId });

  const elapsedMs = Date.now() - startedAt;
  // 実際に走った数 (veto なら 0)
  const exitsTriggered = exitsExecuted;
  const entriesExecuted = entriesExecutedFinal;
  const symbolsSkipped = ctxs.filter((c) => c.analyst === null).length;
  const symbolsProcessed = ctxs.length;

  logger.info(
    {
      cycleId,
      elapsedMs,
      symbolsProcessed,
      symbolsSkipped,
      buySignals: buySignals.length,
      exitsTriggered,
      entriesExecuted,
      proposal: clipped.proposal,
      criticDecision: critic.output.decision,
    },
    "Cycle done",
  );

  // 約定明細 + 現ポジ一覧を embed body (markdown) に詰める
  // buys は "実際に約定した銘柄" のみ。提案 (proposal) と実約定の差は skippedEntries に集約。
  const buys = executedEntries.map((e) => `• ${e.symbol}: ¥${e.budget.toLocaleString()}`);
  const skippedBuys = skippedEntries.map(
    (e) => `• ${e.symbol}: ¥${e.budget.toLocaleString()} — ${e.reason}`,
  );
  // veto された場合 closes/buys は空 (Exit 実行スキップ済み)
  const closes =
    critic.output.decision === "veto" ? [] : exitsToRun.map((c) => `• ${c.coin.symbol}`);

  const refreshedAfterEntries = (
    await db.select().from(portfolios).where(eq(portfolios.strategyId, strategyId)).limit(1)
  )[0];
  const cashAfter = Number(refreshedAfterEntries?.cashJpy ?? 0);
  const initialCash = Number(refreshedAfterEntries?.initialCashJpy ?? 0);
  const openPositions = await db
    .select()
    .from(positions)
    .where(and(eq(positions.strategyId, strategyId), eq(positions.status, "open")));

  // coinId → 最終価格 (このサイクルの snapshot から)
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

  // 含み = Σ(qty × 直近価格)、資産時価総額 = 現金 + 含み
  const marketValue = openPositions.reduce((sum, p) => {
    const price = lastPriceByCoinId.get(p.coinId) ?? 0;
    return sum + Number(p.quantity) * price;
  }, 0);
  const totalAssetJpy = cashAfter + marketValue;

  // 今回サイクルの実現損益 = startedAt 以降に約定した trade の pnlJpy 合計
  const cycleTrades = await db
    .select({ pnl: trades.pnlJpy })
    .from(trades)
    .where(and(eq(trades.strategyId, strategyId), gte(trades.executedAt, new Date(startedAt))));
  const realizedPnlCycle = cycleTrades.reduce((s, t) => s + Number(t.pnl ?? 0), 0);

  // 累計損益 = 資産時価総額 − 初期資本 (実現 + 含み)
  const cumulativePnl = totalAssetJpy - initialCash;

  const fmtJpySigned = (v: number) =>
    `${v >= 0 ? "+" : "-"}¥${Math.abs(Math.round(v)).toLocaleString()}`;

  const bodyParts: string[] = [];
  if (buys.length > 0) bodyParts.push(`**📥 新規 Entry**\n${buys.join("\n")}`);
  if (skippedBuys.length > 0) {
    bodyParts.push(`**⚠️ Entry 未実行**\n${skippedBuys.join("\n")}`);
  }
  if (closes.length > 0) bodyParts.push(`**📕 Close**\n${closes.join("\n")}`);
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

  const CRITIC_JP: Record<string, string> = {
    approve: "承認",
    veto: "拒否",
    modify: "修正",
  };

  await notify({
    level: "info",
    title: "🔁 サイクル完了",
    body: bodyParts.join("\n\n"),
    fields: {
      処理銘柄: `${symbolsProcessed}/${enabledCoins.length}`,
      Tier1スキップ: `${symbolsSkipped}/${enabledCoins.length}`,
      entry: `${entriesExecuted}件`,
      exit: `${exitsTriggered}件`,
      Critic判定: CRITIC_JP[critic.output.decision] ?? critic.output.decision,
      所要時間: `${(elapsedMs / 1000).toFixed(1)}秒`,
    },
  });

  return {
    cycleId,
    elapsedMs,
    symbolsProcessed,
    symbolsSkipped,
    symbolsFailed: 0,
    buySignals: buySignals.length,
    exitsTriggered,
    entriesExecuted,
    criticDecision: critic.output.decision,
  };
}

// failure handling は src/lib/cycle/failure.ts に分離 (§15 split)。
// 既存 import パス (phases.ts から recordCycleFailure を import している箇所) との互換のため re-export。
export { recordCycleFailure } from "./failure";
