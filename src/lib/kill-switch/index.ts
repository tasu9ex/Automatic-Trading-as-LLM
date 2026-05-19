import { db } from "@/db/client";
import { coins, portfolios, positions, systemEvents, systemState } from "@/db/schema";
import { getTicker } from "@/lib/clients/gmo";
import { executeExit } from "@/lib/executor";
import { createLogger } from "@/lib/logging";
import { notify } from "@/lib/notifications";
import { and, eq } from "drizzle-orm";

const logger = createLogger("kill-switch");

const PORTFOLIO_DD_TRIGGER = 0.5; // -50%
const CONSECUTIVE_FAILURES_TRIGGER = 3;

export interface KillSwitchCheckInput {
  model: string;
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
    await db.select().from(portfolios).where(eq(portfolios.model, input.model)).limit(1)
  )[0];
  if (!portfolio) return false;

  const state = (
    await db.select().from(systemState).where(eq(systemState.id, "singleton")).limit(1)
  )[0];

  const open = await db
    .select({ position: positions, coin: coins })
    .from(positions)
    .innerJoin(coins, eq(positions.coinId, coins.id))
    .where(and(eq(positions.model, input.model), eq(positions.status, "open")));

  let marketValue = 0;
  for (const { position, coin } of open) {
    try {
      const ticker = await getTicker(`${coin.symbol}_JPY`);
      const lastPrice = Number(ticker[0]?.last ?? 0);
      marketValue += Number(position.quantity) * lastPrice;
    } catch {
      // fail to estimate, skip
    }
  }
  const totalValue = Number(portfolio.cashJpy) + marketValue;
  const initial = Number(portfolio.initialCashJpy);
  const ddRatio = (initial - totalValue) / initial;

  const failureTriggered = state && state.consecutiveFailures >= CONSECUTIVE_FAILURES_TRIGGER;
  const ddTriggered = ddRatio >= PORTFOLIO_DD_TRIGGER;

  if (ddTriggered) {
    const reason = `portfolio DD ${(ddRatio * 100).toFixed(1)}%`;
    await triggerKillSwitch({ model: input.model, open, reason, totalValue, initial, ddRatio });
    return "killed";
  }

  if (failureTriggered) {
    const failures = state?.consecutiveFailures ?? 0;
    await triggerAutoPauseDueToFailures({ model: input.model, failures });
    return "paused";
  }

  return false;
}

async function triggerKillSwitch(input: {
  model: string;
  open: { coin: typeof coins.$inferSelect }[];
  reason: string;
  totalValue: number;
  initial: number;
  ddRatio: number;
}) {
  const { model, open, reason, totalValue, initial, ddRatio } = input;

  logger.error({ model, totalValue, ddRatio, reason }, "Kill Switch triggered");

  for (const { coin } of open) {
    try {
      const ticker = await getTicker(`${coin.symbol}_JPY`);
      const lastPrice = Number(ticker[0]?.last ?? 0);
      if (lastPrice > 0) {
        await executeExit({
          model,
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
    model,
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

async function triggerAutoPauseDueToFailures(input: { model: string; failures: number }) {
  const { model, failures } = input;
  const reason = `${failures} consecutive cycle failures`;

  logger.warn({ model, failures }, "Auto-pause due to consecutive failures");

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
    model,
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
