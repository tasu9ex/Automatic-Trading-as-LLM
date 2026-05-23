import type { SizingMethod } from "@/lib/allocator";

/**
 * 単一 portfolio 運用前提の strategyId。`coins` → `portfolios` → `positions` 等の
 * strategy_id カラムは全てこれを通る。マルチポートフォリオ化する際は呼び出し側で
 * パラメータ化する想定。
 */
export const DEFAULT_STRATEGY_ID = "trial-5";

/** Allocator のサイズリング既定: confidence-weighted (vs equal-weight) */
export const DEFAULT_SIZING_METHOD: SizingMethod = "confidence";
