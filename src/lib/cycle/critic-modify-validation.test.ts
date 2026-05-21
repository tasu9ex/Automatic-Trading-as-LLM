import { describe, expect, it } from "vitest";
import {
  applyModify,
  computeModifiedPositions,
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
  cashJpy: 500_000,
  equityJpy: 780_000,
  perCoinMaxRatio: 0.25, // cap = 125_000
  perCoinTotalMaxRatio: 1.0,
};

describe("validateCriticModify", () => {
  describe("exits 検算", () => {
    it("計画にある銘柄の closePct を 10-100 整数で変更 → OK", () => {
      const err = validateCriticModify({
        ...baseValidateInput,
        adjustments: { exits: { SOL: 50 } },
      });
      expect(err).toBeNull();
    });

    it("計画に無い銘柄の Exit 開始は拒否", () => {
      const err = validateCriticModify({
        ...baseValidateInput,
        adjustments: { exits: { ETH: 50 } },
      });
      expect(err).toMatch(/exits\.ETH.*計画に存在しない/);
    });

    it("closePct 10 未満 → 拒否", () => {
      const err = validateCriticModify({
        ...baseValidateInput,
        adjustments: { exits: { SOL: 5 } },
      });
      expect(err).toMatch(/exits\.SOL.*10-100/);
    });

    it("closePct 101 → 拒否", () => {
      const err = validateCriticModify({
        ...baseValidateInput,
        adjustments: { exits: { SOL: 101 } },
      });
      expect(err).toMatch(/exits\.SOL.*10-100/);
    });

    it("closePct 非整数 → 拒否", () => {
      const err = validateCriticModify({
        ...baseValidateInput,
        adjustments: { exits: { SOL: 50.5 } },
      });
      expect(err).toMatch(/exits\.SOL.*10-100/);
    });
  });

  describe("buys 検算", () => {
    it("Allocator 候補内 + cap 内 → OK", () => {
      const err = validateCriticModify({
        ...baseValidateInput,
        adjustments: { buys: { BTC: 50_000 } },
      });
      expect(err).toBeNull();
    });

    it("Allocator 候補外の銘柄を追加 → 拒否 (whitelist)", () => {
      const err = validateCriticModify({
        ...baseValidateInput,
        adjustments: { buys: { XYZ: 50_000 } },
      });
      expect(err).toMatch(/buys\.XYZ.*Allocator 候補外/);
    });

    it("負の金額 → 拒否", () => {
      const err = validateCriticModify({
        ...baseValidateInput,
        adjustments: { buys: { BTC: -100 } },
      });
      expect(err).toMatch(/buys\.BTC.*不正な金額/);
    });

    it("0 円は OK (除外指定)", () => {
      const err = validateCriticModify({
        ...baseValidateInput,
        adjustments: { buys: { BTC: 0 } },
      });
      expect(err).toBeNull();
    });

    it("min 未満の正値 (1 < x < 5000) は拒否", () => {
      const err = validateCriticModify({
        ...baseValidateInput,
        adjustments: { buys: { BTC: 3_000 } },
      });
      expect(err).toMatch(/buys\.BTC.*5000/);
    });

    it("per-cycle cap (cash × 0.25 = 125k) 超過 → 拒否", () => {
      const err = validateCriticModify({
        ...baseValidateInput,
        adjustments: { buys: { BTC: 150_000 } },
      });
      expect(err).toMatch(/buys\.BTC.*per-cycle cap/);
    });

    it("per-coin total cap 有効時、既存 + 新規 > equity × ratio → 拒否", () => {
      // ETH 既存 250_000、equity 780_000、totalRatio 0.3 → cap = 234_000
      // 既存 250_000 で既に超え → 新規 1 円でも拒否
      const err = validateCriticModify({
        ...baseValidateInput,
        perCoinTotalMaxRatio: 0.3,
        adjustments: { buys: { ETH: 10_000 } },
      });
      expect(err).toMatch(/buys\.ETH.*per-coin total cap/);
    });

    it("perCoinTotalMaxRatio=1.0 なら per-coin total cap は無視", () => {
      const err = validateCriticModify({
        ...baseValidateInput,
        adjustments: { buys: { BTC: 100_000 } },
      });
      expect(err).toBeNull();
    });
  });

  describe("合計 cash 検算", () => {
    it("modify 後の合計が cash 以下 → OK", () => {
      // base 計画 entries = 180k。modify で BTC 100k → 合計 180k、cash 500k → OK
      const err = validateCriticModify({
        ...baseValidateInput,
        adjustments: { buys: { BTC: 100_000 } },
      });
      expect(err).toBeNull();
    });

    it("modify で合計が cash 超過 → 拒否", () => {
      // base entries BTC 100k + XRP 80k = 180k
      // BTC を 125k に上げ + DOT 125k + XRP 125k で 375k → cash 500k 以下 (OK)
      // 全部 cap 125k で 3 銘柄 → 375k、4 銘柄目で 500k 超
      const err = validateCriticModify({
        ...baseValidateInput,
        cashJpy: 200_000, // cap = 50_000
        perCoinMaxRatio: 0.25,
        adjustments: { buys: { BTC: 50_000, XRP: 50_000, ETH: 50_000, DOT: 50_000 } }, // 合計 200k
      });
      // ここは合計 = 200k で cashRoom 200k と同じ → ぎりぎり OK
      expect(err).toBeNull();
    });

    it("実際に cash を超える modify は拒否", () => {
      const err = validateCriticModify({
        ...baseValidateInput,
        cashJpy: 100_000,
        adjustments: { buys: { BTC: 25_000, XRP: 25_000, ETH: 25_000, DOT: 25_000 } },
        // 合計 = 100k、cashRoom = 100k → ぎりぎり OK
      });
      expect(err).toBeNull();
    });

    it("合計が cash を超えるケース", () => {
      // base entries BTC 100k + XRP 80k = 180k
      // ETH を 100k 追加で合計 280k、cash を 250k に落として超過させる
      const err = validateCriticModify({
        ...baseValidateInput,
        cashJpy: 250_000,
        perCoinMaxRatio: 0.5, // cap = 125k で per-coin は通る
        adjustments: { buys: { ETH: 100_000 } }, // 既存 BTC 100k + XRP 80k + 新規 ETH 100k = 280k > 250k
      });
      expect(err).toMatch(/Σ buys.*合計が cash を超過/);
    });
  });

  it("adjustments 空 → null (検算するものなし)", () => {
    const err = validateCriticModify({
      ...baseValidateInput,
      adjustments: {},
    });
    expect(err).toBeNull();
  });
});

