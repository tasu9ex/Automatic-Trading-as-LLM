/**
 * 本番 DB を fresh state に戻す。
 *
 *   pnpm db:prod:reset
 *
 * 必須: .env.prod に `DB_PROD_RESET_PERMISSION=true` が無いと abort する。
 * 運用フロー:
 *   1. .env.prod に `DB_PROD_RESET_PERMISSION=true` を一行追加
 *   2. `pnpm db:prod:reset` を実行
 *   3. 完了後、安全のため `DB_PROD_RESET_PERMISSION` を削除 (or `=false`) してロック
 *
 * 破壊的: cycles / positions / trades / market_snapshots など **全データ消失**。
 *
 * 安全ガード:
 *   - DATABASE_URL が localhost 系だと逆に拒否 (これは本番用)
 *   - DB_PROD_RESET_PERMISSION=true でなければ abort
 *   - drop 前に現在の cycles / positions / portfolios 件数を表示
 *
 * リセット内容:
 *   - public + drizzle schema を CASCADE で DROP
 *   - 再作成
 *   - 後段で pnpm db:prod:migrate + pnpm db:prod:seed が走る
 */

import "dotenv/config";
import { db } from "@/db/client";
import { sql } from "drizzle-orm";

const PERMISSION_ENV = "DB_PROD_RESET_PERMISSION";

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (/127\.0\.0\.1|localhost/.test(url)) {
    console.error(
      "[reset-db-prod] DATABASE_URL が localhost 系です。本番 URL を向けて再実行してください。",
    );
    process.exit(1);
  }
  const hostMatch = url.match(/@([^/]+)/);
  const host = hostMatch ? hostMatch[1] : "(unknown)";

  console.log("=".repeat(60));
  console.log("本番 DB RESET");
  console.log("=".repeat(60));
  console.log(`接続先 host: ${host}`);

  // 現状サマリ
  try {
    const cycles = await db.execute(sql`SELECT COUNT(*)::int AS n FROM cycles`);
    const positions = await db.execute(sql`SELECT COUNT(*)::int AS n FROM positions`);
    const trades = await db.execute(sql`SELECT COUNT(*)::int AS n FROM trades`);
    const portfolios = await db.execute(sql`SELECT cash_jpy FROM portfolios LIMIT 1`);
    console.log("現在の状態:");
    console.log(`  cycles:    ${(cycles[0] as { n: number }).n}`);
    console.log(`  positions: ${(positions[0] as { n: number }).n}`);
    console.log(`  trades:    ${(trades[0] as { n: number }).n}`);
    console.log(
      `  cash_jpy:  ${(portfolios[0] as { cash_jpy: string } | undefined)?.cash_jpy ?? "(no row)"}`,
    );
  } catch (err) {
    console.log("(現状取得失敗、schema が既に空かもしれません)", err);
  }
  console.log("");

  // 許可フラグ: env var が "true" のときだけ進む
  const permission = process.env[PERMISSION_ENV];
  if (permission !== "true") {
    console.error(
      [
        `${PERMISSION_ENV}=true が .env.prod に無いため abort します。`,
        "  1. .env.prod に以下を追加:",
        `       ${PERMISSION_ENV}=true`,
        "  2. pnpm db:prod:reset を再実行",
        `  3. 完了後、安全のため ${PERMISSION_ENV} 行は削除 (or =false) してロック`,
      ].join("\n"),
    );
    process.exit(1);
  }
  console.log(`(${PERMISSION_ENV}=true を確認、進行します)`);

  console.log("Dropping schemas (public + drizzle)...");
  await db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE`);
  await db.execute(sql`DROP SCHEMA IF EXISTS drizzle CASCADE`);
  await db.execute(sql`CREATE SCHEMA public`);
  await db.execute(sql`GRANT ALL ON SCHEMA public TO postgres`);
  await db.execute(sql`GRANT ALL ON SCHEMA public TO public`);
  console.log("✓ schema reset done. Next: pnpm db:prod:migrate && pnpm db:prod:seed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
