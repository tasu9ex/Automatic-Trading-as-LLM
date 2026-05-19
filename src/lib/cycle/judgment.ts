/**
 * 判定パイプライン本体。CLI / Inngest どちらからも呼べる。
 *
 * 流れ:
 *   1. GMO 取引所メンテチェック
 *   2. Kill switch チェック (killed なら早期 return)
 *   3. Price-monitor: 前回サイクル以降の 1m バーで逆指値タッチ判定
 *   4. 各銘柄並列: Tier 0 → Tier 1 → Tier 2 → Entry/Exit Decision
 *   5. Allocator → Critic → Risk Clipper
 *   6. Executor で仮想約定 (Exit 優先 → Entry)
 *   7. system_state.last_cycle_* 更新、連続失敗カウンタリセット
 *   8. Kill switch 再チェック
 */

import { randomUUID } from "node:crypto";
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

const logger = createLogger("cycle.judgment");

const RISK_PER_COIN_MAX_RATIO = 0.25;
const RISK_PER_COIN_MIN_JPY = 5000;
const RISK_TOTAL_MAX_RATIO = 1.0;

export interface JudgmentCycleInput {
  model?: string;
  method?: SizingMethod;
}

export interface JudgmentCycleResult {
  cycleId: string;
  skipped?: "exchange_closed" | "killed" | "no_coins";
  elapsedMs: number;
  symbolsProcessed: number;
  symbolsFailed: number;
  buySignals: number;
  exitsTriggered: number;
  entriesExecuted: number;
  criticDecision?: string;
}

async function recordSnapshot(cycleId: string, coinId: string, snap: Snapshot) {
  const [row] = await db
    .insert(marketSnapshots)
    .values({
      cycleId,
      coinId,
      ohlcv1m: snap.ohlcv1m,
      ohlcv1h: [],
      perplexitySummary: snap.perplexitySummary,
      grokSummary: snap.grokSummary,
      fetchedAt: snap.fetchedAt,
    })
    .returning();
  if (!row) throw new Error("snapshot insert failed");
  return row;
}

