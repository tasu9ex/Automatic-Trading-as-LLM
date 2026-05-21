import { PER_COIN_MIN_JPY, TOTAL_MAX_RATIO } from "@/lib/constants/risk";
import type { ExecutionPlan } from "./execution-plan";

/**
 * Critic modify の adjustments がハードガードを守っているか機械検算。
 *
 * 1 つでも違反したら違反理由を返す (caller 側で throw して ALL-or-NOTHING)。
 * 違反なしなら null。Critic LLM が信頼できないとき (cap 超え / 新規銘柄追加 等) に
 * silent fallback ではなく cycle 失敗扱いにする (CLAUDE.md の ALL-or-NOTHING 原則)。
 */

export interface ModifyAdjustments {
  buys?: Record<string, number>;
  exits?: Record<string, number>;
}

export interface ValidateModifyInput {
  plan: ExecutionPlan;
  adjustments: ModifyAdjustments;
  /** Allocator が buy 候補にした symbol (= Analyst が "buy" を出した銘柄) */
  buyCandidates: Set<string>;
  cashJpy: number;
  equityJpy: number;
  perCoinMaxRatio: number;
  perCoinTotalMaxRatio: number;
}

export function validateCriticModify(input: ValidateModifyInput): string | null {
  const { plan, adjustments, buyCandidates, cashJpy, equityJpy } = input;
  const buys = adjustments.buys ?? {};
  const exits = adjustments.exits ?? {};

  // --- exits 検算 ---
  for (const [sym, pct] of Object.entries(exits)) {
    if (!plan.exits[sym]) {
      return `exits.${sym}: 計画に存在しない銘柄の Exit 開始は不可 (元々 hold 判定)`;
    }
    if (!Number.isInteger(pct) || pct < 10 || pct > 100) {
      return `exits.${sym}: closePct は 10-100 整数のみ (受信: ${pct})`;
    }
  }

  // --- buys 検算 ---
  const perCoinCycleCap = cashJpy * input.perCoinMaxRatio;
  const perCoinTotalRatio = input.perCoinTotalMaxRatio;
  const totalCapRoom = cashJpy * TOTAL_MAX_RATIO;

  for (const [sym, jpy] of Object.entries(buys)) {
    if (!buyCandidates.has(sym)) {
      return `buys.${sym}: Allocator 候補外の銘柄 (Analyst が buy を出していない)`;
    }
    if (!Number.isFinite(jpy) || jpy < 0) {
      return `buys.${sym}: 不正な金額 (受信: ${jpy})`;
    }
    if (jpy > 0 && jpy < PER_COIN_MIN_JPY) {
      return `buys.${sym}: 0 < x < ${PER_COIN_MIN_JPY} は不可 (受信: ${jpy})`;
    }
    if (jpy > perCoinCycleCap) {
      return `buys.${sym}: per-cycle cap 違反 (¥${Math.floor(jpy)} > ¥${Math.floor(perCoinCycleCap)})`;
    }
    if (perCoinTotalRatio < 1.0) {
      const existing = plan.currentPositions[sym] ?? 0;
      const totalCap = equityJpy * perCoinTotalRatio;
      if (existing + jpy > totalCap) {
        return `buys.${sym}: per-coin total cap 違反 (既存¥${Math.floor(existing)} + 新規¥${Math.floor(jpy)} > 上限¥${Math.floor(totalCap)})`;
      }
    }
  }

  // 合計検算: modify 適用後の総 buy が cash を超えないか
  const merged: Record<string, number> = { ...plan.entries };
  for (const [sym, jpy] of Object.entries(buys)) {
    merged[sym] = jpy;
  }
  const totalBuys = Object.values(merged).reduce((s, v) => s + v, 0);
  if (totalBuys > totalCapRoom) {
    return `Σ buys: 合計が cash を超過 (¥${Math.floor(totalBuys)} > ¥${Math.floor(totalCapRoom)})`;
  }

  return null;
}

/**
 * Critic modify を計画に適用して新しい entries / exits を計算。
 * バリデーション通過後に呼ぶこと。
 */
export function applyModify(
  plan: ExecutionPlan,
  adjustments: ModifyAdjustments,
): { entries: Record<string, number>; exits: ExecutionPlan["exits"] } {
  const entries: Record<string, number> = { ...plan.entries };
  for (const [sym, jpy] of Object.entries(adjustments.buys ?? {})) {
    if (jpy <= 0) {
      delete entries[sym];
    } else {
      entries[sym] = Math.floor(jpy);
    }
  }

  const exits: ExecutionPlan["exits"] = { ...plan.exits };
  for (const [sym, pct] of Object.entries(adjustments.exits ?? {})) {
    const orig = exits[sym];
    if (!orig) continue;
    // qty / expectedCash は closePct に比例して再計算
    const ratio = pct / orig.closePct;
    exits[sym] = {
      closePct: pct,
      qtyToClose: orig.qtyToClose * ratio,
      expectedCashJpy: orig.expectedCashJpy * ratio,
    };
  }

  return { entries, exits };
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
  // 既存ポジション - exit 決済分
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
  // 新規 Entry を加算
  for (const [sym, jpy] of Object.entries(modified.entries)) {
    result[sym] = (result[sym] ?? 0) + jpy;
  }
  return result;
}
