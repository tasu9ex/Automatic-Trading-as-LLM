"use client";

import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

function LoginInner() {
  const params = useSearchParams();
  const error = params.get("error");

  async function signIn() {
    const supabase = createSupabaseBrowserClient();
    await supabase.auth.signInWithOAuth({
      provider: "github",
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background">
      <div className="w-full max-w-sm space-y-6 rounded-xl border border-border bg-card p-8 shadow-sm">
        <div className="space-y-1 text-center">
          <h1 className="font-semibold text-xl">LLM Trading</h1>
          <p className="text-muted-foreground text-sm">サインインしてダッシュボードへ</p>
        </div>

        <button
          type="button"
          onClick={signIn}
          className="w-full rounded-md bg-foreground py-2 font-medium text-background text-sm transition hover:opacity-90"
        >
          GitHub でサインイン
        </button>

        {error && <p className="text-center text-red-500 text-xs">ログイン失敗: {error}</p>}
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginInner />
    </Suspense>
  );
}
