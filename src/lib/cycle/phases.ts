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
  decisions,
  marketSnapshots,
  portfolios,
  positions,
  preAnalystOutputs,
  systemEvents,
  systemState,
} from "@/db/schema";
import { type SizingMethod, allocate } from "@/lib/allocator";
import { getExchangeStatus } from "@/lib/clients/gmo";
import { runCritic } from "@/lib/critic";
import { withRetry } from "@/lib/cycle/retry";
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
import { and, eq } from "drizzle-orm";

const logger = createLogger("cycle.phases");

const RISK_PER_COIN_MAX_RATIO = 0.25;
const RISK_PER_COIN_MIN_JPY = 5000;
const RISK_TOTAL_MAX_RATIO = 1.0;

export type CycleSkipReason = "exchange_closed" | "not_running" | "no_coins";

export interface PreflightInput {
  cycleId: string;
  model: string;
  method: SizingMethod;
}

export interface PreflightResult {
  proceed: boolean;
  skipped?: CycleSkipReason;
  periodHours?: number;
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
  }

  const portfolio = (
    await db.select().from(portfolios).where(eq(portfolios.model, input.model)).limit(1)
  )[0];
  if (!portfolio) throw new Error(`Portfolio not found: ${input.model}`);

  const enabledCoins = await db.select().from(coins).where(eq(coins.enabled, true));
  if (enabledCoins.length === 0) {
    logger.warn("No enabled coins");
    return { proceed: false, skipped: "no_coins" };
  }

  // Tier 0 の検索対象期間: 前回サイクルから経過時間 (下限 6h、上限 168h)
  const hoursSinceLast = state.lastCycleAt
    ? (Date.now() - state.lastCycleAt.getTime()) / 3_600_000
    : 24;
  const periodHours = Math.round(Math.max(6, Math.min(168, hoursSinceLast)));

  return { proceed: true, periodHours, coinIdsCount: enabledCoins.length };
}

/** 有効コインのリストを DB から取得 (phase 間で共有) */
async function getEnabledCoins() {
  return await db.select().from(coins).where(eq(coins.enabled, true));
}

