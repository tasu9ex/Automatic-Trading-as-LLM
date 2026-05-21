/**
 * 入金 / 出金処理。
 *
 * Capital-injection-adjusted HWM の核となる関数群:
 *   - 入金: cash += 入金、initialCashJpy += 入金、HWM += 入金 (peak を入金分上に持ち上げる)
 *   - 出金: cash -= 出金、initialCashJpy -= 出金、HWM -= 出金 (peak も出金分下げる)
 * これで「performance による HWM 変動」だけを Kill Switch が見る形になる。
 *
 * portfolio_capital_events に履歴を残す (将来 UI から参照)。
 *
 * 現状は CLI スクリプト (`scripts/dev/capital.ts`) から呼ぶ想定。
 * 将来 UI server action にする場合はこの関数をそのままラップする。
 */

import { db } from "@/db/client";
import { portfolioCapitalEvents, portfolios } from "@/db/schema";
import { createLogger } from "@/lib/logging";
import { eq } from "drizzle-orm";

const logger = createLogger("capital");

export interface CapitalEventArgs {
  strategyId: string;
  amountJpy: number;
  note?: string;
}

export async function recordDeposit(args: CapitalEventArgs): Promise<{
  newCashJpy: number;
  newInitialCashJpy: number;
  newHwmJpy: number;
}> {
  if (!Number.isFinite(args.amountJpy) || args.amountJpy <= 0) {
    throw new Error("入金額は正の数を指定してください");
  }
  return db.transaction(async (tx) => {
    const portfolio = (
      await tx.select().from(portfolios).where(eq(portfolios.strategyId, args.strategyId)).limit(1)
    )[0];
    if (!portfolio) throw new Error(`Portfolio not found: ${args.strategyId}`);

    const cashBefore = Number(portfolio.cashJpy);
    const initialBefore = Number(portfolio.initialCashJpy);
    const hwmBefore = Number(portfolio.highWaterMarkJpy);
    const equityBefore = cashBefore; // open positions の mtm は別途計算が必要だが、capital event 時点では簡易的に cash のみ。HWM 調整は cash 増分のみで正しい

    const newCash = cashBefore + args.amountJpy;
    const newInitial = initialBefore + args.amountJpy;
    const newHwm = hwmBefore + args.amountJpy;

    await tx
      .update(portfolios)
      .set({
        cashJpy: newCash.toFixed(4),
        initialCashJpy: newInitial.toFixed(4),
        highWaterMarkJpy: newHwm.toFixed(4),
        updatedAt: new Date(),
      })
      .where(eq(portfolios.id, portfolio.id));

    await tx.insert(portfolioCapitalEvents).values({
      strategyId: args.strategyId,
      kind: "deposit",
      amountJpy: args.amountJpy.toFixed(4),
      note: args.note,
      equityBeforeJpy: equityBefore.toFixed(4),
      hwmBeforeJpy: hwmBefore.toFixed(4),
    });

    logger.info(
      {
        strategyId: args.strategyId,
        amount: args.amountJpy,
        cashBefore,
        newCash,
        hwmBefore,
        newHwm,
      },
      "Deposit recorded",
    );

    return { newCashJpy: newCash, newInitialCashJpy: newInitial, newHwmJpy: newHwm };
  });
}

export async function recordWithdrawal(args: CapitalEventArgs): Promise<{
  newCashJpy: number;
  newInitialCashJpy: number;
  newHwmJpy: number;
}> {
  if (!Number.isFinite(args.amountJpy) || args.amountJpy <= 0) {
    throw new Error("出金額は正の数を指定してください");
  }
  return db.transaction(async (tx) => {
    const portfolio = (
      await tx.select().from(portfolios).where(eq(portfolios.strategyId, args.strategyId)).limit(1)
    )[0];
    if (!portfolio) throw new Error(`Portfolio not found: ${args.strategyId}`);

    const cashBefore = Number(portfolio.cashJpy);
    const initialBefore = Number(portfolio.initialCashJpy);
    const hwmBefore = Number(portfolio.highWaterMarkJpy);

    if (cashBefore < args.amountJpy) {
      throw new Error(
        `現金残高 (¥${cashBefore.toLocaleString()}) が出金額 (¥${args.amountJpy.toLocaleString()}) を下回ります`,
      );
    }

    const newCash = cashBefore - args.amountJpy;
    // initial / HWM は出金分減算で「performance による HWM 変動」だけを追う
    const newInitial = Math.max(0, initialBefore - args.amountJpy);
    const newHwm = Math.max(0, hwmBefore - args.amountJpy);

    await tx
      .update(portfolios)
      .set({
        cashJpy: newCash.toFixed(4),
        initialCashJpy: newInitial.toFixed(4),
        highWaterMarkJpy: newHwm.toFixed(4),
        updatedAt: new Date(),
      })
      .where(eq(portfolios.id, portfolio.id));

    await tx.insert(portfolioCapitalEvents).values({
      strategyId: args.strategyId,
      kind: "withdrawal",
      amountJpy: args.amountJpy.toFixed(4),
      note: args.note,
      equityBeforeJpy: cashBefore.toFixed(4),
      hwmBeforeJpy: hwmBefore.toFixed(4),
    });

    logger.info(
      {
        strategyId: args.strategyId,
        amount: args.amountJpy,
        cashBefore,
        newCash,
        hwmBefore,
        newHwm,
      },
      "Withdrawal recorded",
    );

    return { newCashJpy: newCash, newInitialCashJpy: newInitial, newHwmJpy: newHwm };
  });
}
