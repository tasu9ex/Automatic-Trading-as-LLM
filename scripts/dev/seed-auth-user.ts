/**
 * Supabase Auth に「自分」のユーザーレコードを事前 seed する。
 *
 * 目的: OAuth サインアップを無効化した状態でも、メール一致で既存ユーザーに
 *      GitHub identity が自動リンクされるので、自分だけがログイン可能になる。
 *
 * Usage:
 *   pnpm tsx --env-file=.env.prod scripts/dev/seed-auth-user.ts
 *
 * 必要 env:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */
import { createClient } from "@supabase/supabase-js";

const ALLOWED_EMAIL = "REDACTED_EMAIL";

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing");
  }

  const admin = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 既存確認
  const { data: list, error: listErr } = await admin.auth.admin.listUsers();
  if (listErr) throw listErr;
  const existing = list.users.find((u) => u.email === ALLOWED_EMAIL);

  if (existing) {
    console.log(`✓ already exists: ${ALLOWED_EMAIL} (id=${existing.id})`);
    return;
  }

  const { data, error } = await admin.auth.admin.createUser({
    email: ALLOWED_EMAIL,
    email_confirm: true,
  });
  if (error) throw error;

  console.log(`✓ created: ${data.user?.email} (id=${data.user?.id})`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
