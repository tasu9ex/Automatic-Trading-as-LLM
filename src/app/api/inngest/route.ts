import { inngest } from "@/lib/inngest/client";
import { functions } from "@/lib/inngest/functions";
import { serve } from "inngest/next";

/**
 * Inngest webhook handler。
 * Inngest Cloud / Dev Server が cron 時刻に POST してくる。
 *
 * 設定 env (Inngest Cloud 接続時のみ):
 *   INNGEST_EVENT_KEY
 *   INNGEST_SIGNING_KEY
 */

// Inngest の各 step.run は単独 HTTP invocation として実行される。
// tier0 (perplexity + grok 並列検索) が N 銘柄でバッチ複数になると 60s 近くまで伸びるため、
// Vercel plan default に依存せず明示的に上限を確保する (Pro 上限 300s, Fluid なら更に上)。
export const maxDuration = 180;

export const { GET, POST, PUT } = serve({ client: inngest, functions });
