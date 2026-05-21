import type { AllocationProposal } from "@/lib/schemas/llm-outputs";

export interface RiskClipperInput {
  proposal: AllocationProposal;
  availableCashJpy: number;
  currentInvestedJpy: number;
  /**
   * symbol 別の既存エクスポージャ (mark-to-market)。
   * per-coin total cap 計算のため必須。0 / 未保有銘柄は省略可。
   */
  existingExposureBySymbol?: Record<string, number>;
  /**
   * ポートフォリオ全体の equity (= cash + Σ positions の mtm)。
   * per-coin total cap の base 値。
   */
  equityJpy?: number;
  /** 段 1: 1 サイクル新規 buy 上限 (cash × X)。1 トランザクション粒度のガード */
  perCoinMaxRatio: number;
  /** per-coin 最小発注額 (この値未満は skip) */
  perCoinMinJpy: number;
  /** portfolio 総投資率上限 */
  totalMaxRatio: number;
  /**
   * 段 2: per-coin 総エクスポージャ上限 (equity × X)。
   * 既存 + 新規 がこの cap を超えないようにする。1.0 で「制限なし」(現状挙動互換)。
   */
  perCoinTotalMaxRatio?: number;
}

export interface ClippedProposal {
  proposal: AllocationProposal;
  /** 削除/減額された変更ログ */
  changes: Array<{ symbol: string; reason: string; from: number; to: number }>;
}

/**
 * Allocator 出力をハードガードでクリップ。
 *
 * 二段リスクモデル:
 *   段 1 (per-cycle buy cap, cash base):  1 トランザクションあたり cash × `perCoinMaxRatio` まで
 *   段 2 (per-coin total cap, equity base): 既存 + 新規が equity × `perCoinTotalMaxRatio` まで
 *   両 cap の min を per-symbol headroom として適用。さらに portfolio cap (total) を比例縮小で適用。
 *
 * 段 2 は default 1.0 (= 制限なし) で、UI から設定すれば有効化。
 */
export function applyRiskClipper(input: RiskClipperInput): ClippedProposal {
  const perCoinCycleCap = input.availableCashJpy * input.perCoinMaxRatio;
  const totalCapRoom = Math.max(
    0,
    input.availableCashJpy * input.totalMaxRatio - input.currentInvestedJpy,
  );

  const equity = input.equityJpy ?? input.availableCashJpy + input.currentInvestedJpy;
  const perCoinTotalRatio = input.perCoinTotalMaxRatio ?? 1.0;
  const existingBySymbol = input.existingExposureBySymbol ?? {};

  const changes: ClippedProposal["changes"] = [];
  const clipped: AllocationProposal = {};

  for (const [symbol, jpy] of Object.entries(input.proposal)) {
    let value = jpy;

    if (value < input.perCoinMinJpy) {
      changes.push({ symbol, reason: "below per-coin min", from: jpy, to: 0 });
      continue;
    }

    // 段 2: per-coin 総エクスポージャ上限 (equity base)。既存控除した headroom。
    if (perCoinTotalRatio < 1.0) {
      const totalCap = equity * perCoinTotalRatio;
      const existing = existingBySymbol[symbol] ?? 0;
      const headroom = Math.max(0, totalCap - existing);
      if (value > headroom) {
        changes.push({
          symbol,
          reason: "per-coin total cap",
          from: value,
          to: Math.floor(headroom),
        });
        value = Math.floor(headroom);
        if (value < input.perCoinMinJpy) {
          changes.push({
            symbol,
            reason: "per-coin total cap (below min after headroom)",
            from: jpy,
            to: 0,
          });
          continue;
        }
      }
    }

    // 段 1: per-cycle buy cap (cash base)
    if (value > perCoinCycleCap) {
      changes.push({
        symbol,
        reason: "per-cycle buy cap",
        from: value,
        to: Math.floor(perCoinCycleCap),
      });
      value = Math.floor(perCoinCycleCap);
    }
    clipped[symbol] = value;
  }

  const total = Object.values(clipped).reduce((s, v) => s + v, 0);
  if (total > totalCapRoom && total > 0) {
    const scale = totalCapRoom / total;
    const preScale = { ...clipped };
    for (const symbol of Object.keys(clipped)) {
      const prev = preScale[symbol] ?? 0;
      const scaled = Math.floor(prev * scale);
      if (scaled < input.perCoinMinJpy) {
        changes.push({ symbol, reason: "total cap (below min after scale)", from: prev, to: 0 });
        delete clipped[symbol];
      } else if (scaled !== prev) {
        changes.push({ symbol, reason: "total cap proportional scale", from: prev, to: scaled });
        clipped[symbol] = scaled;
      }
    }

    // NN: floor 連鎖で発生した端数 (= totalCapRoom - sum(clipped)) を最大配分銘柄に寄せる。
    //     ただし per-cycle cap / per-coin total cap も両方を超えない範囲で。
    const remaining = totalCapRoom - Object.values(clipped).reduce((s, v) => s + v, 0);
    if (remaining > 0 && Object.keys(clipped).length > 0) {
      const symbols = Object.keys(clipped).sort((a, b) => (clipped[b] ?? 0) - (clipped[a] ?? 0));
      const top = symbols[0];
      const topValue = clipped[top] ?? 0;
      const headroomCycle = perCoinCycleCap - topValue;
      const headroomTotal =
        perCoinTotalRatio < 1.0
          ? Math.max(0, equity * perCoinTotalRatio - (existingBySymbol[top] ?? 0) - topValue)
          : Number.POSITIVE_INFINITY;
      const inject = Math.floor(Math.max(0, Math.min(remaining, headroomCycle, headroomTotal)));
      if (inject > 0) {
        clipped[top] = topValue + inject;
        changes.push({
          symbol: top,
          reason: "floor remainder injected",
          from: topValue,
          to: topValue + inject,
        });
      }
    }
  }

  return { proposal: clipped, changes };
}
