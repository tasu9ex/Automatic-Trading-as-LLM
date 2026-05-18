/**
 * GMO コイン現物口座の保有残高 + 約定履歴から平均取得価格を推定して表示 (READ-ONLY)。
 * DB は変更しない。
 *
 * Usage:
 *   pnpm tsx --env-file=.env.local scripts/dev/dump-gmo-positions.ts
 */
import { type Execution, getAssets, getLatestExecutions } from "@/lib/clients/gmo-private";

interface DerivedPosition {
  symbol: string;
  heldAmount: number;
  avgEntryPrice: number;
  earliestBuyAt: Date;
  totalBuyCount: number;
  totalSellCount: number;
  peakPrice: number;
  troughPrice: number;
}

/**
 * 約定履歴 (古い順) を replay して、現在残高に対応する平均取得価格・保有開始時刻を推定。
 *
 * 単純な FIFO 重み付き平均:
 *   BUY:  cost += size * price, amount += size
 *   SELL: cost を amount に比例して削減 (avg price は変わらない), amount -= size
 * 最後に avg = cost / amount。
 *
 * 履歴ページの取得範囲外の古い BUY が残っている場合は推定が外れるが、
 * 直近 100 件で残高の説明がつかない場合は警告。
 */
function derivePosition(
  symbol: string,
  heldAmount: number,
  executions: Execution[],
): DerivedPosition | null {
  if (heldAmount <= 0) return null;

  // 古い順にソート
  const sorted = [...executions].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  let amount = 0;
  let cost = 0;
  let earliestBuyAt: Date | null = null;
  let buyCount = 0;
  let sellCount = 0;
  let peakPrice = 0;
  let troughPrice = Number.POSITIVE_INFINITY;

  for (const ex of sorted) {
    const size = Number(ex.size);
    const price = Number(ex.price);
    peakPrice = Math.max(peakPrice, price);
    troughPrice = Math.min(troughPrice, price);

    if (ex.side === "BUY") {
      buyCount++;
      if (!earliestBuyAt) earliestBuyAt = new Date(ex.timestamp);
      cost += size * price;
      amount += size;
    } else {
      sellCount++;
      if (amount > 0) {
        const sellPortion = Math.min(size, amount) / amount;
        cost -= cost * sellPortion;
      }
      amount -= size;
      if (amount <= 1e-12) {
        amount = 0;
        cost = 0;
        earliestBuyAt = null; // 完全クローズ後の新規エントリ
      }
    }
  }

  if (Math.abs(amount - heldAmount) / heldAmount > 0.05) {
    console.warn(
      `[${symbol}] WARN: replay amount=${amount} vs held=${heldAmount} (5%超のズレ、履歴外の古い約定の可能性)`,
    );
  }

  return {
    symbol,
    heldAmount,
    avgEntryPrice: amount > 0 ? cost / amount : 0,
    earliestBuyAt: earliestBuyAt ?? new Date(),
    totalBuyCount: buyCount,
    totalSellCount: sellCount,
    peakPrice,
    troughPrice: Number.isFinite(troughPrice) ? troughPrice : 0,
  };
}

async function main() {
  const assets = await getAssets();
  const nonZeroCoins = assets.filter((a) => Number(a.amount) > 0 && a.symbol !== "JPY");

  console.log(`=== GMO Spot Holdings (${nonZeroCoins.length} coins, JPY 除外) ===\n`);

  for (const a of nonZeroCoins) {
    const heldAmount = Number(a.amount);
    const rate = Number(a.conversionRate);
    const currentJpy = heldAmount * rate;

    let execs: Execution[] = [];
    try {
      const res = await getLatestExecutions({ symbol: a.symbol, count: 100 });
      execs = res.list;
    } catch (err) {
      console.log(`[${a.symbol}] 約定履歴取得エラー: ${(err as Error).message}`);
      continue;
    }

    const derived = derivePosition(a.symbol, heldAmount, execs);
    if (!derived) continue;

    const pnl = heldAmount * (rate - derived.avgEntryPrice);
    const pnlPct = derived.avgEntryPrice > 0 ? (rate / derived.avgEntryPrice - 1) * 100 : 0;
    const holdingDays = (Date.now() - derived.earliestBuyAt.getTime()) / 86_400_000;

    console.log(
      `${a.symbol}  held=${a.amount}  current=¥${rate.toLocaleString("ja-JP")}  market=¥${currentJpy.toLocaleString("ja-JP", { maximumFractionDigits: 0 })}`,
    );
    console.log(
      `       avg=¥${derived.avgEntryPrice.toLocaleString("ja-JP", { maximumFractionDigits: 2 })}  pnl=¥${pnl.toLocaleString("ja-JP", { maximumFractionDigits: 0 })} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%)  hold=${holdingDays.toFixed(1)}d  (buys=${derived.totalBuyCount}, sells=${derived.totalSellCount})`,
    );
    console.log("");
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
