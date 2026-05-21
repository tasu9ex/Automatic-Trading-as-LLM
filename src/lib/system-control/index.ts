import { db } from "@/db/client";
import { systemEvents, systemState } from "@/db/schema";
import type { SystemState } from "@/db/schema/system-state";
import { and, eq, inArray } from "drizzle-orm";
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
  // V: TOCTOU 解消。read → check → update を分けると 2 タブ同時押下で system_events が
  // 二重発火する。state='running' の行を条件付き UPDATE で atomic に paused に倒す。
  const [updated] = await db
    .update(systemState)
    .set({ state: "paused", updatedAt: new Date() })
    .where(and(eq(systemState.id, SINGLETON_ID), eq(systemState.state, "running")))
    .returning();

  if (updated) {
    await db.insert(systemEvents).values({
      kind: "system_paused",
      severity: "info",
      message: "Manual pause from dashboard",
      payload: { source: "dashboard" },
    });
    return updated;
  }

  // UPDATE が 0 行: 既に paused / killed / stopped / row 不在 のどれか。冪等 / エラーを判別。
  const row = await getSystemStateRow();
  if (!row) throw new Error("system_state not found");
  if (row.state === "paused") return row;
  if (row.state === "killed") throw new Error("Kill Switch 発動中は停止できません");
  throw new Error("稼働中のみ一時停止できます");
}

export async function startSystem(): Promise<SystemState> {
  // V: TOCTOU 解消。state IN (stopped, paused) の行のみ atomic に running に倒す。
  // 2 タブ同時押下しても system_events が二重発火しない。
  const beforeRow = await getSystemStateRow();
  if (!beforeRow) throw new Error("system_state not found");
  if (beforeRow.state === "killed") {
    throw new Error("Kill Switch 発動中は起動できません");
  }
  if (beforeRow.state === "running") return beforeRow;

  const interval = intervalFromRow(beforeRow);
  const nextScheduledAt = computeNextScheduledAt(new Date(), interval);

  const [updated] = await db
    .update(systemState)
    .set({
      state: "running",
      nextScheduledAt,
      updatedAt: new Date(),
    })
    .where(and(eq(systemState.id, SINGLETON_ID), inArray(systemState.state, ["stopped", "paused"])))
    .returning();

  if (!updated) {
    // 並行に他タブが触った: state を再 read して冪等 / エラーを判別。
    const row = await getSystemStateRow();
    if (row?.state === "running") return row;
    if (row?.state === "killed") throw new Error("Kill Switch 発動中は起動できません");
    throw new Error("起動できない状態です");
  }

  const kind = beforeRow.state === "paused" ? "system_resumed" : "system_started";
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
  // BB-2: 再開時に emergencyStop フラグも下ろす (緊急停止解除と通常 pause 解除を同じ動線に集約)。
  // startSystem が paused → running の更新を行う前に flag を倒しておけば、
  // 起動後の最初のサイクル冒頭で phase ガードに引っかからない。
  await db
    .update(systemState)
    .set({ emergencyStop: false, updatedAt: new Date() })
    .where(eq(systemState.id, SINGLETON_ID));
  return startSystem();
}

/**
 * BB-2: 緊急停止。emergencyStop=true + state=paused に倒す。
 * - 進行中サイクルは次の phase 冒頭で `EmergencyStopError` を throw して abort
 * - state=paused にすることで次サイクル :00 cron も skip される
 * - 解除は resumeSystem (= 再開ボタン) で flag を下ろす
 */
export async function emergencyStop(): Promise<SystemState> {
  const [updated] = await db
    .update(systemState)
    .set({ emergencyStop: true, state: "paused", updatedAt: new Date() })
    .where(eq(systemState.id, SINGLETON_ID))
    .returning();
  if (!updated) throw new Error("system_state not found");

  await db.insert(systemEvents).values({
    kind: "system_paused",
    severity: "warning",
    message: "Emergency stop from dashboard",
    payload: { source: "dashboard", emergencyStop: true },
  });

  return updated;
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
