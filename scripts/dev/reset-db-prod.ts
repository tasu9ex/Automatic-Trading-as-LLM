/**
 * 本番 DB を fresh state に戻す。
 *
 *   pnpm db:prod:reset                        # 対話モード
 *   pnpm db:prod:reset -- --confirm RESET_PRODUCTION  # 非対話 (CI / Claude Code)
 *
 * 破壊的: cycles / positions / trades / market_snapshots など **全データ消失**。
 *
 * 安全ガード:
 *   1. DATABASE_URL が localhost 系だと逆に拒否 (これは本番用)
 *   2. 確認:
 *      - 対話 TTY: "RESET PRODUCTION" の手打ち入力を要求
 *      - 非対話: --confirm RESET_PRODUCTION フラグが必須 (なければ abort)
 *   3. drop 前に現在の cycles / positions / portfolios 件数を表示
 *
 * リセット内容:
 *   - public + drizzle schema を CASCADE で DROP
 *   - 再作成
 *   - 後段で pnpm db:prod:migrate + pnpm db:prod:seed が走る
 */

import "dotenv/config";
import { stdin, stdout } from "node:process";
import readline from "node:readline/promises";
import { db } from "@/db/client";
import { sql } from "drizzle-orm";

const REQUIRED_CONFIRM = "RESET_PRODUCTION";

function parseConfirmFlag(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--confirm") return argv[i + 1] ?? null;
  }
  return null;
}

async function readConfirmInteractive(): Promise<string> {
  console.log("⚠️ 上記データは全て消えます。続行するには 'RESET PRODUCTION' と入力:");
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const answer = await rl.question("> ");
  rl.close();
  // 対話モードは "RESET PRODUCTION" (スペース区切り) を許容、コードでは underscore に正規化
  return answer.trim().replace(/\s+/g, "_");
}

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

  // 確認: --confirm フラグ優先 / なければ対話 TTY / それも無理なら abort
  const flagToken = parseConfirmFlag(process.argv.slice(2));
  let token: string;
  if (flagToken !== null) {
    token = flagToken;
    console.log(`(--confirm フラグ受信: ${flagToken})`);
  } else if (stdin.isTTY) {
    token = await readConfirmInteractive();
  } else {
    console.error(
      "非対話モードで --confirm フラグが指定されていません。abort します。\n" +
        "  pnpm db:prod:reset -- --confirm RESET_PRODUCTION",
    );
    process.exit(1);
  }

  if (token !== REQUIRED_CONFIRM) {
    console.error(`確認文字列が一致しません (期待: ${REQUIRED_CONFIRM})。中断します。`);
    process.exit(1);
  }

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
