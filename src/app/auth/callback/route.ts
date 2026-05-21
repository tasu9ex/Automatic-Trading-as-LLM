import { createSupabaseServerClient } from "@/lib/supabase/server";
import { type NextRequest, NextResponse } from "next/server";

/**
 * GitHub OAuth から戻ってきた時の認可コード処理。
 *   ?code=xxx を session に交換して、元のページにリダイレクト。
 */
// X: ?next= の検証。現状は文字列連結で外部 redirect は構造上できないが、
// 将来 `new URL(next)` リファクタで穴になるのを防ぐ。
//   - "/" で始まる
//   - "//" で始まらない (protocol-relative URL を弾く)
//   - "/\\" で始まらない (Windows-style protocol-relative も弾く)
function safeNextPath(raw: string | null): string {
  if (!raw) return "/";
  if (!raw.startsWith("/")) return "/";
  if (raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  return raw;
}

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = safeNextPath(searchParams.get("next"));

  if (code) {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  // Y: enum 化された code に統一
  return NextResponse.redirect(`${origin}/login?error=callback_failed`);
}
