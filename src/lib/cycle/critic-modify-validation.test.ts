import { describe, expect, it } from "vitest";
import {
  applyModify,
  computeModifiedPositions,
  isSamePlan,
  validateCriticModify,
} from "./critic-modify-validation";
import type { ExecutionPlan } from "./execution-plan";

const basePlan: ExecutionPlan = {
  exits: {
    SOL: { closePct: 100, qtyToClose: 1, expectedCashJpy: 30_000 },
  },
  entries: { BTC: 100_000, XRP: 80_000 },
  projectedCashJpy: 500_000,
  currentPositions: { ETH: 250_000, SOL: 30_000 },
  plannedPositions: { ETH: 250_000, BTC: 100_000, XRP: 80_000 },
  clipperChanges: [],
};

const baseValidateInput = {
  plan: basePlan,
  buyCandidates: new Set(["BTC", "XRP", "ETH", "DOT"]),
};

describe("validateCriticModify (pct-based)", () => {
  it("Allocator 候補内の銘柄に size_pct 上書き → OK", () => {
    expect(
      validateCriticModify({ ...baseValidateInput, adjustments: { buys: { BTC: 50 } } }),
    ).toBeNull();
  });

  it("Allocator 候補外の銘柄追加 → 拒否 (whitelist)", () => {
    const err = validateCriticModify({
      ...baseValidateInput,
      adjustments: { buys: { XYZ: 50 } },
    });
    expect(err).toMatch(/buys\.XYZ.*Allocator 候補外/);
  });

  it("計画に存在する exits の close_pct 上書き → OK", () => {
    expect(
      validateCriticModify({ ...baseValidateInput, adjustments: { exits: { SOL: 50 } } }),
    ).toBeNull();
  });

  it("計画に無い銘柄の Exit 開始 → 拒否", () => {
    const err = validateCriticModify({
      ...baseValidateInput,
      adjustments: { exits: { ETH: 50 } },
    });
    expect(err).toMatch(/exits\.ETH.*計画に存在しない/);
  });

  it("buys=0 (除外指定) も whitelist 内なら OK", () => {
    expect(
      validateCriticModify({ ...baseValidateInput, adjustments: { buys: { BTC: 0 } } }),
    ).toBeNull();
  });

  it("adjustments 空 → null", () => {
    expect(validateCriticModify({ ...baseValidateInput, adjustments: {} })).toBeNull();
  });
});

const MAX_BUDGET = 30_000;

describe("applyModify (pct → JPY 変換)", () => {
  it("buys pct で entries を上書き", () => {
    // 100% → max_budget 全額
    const r = applyModify(basePlan, { buys: { BTC: 100 } }, MAX_BUDGET);
    expect(r.entries.BTC).toBe(30_000);
    expect(r.entries.XRP).toBe(80_000);
  });

  it("buys = 50% → max_budget の半分", () => {
    const r = applyModify(basePlan, { buys: { BTC: 50 } }, MAX_BUDGET);
    expect(r.entries.BTC).toBe(15_000);
  });

  it("buys = 0 → entries から削除", () => {
    const r = applyModify(basePlan, { buys: { BTC: 0 } }, MAX_BUDGET);
    expect(r.entries.BTC).toBeUndefined();
    expect(r.entries.XRP).toBe(80_000);
  });

  it("buys = 100 超は 100 にクランプ", () => {
    const r = applyModify(basePlan, { buys: { BTC: 200 } }, MAX_BUDGET);
    expect(r.entries.BTC).toBe(30_000);
  });

  it("buys = 負値 → 0 扱いで削除", () => {
    const r = applyModify(basePlan, { buys: { BTC: -10 } }, MAX_BUDGET);
    expect(r.entries.BTC).toBeUndefined();
  });

  it("exits で closePct を変更 → qty/expectedCash も比例縮小", () => {
    const r = applyModify(basePlan, { exits: { SOL: 50 } }, MAX_BUDGET);
    expect(r.exits.SOL.closePct).toBe(50);
    expect(r.exits.SOL.qtyToClose).toBeCloseTo(0.5);
    expect(r.exits.SOL.expectedCashJpy).toBeCloseTo(15_000);
  });

  it("計画に無い銘柄の exits 修正は無視", () => {
    const r = applyModify(basePlan, { exits: { ETH: 50 } }, MAX_BUDGET);
    expect(r.exits.ETH).toBeUndefined();
  });

  it("exits = 0 → 個別 Exit キャンセル (plan から削除)", () => {
    const r = applyModify(basePlan, { exits: { SOL: 0 } }, MAX_BUDGET);
    expect(r.exits.SOL).toBeUndefined();
  });
});

describe("isSamePlan (no-op modify 判定)", () => {
  it("空 adjustments → applyModify 結果は計画と同一 (no-op)", () => {
    const final = applyModify(basePlan, { buys: {}, exits: {} }, MAX_BUDGET);
    expect(isSamePlan(basePlan, final)).toBe(true);
  });

  it("identity adjustments (既存と同じ closePct) → no-op", () => {
    // SOL は元々 closePct=100。100 を再指定しても比例縮小 ratio=1 で同一。
    const final = applyModify(basePlan, { exits: { SOL: 100 } }, MAX_BUDGET);
    expect(isSamePlan(basePlan, final)).toBe(true);
  });

  it("entries を変える adjustments → 同一でない", () => {
    const final = applyModify(basePlan, { buys: { BTC: 50 } }, MAX_BUDGET);
    expect(isSamePlan(basePlan, final)).toBe(false);
  });

  it("exits を部分決済に変える → 同一でない", () => {
    const final = applyModify(basePlan, { exits: { SOL: 50 } }, MAX_BUDGET);
    expect(isSamePlan(basePlan, final)).toBe(false);
  });

  it("Exit キャンセル (exits=0) → 同一でない", () => {
    const final = applyModify(basePlan, { exits: { SOL: 0 } }, MAX_BUDGET);
    expect(isSamePlan(basePlan, final)).toBe(false);
  });
});

describe("computeModifiedPositions", () => {
  it("Exit なし → 現在 mtm そのまま + 新規 Entry 加算", () => {
    const r = computeModifiedPositions(basePlan, {
      entries: { BTC: 100_000 },
      exits: {},
    });
    expect(r.ETH).toBe(250_000);
    expect(r.SOL).toBe(30_000);
    expect(r.BTC).toBe(100_000);
  });

  it("100% Exit は対象銘柄を消す", () => {
    const r = computeModifiedPositions(basePlan, {
      entries: {},
      exits: basePlan.exits,
    });
    expect(r.SOL).toBeUndefined();
    expect(r.ETH).toBe(250_000);
  });

  it("50% Exit は半分残す", () => {
    const r = computeModifiedPositions(basePlan, {
      entries: {},
      exits: { SOL: { closePct: 50, qtyToClose: 0.5, expectedCashJpy: 15_000 } },
    });
    expect(r.SOL).toBe(15_000);
  });

  it("既存銘柄に新規 Entry を加算", () => {
    const r = computeModifiedPositions(basePlan, {
      entries: { ETH: 50_000 },
      exits: {},
    });
    expect(r.ETH).toBe(300_000);
  });
});
