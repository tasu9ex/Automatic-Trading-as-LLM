"use client";

import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

// Y: ?error= の素通し表示は phishing 文言注入の余地があるため enum で受ける。
// 未知の code はまとめて汎用メッセージにマップ。
const LOGIN_ERROR_MESSAGES: Record<string, string> = {
  oauth_failed: "GitHub 認証に失敗しました。もう一度お試しください。",
  callback_failed: "認証コールバックでエラーが発生しました。",
  session_expired: "セッションの有効期限が切れました。再ログインしてください。",
  unauthorized: "このアカウントではアクセスできません。",
};

function loginErrorMessage(code: string | null): string | null {
  if (!code) return null;
  return LOGIN_ERROR_MESSAGES[code] ?? "ログインでエラーが発生しました。";
}

function LoginInner() {
  const params = useSearchParams();
  const errorMessage = loginErrorMessage(params.get("error"));

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

        {errorMessage && <p className="text-center text-red-500 text-xs">{errorMessage}</p>}
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
