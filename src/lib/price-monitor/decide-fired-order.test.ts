import { describe, expect, it } from "vitest";
import { type Bar, decideFiredOrder } from "./decide";

function bar(low: number, high: number, openTime = 0): Bar {
  return { openTime, low, high, close: (low + high) / 2 };
}

describe("decideFiredOrder", () => {
  describe("空入力", () => {
    it("triggered 空 → null", () => {
      expect(decideFiredOrder([], [bar(100, 110)], 100)).toBeNull();
    });
  });

  describe("stop_limit_primary", () => {
    it("trigger 到達 + 同 bar 以降に limit 到達 → 約定 (forced=false)", () => {
      const r = decideFiredOrder(
        [{ kind: "stop_limit_primary", triggerPrice: "95", limitPrice: "96" }],
        [bar(90, 95.5), bar(95.5, 96.5)],
        90,
      );
      expect(r).toEqual({ kind: "stop_limit_primary", marketPrice: 96, forced: false });
    });

    it("trigger 到達するも limit 未到達 → null (約定不発)", () => {
      const r = decideFiredOrder(
        [{ kind: "stop_limit_primary", triggerPrice: "95", limitPrice: "96" }],
        [bar(90, 95.5), bar(94, 95.5)],
        90,
      );
      expect(r).toBeNull();
    });

    it("trigger 未到達 → null", () => {
      const r = decideFiredOrder(
        [{ kind: "stop_limit_primary", triggerPrice: "90", limitPrice: "92" }],
        [bar(100, 110), bar(95, 105)],
        95,
      );
      expect(r).toBeNull();
    });

    it("limit 未設定 (null) → 不発", () => {
      const r = decideFiredOrder(
        [{ kind: "stop_limit_primary", triggerPrice: "95", limitPrice: null }],
        [bar(90, 100)],
        90,
      );
      expect(r).toBeNull();
    });
  });

  describe("stop_market_entry", () => {
    it("recentLow が trigger 以下 → 約定 (forced=true)", () => {
      const r = decideFiredOrder(
        [{ kind: "stop_market_entry", triggerPrice: "90", limitPrice: null }],
        [bar(85, 95)],
        85,
      );
      expect(r).toEqual({ kind: "stop_market_entry", marketPrice: 90, forced: true });
    });

    it("recentLow が trigger より上 → 不発", () => {
      const r = decideFiredOrder(
        [{ kind: "stop_market_entry", triggerPrice: "90", limitPrice: null }],
        [bar(95, 100)],
        95,
      );
      expect(r).toBeNull();
    });
  });

  describe("stop_market_peak", () => {
    it("recentLow が trigger 以下 → 約定 (forced=true)", () => {
      const r = decideFiredOrder(
        [{ kind: "stop_market_peak", triggerPrice: "80", limitPrice: null }],
        [bar(75, 85)],
        75,
      );
      expect(r).toEqual({ kind: "stop_market_peak", marketPrice: 80, forced: true });
    });

    it("recentLow が trigger より上 → 不発", () => {
      const r = decideFiredOrder(
        [{ kind: "stop_market_peak", triggerPrice: "80", limitPrice: null }],
        [bar(85, 95)],
        85,
      );
      expect(r).toBeNull();
    });
  });

  describe("優先順位", () => {
    it("stop_limit_primary が約定可能なら他より優先", () => {
      const r = decideFiredOrder(
        [
          { kind: "stop_limit_primary", triggerPrice: "95", limitPrice: "96" },
          { kind: "stop_market_entry", triggerPrice: "90", limitPrice: null },
          { kind: "stop_market_peak", triggerPrice: "85", limitPrice: null },
        ],
        [bar(80, 96.5)],
        80,
      );
      expect(r?.kind).toBe("stop_limit_primary");
    });

    it("stop_limit_primary 不発時は stop_market_entry を優先", () => {
      const r = decideFiredOrder(
        [
          { kind: "stop_limit_primary", triggerPrice: "95", limitPrice: "100" }, // limit 未達
          { kind: "stop_market_entry", triggerPrice: "90", limitPrice: null },
          { kind: "stop_market_peak", triggerPrice: "85", limitPrice: null },
        ],
        [bar(80, 96)], // limit 100 まで届かない
        80,
      );
      expect(r?.kind).toBe("stop_market_entry");
    });

    it("stop_market_entry も不発なら stop_market_peak", () => {
      const r = decideFiredOrder(
        [
          { kind: "stop_market_entry", triggerPrice: "70", limitPrice: null }, // recentLow 80 > 70
          { kind: "stop_market_peak", triggerPrice: "85", limitPrice: null },
        ],
        [bar(80, 90)],
        80,
      );
      expect(r?.kind).toBe("stop_market_peak");
    });
  });
});
