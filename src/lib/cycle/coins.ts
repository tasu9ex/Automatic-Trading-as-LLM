import { db } from "@/db/client";
import { coins, cycles } from "@/db/schema";
import { eq, sql } from "drizzle-orm";

/**
 * サイクル行に凍結された coin_ids をもとに coins レコードを取得 (phase 間で共有)。
 * cycles テーブルから coin_ids を取って coins を引く 2 クエリではなく、
 * postgres の `id = ANY(coin_ids)` を 1 クエリで叩く。
 */
export async function getCycleCoins(cycleId: string) {
  const rows = await db
    .select({
      id: coins.id,
      symbol: coins.symbol,
      name: coins.name,
      minOrderSize: coins.minOrderSize,
      makerFeeRate: coins.makerFeeRate,
      takerFeeRate: coins.takerFeeRate,
      enabled: coins.enabled,
      createdAt: coins.createdAt,
      updatedAt: coins.updatedAt,
    })
    .from(coins)
    .innerJoin(
      cycles,
      sql`${coins.id}::text = ANY(SELECT jsonb_array_elements_text(${cycles.coinIds}))`,
    )
    .where(eq(cycles.id, cycleId));
  if (rows.length === 0) {
    // cycle 行が無い、もしくは coin_ids が空 → 区別したいので明示チェック
    const cycle = (
      await db.select({ id: cycles.id }).from(cycles).where(eq(cycles.id, cycleId)).limit(1)
    )[0];
    if (!cycle) throw new Error(`Cycle not found: ${cycleId}`);
  }
  return rows;
}

export type CycleCoin = Awaited<ReturnType<typeof getCycleCoins>>[number];
