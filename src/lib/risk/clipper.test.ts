import { describe, expect, it } from "vitest";
import { applyRiskClipper } from "./clipper";

describe("applyRiskClipper", () => {
  const baseInput = {
    availableCashJpy: 1_000_000,
    currentInvestedJpy: 0,
    perCoinMaxRatio: 0.25, // 段 1: per-cycle 25%
    perCoinMinJpy: 5_000,
    totalMaxRatio: 1.0,
  };

  describe("段 1 (per-cycle buy cap)", () => {
    it("cap 内ならそのまま通る", () => {
      const r = applyRiskClipper({ ...baseInput, proposal: { BTC: 200_000 } });
      expect(r.proposal.BTC).toBe(200_000);
    });

    it("cap 超過は floor(cap) に切り詰め", () => {
      const r = applyRiskClipper({ ...baseInput, proposal: { BTC: 400_000 } });
      expect(r.proposal.BTC).toBe(250_000);
      expect(r.changes.some((c) => c.reason === "per-cycle buy cap")).toBe(true);
    });

    it("min 未満は skip", () => {
      const r = applyRiskClipper({ ...baseInput, proposal: { BTC: 3_000 } });
      expect(r.proposal.BTC).toBeUndefined();
    });
  });

  describe("段 2 (per-coin total cap, equity base)", () => {
    it("default 1.0 は既存挙動互換 (段 2 を無視)", () => {
      const r = applyRiskClipper({
        ...baseInput,
        proposal: { BTC: 200_000 },
        existingExposureBySymbol: { BTC: 300_000 },
        equityJpy: 1_300_000,
        // perCoinTotalMaxRatio 省略 → 1.0
      });
      // 段 1 のみで cap (250_000) → 200_000 < 250_000 なのでそのまま
      expect(r.proposal.BTC).toBe(200_000);
    });

    it("ピラミ累積で per-coin total cap に当たる", () => {
      // equity 100 万、BTC 既に 20 万、追加 buy 25 万を提案
      // per-coin total cap = 100 万 × 0.30 = 30 万 → headroom = 10 万
      const r = applyRiskClipper({
        ...baseInput,
        proposal: { BTC: 250_000 },
        existingExposureBySymbol: { BTC: 200_000 },
        equityJpy: 1_000_000,
        perCoinTotalMaxRatio: 0.3,
      });
      expect(r.proposal.BTC).toBe(100_000); // = headroom
      expect(r.changes.some((c) => c.reason === "per-coin total cap")).toBe(true);
    });

    it("既存が cap に達している銘柄は新規 buy 不可", () => {
      // BTC 既に 30 万、cap 30 万 → headroom 0 → 提案 5 万 は below min で skip
      const r = applyRiskClipper({
        ...baseInput,
        proposal: { BTC: 50_000 },
        existingExposureBySymbol: { BTC: 300_000 },
        equityJpy: 1_000_000,
        perCoinTotalMaxRatio: 0.3,
      });
      expect(r.proposal.BTC).toBeUndefined();
      expect(
        r.changes.some((c) => c.symbol === "BTC" && c.reason.startsWith("per-coin total cap")),
      ).toBe(true);
    });

    it("段 1 と段 2 の両方が効く: より厳しい方が勝つ", () => {
      // cycle cap 25 万、total cap (30%) で既存 25 万 → headroom 5 万
      // → 段 2 が支配的
      const r = applyRiskClipper({
        ...baseInput,
        proposal: { BTC: 200_000 },
        existingExposureBySymbol: { BTC: 250_000 },
        equityJpy: 1_000_000,
        perCoinTotalMaxRatio: 0.3,
      });
      expect(r.proposal.BTC).toBe(50_000);
    });
  });

  describe("段 3 (portfolio total cap)", () => {
    it("合計が total cap を超えると比例縮小", () => {
      const r = applyRiskClipper({
        ...baseInput,
        availableCashJpy: 1_000_000,
        totalMaxRatio: 0.5, // 50 万まで
        proposal: { BTC: 200_000, ETH: 200_000, XRP: 200_000 },
      });
      const sum = Object.values(r.proposal).reduce((s, v) => s + v, 0);
      expect(sum).toBeLessThanOrEqual(500_000);
    });
  });
});
