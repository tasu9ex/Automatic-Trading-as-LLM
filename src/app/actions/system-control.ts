"use server";

import { db } from "@/db/client";
import { systemState } from "@/db/schema";
import { DASHBOARD_CACHE_TAG } from "@/lib/cycle/queries";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  pauseSystem,
  resumeSystem,
  setCycleIntervalHours,
  startSystem,
} from "@/lib/system-control";
import { type CycleIntervalHours, isCycleIntervalHours } from "@/lib/system-control/constants";
import { eq } from "drizzle-orm";
import { revalidatePath, updateTag } from "next/cache";

async function requireUser() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    throw new Error("ログインが必要です");
  }
  return user;
}

export type SystemControlActionResult = { ok: true } | { ok: false; error: string };

/** すべての server action でこのラッパーを通せば、未捕捉 throw が消えて UI に message が出る */
function withResult(fn: () => Promise<unknown>): Promise<SystemControlActionResult> {
  return fn()
    .then(() => {
      updateTag(DASHBOARD_CACHE_TAG);
      revalidatePath("/");
      return { ok: true as const };
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      // 個人ツールなので server console にも全文出す (Vercel logs で確認用)
      console.error("[system-control action error]", err);
      return { ok: false as const, error: message };
    });
}

export async function pauseSystemAction(): Promise<SystemControlActionResult> {
  return withResult(async () => {
    await requireUser();
    await pauseSystem();
  });
}

export async function resumeSystemAction(): Promise<SystemControlActionResult> {
  return withResult(async () => {
    await requireUser();
    await resumeSystem();
  });
}

export async function startSystemAction(): Promise<SystemControlActionResult> {
  return withResult(async () => {
    await requireUser();
    await startSystem();
  });
}

export async function setCycleIntervalAction(hours: number): Promise<SystemControlActionResult> {
  return withResult(async () => {
    await requireUser();
    if (!isCycleIntervalHours(hours)) {
      throw new Error(`実行レートが不正です: ${hours}`);
    }
    await setCycleIntervalHours(hours as CycleIntervalHours);
  });
}

/**
 * §17: UI からリスクパラメータ 3 種を更新する。
 *   - perCoinMaxRatio: 0.01 - 1.0
 *   - portfolioDdTrigger: 0.05 - 0.99
 *   - autoPauseThreshold: 1 - 10 (整数)
 * 範囲外は throw して UI 側でエラー表示。
 */
export async function setRiskParamsAction(input: {
  perCoinMaxRatio: number;
  portfolioDdTrigger: number;
  autoPauseThreshold: number;
}): Promise<SystemControlActionResult> {
  return withResult(async () => {
    await requireUser();
    if (
      !Number.isFinite(input.perCoinMaxRatio) ||
      input.perCoinMaxRatio < 0.01 ||
      input.perCoinMaxRatio > 1
    ) {
      throw new Error("PER_COIN_MAX_RATIO は 0.01 - 1.00 の範囲で指定してください");
    }
    if (
      !Number.isFinite(input.portfolioDdTrigger) ||
      input.portfolioDdTrigger < 0.05 ||
      input.portfolioDdTrigger > 0.99
    ) {
      throw new Error("PORTFOLIO_DD_TRIGGER は 0.05 - 0.99 の範囲で指定してください");
    }
    if (
      !Number.isInteger(input.autoPauseThreshold) ||
      input.autoPauseThreshold < 1 ||
      input.autoPauseThreshold > 10
    ) {
      throw new Error("AUTO_PAUSE_THRESHOLD は 1 - 10 の整数で指定してください");
    }
    await db
      .update(systemState)
      .set({
        perCoinMaxRatio: input.perCoinMaxRatio.toFixed(3),
        portfolioDdTrigger: input.portfolioDdTrigger.toFixed(3),
        autoPauseThreshold: input.autoPauseThreshold,
        updatedAt: new Date(),
      })
      .where(eq(systemState.id, "singleton"));
  });
}
