import { describe, expect, it } from "vitest";
import { allocate } from "./index";

describe("allocate", () => {
  describe("空入力", () => {
    it("buySignals 空 → 空 proposal", () => {
      const r = allocate({
        buySignals: [],
        availableCashJpy: 1_000_000,
        maxAllocationRatio: 1.0,
        method: "equal",
      });
      expect(r).toEqual({});
    });

    it("confidence 合計が 0 (全銘柄 confidence=0) → 空 proposal", () => {
      const r = allocate({
        buySignals: [
          { symbol: "BTC", confidence: 0 },
          { symbol: "XRP", confidence: 0 },
        ],
        availableCashJpy: 1_000_000,
        maxAllocationRatio: 1.0,
        method: "confidence",
      });
      expect(r).toEqual({});
    });
  });

  describe("equal weight", () => {
    it("2 銘柄に半分ずつ", () => {
      const r = allocate({
        buySignals: [
          { symbol: "BTC", confidence: 0.5 },
          { symbol: "XRP", confidence: 0.9 },
        ],
        availableCashJpy: 1_000_000,
        maxAllocationRatio: 1.0,
        method: "equal",
      });
      expect(r.BTC).toBe(500_000);
      expect(r.XRP).toBe(500_000);
    });

    it("3 銘柄に三等分 (floor)", () => {
      const r = allocate({
        buySignals: [
          { symbol: "BTC", confidence: 0.5 },
          { symbol: "XRP", confidence: 0.5 },
          { symbol: "ETH", confidence: 0.5 },
        ],
        availableCashJpy: 1_000_000,
        maxAllocationRatio: 1.0,
        method: "equal",
      });
      // 1_000_000 / 3 = 333_333.33... → floor 333_333
      expect(r.BTC).toBe(333_333);
      expect(r.XRP).toBe(333_333);
      expect(r.ETH).toBe(333_333);
    });

    it("equal モードは confidence を無視 (全銘柄同額)", () => {
      const r = allocate({
        buySignals: [
          { symbol: "BTC", confidence: 0.1 },
          { symbol: "XRP", confidence: 0.99 },
        ],
        availableCashJpy: 100_000,
        maxAllocationRatio: 1.0,
        method: "equal",
      });
      expect(r.BTC).toBe(r.XRP);
    });
  });

  describe("confidence weighted", () => {
    it("confidence 比に応じて配分", () => {
      // 0.6 vs 0.4 → 60:40
      const r = allocate({
        buySignals: [
          { symbol: "BTC", confidence: 0.6 },
          { symbol: "XRP", confidence: 0.4 },
        ],
        availableCashJpy: 1_000_000,
        maxAllocationRatio: 1.0,
        method: "confidence",
      });
      expect(r.BTC).toBe(600_000);
      expect(r.XRP).toBe(400_000);
    });

    it("confidence が等しいなら equal と同じ結果", () => {
      const r = allocate({
        buySignals: [
          { symbol: "BTC", confidence: 0.7 },
          { symbol: "XRP", confidence: 0.7 },
        ],
        availableCashJpy: 1_000_000,
        maxAllocationRatio: 1.0,
        method: "confidence",
      });
      expect(r.BTC).toBe(500_000);
      expect(r.XRP).toBe(500_000);
    });
  });

  describe("maxAllocationRatio", () => {
    it("ratio 0.5 → cash の半分を配分", () => {
      const r = allocate({
        buySignals: [{ symbol: "BTC", confidence: 1.0 }],
        availableCashJpy: 1_000_000,
        maxAllocationRatio: 0.5,
        method: "equal",
      });
      expect(r.BTC).toBe(500_000);
    });

    it("ratio 0 → 全銘柄 0 (proposal から除外)", () => {
      const r = allocate({
        buySignals: [{ symbol: "BTC", confidence: 1.0 }],
        availableCashJpy: 1_000_000,
        maxAllocationRatio: 0,
        method: "equal",
      });
      expect(r.BTC).toBeUndefined();
    });
  });

  describe("cash 0", () => {
    it("availableCashJpy = 0 → 空", () => {
      const r = allocate({
        buySignals: [{ symbol: "BTC", confidence: 0.5 }],
        availableCashJpy: 0,
        maxAllocationRatio: 1.0,
        method: "equal",
      });
      expect(r.BTC).toBeUndefined();
    });
  });
});