export async function runJudgmentCycle(
  input: JudgmentCycleInput = {},
): Promise<JudgmentCycleResult> {
  const model = input.model ?? "opus-confidence";
  const method = input.method ?? "confidence";
  const cycleId = randomUUID();
  const startedAt = Date.now();

  logger.info({ cycleId, model, method }, "Cycle started");

  try {
    const exchangeStatus = await getExchangeStatus();
    if (exchangeStatus !== "OPEN") {
      logger.warn({ exchangeStatus }, "Exchange not OPEN, skipping cycle");
      await notify({
        level: "info",
        title: `⏸ GMO 取引所 ${exchangeStatus} のためサイクルスキップ`,
        fields: { ステータス: exchangeStatus },
      });
      return {
        cycleId,
        skipped: "exchange_closed",
        elapsedMs: Date.now() - startedAt,
        symbolsProcessed: 0,
        symbolsFailed: 0,
        buySignals: 0,
        exitsTriggered: 0,
        entriesExecuted: 0,
      };
    }
  } catch (err) {
    logger.warn({ err }, "Exchange status check failed, proceeding anyway");
  }

  const state = (
    await db.select().from(systemState).where(eq(systemState.id, "singleton")).limit(1)
  )[0];
  if (state?.state === "killed") {
    logger.error("System is killed, skipping cycle");
    return {
      cycleId,
      skipped: "killed",
      elapsedMs: Date.now() - startedAt,
      symbolsProcessed: 0,
      symbolsFailed: 0,
      buySignals: 0,
      exitsTriggered: 0,
      entriesExecuted: 0,
    };
  }

  // Price-monitor: 前回サイクル以降の 1m バー全部を見て逆指値判定。
  // ペーパー運用中のシミュレーション (実マネー時は GMO 側で動く)。
  const priceMonitorSince = state?.lastCycleAt ?? new Date(Date.now() - 60 * 60_000);
  try {
    await runPriceMonitor({ since: priceMonitorSince });
  } catch (err) {
    logger.error({ err }, "Price monitor failed (continuing cycle)");
  }

  const portfolio = (
    await db.select().from(portfolios).where(eq(portfolios.model, model)).limit(1)
  )[0];
  if (!portfolio) throw new Error(`Portfolio not found: ${model}`);

  const enabledCoins = await db.select().from(coins).where(eq(coins.enabled, true));
  if (enabledCoins.length === 0) {
    logger.warn("No enabled coins");
    return {
      cycleId,
      skipped: "no_coins",
      elapsedMs: Date.now() - startedAt,
      symbolsProcessed: 0,
      symbolsFailed: 0,
      buySignals: 0,
      exitsTriggered: 0,
      entriesExecuted: 0,
    };
  }

  const perCoin = await Promise.allSettled(
    enabledCoins.map(async (coin) => {
      const snap = await fetchSnapshot({ symbol: coin.symbol });
      const snapRow = await recordSnapshot(cycleId, coin.id, snap);

      const preRes = await runPreAnalyst(snap);
      const [preRow] = await db
        .insert(preAnalystOutputs)
        .values({
          snapshotId: snapRow.id,
          model: preRes.model,
          summary: preRes.output.summary,
          relevanceScore: preRes.output.relevance_score.toFixed(3),
          skipFlag: preRes.output.skip_flag,
          reasoning: preRes.output.reasoning,
          promptVersion: preRes.promptVersion,
        })
        .returning();

      // 既存ポジション確認 (skip 判定で参照)
      const openPosPre = (
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

      // skip_flag が立っていて未保有なら Tier 2 以降スキップ (コスト削減)
      // 保有中はメンテのため必ず Tier 2 + Exit を回す
      if (preRes.output.skip_flag && !openPosPre) {
        return {
          coin,
          snap,
          analyst: null,
          entry: null,
          entryDecisionId: null,
          exit: null,
          exitDecisionId: null,
          openPos: null,
          skipped: true as const,
        };
      }

      const analystRes = await runAnalyst(snap, preRes);
      const [analystRow] = await db
        .insert(analystOutputs)
        .values({
          snapshotId: snapRow.id,
          preAnalystId: preRow?.id ?? null,
          model: analystRes.model,
          fundamental: analystRes.output.fundamental,
          sentiment: analystRes.output.sentiment,
          technical: analystRes.output.technical,
          synthesis: analystRes.output.synthesis,
          promptVersion: analystRes.promptVersion,
        })
        .returning();
      if (!analystRow) throw new Error("analyst insert failed");

      const openPos = openPosPre;

      let entry: Awaited<ReturnType<typeof runEntryDecision>> | null = null;
      let exit: Awaited<ReturnType<typeof runExitDecision>> | null = null;
      let entryDecisionId: string | null = null;
      let exitDecisionId: string | null = null;

      if (openPos) {
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
        exit = await runExitDecision(
          {
            symbol: coin.symbol,
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
          analystRes,
        );

        const [row] = await db
          .insert(decisions)
          .values({
            analystId: analystRow.id,
            coinId: coin.id,
            model: exit.model,
            kind: "exit",
            result: exit.output.decision,
            confidence: exit.output.confidence.toFixed(3),
            reasoning: exit.output.reasoning,
            promptVersion: exit.promptVersion,
          })
          .returning();
        exitDecisionId = row?.id ?? null;
      }

      entry = await runEntryDecision(coin.symbol, analystRes);
      const [entryRow] = await db
        .insert(decisions)
        .values({
          analystId: analystRow.id,
          coinId: coin.id,
          model: entry.model,
          kind: "entry",
          result: entry.output.decision,
          confidence: entry.output.confidence.toFixed(3),
          reasoning: entry.output.reasoning,
          promptVersion: entry.promptVersion,
        })
        .returning();
      entryDecisionId = entryRow?.id ?? null;

      return {
        coin,
        snap,
        analyst: analystRes,
        entry,
        entryDecisionId,
        exit,
        exitDecisionId,
        openPos,
        skipped: false as const,
      };
    }),
  );

  const results = perCoin.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  const failures = perCoin.filter((r) => r.status === "rejected");
  for (const f of failures) {
    logger.error({ err: f.reason }, "Per-coin pipeline failed");
  }

  for (const r of results) {
    if (r.exit?.output.decision === "close" && r.openPos) {
      const lastPrice = Number(r.snap.ticker.last) || 0;
      if (lastPrice > 0) {
        try {
          await executeExit({
            model,
            symbol: r.coin.symbol,
            decisionId: r.exitDecisionId,
            marketPrice: lastPrice,
            takerFeeRate: Number(r.coin.takerFeeRate),
            reason: "llm decision",
          });
        } catch (err) {
          logger.error({ err, symbol: r.coin.symbol }, "executeExit failed");
        }
      }
    }
  }

  const refreshedPortfolio = (
    await db.select().from(portfolios).where(eq(portfolios.model, model)).limit(1)
  )[0];
  const cashJpy = Number(refreshedPortfolio?.cashJpy ?? 0);

  const buySignals = results
    .filter((r) => r.entry?.output.decision === "buy")
    .map((r) => ({ symbol: r.coin.symbol, confidence: r.entry?.output.confidence ?? 0 }));

  const proposal = allocate({
    buySignals,
    availableCashJpy: cashJpy,
    maxAllocationRatio: 1.0,
    perCoinMaxRatio: RISK_PER_COIN_MAX_RATIO,
    perCoinMinJpy: RISK_PER_COIN_MIN_JPY,
    method,
  });

  const analystSummariesBySymbol = Object.fromEntries(
    results
      .filter((r) => r.analyst !== null)
      .map((r) => [
        r.coin.symbol,
        // biome-ignore lint/style/noNonNullAssertion: filter で確認済み
        r.analyst!.output.synthesis,
      ]),
  );
  const decisionsBySymbol = Object.fromEntries(
    results.map((r) => [
      r.coin.symbol,
      { entry: r.entry?.output ?? null, exit: r.exit?.output ?? null },
    ]),
  );
  const currentPositions = results
    .filter((r) => r.openPos)
    .map((r) => ({
      symbol: r.coin.symbol,
      qty: Number(r.openPos?.quantity ?? 0),
      avgPrice: Number(r.openPos?.avgEntryPrice ?? 0),
    }));

  const critic = await runCritic({
    proposal,
    analystSummariesBySymbol,
    decisionsBySymbol,
    currentPositions,
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

  for (const r of results) {
    const budget = clipped.proposal[r.coin.symbol];
    if (!budget) continue;
    const lastPrice = Number(r.snap.ticker.last) || 0;
    if (lastPrice <= 0) continue;
    try {
      await executeEntry({
        model,
        symbol: r.coin.symbol,
        decisionId: r.entryDecisionId,
        marketPrice: lastPrice,
        budgetJpy: budget,
        takerFeeRate: Number(r.coin.takerFeeRate),
        entryReason: r.entry?.output.reasoning ?? null,
        expectedHoldingDays: r.entry?.output.expected_holding_days ?? null,
        targetPriceJpy: r.entry?.output.target_price_jpy ?? null,
        exitCondition: r.entry?.output.exit_condition ?? null,
      });
    } catch (err) {
      logger.error({ err, symbol: r.coin.symbol }, "executeEntry failed");
    }
  }

  const allFailed = perCoin.length > 0 && results.length === 0;
  const newConsecutiveFailures = allFailed ? (state?.consecutiveFailures ?? 0) + 1 : 0;
  await db
    .insert(systemState)
    .values({
      id: "singleton",
      state: "running",
      consecutiveFailures: newConsecutiveFailures,
      lastCycleId: cycleId,
      lastCycleAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: systemState.id,
      set: {
        state: "running",
        consecutiveFailures: newConsecutiveFailures,
        lastCycleId: cycleId,
        lastCycleAt: new Date(),
        updatedAt: new Date(),
      },
    });

  await checkAndTriggerKillSwitch({ model });

  const elapsedMs = Date.now() - startedAt;
  const exitsTriggered = results.filter((r) => r.exit?.output.decision === "close").length;
  const entriesExecuted = Object.keys(clipped.proposal).length;
  const symbolsSkipped = results.filter((r) => r.skipped).length;
  logger.info(
    {
      cycleId,
      elapsedMs,
      symbolsProcessed: results.length,
      symbolsSkipped,
      symbolsFailed: failures.length,
      buySignals: buySignals.length,
      exitsTriggered,
      entriesExecuted,
      proposal: clipped.proposal,
      criticDecision: critic.output.decision,
    },
    "Cycle done",
  );

  await notify({
    level: failures.length > 0 ? "warning" : "info",
    title: `🔁 サイクル完了 · ${model}`,
    fields: {
      処理銘柄: `${results.length}/${enabledCoins.length}`,
      Tier1スキップ: symbolsSkipped,
      失敗: failures.length,
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
    symbolsProcessed: results.length,
    symbolsFailed: failures.length,
    buySignals: buySignals.length,
    exitsTriggered,
    entriesExecuted,
    criticDecision: critic.output.decision,
  };
}