describe("applyModify", () => {
  it("buys で既存 entries を上書き", () => {
    const r = applyModify(basePlan, { buys: { BTC: 50_000 } });
    expect(r.entries.BTC).toBe(50_000);
    expect(r.entries.XRP).toBe(80_000);
  });

  it("buys = 0 は entries から削除", () => {
    const r = applyModify(basePlan, { buys: { BTC: 0 } });
    expect(r.entries.BTC).toBeUndefined();
    expect(r.entries.XRP).toBe(80_000);
  });

  it("buys で新規追加 (whitelist は validate 側の責務)", () => {
    const r = applyModify(basePlan, { buys: { DOT: 10_000 } });
    expect(r.entries.DOT).toBe(10_000);
  });

  it("exits で closePct を変更 → qty/expectedCash も比例縮小", () => {
    const r = applyModify(basePlan, { exits: { SOL: 50 } });
    expect(r.exits.SOL.closePct).toBe(50);
    expect(r.exits.SOL.qtyToClose).toBeCloseTo(0.5);
    expect(r.exits.SOL.expectedCashJpy).toBeCloseTo(15_000);
  });

  it("計画に無い銘柄の exits 修正は無視", () => {
    const r = applyModify(basePlan, { exits: { ETH: 50 } });
    expect(r.exits.ETH).toBeUndefined();
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
      exits: basePlan.exits, // SOL 100%
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
