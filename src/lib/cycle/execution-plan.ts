import { allocate } from "@/lib/allocator";
import { PER_COIN_MIN_JPY, TOTAL_MAX_RATIO } from "@/lib/constants/risk";
import { applyRiskClipper } from "@/lib/risk/clipper";

/**
 * Critic に渡す「実行計画」を組み立てる純関数。
 *
 * 旧フロー: Allocator → Critic → Exit → Clipper → Entry
 *   Critic は raw proposal (cap 未適用) を見て判断 → cap で削られる前提で
 *   配分比率を実質スルーする「形式的承認」になりがちだった。
 *
 * 新フロー: [Exit dry-run + Allocator + Clipper] → Critic → 実行
 *   Critic は実発注に近い計画 (= clip 済 + post-exit cash base) を見るので、
 *   真の最終判断者として approve / veto / modify ができる。
 *
 * 本関数は DB / 外部 API に一切触れない。phases.ts から ctxs を整形した
 * signals を渡して呼ぶ。
 */

export interface ExecutionPlanSignal {
  symbol: string;
  lastPriceJpy: number;
  takerFeeRate: number;
  /**
   * Entry LLM 出力。buy 時は sizePct (1-100 整数) が必須。
   * confidence は観測専用 (Allocator では使わない)。
   */
  entry: {
    decision: "buy" | "no";
    confidence: number;
    sizePct: number | null;
  } | null;
  exit: { decision: "close" | "hold"; confidence: number; closePct: number } | null;
  openPosition: { quantity: number; avgEntryPrice: number } | null;
}

export interface ExecutionPlanInput {
  signals: ExecutionPlanSignal[];
  currentCashJpy: number;
  riskParams: {
    perCoinMaxRatio: number;
    perCoinTotalMaxRatio: number;
  };
}

export interface PlannedExit {
  /** 10-100 整数 */
  closePct: number;
  /** 決済予定数量 (quantity × closePct/100) */
  qtyToClose: number;
  /** 期待手取り cash (taker fee 控除済) */
  expectedCashJpy: number;
}

export interface ExecutionPlan {
  /** 決済予定。close 判断のある銘柄のみ */
  exits: Record<string, PlannedExit>;
  /** Clipper 適用済の Entry 配分 */
  entries: Record<string, number>;
  /** Exit 後の見込み cash (Allocator/Clipper の base) */
  projectedCashJpy: number;
  /** サイクル開始時点の mtm 評価額。symbol → jpy */
  currentPositions: Record<string, number>;
  /** Exit + Entry 後の見込み mtm 評価額。symbol → jpy */
  plannedPositions: Record<string, number>;
  /** Clipper が削った/減らしたログ (デバッグ・UI 表示用) */
  clipperChanges: Array<{ symbol: string; reason: string; from: number; to: number }>;
}

export function buildExecutionPlan(input: ExecutionPlanInput): ExecutionPlan {
  const exits: Record<string, PlannedExit> = {};
  const currentPositions: Record<string, number> = {};
  const existingExposureBySymbol: Record<string, number> = {};

  // 現在 mtm + Exit dry-run
  let expectedCloseCash = 0;
  let postExitInvested = 0;
  for (const s of input.signals) {
    const qty = s.openPosition?.quantity ?? 0;
    if (qty <= 0) continue;

    const mtmPrice = s.lastPriceJpy > 0 ? s.lastPriceJpy : (s.openPosition?.avgEntryPrice ?? 0);
    const mtm = qty * mtmPrice;
    currentPositions[s.symbol] = mtm;

    if (s.exit?.decision === "close") {
      const closePct = s.exit.closePct;
      const qtyToClose = qty * (closePct / 100);
      const grossCash = qtyToClose * mtmPrice;
      const netCash = grossCash * (1 - s.takerFeeRate);
      exits[s.symbol] = { closePct, qtyToClose, expectedCashJpy: netCash };
      expectedCloseCash += netCash;
      const remainingQty = qty - qtyToClose;
      const remainingExposure = remainingQty * mtmPrice;
      postExitInvested += remainingExposure;
      if (remainingExposure > 0) {
        existingExposureBySymbol[s.symbol] = remainingExposure;
      }
    } else {
      postExitInvested += mtm;
      existingExposureBySymbol[s.symbol] = mtm;
    }
  }

  const projectedCashJpy = input.currentCashJpy + expectedCloseCash;

  // §size: Entry LLM が見た max_budget と同じ base で size_pct を JPY 化する。
  // (Exit の見込み回収を含めない currentCashJpy ベースに統一。実約定リスクを排除する保守設計。)
  const maxBudgetJpy = Math.max(
    0,
    Math.floor(input.currentCashJpy * input.riskParams.perCoinMaxRatio),
  );

  const buySignals = input.signals
    .filter((s) => s.entry?.decision === "buy" && (s.entry.sizePct ?? 0) > 0)
    .map((s) => ({ symbol: s.symbol, sizePct: s.entry?.sizePct ?? 0 }));

  const proposal = allocate({ buySignals, maxBudgetJpy });

  const equity = projectedCashJpy + postExitInvested;
  const clipped = applyRiskClipper({
    proposal,
    availableCashJpy: projectedCashJpy,
    currentInvestedJpy: postExitInvested,
    existingExposureBySymbol,
    equityJpy: equity,
    perCoinMaxRatio: input.riskParams.perCoinMaxRatio,
    perCoinMinJpy: PER_COIN_MIN_JPY,
    totalMaxRatio: TOTAL_MAX_RATIO,
    perCoinTotalMaxRatio: input.riskParams.perCoinTotalMaxRatio,
  });

  // 計画後の mtm を組み立てる: 現在 - Exit 決済分 + Entry 新規
  const plannedPositions: Record<string, number> = { ...existingExposureBySymbol };
  for (const [sym, jpy] of Object.entries(clipped.proposal)) {
    plannedPositions[sym] = (plannedPositions[sym] ?? 0) + jpy;
  }

  return {
    exits,
    entries: clipped.proposal,
    projectedCashJpy,
    currentPositions,
    plannedPositions,
    clipperChanges: clipped.changes,
  };
}
