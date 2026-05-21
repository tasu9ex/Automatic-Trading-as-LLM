import type { AllocationProposal } from "@/lib/schemas/llm-outputs";

export interface RiskClipperInput {
  proposal: AllocationProposal;
  availableCashJpy: number;
  currentInvestedJpy: number;
  /** ハードガード (デフォルト Risk Clipper 設定) */
  perCoinMaxRatio: number; // 1 銘柄あたり最大投資率 (現金比、例 0.25 = 25%)
  perCoinMinJpy: number; // 1 銘柄あたり最小発注 (例 5000)
  totalMaxRatio: number; // ポートフォリオ総投資率上限 (例 1.0 = 100%)
}

export interface ClippedProposal {
  proposal: AllocationProposal;
  /** 削除/減額された変更ログ */
  changes: Array<{ symbol: string; reason: string; from: number; to: number }>;
}

/**
 * Allocator 出力をハードガードでクリップ。
 *   - 1 銘柄上限超過 → ratio で切り詰め
 *   - 1 銘柄下限割れ → スキップ
 *   - 総投資率超過 → 全銘柄を比例縮小
 */
export function applyRiskClipper(input: RiskClipperInput): ClippedProposal {
  const perCoinCap = input.availableCashJpy * input.perCoinMaxRatio;
  const totalCapRoom = Math.max(
    0,
    input.availableCashJpy * input.totalMaxRatio - input.currentInvestedJpy,
  );

  const changes: ClippedProposal["changes"] = [];
  const clipped: AllocationProposal = {};

  for (const [symbol, jpy] of Object.entries(input.proposal)) {
    let value = jpy;

    if (value < input.perCoinMinJpy) {
      changes.push({ symbol, reason: "below per-coin min", from: jpy, to: 0 });
      continue;
    }
    if (value > perCoinCap) {
      changes.push({ symbol, reason: "per-coin cap", from: value, to: Math.floor(perCoinCap) });
      value = Math.floor(perCoinCap);
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
    //     毎回 floor で切り捨てると 数 % 程度現金が遊ぶため。per-coin cap を超えないかチェック。
    const remaining = totalCapRoom - Object.values(clipped).reduce((s, v) => s + v, 0);
    if (remaining > 0 && Object.keys(clipped).length > 0) {
      const symbols = Object.keys(clipped).sort((a, b) => (clipped[b] ?? 0) - (clipped[a] ?? 0));
      const top = symbols[0];
      const topValue = clipped[top] ?? 0;
      const headroom = perCoinCap - topValue;
      const inject = Math.floor(Math.max(0, Math.min(remaining, headroom)));
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
