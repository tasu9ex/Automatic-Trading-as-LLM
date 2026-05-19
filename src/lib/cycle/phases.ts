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
  strategyId: string;
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
    await notify({
      level: "error",
      title: "⚠️ Price monitor 失敗 (サイクル継続)",
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
  const expectedCloseCash = exitsToRun.reduce((sum, c) => {
    const price = Number(c.snap.ticker.last) || 0;
    const qty = Number(c.openPos?.quantity ?? 0);
    return sum + qty * price;
  }, 0);
  const projectedCashJpy = currentCashJpy + expectedCloseCash;

  const buySignals = ctxs
    .filter((c) => c.entry?.result === "buy")
    .map((c) => ({ symbol: c.coin.symbol, confidence: Number(c.entry?.confidence ?? 0) }));

  const proposal = allocate({
    buySignals,
    availableCashJpy: projectedCashJpy,
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

  const critic = await runCritic({
    proposal,
    analystSummariesBySymbol,
    decisionsBySymbol,
    currentPositions,
    symbolToName,
    cashJpy: projectedCashJpy,
    riskParams: { perCoinMaxRatio: RISK_PER_COIN_MAX_RATIO, killSwitchDdRatio: 0.5 },
  });

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
    await notify({
      level: "warning",
      title: "🛑 Critic 拒否 (VETO)",
      body: critic.output.reasoning.slice(0, 1000),
      fields: { シグナル数: Object.keys(proposal).length },
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

    // Exit 後の cash refresh
    const refreshedPortfolio = (
      await db.select().from(portfolios).where(eq(portfolios.strategyId, strategyId)).limit(1)
    )[0];
    const cashAfterExits = Number(refreshedPortfolio?.cashJpy ?? 0);

    const currentInvested = currentPositions.reduce((s, p) => s + p.qty * p.avgPrice, 0);
    clipped = applyRiskClipper({
      proposal: finalProposal,
      availableCashJpy: cashAfterExits,
      currentInvestedJpy: currentInvested,
      perCoinMaxRatio: RISK_PER_COIN_MAX_RATIO,
      perCoinMinJpy: RISK_PER_COIN_MIN_JPY,
      totalMaxRatio: RISK_TOTAL_MAX_RATIO,
    });
    if (clipped.changes.length > 0) {
      logger.info({ changes: clipped.changes }, "Risk Clipper applied");
    }

    // Entry 実行
    for (const c of ctxs) {
      const budget = clipped.proposal[c.coin.symbol];
      if (!budget) continue;
      const lastPrice = Number(c.snap.ticker.last) || 0;
      if (lastPrice <= 0) continue;
      try {
        await executeEntry({
          strategyId,
          symbol: c.coin.symbol,
          decisionId: c.entry?.id ?? null,
          marketPrice: lastPrice,
          budgetJpy: budget,
          takerFeeRate: Number(c.coin.takerFeeRate),
          entryReason: c.entry?.reasoning ?? null,
        });
        entriesExecutedFinal++;
      } catch (err) {
        logger.error({ err, symbol: c.coin.symbol }, "executeEntry failed");
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
  const buys = ctxs
    .filter((c) => clipped.proposal[c.coin.symbol])
    .map((c) => `• ${c.coin.symbol}: ¥${(clipped.proposal[c.coin.symbol] ?? 0).toLocaleString()}`);
  // veto された場合 closes/buys は空 (Exit 実行スキップ済み)
  const closes =
    critic.output.decision === "veto" ? [] : exitsToRun.map((c) => `• ${c.coin.symbol}`);

  const refreshedAfterEntries = (
    await db.select().from(portfolios).where(eq(portfolios.strategyId, strategyId)).limit(1)
  )[0];
  const cashAfter = Number(refreshedAfterEntries?.cashJpy ?? 0);
  const openPositions = await db
    .select()
    .from(positions)
    .where(and(eq(positions.strategyId, strategyId), eq(positions.status, "open")));
  const positionLines = await Promise.all(
    openPositions.map(async (p) => {
      const c = (await db.select().from(coins).where(eq(coins.id, p.coinId)).limit(1))[0];
      const sym = c?.symbol ?? "?";
      const qty = Number(p.quantity).toFixed(6);
      const avg = Math.round(Number(p.avgEntryPrice)).toLocaleString();
      return `• ${sym}: ${qty} @ ¥${avg}`;
    }),
  );

  const bodyParts: string[] = [];
  if (buys.length > 0) bodyParts.push(`**📥 新規 Entry**\n${buys.join("\n")}`);
  if (closes.length > 0) bodyParts.push(`**📤 Close**\n${closes.join("\n")}`);
  if (positionLines.length > 0) {
    bodyParts.push(`**📊 保有ポジション (${positionLines.length})**\n${positionLines.join("\n")}`);
  }
  bodyParts.push(`**💰 現金**: ¥${Math.round(cashAfter).toLocaleString()}`);

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
      買いシグナル: buySignals.length,
      新規約定: entriesExecuted,
      決済: exitsTriggered,
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

/** サイクル中断時の通知 + 連続失敗カウント更新 */
export async function recordCycleFailure(args: {
  cycleId: string;
  strategyId: string;
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
    strategyId: args.strategyId,
    // 暫定: 専用 enum 値が未定義のため llm_failure 流用 (Inngest dashboard / 通知が主観測点)
    kind: "llm_failure",
    severity: "error",
    message: `Cycle ${args.cycleId.slice(0, 8)} aborted at ${args.phase}: ${errMsg.slice(0, 300)}`,
    payload: { cycleId: args.cycleId, phase: args.phase },
  });

  // Phase 名から推定原因 + 推奨対応
  const PHASE_HINTS: Record<string, { cause: string; action: string }> = {
    "tier0-snapshots": {
      cause: "Perplexity / Grok / GMO API 一時障害の可能性",
      action: "API status 確認後、次サイクル待ち",
    },
    "tier1-pre-analyst": {
      cause: "Anthropic 過負荷 (overloaded_error) の可能性",
      action: "https://status.anthropic.com 確認、次サイクル待ち",
    },
    "tier2-analyst": {
      cause: "Anthropic Opus 過負荷 or ITPM レート超過",
      action: "Langfuse で詳細確認、次サイクル待ち",
    },
    "tier3-decisions": {
      cause: "Anthropic Sonnet 過負荷 or ITPM レート超過",
      action: "Langfuse で詳細確認、次サイクル待ち",
    },
    finalize: {
      cause: "Critic 失敗 / DB 接続 / Executor バグ",
      action: "ログとダッシュボード状態を確認",
    },
  };
  const hint = PHASE_HINTS[args.phase] ?? {
    cause: "不明",
    action: "ログ確認",
  };

  // 自動 pause 閾値 (kill-switch CONSECUTIVE_FAILURES_TRIGGER と同期)
  const AUTO_PAUSE_THRESHOLD = 3;
  const remaining = Math.max(0, AUTO_PAUSE_THRESHOLD - newCount);
  const nextScheduledAt = state?.nextScheduledAt
    ? state.nextScheduledAt.toISOString().slice(0, 16).replace("T", " ")
    : "未設定";

  await notify({
    level: "error",
    title: `🛑 サイクル中断 (${args.phase})`,
    body: [
      "**エラー**",
      `\`\`\`\n${errMsg.slice(0, 800)}\n\`\`\``,
      `**推定原因**: ${hint.cause}`,
      `**推奨対応**: ${hint.action}`,
    ].join("\n"),
    fields: {
      サイクル: args.cycleId.slice(0, 8),
      連続失敗: `${newCount}/${AUTO_PAUSE_THRESHOLD}${remaining === 0 ? " (次回 auto pause)" : ` (あと ${remaining})`}`,
      次サイクル: nextScheduledAt,
    },
  });
}
