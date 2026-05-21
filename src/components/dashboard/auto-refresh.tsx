"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * C: dashboard を 30s 間隔で `router.refresh()` する client-only コンポーネント。
 *
 * - サイクル開始/完了で nextScheduledAt や open positions が変わるが、現状は手動 reload しか
 *   反映手段が無い。Supabase Realtime / SSE を引くほどでもないので軽量 polling で対応。
 * - tab が非アクティブのときは visibilitychange で停止 (無駄な API 叩きを避ける)。
 * - revalidateTag(DASHBOARD_CACHE_TAG) は server action 側で別途やっているので、polling は
 *   キャッシュ TTL (30s) と同じテンポでサーバから fresh を引き直す。
 */
export function AutoRefresh({ intervalMs = 30_000 }: { intervalMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    function start() {
      if (timer !== null) return;
      timer = setInterval(() => router.refresh(), intervalMs);
    }
    function stop() {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    }
    function onVisibility() {
      if (document.visibilityState === "visible") start();
      else stop();
    }
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [router, intervalMs]);

  return null;
}
