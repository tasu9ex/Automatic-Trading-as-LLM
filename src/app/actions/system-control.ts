"use server";

import { db } from "@/db/client";
import { systemState } from "@/db/schema";
import { DASHBOARD_CACHE_TAG } from "@/lib/cycle/queries";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  emergencyStop,
  pauseSystem,
  resumeSystem,
  setCycleIntervalMinutes,
  startSystem,
} from "@/lib/system-control";
import { type CycleIntervalMinutes, isCycleIntervalMinutes } from "@/lib/system-control/constants";
import * as Sentry from "@sentry/nextjs";
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
      // R: `updateTag` は unstable_cache 内のエントリを無効化 (next の cache layer)。
      // `revalidatePath` は path の RSC キャッシュを無効化 (router 側)。
      // page.tsx は `force-dynamic` なので revalidatePath は実質 router.refresh() 後の
      // 再 fetch を担保する意図。両方残すのが最も保守的で、本番でいずれか不要と判明すれば落とす。
      updateTag(DASHBOARD_CACHE_TAG);
      revalidatePath("/");
      return { ok: true as const };
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      // P (Sentry): CLAUDE.md の運用方針 (本番エラーは Sentry で追う) に合わせて捕捉
      Sentry.captureException(err, { tags: { source: "server-action", group: "system-control" } });
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

/** BB-2: 緊急停止 (進行中サイクルを次 phase 境界で abort + 次サイクル停止) */
export async function emergencyStopAction(): Promise<SystemControlActionResult> {
  return withResult(async () => {
    await requireUser();
    await emergencyStop();
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

export async function setCycleIntervalAction(minutes: number): Promise<SystemControlActionResult> {
  return withResult(async () => {
    await requireUser();
    if (!isCycleIntervalMinutes(minutes)) {
      throw new Error(`実行レートが不正です: ${minutes}`);
    }
    await setCycleIntervalMinutes(minutes as CycleIntervalMinutes);
  });
}

/**
 * §17: UI からリスクパラメータを更新する。
 *   - perCoinMaxRatio (段 1 / per-cycle): 0.01 - 1.0
 *   - perCoinTotalMaxRatio (段 2 / per-coin total): 0.01 - 1.0 (1.0 = 制限なし)
 *   - portfolioDdTrigger: 0.05 - 0.99
 *   - autoPauseThreshold: 1 - 10 (整数)
 * 範囲外は throw して UI 側でエラー表示。
 */
export async function setRiskParamsAction(input: {
  perCoinMaxRatio: number;
  perCoinTotalMaxRatio: number;
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
      throw new Error("PER_COIN_MAX_RATIO (段 1) は 0.01 - 1.00 の範囲で指定してください");
    }
    if (
      !Number.isFinite(input.perCoinTotalMaxRatio) ||
      input.perCoinTotalMaxRatio < 0.01 ||
      input.perCoinTotalMaxRatio > 1
    ) {
      throw new Error("PER_COIN_TOTAL_MAX_RATIO (段 2) は 0.01 - 1.00 の範囲で指定してください");
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
        perCoinTotalMaxRatio: input.perCoinTotalMaxRatio.toFixed(3),
        portfolioDdTrigger: input.portfolioDdTrigger.toFixed(3),
        autoPauseThreshold: input.autoPauseThreshold,
        updatedAt: new Date(),
      })
      .where(eq(systemState.id, "singleton"));
  });
}
