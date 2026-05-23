import { db } from "@/db/client";
import { marketSnapshots } from "@/db/schema";
import type { Snapshot } from "@/lib/tier0/fetch-snapshot";
import { and, eq } from "drizzle-orm";

export type SnapshotRow = typeof marketSnapshots.$inferSelect;

/**
 * 指定 cycle × coin の snapshot 行を引く。idempotency check と本 fetch の両方で使う。
 * 行は呼び元で再利用するので、見つかったらそのまま row を返す (loadSnapshotFromRow に渡せる)。
 */
export async function getCycleSnapshot(
  cycleId: string,
  coinId: string,
): Promise<SnapshotRow | null> {
  return (
    (
      await db
        .select()
        .from(marketSnapshots)
        .where(and(eq(marketSnapshots.cycleId, cycleId), eq(marketSnapshots.coinId, coinId)))
        .limit(1)
    )[0] ?? null
  );
}

/** snapshot 行 + coin 情報を結合して Snapshot 型に復元。行は呼び元が既に握っている前提 (二重 fetch 防止)。 */
export function loadSnapshotFromRow(
  row: SnapshotRow,
  coin: { symbol: string; name: string },
): Snapshot {
  const ohlcv = (row.ohlcv as Snapshot["ohlcv"] | null) ?? [];
  const klineInterval = (row.klineInterval as Snapshot["klineInterval"] | null) ?? "1day";

  // ticker は新規行は DB に直接保存 (§31 根治)。旧行は最終 bar の close で再構成 fallback。
  const tickerRow = row.ticker as Snapshot["ticker"] | null;
  const ticker: Snapshot["ticker"] = tickerRow ?? {
    last: ohlcv.at(-1)?.close ?? "0",
    bid: ohlcv.at(-1)?.close ?? "0",
    ask: ohlcv.at(-1)?.close ?? "0",
    volume: "0",
  };

  return {
    symbol: coin.symbol,
    name: coin.name,
    fetchedAt: row.fetchedAt,
    perplexitySummary: row.perplexitySummary ?? "情報なし",
    perplexityCitations: row.perplexityCitations,
    grokSummary: row.grokSummary ?? "情報なし",
    grokCitations: row.grokCitations,
    ohlcv,
    klineInterval,
    ticker,
    micro: (row.micro as Snapshot["micro"] | null) ?? null,
  };
}
