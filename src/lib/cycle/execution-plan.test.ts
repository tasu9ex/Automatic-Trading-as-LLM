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
  it("既存ポジションなし・Entry 2 件 → cap で clip される", () => {
    const plan = buildExecutionPlan({
      signals: [
        signal({ symbol: "BTC", entry: { decision: "buy", confidence: 0.5 } }),
        signal({ symbol: "XRP", entry: { decision: "buy", confidence: 0.5 } }),
      ],
      currentCashJpy: 500_000,
      method: "confidence",
      riskParams: baseRiskParams,
    });

    // 各 ¥250,000 ideal だが cash × 0.25 = ¥125,000 で頭打ち
    expect(plan.entries.BTC).toBe(125_000);
    expect(plan.entries.XRP).toBe(125_000);
    expect(plan.projectedCashJpy).toBe(500_000);
    expect(plan.exits).toEqual({});
    expect(plan.currentPositions).toEqual({});
    expect(plan.plannedPositions).toEqual({ BTC: 125_000, XRP: 125_000 });
    expect(plan.clipperChanges.length).toBeGreaterThan(0);
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
      method: "confidence",
      riskParams: baseRiskParams,
    });

    expect(plan.exits.SOL.closePct).toBe(100);
    expect(plan.exits.SOL.qtyToClose).toBe(1);
    // 30_000 × 1 × (1 - 0.005) = 29_850
    expect(plan.exits.SOL.expectedCashJpy).toBeCloseTo(29_850);
    expect(plan.projectedCashJpy).toBeCloseTo(129_850);
    expect(plan.currentPositions.SOL).toBe(30_000);
    // 全部閉じたので planned からは消える
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
      method: "confidence",
      riskParams: baseRiskParams,
    });

    expect(plan.exits.ETH.closePct).toBe(50);
    expect(plan.exits.ETH.qtyToClose).toBeCloseTo(0.25);
    // 500_000 × 0.25 × (1 - 0.005) = 124_375
    expect(plan.exits.ETH.expectedCashJpy).toBeCloseTo(124_375);
    expect(plan.currentPositions.ETH).toBeCloseTo(250_000);
    // 残量 0.25 × 500_000 = 125_000
    expect(plan.plannedPositions.ETH).toBeCloseTo(125_000);
  });

  it("Exit + Entry の合成: Exit で増えた cash が Entry の base になる", () => {
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
          entry: { decision: "buy", confidence: 1.0 },
        }),
      ],
      currentCashJpy: 100_000,
      method: "confidence",
      riskParams: baseRiskParams,
    });

    // SOL exit: 10 × 30_000 = 300_000
    expect(plan.projectedCashJpy).toBe(400_000);
    // BTC 単独 buy: ideal = 400_000、cap = 400_000 × 0.25 = 100_000
    expect(plan.entries.BTC).toBe(100_000);
    expect(plan.plannedPositions.BTC).toBe(100_000);
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
      method: "confidence",
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
      method: "confidence",
      riskParams: baseRiskParams,
    });

    expect(plan.currentPositions.ETH).toBe(400_000);
    expect(plan.plannedPositions.ETH).toBe(400_000);
  });

  it("Entry 0 件 / Exit 0 件 → 全部空", () => {
    const plan = buildExecutionPlan({
      signals: [signal({ symbol: "BTC", entry: { decision: "no", confidence: 0.3 } })],
      currentCashJpy: 100_000,
      method: "confidence",
      riskParams: baseRiskParams,
    });
    expect(plan.exits).toEqual({});
    expect(plan.entries).toEqual({});
    expect(plan.currentPositions).toEqual({});
    expect(plan.plannedPositions).toEqual({});
    expect(plan.projectedCashJpy).toBe(100_000);
  });

  it("perCoinTotalMaxRatio 有効時: 既存込みで Clipper が更に削る", () => {
    // ETH 既存 200k、Entry ETH 100k 追加 → total cap = equity × 0.3
    // projectedCash = 100k, postExitInvested = 200k, equity = 300k
    // cap = 300k × 0.3 = 90k → 既存 200k で既に超え → headroom 0 → drop
    const plan = buildExecutionPlan({
      signals: [
        signal({
          symbol: "ETH",
          lastPriceJpy: 400_000,
          openPosition: { quantity: 0.5, avgEntryPrice: 400_000 },
          entry: { decision: "buy", confidence: 1.0 },
          exit: { decision: "hold", confidence: 0.5, closePct: 100 },
        }),
      ],
      currentCashJpy: 100_000,
      method: "confidence",
      riskParams: { perCoinMaxRatio: 0.5, perCoinTotalMaxRatio: 0.3 },
    });

    expect(plan.entries.ETH).toBeUndefined();
    expect(plan.clipperChanges.some((c) => c.reason.includes("per-coin total cap"))).toBe(true);
  });
});
