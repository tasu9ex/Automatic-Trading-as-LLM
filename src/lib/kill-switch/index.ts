import { db } from "@/db/client";
import {
  coins,
  marketSnapshots,
  portfolios,
  positions,
  systemEvents,
  systemState,
} from "@/db/schema";
import { getTicker } from "@/lib/clients/gmo";
import { AUTO_PAUSE_THRESHOLD, PORTFOLIO_DD_TRIGGER } from "@/lib/constants/risk";
import { executeExit } from "@/lib/executor";
import { createLogger } from "@/lib/logging";
import { notify } from "@/lib/notifications";
import { and, desc, eq } from "drizzle-orm";

const logger = createLogger("kill-switch");

export interface KillSwitchCheckInput {
  strategyId: string;
}

export type SafetyTriggerKind = "killed" | "paused";

/**
 * サイクル終了後の安全チェック。
 *
 * - ポートフォリオ DD <= -50% → Kill Switch（全ポジション仮想成行クローズ + killed）
 * - 連続失敗 >= 3 → 自動一時停止（ポジション維持 + paused、LLM のみ止める）
 */
export async function checkAndTriggerKillSwitch(
  input: KillSwitchCheckInput,
): Promise<SafetyTriggerKind | false> {
  const portfolio = (
    await db.select().from(portfolios).where(eq(portfolios.strategyId, input.strategyId)).limit(1)
  )[0];
  if (!portfolio) return false;

  const state = (
    await db.select().from(systemState).where(eq(systemState.id, "singleton")).limit(1)
  )[0];

  const open = await db
    .select({ position: positions, coin: coins })
    .from(positions)
    .innerJoin(coins, eq(positions.coinId, coins.id))
    .where(and(eq(positions.strategyId, input.strategyId), eq(positions.status, "open")));

  // §8: ticker 取得失敗時に position を silent skip すると DD が過小評価される。
  // フォールバック順:
  //   1. GMO ticker (現値)
  //   2. 直近 market_snapshots の ohlcv_1m 最終 close
  //   3. positions.peakPrice (保守的: trail で最も楽観的だがゼロよりマシ)
  //   4. positions.avgEntryPrice (建値、最も楽観的)
  let marketValue = 0;
  for (const { position, coin } of open) {
    let lastPrice = 0;
    let source: "ticker" | "snapshot" | "peak" | "avg" = "ticker";
    try {
      const ticker = await getTicker(`${coin.symbol}_JPY`);
      lastPrice = Number(ticker[0]?.last ?? 0);
    } catch (err) {
      logger.warn(
        { symbol: coin.symbol, err },
        "Kill-switch: ticker fetch failed, falling back to snapshot/position price",
      );
    }
    if (lastPrice <= 0) {
      const snap = (
        await db
          .select({ ohlcv1m: marketSnapshots.ohlcv1m })
          .from(marketSnapshots)
          .where(eq(marketSnapshots.coinId, coin.id))
          .orderBy(desc(marketSnapshots.fetchedAt))
          .limit(1)
      )[0];
      const bars = (snap?.ohlcv1m as Array<{ close: string }> | null) ?? [];
      const lastBar = bars.at(-1);
      if (lastBar?.close) {
        lastPrice = Number(lastBar.close);
        source = "snapshot";
      }
    }
    if (lastPrice <= 0) {
      const peak = Number(position.peakPrice ?? 0);
      if (peak > 0) {
        lastPrice = peak;
        source = "peak";
      }
    }
    if (lastPrice <= 0) {
      lastPrice = Number(position.avgEntryPrice);
      source = "avg";
    }
    if (source !== "ticker") {
      logger.warn(
        { symbol: coin.symbol, source, lastPrice },
        "Kill-switch: using fallback price for DD calc",
      );
    }
    marketValue += Number(position.quantity) * lastPrice;
  }
  const totalValue = Number(portfolio.cashJpy) + marketValue;
  const initial = Number(portfolio.initialCashJpy);
  const ddRatio = (initial - totalValue) / initial;

  const failureTriggered = state && state.consecutiveFailures >= AUTO_PAUSE_THRESHOLD;
  const ddTriggered = ddRatio >= PORTFOLIO_DD_TRIGGER;

  if (ddTriggered) {
    const reason = `portfolio DD ${(ddRatio * 100).toFixed(1)}%`;
    await triggerKillSwitch({
      strategyId: input.strategyId,
      open,
      reason,
      totalValue,
      initial,
      ddRatio,
    });
    return "killed";
  }

  if (failureTriggered) {
    const failures = state?.consecutiveFailures ?? 0;
    await triggerAutoPauseDueToFailures({ strategyId: input.strategyId, failures });
    return "paused";
  }

  return false;
}

