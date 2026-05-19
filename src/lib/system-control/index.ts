import { db } from "@/db/client";
import { systemEvents, systemState } from "@/db/schema";
import type { SystemState } from "@/db/schema/system-state";
import { eq } from "drizzle-orm";
import {
  type CycleIntervalHours,
  DEFAULT_CYCLE_INTERVAL_HOURS,
  isCycleIntervalHours,
} from "./constants";
import { computeNextScheduledAt } from "./scheduling";

const SINGLETON_ID = "singleton";

export async function getSystemStateRow(): Promise<SystemState | undefined> {
  return (await db.select().from(systemState).where(eq(systemState.id, SINGLETON_ID)).limit(1))[0];
}

function intervalFromRow(row: SystemState | undefined): CycleIntervalHours {
  const h = row?.cycleIntervalHours ?? DEFAULT_CYCLE_INTERVAL_HOURS;
  return isCycleIntervalHours(h) ? h : DEFAULT_CYCLE_INTERVAL_HOURS;
}

/** サイクル実行後に次回スロットへ進める。 */
export async function advanceNextScheduledAt(from: Date = new Date()): Promise<Date> {
  const row = await getSystemStateRow();
  const interval = intervalFromRow(row);
  const next = computeNextScheduledAt(from, interval);

  await db
    .update(systemState)
    .set({ nextScheduledAt: next, updatedAt: new Date() })
    .where(eq(systemState.id, SINGLETON_ID));

  return next;
}

export async function pauseSystem(): Promise<SystemState> {
  const row = await getSystemStateRow();
  if (row?.state === "killed") {
    throw new Error("Kill Switch 発動中は停止できません");
  }
  if (row?.state !== "running") {
    if (row?.state === "paused") return row;
    throw new Error("稼働中のみ一時停止できます");
  }

  const [updated] = await db
    .update(systemState)
    .set({ state: "paused", updatedAt: new Date() })
    .where(eq(systemState.id, SINGLETON_ID))
    .returning();
  if (!updated) throw new Error("system_state not found");

  await db.insert(systemEvents).values({
    kind: "system_paused",
    severity: "info",
    message: "Manual pause from dashboard",
    payload: { source: "dashboard" },
  });

  return updated;
}

export async function startSystem(): Promise<SystemState> {
  const row = await getSystemStateRow();
  if (row?.state === "killed") {
    throw new Error("Kill Switch 発動中は起動できません");
  }
  if (row?.state === "running") {
    return row;
  }

  const interval = intervalFromRow(row);
  const nextScheduledAt = computeNextScheduledAt(new Date(), interval);

  const [updated] = await db
    .update(systemState)
    .set({
      state: "running",
      nextScheduledAt,
      updatedAt: new Date(),
    })
    .where(eq(systemState.id, SINGLETON_ID))
    .returning();
  if (!updated) throw new Error("system_state not found");

  const kind = row?.state === "paused" ? "system_resumed" : "system_started";
  await db.insert(systemEvents).values({
    kind,
    severity: "info",
    message:
      kind === "system_resumed"
        ? "Resumed from dashboard (next scheduled slot)"
        : "Started from dashboard (next scheduled slot)",
    payload: { nextScheduledAt: nextScheduledAt.toISOString(), intervalHours: interval },
  });

  return updated;
}

/** stopped / paused → running（次スロットから判定再開） */
export async function resumeSystem(): Promise<SystemState> {
  return startSystem();
}

export async function setCycleIntervalHours(hours: CycleIntervalHours): Promise<SystemState> {
  if (!isCycleIntervalHours(hours)) {
    throw new Error("Invalid cycle interval");
  }

  const row = await getSystemStateRow();
  if (row?.state === "killed") {
    throw new Error("Kill Switch 発動中は実行レートを変更できません");
  }

  const patch: Partial<typeof systemState.$inferInsert> = {
    cycleIntervalHours: hours,
    updatedAt: new Date(),
  };

  if (row?.state === "running") {
    patch.nextScheduledAt = computeNextScheduledAt(new Date(), hours);
  }

  const [updated] = await db
    .update(systemState)
    .set(patch)
    .where(eq(systemState.id, SINGLETON_ID))
    .returning();
  if (!updated) throw new Error("system_state not found");

  await db.insert(systemEvents).values({
    kind: "human_intervention",
    severity: "info",
    message: `Cycle interval set to ${hours}h`,
    payload: {
      cycleIntervalHours: hours,
      nextScheduledAt: updated.nextScheduledAt?.toISOString() ?? null,
    },
  });

  return updated;
}

export { computeNextScheduledAt, isScheduleDue } from "./scheduling";
export { formatIntervalLabel } from "./constants";
export {
  CYCLE_INTERVAL_HOURS,
  DEFAULT_CYCLE_INTERVAL_HOURS,
  isCycleIntervalHours,
} from "./constants";
