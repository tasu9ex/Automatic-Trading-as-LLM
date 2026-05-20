"use server";

import { db } from "@/db/client";
import { coins } from "@/db/schema";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { eq } from "drizzle-orm";
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

export type CoinToggleResult = { ok: true } | { ok: false; error: string };

export async function setCoinEnabledAction(
  coinId: string,
  enabled: boolean,
): Promise<CoinToggleResult> {
  try {
    await requireUser();
    await db.update(coins).set({ enabled, updatedAt: new Date() }).where(eq(coins.id, coinId));
    revalidatePath("/");
    return { ok: true };
  } catch (err) {
    console.error("[coins action error]", err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