/** Phase 2: Tier 0 全コイン snapshot 取得 (ALL-or-NOTHING) */
export async function tier0Snapshots(cycleId: string, periodHours: number): Promise<void> {
  const enabledCoins = await getEnabledCoins();

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
          });
          await db.insert(marketSnapshots).values({
            cycleId,
            coinId: coin.id,
            ohlcv1m: snap.ohlcv1m,
            ohlcv1h: [],
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
  // ticker / micro は snapshot 保存時に落ちてるので、Tier 2 用に最小限フィールドのみ復元
  const bars = (row.ohlcv1m as Snapshot["ohlcv1m"]) ?? [];
  const lastBar = bars.at(-1);
  const lastClose = lastBar?.close ?? "0";
  const snap: Snapshot = {
    symbol: coin.symbol,
    name: coin.name,
    fetchedAt: row.fetchedAt,
    perplexitySummary: row.perplexitySummary ?? "情報なし",
    perplexityCitations: row.perplexityCitations,
    grokSummary: row.grokSummary ?? "情報なし",
    grokCitations: row.grokCitations,
    ohlcv1m: bars,
    ohlcv1d: [], // Tier 2 内では使われない (formatBars で 1m のみ参照)
    ticker: { last: lastClose, bid: lastClose, ask: lastClose, volume: "0" },
    micro: null,
  };
  return { snapshotRow: row, snap };
}

/** Phase 3: Tier 1 Pre-Analyst (ALL-or-NOTHING) */
export async function tier1PreAnalyst(cycleId: string): Promise<void> {
  const enabledCoins = await getEnabledCoins();

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
            model: preRes.model,
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

/** Phase 4: Tier 2 Analyst (skip_flag=false のコインのみ、ALL-or-NOTHING) */
export async function tier2Analyst(cycleId: string): Promise<void> {
  const enabledCoins = await getEnabledCoins();

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

          // skip_flag を保有/未保有問わず尊重 (毎サイクル fresh decision、Hold は default)
          if (pre.skipFlag) return;

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
            model: pre.model,
          };
          const analystRes = await runAnalyst(snap, preResLike);
          await db.insert(analystOutputs).values({
            snapshotId: snapshot.id,
            preAnalystId: pre.id,
            model: analystRes.model,
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
export async function tier3Decisions(cycleId: string, model: string): Promise<void> {
  const enabledCoins = await getEnabledCoins();

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
          // analyst なし = Tier 2 が skip_flag で省略された → Tier 3 もスキップ
          if (!analyst) return;

          const analystResLike = {
            output: {
              fundamental: analyst.fundamental,
              sentiment: analyst.sentiment,
              technical: analyst.technical,
              synthesis: analyst.synthesis,
            },
            promptVersion: analyst.promptVersion,
            model: analyst.model,
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
              model: entry.model,
              kind: "entry",
              result: entry.output.decision,
              confidence: entry.output.confidence.toFixed(3),
              reasoning: entry.output.reasoning,
              promptVersion: entry.promptVersion,
            });
          }

          // Exit decision (保有時のみ)
          const openPos = (
            await db
              .select()
              .from(positions)
              .where(
                and(
                  eq(positions.model, model),
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
            model: exit.model,
            kind: "exit",
            result: exit.output.decision,
            confidence: exit.output.confidence.toFixed(3),
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
  model: string;
  method: SizingMethod;
  startedAt: number;
}

/** Phase 6: Exit 実行 → Critic → Risk Clipper → Entry 実行 → state 更新 → kill switch */
export async function finalize(input: FinalizeInput): Promise<FinalizeResult> {
  const { cycleId, model, method, startedAt } = input;
  const enabledCoins = await getEnabledCoins();

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
                eq(positions.model, model),
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
  for (const c of ctxs) {
    if (c.exit?.result === "close" && c.openPos) {
      const lastPrice = Number(c.snap.ticker.last) || 0;
      if (lastPrice > 0) {
        try {
          // Exit の close_pct は decisions テーブルに無いので、現状全決済 (100%) として扱う。
          // 将来 decisions に close_pct 列追加 or LLM 出力を別途保存。
          await executeExit({
            model,
            symbol: c.coin.symbol,
            decisionId: c.exit.id,
            marketPrice: lastPrice,
            takerFeeRate: Number(c.coin.takerFeeRate),
            reason: "llm decision",
          });
        } catch (err) {
          logger.error({ err, symbol: c.coin.symbol }, "executeExit failed");
        }
      }
    }
  }

  // 現金残高 refresh
  const refreshedPortfolio = (
    await db.select().from(portfolios).where(eq(portfolios.model, model)).limit(1)
  )[0];
  const cashJpy = Number(refreshedPortfolio?.cashJpy ?? 0);

  const buySignals = ctxs
    .filter((c) => c.entry?.result === "buy")
    .map((c) => ({ symbol: c.coin.symbol, confidence: Number(c.entry?.confidence ?? 0) }));

  const proposal = allocate({
    buySignals,
    availableCashJpy: cashJpy,
    maxAllocationRatio: 1.0,
    perCoinMaxRatio: RISK_PER_COIN_MAX_RATIO,
    perCoinMinJpy: RISK_PER_COIN_MIN_JPY,
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
        exit: c.exit ? { decision: c.exit.result, confidence: Number(c.exit.confidence) } : null,
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

  const critic = await runCritic({
    proposal,
    analystSummariesBySymbol,
    decisionsBySymbol,
    currentPositions,
    symbolToName,
    cashJpy,
    riskParams: { perCoinMaxRatio: RISK_PER_COIN_MAX_RATIO, killSwitchDdRatio: 0.5 },
  });

  await db.insert(criticOutputs).values({
    cycleId,
    model: critic.model,
    decision: critic.output.decision,
    allocationProposal: proposal,
    adjustments: critic.output.adjustments,
    reasoning: critic.output.reasoning,
    promptVersion: critic.promptVersion,
  });

  let finalProposal = proposal;
  if (critic.output.decision === "veto") {
    logger.warn({ reason: critic.output.reasoning }, "Critic vetoed this cycle");
    await db.insert(systemEvents).values({
      model,
      kind: "critic_veto",
      severity: "warning",
      message: `Critic veto: ${critic.output.reasoning.slice(0, 200)}`,
      payload: { cycleId, proposal },
    });
    await notify({
      level: "warning",
      title: "🛑 Critic 拒否 (VETO)",
      body: critic.output.reasoning.slice(0, 1000),
      fields: { モデル: model, シグナル数: Object.keys(proposal).length },
    });
    finalProposal = {};
  } else if (critic.output.decision === "modify" && critic.output.adjustments) {
    finalProposal = { ...proposal, ...critic.output.adjustments };
    await db.insert(systemEvents).values({
      model,
      kind: "critic_modify",
      severity: "info",
      message: `Critic modified: ${critic.output.reasoning.slice(0, 200)}`,
      payload: { cycleId, before: proposal, after: finalProposal },
    });
    await notify({
      level: "info",
      title: "✏️ Critic 修正 (MODIFY)",
      body: critic.output.reasoning.slice(0, 1000),
      fields: {
        モデル: model,
        修正前: JSON.stringify(proposal).slice(0, 200),
        修正後: JSON.stringify(finalProposal).slice(0, 200),
      },
    });
  }

  const currentInvested = currentPositions.reduce((s, p) => s + p.qty * p.avgPrice, 0);
  const clipped = applyRiskClipper({
    proposal: finalProposal,
    availableCashJpy: cashJpy,
    currentInvestedJpy: currentInvested,
    perCoinMaxRatio: RISK_PER_COIN_MAX_RATIO,
    perCoinMinJpy: RISK_PER_COIN_MIN_JPY,
    totalMaxRatio: RISK_TOTAL_MAX_RATIO,
  });
  if (clipped.changes.length > 0) {
    logger.info({ changes: clipped.changes }, "Risk Clipper applied");
  }

  for (const c of ctxs) {
    const budget = clipped.proposal[c.coin.symbol];
    if (!budget) continue;
    const lastPrice = Number(c.snap.ticker.last) || 0;
    if (lastPrice <= 0) continue;
    try {
      await executeEntry({
        model,
        symbol: c.coin.symbol,
        decisionId: c.entry?.id ?? null,
        marketPrice: lastPrice,
        budgetJpy: budget,
        takerFeeRate: Number(c.coin.takerFeeRate),
        entryReason: c.entry?.reasoning ?? null,
      });
    } catch (err) {
      logger.error({ err, symbol: c.coin.symbol }, "executeEntry failed");
    }
  }

  // system_state 更新 (連続失敗カウンタリセット)
  await db
    .insert(systemState)
    .values({
      id: "singleton",
      state: "running",
      consecutiveFailures: 0,
      lastCycleId: cycleId,
      lastCycleAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: systemState.id,
      set: {
        consecutiveFailures: 0,
        lastCycleId: cycleId,
        lastCycleAt: new Date(),
        updatedAt: new Date(),
      },
    });

  await checkAndTriggerKillSwitch({ model });

  const elapsedMs = Date.now() - startedAt;
  const exitsTriggered = ctxs.filter((c) => c.exit?.result === "close").length;
  const entriesExecuted = Object.keys(clipped.proposal).length;
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

  await notify({
    level: "info",
    title: `🔁 サイクル完了 · ${model}`,
    fields: {
      処理銘柄: `${symbolsProcessed}/${enabledCoins.length}`,
      Tier1スキップ: symbolsSkipped,
      買いシグナル: buySignals.length,
      新規約定: entriesExecuted,
      決済: exitsTriggered,
      Critic判定: critic.output.decision,
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

/** サイクル中断時の通知 + 連続失敗カウント更新 */
export async function recordCycleFailure(args: {
  cycleId: string;
  model: string;
  phase: string;
  err: unknown;
}): Promise<void> {
  const errMsg = args.err instanceof Error ? args.err.message : String(args.err);
  logger.error({ cycleId: args.cycleId, phase: args.phase, err: args.err }, "Cycle aborted");

  const state = (
    await db.select().from(systemState).where(eq(systemState.id, "singleton")).limit(1)
  )[0];
  const newCount = (state?.consecutiveFailures ?? 0) + 1;
  await db
    .insert(systemState)
    .values({
      id: "singleton",
      state: state?.state ?? "running",
      consecutiveFailures: newCount,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: systemState.id,
      set: { consecutiveFailures: newCount, updatedAt: new Date() },
    });

  await db.insert(systemEvents).values({
    model: args.model,
    // 暫定: 専用 enum 値が未定義のため llm_failure 流用 (Inngest dashboard / 通知が主観測点)
    kind: "llm_failure",
    severity: "error",
    message: `Cycle ${args.cycleId.slice(0, 8)} aborted at ${args.phase}: ${errMsg.slice(0, 300)}`,
    payload: { cycleId: args.cycleId, phase: args.phase },
  });

  await notify({
    level: "error",
    title: `🛑 サイクル中断 (${args.phase})`,
    body: errMsg.slice(0, 500),
    fields: {
      サイクル: args.cycleId.slice(0, 8),
      連続失敗: newCount,
    },
  });
}
