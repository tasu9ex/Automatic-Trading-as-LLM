/**
 * 全ドメイン列挙の単一定義箇所。
 * DB pgEnum (src/db/schema/enums.ts) と Zod z.enum (src/lib/schemas/llm-outputs.ts) が
 * ここから派生する。値追加・変更はここを直すだけで両方に伝播する。
 */

// ============================================================
// DB-side enums (pgEnum で使用)
// ============================================================

export const DECISION_KINDS = ["entry", "exit"] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

export const DECISION_RESULTS = ["buy", "no", "hold", "close"] as const;
export type DecisionResult = (typeof DECISION_RESULTS)[number];

export const ORDER_SIDES = ["buy", "sell"] as const;
export type OrderSide = (typeof ORDER_SIDES)[number];

/**
 * Order lifecycle:
 *   placed → filled / expired / cancelled / rejected
 *   (clipped: Allocator / RiskClipper が削った "発注しなかった" 印、ライフサイクル外)
 */
export const ORDER_STATUSES = [
  "placed",
  "filled",
  "expired",
  "cancelled",
  "rejected",
  "clipped",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * 2 段階 SL 設計:
 *   - stop_limit_primary:    緩い損切り、limit 約定でスリッページなし
 *   - stop_market_entry:     建値ベース最終防衛 (深い)、必ず約定するがスリッページ被弾
 *   - stop_market_peak:      ピーク追従 trailing、必ず約定するがスリッページ被弾
 * 旧名は backward compat のため残存(未使用、新規 insert なし)。
 */
export const PENDING_ORDER_KINDS = [
  "stop_loss_entry_based",
  "stop_loss_peak_based",
  "stop_limit_primary",
  "stop_market_entry",
  "stop_market_peak",
] as const;
export type PendingOrderKind = (typeof PENDING_ORDER_KINDS)[number];

export const PENDING_ORDER_ACTORS = ["code", "llm", "human"] as const;
export type PendingOrderActor = (typeof PENDING_ORDER_ACTORS)[number];

export const POSITION_STATUSES = ["open", "closed"] as const;
export type PositionStatus = (typeof POSITION_STATUSES)[number];

export const SYSTEM_EVENT_KINDS = [
  "system_started",
  "system_paused",
  "system_resumed",
  "kill_switch_triggered",
  "critic_veto",
  "critic_modify",
  "llm_failure",
  "cycle_aborted",
  "cycle_emergency_stopped",
  "human_intervention",
  "price_monitor_triggered",
  "data_fetch_failed",
] as const;
export type SystemEventKind = (typeof SYSTEM_EVENT_KINDS)[number];

export const SYSTEM_EVENT_SEVERITIES = ["info", "warning", "error", "critical"] as const;
export type SystemEventSeverity = (typeof SYSTEM_EVENT_SEVERITIES)[number];

export const SYSTEM_STATES = ["stopped", "running", "paused", "killed"] as const;
export type SystemStateValue = (typeof SYSTEM_STATES)[number];

export const CRITIC_DECISIONS = ["approve", "veto", "modify"] as const;
export type CriticDecision = (typeof CRITIC_DECISIONS)[number];

// ============================================================
// LLM-only sub-enums (DB は jsonb で持つので enum 制約なし、Zod 検証のみ)
// ============================================================

export const FUNDAMENTAL_IMPACTS = ["bullish", "neutral", "bearish"] as const;
export type FundamentalImpact = (typeof FUNDAMENTAL_IMPACTS)[number];

export const SENTIMENT_TONES = ["fear", "greed", "neutral", "euphoria", "panic"] as const;
export type SentimentTone = (typeof SENTIMENT_TONES)[number];

export const SENTIMENT_TRENDS = ["improving", "stable", "degrading"] as const;
export type SentimentTrend = (typeof SENTIMENT_TRENDS)[number];

export const TECHNICAL_TRENDS = ["up", "down", "range"] as const;
export type TechnicalTrend = (typeof TECHNICAL_TRENDS)[number];

export const VOLATILITY_LEVELS = ["low", "mid", "high"] as const;
export type VolatilityLevel = (typeof VOLATILITY_LEVELS)[number];

export const MARKET_DIRECTIONS = ["long_bias", "flat", "short_bias"] as const;
export type MarketDirection = (typeof MARKET_DIRECTIONS)[number];

// ============================================================
// Allocator (コード側、Zod なし、内部 enum)
// ============================================================

export const SIZING_METHODS = ["equal", "confidence"] as const;
export type SizingMethod = (typeof SIZING_METHODS)[number];

// ============================================================
// Entry/Exit decision の部分集合 (DECISION_RESULTS から派生)
// ============================================================

export const ENTRY_DECISIONS = ["buy", "no"] as const satisfies readonly DecisionResult[];
export type EntryDecision = (typeof ENTRY_DECISIONS)[number];

export const EXIT_DECISIONS = ["hold", "close"] as const satisfies readonly DecisionResult[];
export type ExitDecision = (typeof EXIT_DECISIONS)[number];
