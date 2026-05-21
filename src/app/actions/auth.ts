"use server";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import * as Sentry from "@sentry/nextjs";
import { redirect } from "next/navigation";

/**
 * U: ログアウト。cookie 手動削除しかなかった状態を解消。
 * 成功時は /login に redirect (Supabase が cookie を invalidate 済)。
 */
export async function signOutAction(): Promise<void> {
  try {
    const supabase = await createSupabaseServerClient();
    await supabase.auth.signOut();
  } catch (err) {
    Sentry.captureException(err, { tags: { source: "server-action", action: "signOut" } });
    console.error("[auth action error]", err);
  }
  redirect("/login");
}
