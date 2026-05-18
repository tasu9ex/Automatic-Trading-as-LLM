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
export const { GET, POST, PUT } = serve({ client: inngest, functions });
