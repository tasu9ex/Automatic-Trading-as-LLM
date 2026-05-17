import { pgEnum } from "drizzle-orm/pg-core";

export const decisionKindEnum = pgEnum("decision_kind", ["entry", "exit"]);

export const decisionResultEnum = pgEnum("decision_result", ["buy", "no", "hold", "close"]);

export const orderSideEnum = pgEnum("order_side", ["buy", "sell"]);

export const orderStatusEnum = pgEnum("order_status", ["filled", "rejected", "clipped"]);

export const pendingOrderKindEnum = pgEnum("pending_order_kind", [
  "stop_loss_entry_based",
  "stop_loss_peak_based",
]);

export const pendingOrderActorEnum = pgEnum("pending_order_actor", ["code", "llm", "human"]);

export const positionStatusEnum = pgEnum("position_status", ["open", "closed"]);

export const systemEventKindEnum = pgEnum("system_event_kind", [
  "system_started",
  "system_paused",
  "system_resumed",
  "kill_switch_triggered",
  "critic_veto",
  "critic_modify",
  "llm_failure",
  "human_intervention",
  "price_monitor_triggered",
  "data_fetch_failed",
]);

export const systemEventSeverityEnum = pgEnum("system_event_severity", [
  "info",
  "warning",
  "error",
  "critical",
]);

export const criticDecisionEnum = pgEnum("critic_decision", ["approve", "veto", "modify"]);
