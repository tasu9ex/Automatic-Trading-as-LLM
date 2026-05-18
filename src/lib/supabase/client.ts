"use client";

import { createBrowserClient } from "@supabase/ssr";

/** Client Component から呼ぶ用 (ブラウザ実行)。 */
export function createSupabaseBrowserClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
  );
}
