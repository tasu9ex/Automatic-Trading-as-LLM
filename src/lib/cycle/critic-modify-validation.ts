import type { ExecutionPlan } from "./execution-plan";

/**
 * Critic modify の adjustments を機械検算。
 *
 * pct ベース化により、ハードガード違反は schema (buys 0-100, exits 10-100) が防ぐ。
 * このモジュールでは「Analyst 候補外の銘柄追加」「計画に無い銘柄の Exit 開始」のみ検査。
 */

export interface ModifyAdjustments {
  /** Entry の size_pct (0-100 整数) 上書き。0 で除外 */
  buys?: Record<string, number>;
  /** Exit の close_pct (10-100 整数) 上書き */
  exits?: Record<string, number>;
}

export interface ValidateModifyInput {
  plan: ExecutionPlan;
  adjustments: ModifyAdjustments;
  /** Analyst が "buy" を出した銘柄 (Critic が追加できる銘柄の whitelist) */
  buyCandidates: Set<string>;
}

export function validateCriticModify(input: ValidateModifyInput): string | null {
  const { plan, adjustments, buyCandidates } = input;
  const buys = adjustments.buys ?? {};
  const exits = adjustments.exits ?? {};

  for (const sym of Object.keys(buys)) {
    if (!buyCandidates.has(sym)) {
      return `buys.${sym}: Allocator 候補外の銘柄 (Analyst が buy を出していない)`;
    }
  }

  for (const sym of Object.keys(exits)) {
    if (!plan.exits[sym]) {
      return `exits.${sym}: 計画に存在しない銘柄の Exit 開始は不可 (元々 hold 判定)`;
    }
  }

  return null;
}

/**
 * Critic modify を計画に適用して新しい entries / exits を計算。
 * buys は pct → JPY 変換 (max_budget_jpy × pct / 100)。
 */
export function applyModify(
  plan: ExecutionPlan,
  adjustments: ModifyAdjustments,
  maxBudgetJpy: number,
): { entries: Record<string, number>; exits: ExecutionPlan["exits"] } {
  const entries: Record<string, number> = { ...plan.entries };
  for (const [sym, pct] of Object.entries(adjustments.buys ?? {})) {
    const clamped = Math.max(0, Math.min(100, pct));
    if (clamped <= 0) {
      delete entries[sym];
    } else {
      entries[sym] = Math.floor(maxBudgetJpy * (clamped / 100));
    }
  }

  const exits: ExecutionPlan["exits"] = { ...plan.exits };
  for (const [sym, pct] of Object.entries(adjustments.exits ?? {})) {
    const orig = exits[sym];
    if (!orig) continue;
    const clamped = Math.max(0, Math.min(100, pct));
    if (clamped <= 0) {
      // 0 で個別 Exit キャンセル (この銘柄は今サイクル決済しない)
      delete exits[sym];
      continue;
    }
    const ratio = clamped / orig.closePct;
    exits[sym] = {
      closePct: clamped,
      qtyToClose: orig.qtyToClose * ratio,
      expectedCashJpy: orig.expectedCashJpy * ratio,
    };
  }

  return { entries, exits };
}

/**
 * applyModify の結果が元の計画と実質同一か (= no-op modify) を判定。
 * entries (symbol→jpy) と exits (symbol→closePct/qtyToClose/expectedCashJpy) を
 * 構造比較する。key 順に依存しないよう sort して突き合わせる。
 */
export function isSamePlan(
  plan: ExecutionPlan,
  final: { entries: Record<string, number>; exits: ExecutionPlan["exits"] },
): boolean {
  const entryKeys = (e: Record<string, number>) => Object.keys(e).sort();
  const a = entryKeys(plan.entries);
  const b = entryKeys(final.entries);
  if (a.length !== b.length || a.some((k, i) => k !== b[i])) return false;
  if (a.some((k) => plan.entries[k] !== final.entries[k])) return false;

  const x = Object.keys(plan.exits).sort();
  const y = Object.keys(final.exits).sort();
  if (x.length !== y.length || x.some((k, i) => k !== y[i])) return false;
  return x.every((k) => {
    const p = plan.exits[k];
    const f = final.exits[k];
    return (
      p.closePct === f.closePct &&
      p.qtyToClose === f.qtyToClose &&
      p.expectedCashJpy === f.expectedCashJpy
    );
  });
}

/**
 * Critic 通過後の modified positions を計算。
 * UI で 'modify' 時に「修正後はどんなポジションになるか」表示するために使う。
 */
export function computeModifiedPositions(
  plan: ExecutionPlan,
  modified: { entries: Record<string, number>; exits: ExecutionPlan["exits"] },
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [sym, mtm] of Object.entries(plan.currentPositions)) {
    const exit = modified.exits[sym];
    if (!exit) {
      result[sym] = mtm;
    } else {
      const closeRatio = exit.closePct / 100;
      const remaining = mtm * (1 - closeRatio);
      if (remaining > 0) result[sym] = remaining;
    }
  }
  for (const [sym, jpy] of Object.entries(modified.entries)) {
    result[sym] = (result[sym] ?? 0) + jpy;
  }
  return result;
}
