/**
 * DB リセット: 全 schema (public + drizzle) を drop して再作成する。
 * shadow trading 用なのでデータは消えて OK。
 *
 * 使用例:
 *   pnpm tsx --env-file=.env.local scripts/db/reset.ts            # local
 *   pnpm tsx --env-file=.env.prod scripts/db/reset.ts # prod
 *
 * 実行後は db:migrate (or db:migrate:prod) → seed を別途実行する。
 *
 * 安全装置: 環境変数 CONFIRM_RESET=yes が無いと拒否。
 */

import { db } from "@/db/client";
import { sql } from "drizzle-orm";

async function main() {
  if (process.env.CONFIRM_RESET !== "yes") {
    console.error("Refused. Set CONFIRM_RESET=yes to proceed.");
    process.exit(1);
  }

  console.log(`Target: ${process.env.DATABASE_URL?.replace(/:[^:@]+@/, ":***@")}`);
  console.log("Dropping public + drizzle schemas...");

  await db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE;`);
  await db.execute(sql`DROP SCHEMA IF EXISTS drizzle CASCADE;`);
  await db.execute(sql`CREATE SCHEMA public;`);
  // Supabase 標準の権限戻し (postgres は admin、anon/authenticated は client roles)
  await db.execute(sql`GRANT ALL ON SCHEMA public TO postgres;`);
  await db.execute(sql`GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;`);

  console.log("✓ Done. Next: db:migrate(:prod) → seed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
