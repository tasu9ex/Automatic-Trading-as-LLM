/**
 * BB-2: 緊急 pause。通常 pause (現サイクル走り切り + 次サイクル停止) と異なり、
 * サイクル進行中のどの phase 冒頭でもチェックして即時 throw する。
 *
 * 設計:
 *   - 専用 Error 型でサイクル orchestrator が `recordCycleFailure` 経路と区別
 *   - consecutiveFailures は **増やさない** (人手の停止なので失敗ではない)
 *   - 専用 event `cycle_emergency_stopped` を記録
 *   - 部分実行データ (snapshots / pre_analyst など) は DB に残し、再開後の冪等 skip で活用
 */

import { db } from "@/db/client";
import { systemEvents, systemState } from "@/db/schema";
import { markCycleCompleted } from "@/lib/cycle/mark-completed";
import { createLogger } from "@/lib/logging";
import { notify } from "@/lib/notifications";
import { SINGLETON_ID } from "@/lib/system-control/constants";
import { eq } from "drizzle-orm";

const logger = createLogger("cycle.emergency-stop");

export class EmergencyStopError extends Error {
  readonly isEmergencyStop = true;
  constructor(public phase: string) {
    super(`Emergency stop requested at ${phase}`);
    this.name = "EmergencyStopError";
  }
}

export function isEmergencyStopError(err: unknown): err is EmergencyStopError {
  return err instanceof EmergencyStopError;
}

/**
 * 緊急停止フラグが立っていれば throw。各 phase 冒頭で呼ぶ。
 * 1 行 read のみで軽量。
 */
export async function assertNotEmergencyStop(phase: string): Promise<void> {
  const row = (
    await db
      .select({ emergencyStop: systemState.emergencyStop })
      .from(systemState)
      .where(eq(systemState.id, SINGLETON_ID))
      .limit(1)
  )[0];
  if (row?.emergencyStop) {
    throw new EmergencyStopError(phase);
  }
}

/** 緊急停止時の event 記録 + 通知 + cycle.completedAt 埋め。judgment.ts / functions.ts 両方から使う。 */
export async function recordEmergencyStop(args: {
  cycleId: string;
  strategyId: string;
  phase: string;
}): Promise<void> {
  logger.warn({ cycleId: args.cycleId, phase: args.phase }, "Cycle emergency-stopped");

  await db.insert(systemEvents).values({
    strategyId: args.strategyId,
    kind: "cycle_emergency_stopped",
    severity: "warning",
    message: `Cycle ${args.cycleId.slice(0, 8)} emergency-stopped at ${args.phase}`,
    payload: { cycleId: args.cycleId, phase: args.phase },
    cycleId: args.cycleId,
  });

  // DD と同じく completedAt を埋めて "in_flight" 扱いを終わらせる
  await markCycleCompleted(args.cycleId);

  await notify({
    level: "warning",
    title: `🛑 緊急停止 (${args.phase}) — サイクル中断`,
    body: [
      "ダッシュボードから緊急停止ボタンが押されたため、サイクルを中断しました。",
      "部分実行データ (snapshots / pre_analyst 等) は DB に残っており、再開後の冪等 skip で再利用されます。",
      "**再開**: ダッシュボードの「再開」ボタン (state=paused → running と同じ動線)",
    ].join("\n"),
    fields: {
      サイクル: args.cycleId.slice(0, 8),
      Phase: args.phase,
    },
  });
}
