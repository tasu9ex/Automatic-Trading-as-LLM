import { describe, expect, it } from "vitest";
import { type ExecutionPlanSignal, buildExecutionPlan } from "./execution-plan";

const baseRiskParams = { perCoinMaxRatio: 0.25, perCoinTotalMaxRatio: 1.0 };

function signal(overrides: Partial<ExecutionPlanSignal> & { symbol: string }): ExecutionPlanSignal {
  return {
    lastPriceJpy: 1000,
    takerFeeRate: 0.005,
    entry: null,
    exit: null,
    openPosition: null,
    ...overrides,
  };
}

describe("buildExecutionPlan", () => {
  it("Entry 2 件、size_pct=100 / 50 → max_budget の % で配分", () => {
    // max_budget = currentCash 500k × 0.25 = 125k
    const plan = buildExecutionPlan({
      signals: [
        signal({
          symbol: "BTC",
          entry: { decision: "buy", confidence: 0.5, sizePct: 100 },
        }),
        signal({
          symbol: "XRP",
          entry: { decision: "buy", confidence: 0.5, sizePct: 50 },
        }),
      ],
      currentCashJpy: 500_000,
      riskParams: baseRiskParams,
    });

    expect(plan.entries.BTC).toBe(125_000);
    expect(plan.entries.XRP).toBe(62_500);
    expect(plan.projectedCashJpy).toBe(500_000);
    expect(plan.exits).toEqual({});
    expect(plan.currentPositions).toEqual({});
    expect(plan.plannedPositions).toEqual({ BTC: 125_000, XRP: 62_500 });
  });

  it("Exit 100% → projectedCash に手取りが乗り、postExit exposure はゼロ", () => {
    const plan = buildExecutionPlan({
      signals: [
        signal({
          symbol: "SOL",
          lastPriceJpy: 30_000,
          takerFeeRate: 0.005,
          exit: { decision: "close", confidence: 0.8, closePct: 100 },
          openPosition: { quantity: 1, avgEntryPrice: 25_000 },
        }),
      ],
      currentCashJpy: 100_000,
      riskParams: baseRiskParams,
    });

    expect(plan.exits.SOL.closePct).toBe(100);
    expect(plan.exits.SOL.qtyToClose).toBe(1);
    expect(plan.exits.SOL.expectedCashJpy).toBeCloseTo(29_850);
    expect(plan.projectedCashJpy).toBeCloseTo(129_850);
    expect(plan.currentPositions.SOL).toBe(30_000);
    expect(plan.plannedPositions.SOL).toBeUndefined();
    expect(plan.entries).toEqual({});
  });

  it("Exit 50% (部分決済) → 残量が postExit exposure に乗る", () => {
    const plan = buildExecutionPlan({
      signals: [
        signal({
          symbol: "ETH",
          lastPriceJpy: 500_000,
          takerFeeRate: 0.005,
          exit: { decision: "close", confidence: 0.6, closePct: 50 },
          openPosition: { quantity: 0.5, avgEntryPrice: 480_000 },
        }),
      ],
      currentCashJpy: 0,
      riskParams: baseRiskParams,
    });

    expect(plan.exits.ETH.closePct).toBe(50);
    expect(plan.exits.ETH.qtyToClose).toBeCloseTo(0.25);
    expect(plan.exits.ETH.expectedCashJpy).toBeCloseTo(124_375);
    expect(plan.currentPositions.ETH).toBeCloseTo(250_000);
    expect(plan.plannedPositions.ETH).toBeCloseTo(125_000);
  });

  it("Exit + Entry の合成: Entry size_pct 100% は currentCash ベース、Exit 見込みは含めない", () => {
    // max_budget = currentCash 100k × 0.25 = 25k (Exit の +300k は無視)
    const plan = buildExecutionPlan({
      signals: [
        signal({
          symbol: "SOL",
          lastPriceJpy: 30_000,
          takerFeeRate: 0,
          exit: { decision: "close", confidence: 0.8, closePct: 100 },
          openPosition: { quantity: 10, avgEntryPrice: 25_000 },
        }),
        signal({
          symbol: "BTC",
          lastPriceJpy: 15_000_000,
          entry: { decision: "buy", confidence: 1.0, sizePct: 100 },
        }),
      ],
      currentCashJpy: 100_000,
      riskParams: baseRiskParams,
    });

    expect(plan.projectedCashJpy).toBe(400_000);
    expect(plan.entries.BTC).toBe(25_000);
    expect(plan.plannedPositions.BTC).toBe(25_000);
    expect(plan.plannedPositions.SOL).toBeUndefined();
  });

  it("既存ポジションを hold (Exit 判断なし) → currentPositions と plannedPositions に同額", () => {
    const plan = buildExecutionPlan({
      signals: [
        signal({
          symbol: "ETH",
          lastPriceJpy: 500_000,
          openPosition: { quantity: 0.5, avgEntryPrice: 480_000 },
          exit: { decision: "hold", confidence: 0.5, closePct: 100 },
        }),
      ],
      currentCashJpy: 100_000,
      riskParams: baseRiskParams,
    });

    expect(plan.currentPositions.ETH).toBe(250_000);
    expect(plan.plannedPositions.ETH).toBe(250_000);
    expect(plan.exits).toEqual({});
  });

  it("lastPrice = 0 のとき avgEntryPrice で mtm を fallback", () => {
    const plan = buildExecutionPlan({
      signals: [
        signal({
          symbol: "ETH",
          lastPriceJpy: 0,
          openPosition: { quantity: 1, avgEntryPrice: 400_000 },
        }),
      ],
      currentCashJpy: 0,
      riskParams: baseRiskParams,
    });

    expect(plan.currentPositions.ETH).toBe(400_000);
    expect(plan.plannedPositions.ETH).toBe(400_000);
  });

  it("Entry 0 件 / Exit 0 件 → 全部空", () => {
    const plan = buildExecutionPlan({
      signals: [
        signal({
          symbol: "BTC",
          entry: { decision: "no", confidence: 0.3, sizePct: null },
        }),
      ],
      currentCashJpy: 100_000,
      riskParams: baseRiskParams,
    });
    expect(plan.exits).toEqual({});
    expect(plan.entries).toEqual({});
    expect(plan.currentPositions).toEqual({});
    expect(plan.plannedPositions).toEqual({});
    expect(plan.projectedCashJpy).toBe(100_000);
  });

  it("perCoinTotalMaxRatio 有効時: 既存込みで Clipper が更に削る", () => {
    const plan = buildExecutionPlan({
      signals: [
        signal({
          symbol: "ETH",
          lastPriceJpy: 400_000,
          openPosition: { quantity: 0.5, avgEntryPrice: 400_000 },
          entry: { decision: "buy", confidence: 1.0, sizePct: 100 },
          exit: { decision: "hold", confidence: 0.5, closePct: 100 },
        }),
      ],
      currentCashJpy: 100_000,
      riskParams: { perCoinMaxRatio: 0.5, perCoinTotalMaxRatio: 0.3 },
    });

    expect(plan.entries.ETH).toBeUndefined();
    expect(plan.clipperChanges.some((c) => c.reason.includes("per-coin total cap"))).toBe(true);
  });
});
