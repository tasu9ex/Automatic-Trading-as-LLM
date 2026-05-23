import { DASHBOARD_CACHE_TAG } from "@/lib/cycle/queries";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import * as Sentry from "@sentry/nextjs";
import { revalidatePath, updateTag } from "next/cache";

/**
 * server action 共通: Supabase session を確認し未ログインなら throw。
 * 戻り値の user は現状未使用 (今後 audit ログ等で必要なら使う)。
 */
export async function requireUser() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    throw new Error("ログインが必要です");
  }
  return user;
}

export type ServerActionResult = { ok: true } | { ok: false; error: string };

/**
 * server action 共通: 成功時に dashboard キャッシュを無効化、失敗時に Sentry へ送出。
 *
 * - 成功: `updateTag(DASHBOARD_CACHE_TAG)` + `revalidatePath("/")` → UI 即時反映
 * - 失敗: Sentry.captureException + console.error + `{ ok: false, error: message }`
 *
 * `source` タグは Sentry のフィルタ用 (例: "system-control" / "coins")。
 */
export function withResult(
  source: string,
  fn: () => Promise<unknown>,
): Promise<ServerActionResult> {
  return fn()
    .then(() => {
      // updateTag は unstable_cache 内のエントリを、revalidatePath は path の RSC キャッシュを無効化。
      // page.tsx は force-dynamic なので revalidatePath は router.refresh() 後の再 fetch を担保する意図。
      updateTag(DASHBOARD_CACHE_TAG);
      revalidatePath("/");
      return { ok: true as const };
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      Sentry.captureException(err, { tags: { source: "server-action", group: source } });
      console.error(`[${source} action error]`, err);
      return { ok: false as const, error: message };
    });
}
