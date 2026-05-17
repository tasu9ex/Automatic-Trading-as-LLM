import {
  CRITIC_DECISIONS,
  DECISION_KINDS,
  DECISION_RESULTS,
  ORDER_SIDES,
  ORDER_STATUSES,
  PENDING_ORDER_ACTORS,
  PENDING_ORDER_KINDS,
  POSITION_STATUSES,
  SYSTEM_EVENT_KINDS,
  SYSTEM_EVENT_SEVERITIES,
} from "@/lib/constants/enums";
import { pgEnum } from "drizzle-orm/pg-core";

export const decisionKindEnum = pgEnum("decision_kind", DECISION_KINDS);

export const decisionResultEnum = pgEnum("decision_result", DECISION_RESULTS);

export const orderSideEnum = pgEnum("order_side", ORDER_SIDES);

export const orderStatusEnum = pgEnum("order_status", ORDER_STATUSES);

export const pendingOrderKindEnum = pgEnum("pending_order_kind", PENDING_ORDER_KINDS);

export const pendingOrderActorEnum = pgEnum("pending_order_actor", PENDING_ORDER_ACTORS);

export const positionStatusEnum = pgEnum("position_status", POSITION_STATUSES);

export const systemEventKindEnum = pgEnum("system_event_kind", SYSTEM_EVENT_KINDS);

export const systemEventSeverityEnum = pgEnum("system_event_severity", SYSTEM_EVENT_SEVERITIES);

export const criticDecisionEnum = pgEnum("critic_decision", CRITIC_DECISIONS);
