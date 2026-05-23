"use server";

import { db } from "@/db/client";
import { systemState } from "@/db/schema";
import {
  emergencyStop,
  pauseSystem,
  resumeSystem,
  setCycleIntervalMinutes,
  startSystem,
} from "@/lib/system-control";
import {
  type CycleIntervalMinutes,
  SINGLETON_ID,
  isCycleIntervalMinutes,
} from "@/lib/system-control/constants";
import { eq } from "drizzle-orm";
import { type ServerActionResult, requireUser, withResult } from "./_helpers";

export type SystemControlActionResult = ServerActionResult;

const withSystemControlResult = (fn: () => Promise<unknown>) => withResult("system-control", fn);

export async function pauseSystemAction(): Promise<SystemControlActionResult> {
  return withSystemControlResult(async () => {
    await requireUser();
    await pauseSystem();
  });
}

/** BB-2: 緊急停止 (進行中サイクルを次 phase 境界で abort + 次サイクル停止) */
export async function emergencyStopAction(): Promise<SystemControlActionResult> {
  return withSystemControlResult(async () => {
    await requireUser();
    await emergencyStop();
  });
}

export async function resumeSystemAction(): Promise<SystemControlActionResult> {
  return withSystemControlResult(async () => {
    await requireUser();
    await resumeSystem();
  });
}

export async function startSystemAction(): Promise<SystemControlActionResult> {
  return withSystemControlResult(async () => {
    await requireUser();
    await startSystem();
  });
}

export async function setCycleIntervalAction(minutes: number): Promise<SystemControlActionResult> {
  return withSystemControlResult(async () => {
    await requireUser();
    if (!isCycleIntervalMinutes(minutes)) {
      throw new Error(`実行レートが不正です: ${minutes}`);
    }
    await setCycleIntervalMinutes(minutes as CycleIntervalMinutes);
  });
}

/** 範囲外なら throw。整数強制したい場合は `integer: true`。 */
function assertRange(
  value: number,
  label: string,
  min: number,
  max: number,
  opts: { integer?: boolean } = {},
): void {
  const finite = opts.integer ? Number.isInteger(value) : Number.isFinite(value);
  if (!finite || value < min || value > max) {
    const range = opts.integer ? `${min} - ${max} の整数` : `${min} - ${max} の範囲`;
    throw new Error(`${label} は ${range} で指定してください`);
  }
}

/**
 * §17: UI からリスクパラメータを更新する。
 *   - perCoinMaxRatio (段 1 / per-cycle): 0.01 - 1.0
 *   - perCoinTotalMaxRatio (段 2 / per-coin total): 0.01 - 1.0 (1.0 = 制限なし)
 *   - portfolioDdTrigger: 0.05 - 0.99
 *   - autoPauseThreshold: 1 - 10 (整数)
 */
export async function setRiskParamsAction(input: {
  perCoinMaxRatio: number;
  perCoinTotalMaxRatio: number;
  portfolioDdTrigger: number;
  autoPauseThreshold: number;
}): Promise<SystemControlActionResult> {
  return withSystemControlResult(async () => {
    await requireUser();
    assertRange(input.perCoinMaxRatio, "PER_COIN_MAX_RATIO (段 1)", 0.01, 1);
    assertRange(input.perCoinTotalMaxRatio, "PER_COIN_TOTAL_MAX_RATIO (段 2)", 0.01, 1);
    assertRange(input.portfolioDdTrigger, "PORTFOLIO_DD_TRIGGER", 0.05, 0.99);
    assertRange(input.autoPauseThreshold, "AUTO_PAUSE_THRESHOLD", 1, 10, { integer: true });
    await db
      .update(systemState)
      .set({
        perCoinMaxRatio: input.perCoinMaxRatio.toFixed(3),
        perCoinTotalMaxRatio: input.perCoinTotalMaxRatio.toFixed(3),
        portfolioDdTrigger: input.portfolioDdTrigger.toFixed(3),
        autoPauseThreshold: input.autoPauseThreshold,
        updatedAt: new Date(),
      })
      .where(eq(systemState.id, SINGLETON_ID));
  });
}
