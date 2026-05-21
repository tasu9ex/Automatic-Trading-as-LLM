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
/**
 * 段 2: per-coin 総エクスポージャ上限 (equity base)。既存控除した headroom。
 * 戻り値: clip 後の値 (perCoinMinJpy 未満は null = drop)。
 */
function clipPerCoinTotalCap(args: {
  symbol: string;
  value: number;
  originalJpy: number;
  equity: number;
  perCoinTotalRatio: number;
  existing: number;
  perCoinMinJpy: number;
  changes: ClippedProposal["changes"];
}): number | null {
  if (args.perCoinTotalRatio >= 1.0) return args.value;
  const totalCap = args.equity * args.perCoinTotalRatio;
  const headroom = Math.max(0, totalCap - args.existing);
  if (args.value <= headroom) return args.value;
  args.changes.push({
    symbol: args.symbol,
    reason: "per-coin total cap",
    from: args.value,
    to: Math.floor(headroom),
  });
  const clipped = Math.floor(headroom);
  if (clipped < args.perCoinMinJpy) {
    args.changes.push({
      symbol: args.symbol,
      reason: "per-coin total cap (below min after headroom)",
      from: args.originalJpy,
      to: 0,
    });
    return null;
  }
  return clipped;
}

/**
 * 段 1: per-cycle buy cap (cash base)。1 サイクル 1 銘柄あたりの新規 buy 上限。
 */
function clipPerCycleCap(args: {
  symbol: string;
  value: number;
  perCoinCycleCap: number;
  changes: ClippedProposal["changes"];
}): number {
  if (args.value <= args.perCoinCycleCap) return args.value;
  args.changes.push({
    symbol: args.symbol,
    reason: "per-cycle buy cap",
    from: args.value,
    to: Math.floor(args.perCoinCycleCap),
  });
  return Math.floor(args.perCoinCycleCap);
}

/**
 * 段 3: portfolio cap 比例縮小。合計が totalCapRoom を超えていたら scale 倍に。
 * 副作用で clipped を直接書き換える。戻り値: scale が走ったかどうか。
 */
function applyTotalCapScale(args: {
  clipped: AllocationProposal;
  totalCapRoom: number;
  perCoinMinJpy: number;
  changes: ClippedProposal["changes"];
}): boolean {
  const total = Object.values(args.clipped).reduce((s, v) => s + v, 0);
  if (total <= args.totalCapRoom || total === 0) return false;
  const scale = args.totalCapRoom / total;
  const preScale = { ...args.clipped };
  for (const symbol of Object.keys(args.clipped)) {
    const prev = preScale[symbol] ?? 0;
    const scaled = Math.floor(prev * scale);
    if (scaled < args.perCoinMinJpy) {
      args.changes.push({
        symbol,
        reason: "total cap (below min after scale)",
        from: prev,
        to: 0,
      });
      delete args.clipped[symbol];
    } else if (scaled !== prev) {
      args.changes.push({ symbol, reason: "total cap proportional scale", from: prev, to: scaled });
      args.clipped[symbol] = scaled;
    }
  }
  return true;
}

/**
 * NN: floor 連鎖で生じた端数 (= totalCapRoom - sum(clipped)) を最大配分銘柄に寄せる。
 *     ただし per-cycle cap / per-coin total cap も両方を超えない範囲で。
 */
function injectFloorRemainder(args: {
  clipped: AllocationProposal;
  totalCapRoom: number;
  perCoinCycleCap: number;
  perCoinTotalRatio: number;
  equity: number;
  existingBySymbol: Record<string, number>;
  changes: ClippedProposal["changes"];
}): void {
  const remaining = args.totalCapRoom - Object.values(args.clipped).reduce((s, v) => s + v, 0);
  if (remaining <= 0 || Object.keys(args.clipped).length === 0) return;
  const symbols = Object.keys(args.clipped).sort(
    (a, b) => (args.clipped[b] ?? 0) - (args.clipped[a] ?? 0),
  );
  const top = symbols[0];
  const topValue = args.clipped[top] ?? 0;
  const headroomCycle = args.perCoinCycleCap - topValue;
  const headroomTotal =
    args.perCoinTotalRatio < 1.0
      ? Math.max(
          0,
          args.equity * args.perCoinTotalRatio - (args.existingBySymbol[top] ?? 0) - topValue,
        )
      : Number.POSITIVE_INFINITY;
  const inject = Math.floor(Math.max(0, Math.min(remaining, headroomCycle, headroomTotal)));
  if (inject > 0) {
    args.clipped[top] = topValue + inject;
    args.changes.push({
      symbol: top,
      reason: "floor remainder injected",
      from: topValue,
      to: topValue + inject,
    });
  }
}

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
    if (jpy < input.perCoinMinJpy) {
      changes.push({ symbol, reason: "below per-coin min", from: jpy, to: 0 });
      continue;
    }
    const afterStage2 = clipPerCoinTotalCap({
      symbol,
      value: jpy,
      originalJpy: jpy,
      equity,
      perCoinTotalRatio,
      existing: existingBySymbol[symbol] ?? 0,
      perCoinMinJpy: input.perCoinMinJpy,
      changes,
    });
    if (afterStage2 === null) continue;
    clipped[symbol] = clipPerCycleCap({
      symbol,
      value: afterStage2,
      perCoinCycleCap,
      changes,
    });
  }

  const scaled = applyTotalCapScale({
    clipped,
    totalCapRoom,
    perCoinMinJpy: input.perCoinMinJpy,
    changes,
  });
  if (scaled) {
    injectFloorRemainder({
      clipped,
      totalCapRoom,
      perCoinCycleCap,
      perCoinTotalRatio,
      equity,
      existingBySymbol,
      changes,
    });
  }

  return { proposal: clipped, changes };
}
