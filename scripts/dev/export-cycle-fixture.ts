/**
 * 直近の cycle (デフォルト) または指定 cycleId のフルレコードを
 * scripts/dev/fixtures/sample-cycle.json に export する。
 *
 * 用途: 新規開発環境やテスト用 fixture として利用。
 *
 * Usage:
 *   pnpm tsx --env-file=.env.prod scripts/dev/export-cycle-fixture.ts
 *   pnpm tsx --env-file=.env.prod scripts/dev/export-cycle-fixture.ts <cycleId>
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { db } from "@/db/client";
import {
  analystOutputs,
  coins,
  criticOutputs,
  cycles,
  decisions,
  marketSnapshots,
  preAnalystOutputs,
} from "@/db/schema";
import { desc, eq, inArray } from "drizzle-orm";

async function main() {
  const arg = process.argv[2];
  const cycle = arg
    ? (await db.select().from(cycles).where(eq(cycles.id, arg)).limit(1))[0]
    : (await db.select().from(cycles).orderBy(desc(cycles.startedAt)).limit(1))[0];
  if (!cycle) throw new Error("cycle not found");

  const snapshotRows = await db
    .select()
    .from(marketSnapshots)
    .where(eq(marketSnapshots.cycleId, cycle.id));
  const snapshotIds = snapshotRows.map((s) => s.id);
  const coinIds = Array.from(new Set(snapshotRows.map((s) => s.coinId)));

  const [coinRows, preRows, analystRows, criticRow] = await Promise.all([
    coinIds.length
      ? db.select().from(coins).where(inArray(coins.id, coinIds))
      : Promise.resolve([]),
    snapshotIds.length
      ? db
          .select()
          .from(preAnalystOutputs)
          .where(inArray(preAnalystOutputs.snapshotId, snapshotIds))
      : Promise.resolve([]),
    snapshotIds.length
      ? db.select().from(analystOutputs).where(inArray(analystOutputs.snapshotId, snapshotIds))
      : Promise.resolve([]),
    db
      .select()
      .from(criticOutputs)
      .where(eq(criticOutputs.cycleId, cycle.id))
      .limit(1)
      .then((r) => r[0] ?? null),
  ]);

  const analystIds = analystRows.map((a) => a.id);
  const decisionRows = analystIds.length
    ? await db.select().from(decisions).where(inArray(decisions.analystId, analystIds))
    : [];

  const out = {
    exportedAt: new Date().toISOString(),
    source: "production",
    cycle,
    coins: coinRows,
    marketSnapshots: snapshotRows,
    preAnalystOutputs: preRows,
    analystOutputs: analystRows,
    decisions: decisionRows,
    criticOutput: criticRow,
  };

  const outPath = join(process.cwd(), "scripts/dev/fixtures/sample-cycle.json");
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  console.log(`✓ wrote ${outPath}`);
  console.log(
    `  cycle=${cycle.id} snapshots=${snapshotRows.length} decisions=${decisionRows.length} critic=${criticRow ? criticRow.decision : "none"}`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
