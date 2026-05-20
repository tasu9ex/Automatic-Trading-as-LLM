import { db } from "@/db/client";
import { sql } from "drizzle-orm";

async function main() {
  const target = process.env.DATABASE_URL?.replace(/:[^:@]+@/, ":***@");
  console.log(`Target: ${target}\n`);

  const migrations = await db.execute(
    sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`,
  );
  console.log(`migrations applied: ${(migrations as unknown as { n: number }[])[0]?.n}`);

  const tables = [
    "coins",
    "portfolios",
    "system_state",
    "system_events",
    "market_snapshots",
    "pre_analyst_outputs",
    "analyst_outputs",
    "decisions",
    "critic_outputs",
    "orders",
    "trades",
    "positions",
    "pending_orders",
  ];
  for (const t of tables) {
    const r = await db.execute(sql.raw(`SELECT count(*)::int AS n FROM "${t}"`));
    const n = (r as unknown as { n: number }[])[0]?.n;
    console.log(`${t.padEnd(22)} ${n}`);
  }

  // orders に fee / slippage が無いことを確認
  const cols = await db.execute(
    sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'orders' ORDER BY ordinal_position`,
  );
  const colNames = (cols as unknown as { column_name: string }[]).map((c) => c.column_name);
  console.log(`\norders columns: ${colNames.join(", ")}`);
  const tradeCols = await db.execute(
    sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'trades' ORDER BY ordinal_position`,
  );
  const tradeColNames = (tradeCols as unknown as { column_name: string }[]).map(
    (c) => c.column_name,
  );
  console.log(`trades columns: ${tradeColNames.join(", ")}`);

  // system_event_kind enum
  const enums = await db.execute(
    sql`SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'system_event_kind' ORDER BY enumsortorder`,
  );
  const enumValues = (enums as unknown as { enumlabel: string }[]).map((e) => e.enumlabel);
  console.log(`system_event_kind: ${enumValues.join(", ")}`);

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
