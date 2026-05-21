/**
 * ローカル開発用: スキーマ全削除して fresh state にする。
 *
 *   pnpm db:reset
 *
 * 実行内容:
 *   1. public schema を CASCADE で DROP
 *   2. public schema を再作成 (drizzle migrate が走れる状態に)
 *
 * db:reset スクリプト (package.json) が、このスクリプト → drizzle migrate → seed を順次実行する。
 *
 * **本番 DB には絶対に走らせないこと**。.env.local の DATABASE_URL のみ向ける。
 */

import "dotenv/config";
import { db } from "@/db/client";
import { sql } from "drizzle-orm";

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  // 雑だが事故防止: localhost / 127.0.0.1 / supabase の local pooler (127.0.0.1:54322 等) 以外は拒否
  if (!/127\.0\.0\.1|localhost/.test(url)) {
    console.error(
      `[reset-db] DATABASE_URL が localhost 系ではないため中断: ${url.replace(/:[^:@]+@/, ":***@")}`,
    );
    console.error("本番 DB を消したくないので明示的に localhost のみ許可しています。");
    process.exit(1);
  }
  console.log("Dropping schemas (public + drizzle)...");
  // drizzle schema は migrate のメタデータが入っているので一緒に drop しないと
  // 「すでに全 migration 適用済」と判定されてテーブル再作成が起きない。
  await db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE`);
  await db.execute(sql`DROP SCHEMA IF EXISTS drizzle CASCADE`);
  await db.execute(sql`CREATE SCHEMA public`);
  await db.execute(sql`GRANT ALL ON SCHEMA public TO postgres`);
  await db.execute(sql`GRANT ALL ON SCHEMA public TO public`);
  console.log("✓ schema reset done. Next: pnpm db:migrate && pnpm db:seed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
