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

function toResult(fn: () => Promise<void>): Promise<SystemControlActionResult> {
  return fn()
    .then(() => {
      revalidatePath("/");
      return { ok: true as const };
    })
    .catch((err: unknown) => ({
      ok: false as const,
      error: err instanceof Error ? err.message : "操作に失敗しました",
    }));
}

export async function pauseSystemAction(): Promise<SystemControlActionResult> {
  await requireUser();
  return toResult(async () => {
    await pauseSystem();
  });
}

export async function resumeSystemAction(): Promise<SystemControlActionResult> {
  await requireUser();
  return toResult(async () => {
    await resumeSystem();
  });
}

export async function startSystemAction(): Promise<SystemControlActionResult> {
  await requireUser();
  return toResult(async () => {
    await startSystem();
  });
}

export async function setCycleIntervalAction(hours: number): Promise<SystemControlActionResult> {
  await requireUser();
  if (!isCycleIntervalHours(hours)) {
    return { ok: false, error: "実行レートが不正です" };
  }
  return toResult(async () => {
    await setCycleIntervalHours(hours as CycleIntervalHours);
  });
}
