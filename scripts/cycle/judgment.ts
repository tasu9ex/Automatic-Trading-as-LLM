/**
 * 1 サイクル分の判定パイプラインを CLI から実行する。
 *
 * Usage:
 *   pnpm cycle:judgment
 *   pnpm cycle:judgment -- --model opus-confidence --method confidence
 *
 * 流れ:
 *   1. coins テーブルから enabled な銘柄取得
 *   2. 各銘柄: Tier 0 → Tier 1 → market_snapshots / pre_analyst_outputs 保存
 *   3. 各銘柄: Tier 2 → analyst_outputs 保存
 *   4. 各銘柄: Entry/Exit Decision (保有有無で分岐) → decisions 保存
 *   5. Allocator → Critic → Risk Clipper
 *   6. Executor で仮想約定 (Exit 優先 → Entry)
 *   7. system_state.last_cycle_* 更新、連続失敗カウンタリセット
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
import { runCritic } from "@/lib/critic";
import { runEntryDecision } from "@/lib/decision/entry";
import { runExitDecision } from "@/lib/decision/exit";
import { executeEntry, executeExit } from "@/lib/executor";
import { checkAndTriggerKillSwitch } from "@/lib/kill-switch";
import { createLogger } from "@/lib/logging";
import { notify } from "@/lib/notifications";
import { applyRiskClipper } from "@/lib/risk/clipper";
import { type Snapshot, fetchSnapshot } from "@/lib/tier0/fetch-snapshot";
import { runPreAnalyst } from "@/lib/tier1/pre-analyst";
import { runAnalyst } from "@/lib/tier2/analyst";
import { and, eq } from "drizzle-orm";

const logger = createLogger("cycle.judgment");

const RISK_PER_COIN_MAX_RATIO = 0.25;
const RISK_PER_COIN_MIN_JPY = 5000;
const RISK_TOTAL_MAX_RATIO = 1.0;

interface CycleArgs {
  model: string;
  method: SizingMethod;
}

function parseArgs(argv: string[]): CycleArgs {
  const out: CycleArgs = { model: "opus-confidence", method: "confidence" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--model") {
      const v = argv[++i];
      if (v) out.model = v;
    } else if (a === "--method") {
      const v = argv[++i];
      if (v === "equal" || v === "confidence") out.method = v;
    }
  }
  return out;
}

async function recordSnapshot(cycleId: string, coinId: string, snap: Snapshot) {
  const [row] = await db
    .insert(marketSnapshots)
    .values({
      cycleId,
      coinId,
      ohlcv1m: snap.ohlcv1m,
      ohlcv1h: [], // 1d で運用、1h は使わない
      perplexitySummary: snap.perplexitySummary,
      grokSummary: snap.grokSummary,
      fetchedAt: snap.fetchedAt,
    })
    .returning();
  if (!row) throw new Error("snapshot insert failed");
  return row;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cycleId = randomUUID();
  const startedAt = Date.now();

  logger.info({ cycleId, args }, "Cycle started");

  // Kill switch チェック (前サイクル状態考慮)
  const state = (
    await db.select().from(systemState).where(eq(systemState.id, "singleton")).limit(1)
  )[0];
  if (state?.state === "killed") {
    logger.error("System is killed, skipping cycle");
    process.exit(2);
  }

  const portfolio = (
    await db.select().from(portfolios).where(eq(portfolios.model, args.model)).limit(1)
  )[0];
  if (!portfolio) throw new Error(`Portfolio not found: ${args.model}`);

  const enabledCoins = await db.select().from(coins).where(eq(coins.enabled, true));
  if (enabledCoins.length === 0) {
    logger.warn("No enabled coins");
    process.exit(0);
  }

  // 各銘柄パイプライン並列
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

      // MVP 初期: skip_flag を尊重せず常時 Tier 2 実行
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

      // 既存 open position 確認
      const openPos = (
        await db
          .select()
          .from(positions)
          .where(
            and(
              eq(positions.model, args.model),
              eq(positions.coinId, coin.id),
              eq(positions.status, "open"),
            ),
          )
          .limit(1)
      )[0];

      let entry: Awaited<ReturnType<typeof runEntryDecision>> | null = null;
      let exit: Awaited<ReturnType<typeof runExitDecision>> | null = null;
      let entryDecisionId: string | null = null;
      let exitDecisionId: string | null = null;

      if (openPos) {
        // Exit 判定 + ピラミッディング候補として Entry も
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

      // Entry: open ポジ有無に関わらず判定 (ピラミッディング対応)
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
      };
    }),
  );

  const results = perCoin.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  const failures = perCoin.filter((r) => r.status === "rejected");
  for (const f of failures) {
    logger.error({ err: f.reason }, "Per-coin pipeline failed");
  }

  // Exit 優先で実行
  for (const r of results) {
    if (r.exit?.output.decision === "close" && r.openPos) {
      const lastPrice = Number(r.snap.ticker.last) || 0;
      if (lastPrice > 0) {
        try {
          await executeExit({
            model: args.model,
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

  // Buy 信号集めて Allocator → Critic → Risk Clipper → Entry 実行
  const refreshedPortfolio = (
    await db.select().from(portfolios).where(eq(portfolios.model, args.model)).limit(1)
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
    method: args.method,
  });

  const analystSummariesBySymbol = Object.fromEntries(
    results.map((r) => [r.coin.symbol, r.analyst.output.synthesis]),
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
      model: args.model,
      kind: "critic_veto",
      severity: "warning",
      message: `Critic veto: ${critic.output.reasoning.slice(0, 200)}`,
      payload: { cycleId, proposal },
    });
    await notify({
      level: "warning",
      title: "🛑 Critic VETO",
      body: critic.output.reasoning.slice(0, 1000),
      fields: { model: args.model, signals: Object.keys(proposal).length },
    });
    finalProposal = {};
  } else if (critic.output.decision === "modify" && critic.output.adjustments) {
    finalProposal = { ...proposal, ...critic.output.adjustments };
    await db.insert(systemEvents).values({
      model: args.model,
      kind: "critic_modify",
      severity: "info",
      message: `Critic modified: ${critic.output.reasoning.slice(0, 200)}`,
      payload: { cycleId, before: proposal, after: finalProposal },
    });
    await notify({
      level: "info",
      title: "✏️ Critic MODIFY",
      body: critic.output.reasoning.slice(0, 1000),
      fields: {
        model: args.model,
        before: JSON.stringify(proposal).slice(0, 200),
        after: JSON.stringify(finalProposal).slice(0, 200),
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

  // Entry 実行
  for (const r of results) {
    const budget = clipped.proposal[r.coin.symbol];
    if (!budget) continue;
    const lastPrice = Number(r.snap.ticker.last) || 0;
    if (lastPrice <= 0) continue;
    try {
      await executeEntry({
        model: args.model,
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

  // 連続失敗カウンタ更新
  const allFailed = perCoin.length > 0 && results.length === 0;
  await db
    .insert(systemState)
    .values({
      id: "singleton",
      state: "running",
      consecutiveFailures: allFailed ? (state?.consecutiveFailures ?? 0) + 1 : 0,
      lastCycleId: cycleId,
      lastCycleAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: systemState.id,
      set: {
        state: "running",
        consecutiveFailures: allFailed ? (state?.consecutiveFailures ?? 0) + 1 : 0,
        lastCycleId: cycleId,
        lastCycleAt: new Date(),
        updatedAt: new Date(),
      },
    });

  // Kill switch チェック
  await checkAndTriggerKillSwitch({ model: args.model });

  const elapsedMs = Date.now() - startedAt;
  const exitsTriggered = results.filter((r) => r.exit?.output.decision === "close").length;
  const entriesExecuted = Object.keys(clipped.proposal).length;
  logger.info(
    {
      cycleId,
      elapsedMs,
      symbolsProcessed: results.length,
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
    title: `🔁 Cycle done · ${args.model}`,
    fields: {
      processed: `${results.length}/${enabledCoins.length}`,
      failed: failures.length,
      buySignals: buySignals.length,
      entries: entriesExecuted,
      exits: exitsTriggered,
      critic: critic.output.decision,
      elapsed: `${(elapsedMs / 1000).toFixed(1)}s`,
    },
  });

  process.exit(0);
}

main().catch(async (err) => {
  logger.error({ err }, "Cycle failed");
  await notify({
    level: "error",
    title: "❌ Cycle CRASHED",
    body: `\`\`\`${(err as Error)?.stack?.slice(0, 1500) ?? String(err)}\`\`\``,
  });
  process.exit(1);
});
