/**
 * Drizzle マイグレーションの整合性チェック(CI guard)。
 *
 * 検出するもの:
 *  1. _journal.json の when (timestamp) が単調増加か
 *     - drizzle-kit migrate は MAX(created_at) より大きいものしか適用しないため、
 *       時系列が逆転すると silent skip される
 *  2. journal の各エントリに対応する .sql ファイルが存在するか
 *  3. .sql ファイルが journal にないものを孤立として検出
 *
 * Usage:
 *   pnpm db:check
 *
 * 不一致あり → exit 1
 */

import fs from "node:fs";
import path from "node:path";
import {
  detectTransactionControlViolations,
  formatTransactionControlViolations,
} from "@/lib/drizzle/detect-transaction-control";

interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
  breakpoints?: boolean;
}

interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

const MIGRATIONS_DIR = path.resolve("drizzle/migrations");
const JOURNAL_PATH = path.join(MIGRATIONS_DIR, "meta", "_journal.json");

function readJournal(): Journal {
  if (!fs.existsSync(JOURNAL_PATH)) {
    throw new Error(`Journal not found at ${JOURNAL_PATH}`);
  }
  return JSON.parse(fs.readFileSync(JOURNAL_PATH, "utf8")) as Journal;
}

function listSqlFiles(): Set<string> {
  if (!fs.existsSync(MIGRATIONS_DIR)) return new Set();
  return new Set(fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")));
}

function main() {
  const errors: string[] = [];

  const journal = readJournal();
  const entries = [...journal.entries].sort((a, b) => a.idx - b.idx);

  // 1. monotonic when
  for (let i = 1; i < entries.length; i++) {
    const prev = entries[i - 1];
    const curr = entries[i];
    if (!prev || !curr) continue;
    if (curr.when <= prev.when) {
      errors.push(
        `[order] non-monotonic: idx ${prev.idx} (${prev.tag}, when=${prev.when}) ` +
          `>= idx ${curr.idx} (${curr.tag}, when=${curr.when})`,
      );
    }
  }

  // 2. journal -> sql file existence
  const sqlFiles = listSqlFiles();
  for (const entry of entries) {
    const expected = `${entry.tag}.sql`;
    if (!sqlFiles.has(expected)) {
      errors.push(`[missing] journal idx ${entry.idx} (${entry.tag}): ${expected} not found`);
    }
  }

  // 3. orphan sql files
  const tagged = new Set(entries.map((e) => `${e.tag}.sql`));
  for (const f of sqlFiles) {
    if (!tagged.has(f)) {
      errors.push(`[orphan] ${f}: no journal entry`);
    }
  }

  // 4. transaction control violations (BEGIN/COMMIT/ROLLBACK/SAVEPOINT)
  for (const f of sqlFiles) {
    const fullPath = path.join(MIGRATIONS_DIR, f);
    const sql = fs.readFileSync(fullPath, "utf8");
    const violations = detectTransactionControlViolations(sql);
    if (violations.length > 0) {
      errors.push(
        `[transaction] ${f}: ${violations.length} forbidden keyword(s):\n${formatTransactionControlViolations(f, violations)}`,
      );
    }
  }

  if (errors.length > 0) {
    console.error("Drizzle migration check FAILED:");
    for (const e of errors) console.error(`  ${e}`);
    process.exit(1);
  }

  console.log(`✓ ${entries.length} migration(s) consistent`);
  process.exit(0);
}

main();
