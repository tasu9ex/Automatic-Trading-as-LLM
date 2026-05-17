import { db } from "@/db/client";
import { coins, portfolios, positions, systemEvents, systemState } from "@/db/schema";
import { getTicker } from "@/lib/clients/gmo";
import { executeExit } from "@/lib/executor";
import { createLogger } from "@/lib/logging";
import { and, eq } from "drizzle-orm";

const logger = createLogger("kill-switch");

const PORTFOLIO_DD_TRIGGER = 0.5; // -50%
const CONSECUTIVE_FAILURES_TRIGGER = 3;

export interface KillSwitchCheckInput {
  model: string;
}

/**
 * Kill Switch 発動条件チェック:
 *   - ポートフォリオ累積 DD <= -50%
 *   - 連続失敗回数 >= 3
 *   - その他重大エラー(別経路で呼ぶ)
 *
 * 発動時の挙動:
 *   1. 全 open ポジションを仮想成行クローズ
 *   2. system_state.state = 'killed'
 *   3. system_events 記録
 */
export async function checkAndTriggerKillSwitch(input: KillSwitchCheckInput): Promise<boolean> {
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

  // 現在の総資産 = cash + 評価額
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

  if (!ddTriggered && !failureTriggered) return false;

  const reason = ddTriggered
    ? `portfolio DD ${(ddRatio * 100).toFixed(1)}%`
    : `${state?.consecutiveFailures ?? 0} consecutive failures`;

  logger.error({ model: input.model, totalValue, ddRatio, reason }, "Kill Switch triggered");

  // 全クローズ
  for (const { position, coin } of open) {
    try {
      const ticker = await getTicker(`${coin.symbol}_JPY`);
      const lastPrice = Number(ticker[0]?.last ?? 0);
      if (lastPrice > 0) {
        await executeExit({
          model: input.model,
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
    model: input.model,
    kind: "kill_switch_triggered",
    severity: "critical",
    message: `Kill Switch: ${reason}`,
    payload: { totalValue, ddRatio, initialCash: initial },
  });

  return true;
}