async function triggerKillSwitch(input: {
  strategyId: string;
  open: { coin: typeof coins.$inferSelect }[];
  reason: string;
  totalValue: number;
  initial: number;
  ddRatio: number;
}) {
  const { strategyId, open, reason, totalValue, initial, ddRatio } = input;

  logger.error({ strategyId, totalValue, ddRatio, reason }, "Kill Switch triggered");

  for (const { coin } of open) {
    try {
      const ticker = await getTicker(`${coin.symbol}_JPY`);
      const lastPrice = Number(ticker[0]?.last ?? 0);
      if (lastPrice > 0) {
        await executeExit({
          strategyId,
          symbol: coin.symbol,
          decisionId: null,
          marketPrice: lastPrice,
          takerFeeRate: Number(coin.takerFeeRate),
          forced: true,
          reason: `kill switch: ${reason}`,
        });
      }
    } catch (err) {
      logger.error({ err, symbol: coin.symbol }, "Kill switch close failed");
      await notify({
        level: "critical",
        title: `🚨 Kill Switch close 失敗 ${coin.symbol}`,
        body: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
        fields: {
          影響: "ポジション残ったまま killed 状態。手動 close 必要",
        },
      });
    }
  }

  await db
    .insert(systemState)
    .values({
      id: "singleton",
      state: "killed",
      killReason: reason,
      killedAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: systemState.id,
      set: { state: "killed", killReason: reason, killedAt: new Date(), updatedAt: new Date() },
    });

  await db.insert(systemEvents).values({
    strategyId,
    kind: "kill_switch_triggered",
    severity: "critical",
    message: `Kill Switch: ${reason}`,
    payload: { totalValue, ddRatio, initialCash: initial },
  });

  await notify({
    level: "critical",
    title: "🚨 緊急停止 (Kill Switch) 発動",
    body: `**${reason}**\n全ポジションを強制クローズしました。システムは停止状態です。手動で再開してください。`,
    fields: {
      元本: `¥${Math.round(initial).toLocaleString()}`,
      現在資産: `¥${Math.round(totalValue).toLocaleString()}`,
      ドローダウン: `${(ddRatio * 100).toFixed(1)}%`,
    },
  });
}

async function triggerAutoPauseDueToFailures(input: { strategyId: string; failures: number }) {
  const { strategyId, failures } = input;
  const reason = `${failures} consecutive cycle failures`;

  logger.warn({ strategyId, failures }, "Auto-pause due to consecutive failures");

  await db
    .insert(systemState)
    .values({
      id: "singleton",
      state: "paused",
      consecutiveFailures: 0,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: systemState.id,
      set: {
        state: "paused",
        consecutiveFailures: 0,
        updatedAt: new Date(),
      },
    });

  await db.insert(systemEvents).values({
    strategyId,
    kind: "system_paused",
    severity: "warning",
    message: `Auto-pause: ${reason}`,
    payload: { failures, trigger: "consecutive_failures" },
  });

  await notify({
    level: "warning",
    title: "⏸ 連続失敗のため自動一時停止",
    body: `判定パイプラインが **${failures} サイクル連続**で全銘柄失敗しました。\nポジションは維持されています。ダッシュボードから再開してください。`,
    fields: { 連続失敗: String(failures) },
  });
}
