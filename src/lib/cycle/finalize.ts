/**
 * Phase 6 (finalize) の本体と関連ヘルパー。
 *
 * 流れ:
 *   buildCoinContext (全銘柄分) → buildExecutionPlan (Allocator + Clipper) →
 *   processCriticDecision (Critic + modify 検算) → executeExitsAndEntries (Exit → Entry) →
 *   system_state 更新 → kill switch → サイクル完了通知
 *
 * 注: tier0/1/2/3 phase は phases.ts に残置。本 module は finalize 専用。
 */

import { db } from "@/db/client";
import {
  analystOutputs,
  coins,
  criticOutputs,
  decisions,
  portfolios,
  positions,
  systemEvents,
  systemState,
  trades,
} from "@/db/schema";
import { PositionStatusValue } from "@/lib/constants/enums";
import { runCritic } from "@/lib/critic";
import { type CycleCoin, getCycleCoins } from "@/lib/cycle/coins";
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
import { markCycleCompleted } from "@/lib/cycle/mark-completed";
import { getCycleSnapshot, loadSnapshotFromRow } from "@/lib/cycle/snapshot";
import { buildSystemHealth } from "@/lib/cycle/system-health";
import { executeEntry, executeExit } from "@/lib/executor";
import { formatJpy, formatJpySigned } from "@/lib/format/jpy";
import { checkAndTriggerKillSwitch } from "@/lib/kill-switch";
import { createLogger } from "@/lib/logging";
import { notify } from "@/lib/notifications";
import { PER_COIN_MIN_JPY, TOTAL_MAX_RATIO, getRiskParams } from "@/lib/risk/params";
import type { Snapshot } from "@/lib/tier0/fetch-snapshot";
import { and, eq, gte } from "drizzle-orm";

import { SINGLETON_ID } from "@/lib/system-control/constants";
const logger = createLogger("cycle.finalize");

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

export interface FinalizeInput {
  cycleId: string;
  strategyId: string;
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
  const snapshot = await getCycleSnapshot(cycleId, coin.id);
  if (!snapshot) throw new Error(`No snapshot for coin ${coin.symbol} in finalize`);
  const snap = loadSnapshotFromRow(snapshot, coin);

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
      ? ({
          decision: "buy",
          confidence: Number(c.entry.confidence),
          sizePct: c.entry.entrySizePct ?? null,
        } as const)
      : c.entry?.result === "no"
        ? ({
            decision: "no",
            confidence: Number(c.entry.confidence),
            sizePct: null,
          } as const)
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
          size_pct: c.entry.entrySizePct ?? null,
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
            .map(([sym, jpy]) => `${sym}: ${formatJpy(jpy)}`)
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
        参考価格: formatJpy(lastPrice),
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
        配分: formatJpy(budget),
        参考価格: formatJpy(lastPrice),
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
  const buys = execution.executedEntries.map((e) => `• ${e.symbol}: ${formatJpy(e.budget)}`);
  const skippedBuys = execution.skippedEntries.map(
    (e) => `• ${e.symbol}: ${formatJpy(e.budget)} — ${e.reason}`,
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
      const avg = formatJpy(Number(p.avgEntryPrice));
      const price = lastPriceByCoinId.get(p.coinId) ?? 0;
      const valueJpy = formatJpy(qtyNum * price);
      return `• ${sym}: ${qty} @ ${avg} (${valueJpy})`;
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

  const bodyParts: string[] = [];
  if (buys.length > 0) bodyParts.push(`**📥 新規 Entry**\n${buys.join("\n")}`);
  if (skippedBuys.length > 0) bodyParts.push(`**⚠️ Entry 未実行**\n${skippedBuys.join("\n")}`);
  if (closes.length > 0) bodyParts.push(`**📕 Exit**\n${closes.join("\n")}`);
  if (positionLines.length > 0) {
    bodyParts.push(`**📊 保有ポジション (${positionLines.length})**\n${positionLines.join("\n")}`);
  }
  bodyParts.push(
    [
      `**💰 現金**: ${formatJpy(cashAfter)}`,
      `**🏦 資産時価総額**: ${formatJpy(totalAssetJpy)}`,
      `**📈 実現損益 (今回)**: ${formatJpySigned(realizedPnlCycle)}`,
      `**🧮 累計損益**: ${formatJpySigned(cumulativePnl)} (初期 ${formatJpy(initialCash)})`,
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
  const { cycleId, strategyId, startedAt } = input;
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
    .where(eq(systemState.id, SINGLETON_ID));

  await markCycleCompleted(cycleId);
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
