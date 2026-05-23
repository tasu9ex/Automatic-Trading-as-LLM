import { describe, expect, it } from "vitest";
import { allocate } from "./index";

describe("allocate (size_pct base)", () => {
  it("buySignals 空 → 空 proposal", () => {
    expect(allocate({ buySignals: [], maxBudgetJpy: 1_000_000 })).toEqual({});
  });

  it("maxBudgetJpy 0 → 空 proposal", () => {
    expect(allocate({ buySignals: [{ symbol: "BTC", sizePct: 100 }], maxBudgetJpy: 0 })).toEqual(
      {},
    );
  });

  it("size_pct=100 → maxBudgetJpy 全額", () => {
    const r = allocate({
      buySignals: [{ symbol: "BTC", sizePct: 100 }],
      maxBudgetJpy: 30_000,
    });
    expect(r.BTC).toBe(30_000);
  });

  it("size_pct=50 → 半分", () => {
    const r = allocate({
      buySignals: [{ symbol: "BTC", sizePct: 50 }],
      maxBudgetJpy: 30_000,
    });
    expect(r.BTC).toBe(15_000);
  });

  it("複数銘柄、各 size_pct を独立に適用 (合計が cash 超えうるが Clipper が処理)", () => {
    const r = allocate({
      buySignals: [
        { symbol: "BTC", sizePct: 80 },
        { symbol: "XRP", sizePct: 40 },
      ],
      maxBudgetJpy: 30_000,
    });
    expect(r.BTC).toBe(24_000);
    expect(r.XRP).toBe(12_000);
  });

  it("size_pct=0 → 提案から除外", () => {
    const r = allocate({
      buySignals: [{ symbol: "BTC", sizePct: 0 }],
      maxBudgetJpy: 30_000,
    });
    expect(r.BTC).toBeUndefined();
  });

  it("size_pct が 100 超過 → 100 にクランプ", () => {
    const r = allocate({
      buySignals: [{ symbol: "BTC", sizePct: 200 }],
      maxBudgetJpy: 30_000,
    });
    expect(r.BTC).toBe(30_000);
  });

  it("size_pct が負値 → 0 にクランプして除外", () => {
    const r = allocate({
      buySignals: [{ symbol: "BTC", sizePct: -10 }],
      maxBudgetJpy: 30_000,
    });
    expect(r.BTC).toBeUndefined();
  });

  it("floor で切り捨て", () => {
    // 33_333 × 33 / 100 = 10999.89 → floor 10999
    const r = allocate({
      buySignals: [{ symbol: "BTC", sizePct: 33 }],
      maxBudgetJpy: 33_333,
    });
    expect(r.BTC).toBe(10_999);
  });
});
