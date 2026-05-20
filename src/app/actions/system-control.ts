"use server";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  pauseSystem,
  resumeSystem,
  setCycleIntervalHours,
  startSystem,
} from "@/lib/system-control";
import { type CycleIntervalHours, isCycleIntervalHours } from "@/lib/system-control/constants";
import { revalidatePath } from "next/cache";

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
