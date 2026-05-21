"use server";

import { db } from "@/db/client";
import { coins } from "@/db/schema";
import { DASHBOARD_CACHE_TAG } from "@/lib/cycle/queries";
import { createSupabaseServerClient } from "@/lib/supabase/server";
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

export type CoinToggleResult = { ok: true } | { ok: false; error: string };

export async function setCoinEnabledAction(
  coinId: string,
  enabled: boolean,
): Promise<CoinToggleResult> {
  try {
    await requireUser();
    // O: 不正な coinId / 存在しない coinId を silent ignore にしない。
    // UUID v4 ライクな簡易検証 + UPDATE 行数チェック (存在しなければ rowCount 0)。
    if (typeof coinId !== "string" || !/^[0-9a-f-]{36}$/i.test(coinId)) {
      throw new Error("不正な coinId 形式です");
    }
    const updated = await db
      .update(coins)
      .set({ enabled, updatedAt: new Date() })
      .where(eq(coins.id, coinId))
      .returning({ id: coins.id });
    if (updated.length === 0) {
      throw new Error(`coinId が見つかりません: ${coinId}`);
    }
    updateTag(DASHBOARD_CACHE_TAG);
    revalidatePath("/");
    return { ok: true };
  } catch (err) {
    // P (Sentry): CLAUDE.md の運用方針 (本番エラーは Sentry で追う) に合わせて捕捉
    Sentry.captureException(err, { tags: { source: "server-action", action: "setCoinEnabled" } });
    console.error("[coins action error]", err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
