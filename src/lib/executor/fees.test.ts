import { describe, expect, it } from "vitest";
import { calculateFill } from "./fees";

describe("calculateFill", () => {
  describe("buy", () => {
    it("手数料は支払いに加算 (netCash > quoteAmount)", () => {
      const r = calculateFill({
        side: "buy",
        marketPrice: 100,
        quoteAmountJpy: 10_000,
        takerFeeRate: 0.001,
      });
      expect(r.feeJpy).toBe(10);
      expect(r.netCashJpy).toBe(10_010);
      expect(r.executedPrice).toBe(100);
      expect(r.quantity).toBe(100);
      expect(r.slippageJpy).toBe(0);
    });

    it("slippage 反映 (buy で価格が上がる)", () => {
      const r = calculateFill({
        side: "buy",
        marketPrice: 100,
        quoteAmountJpy: 10_000,
        takerFeeRate: 0,
        slippageRate: 0.003,
      });
      expect(r.executedPrice).toBeCloseTo(100.3);
      expect(r.slippageJpy).toBe(30);
      // quantity は executedPrice ベース
      expect(r.quantity).toBeCloseTo(10_000 / 100.3);
    });

    it("slippage + 手数料の独立性", () => {
      const r = calculateFill({
        side: "buy",
        marketPrice: 100,
        quoteAmountJpy: 10_000,
        takerFeeRate: 0.005,
        slippageRate: 0.003,
      });
      expect(r.feeJpy).toBe(50);
      expect(r.slippageJpy).toBe(30);
      // netCash は fee のみ加算 (slippage は executedPrice に既に織り込まれている)
      expect(r.netCashJpy).toBe(10_050);
    });
  });

  describe("sell", () => {
    it("手数料は受領から控除 (netCash < quoteAmount)", () => {
      const r = calculateFill({
        side: "sell",
        marketPrice: 100,
        quoteAmountJpy: 10_000,
        takerFeeRate: 0.001,
      });
      expect(r.feeJpy).toBe(10);
      expect(r.netCashJpy).toBe(9_990);
      expect(r.executedPrice).toBe(100);
      expect(r.quantity).toBe(100);
    });

    it("slippage 反映 (sell で価格が下がる)", () => {
      const r = calculateFill({
        side: "sell",
        marketPrice: 100,
        quoteAmountJpy: 10_000,
        takerFeeRate: 0,
        slippageRate: 0.003,
      });
      expect(r.executedPrice).toBeCloseTo(99.7);
      expect(r.slippageJpy).toBe(30);
      expect(r.quantity).toBeCloseTo(10_000 / 99.7);
    });

    it("slippage + 手数料の独立性 (sell)", () => {
      const r = calculateFill({
        side: "sell",
        marketPrice: 100,
        quoteAmountJpy: 10_000,
        takerFeeRate: 0.005,
        slippageRate: 0.003,
      });
      expect(r.feeJpy).toBe(50);
      expect(r.slippageJpy).toBe(30);
      expect(r.netCashJpy).toBe(9_950);
    });
  });

  describe("slippage 未指定 = 0", () => {
    it("slippageRate 省略時はスリッページなし", () => {
      const r = calculateFill({
        side: "buy",
        marketPrice: 100,
        quoteAmountJpy: 10_000,
        takerFeeRate: 0.001,
      });
      expect(r.slippageJpy).toBe(0);
      expect(r.executedPrice).toBe(100);
    });
  });

  describe("手数料 0 / quote 0 の境界", () => {
    it("takerFeeRate = 0 → fee 0、netCash = quote", () => {
      const r = calculateFill({
        side: "buy",
        marketPrice: 100,
        quoteAmountJpy: 10_000,
        takerFeeRate: 0,
      });
      expect(r.feeJpy).toBe(0);
      expect(r.netCashJpy).toBe(10_000);
    });
  });
});
