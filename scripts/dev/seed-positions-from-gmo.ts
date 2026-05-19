/**
 * GMO 現物保有を読み出し → 仮想ポジションを DB に挿入する (一回限り使う seed)。
 *
 * 約定履歴 API がないため、ユーザー申告の元本合計を全通貨に均等な損益率で割り戻し、
 * 取得価格として登録する。テスト用近似値。
 *
 * Usage:
 *   pnpm tsx --env-file=.env.local scripts/dev/seed-positions-from-gmo.ts
 */
import { db } from "@/db/client";
import { coins, pendingOrders, positions } from "@/db/schema";
import { getTicker } from "@/lib/clients/gmo";
import { getAssets } from "@/lib/clients/gmo-private";
import { and, eq, inArray } from "drizzle-orm";

// executor と同じ比率
const STOP_LIMIT_TRIGGER_RATIO = 0.75;
const STOP_LIMIT_LIMIT_RATIO = 0.73;
const STOP_MARKET_ENTRY_RATIO = 0.65;
const STOP_MARKET_PEAK_RATIO = 0.5;

/** ユーザー申告の元本合計 (¥) */
const TOTAL_COST_JPY = 98370;
/** 仮の保有開始日 (約2年前) */
const OPENED_AT = new Date(Date.now() - 730 * 86_400_000);
const STRATEGY_ID = "trial-5";

async function main() {
  const assets = (await getAssets()).filter((a) => Number(a.amount) > 0 && a.symbol !== "JPY");
  if (assets.length === 0) {
    console.log("No non-zero coin holdings.");
    return;
  }

  const symbols = assets.map((a) => a.symbol);

  // 各通貨の現在価格を Public Ticker から取得
  const currentPrices = new Map<string, number>();
  for (const sym of symbols) {
    const tickers = await getTicker(`${sym}_JPY`);
    const last = Number(tickers[0]?.last ?? 0);
    if (last > 0) currentPrices.set(sym, last);
  }

  // 現在価値合計
  let totalCurrentJpy = 0;
  for (const a of assets) {
    const p = currentPrices.get(a.symbol);
    if (!p) continue;
    totalCurrentJpy += Number(a.amount) * p;
  }

  const lossFactor = totalCurrentJpy / TOTAL_COST_JPY;
  console.log(`Cost: ¥${TOTAL_COST_JPY.toLocaleString("ja-JP")}`);
  console.log(`Current: ¥${totalCurrentJpy.toLocaleString("ja-JP", { maximumFractionDigits: 0 })}`);
  console.log(`Loss factor: ${lossFactor.toFixed(4)} (${((lossFactor - 1) * 100).toFixed(2)}%)\n`);

  // coins テーブルから ID 解決
  const coinRows = await db
    .select({ id: coins.id, symbol: coins.symbol })
    .from(coins)
    .where(inArray(coins.symbol, symbols));
  const coinIdBySymbol = new Map(coinRows.map((r) => [r.symbol, r.id]));

  // 既存 open ポジションを check & 重複防止
  const existing = await db
    .select({ coinId: positions.coinId })
    .from(positions)
    .where(and(eq(positions.strategyId, STRATEGY_ID), eq(positions.status, "open")));
  const existingCoinIds = new Set(existing.map((p) => p.coinId));

  for (const a of assets) {
    const coinId = coinIdBySymbol.get(a.symbol);
    if (!coinId) {
      console.log(`[${a.symbol}] coins テーブルに無いのでスキップ`);
      continue;
    }
    if (existingCoinIds.has(coinId)) {
      console.log(`[${a.symbol}] 既に open ポジションあり、スキップ`);
      continue;
    }
    const currentPrice = currentPrices.get(a.symbol);
    if (!currentPrice) {
      console.log(`[${a.symbol}] ticker 取得失敗、スキップ`);
      continue;
    }
    const heldAmount = Number(a.amount);
    const estimatedEntryPrice = currentPrice / lossFactor;
    const estimatedCost = heldAmount * estimatedEntryPrice;

    const peakInit = Math.max(currentPrice, estimatedEntryPrice);
    const [inserted] = await db
      .insert(positions)
      .values({
        strategyId: STRATEGY_ID,
        coinId,
        status: "open",
        quantity: a.amount,
        avgEntryPrice: estimatedEntryPrice.toFixed(4),
        peakPrice: peakInit.toFixed(4),
        troughPrice: Math.min(currentPrice, estimatedEntryPrice).toFixed(4),
        entryReason: `Seed from GMO holdings (estimated cost ¥${estimatedCost.toFixed(0)}, opened 2y ago,均等損益率法)`,
        openedAt: OPENED_AT,
        realizedPnlJpy: "0",
      })
      .returning({ id: positions.id });

    if (!inserted) throw new Error(`Failed to insert position for ${a.symbol}`);
    const positionId = inserted.id;

    // executor と同じ 3 種の逆指値を配置
    await db.insert(pendingOrders).values([
      {
        positionId,
        coinId,
        strategyId: STRATEGY_ID,
        kind: "stop_limit_primary",
        triggerPrice: (estimatedEntryPrice * STOP_LIMIT_TRIGGER_RATIO).toFixed(4),
        limitPrice: (estimatedEntryPrice * STOP_LIMIT_LIMIT_RATIO).toFixed(4),
        createdBy: "code",
      },
      {
        positionId,
        coinId,
        strategyId: STRATEGY_ID,
        kind: "stop_market_entry",
        triggerPrice: (estimatedEntryPrice * STOP_MARKET_ENTRY_RATIO).toFixed(4),
        createdBy: "code",
      },
      {
        positionId,
        coinId,
        strategyId: STRATEGY_ID,
        kind: "stop_market_peak",
        triggerPrice: (peakInit * STOP_MARKET_PEAK_RATIO).toFixed(4),
        createdBy: "code",
      },
    ]);

    console.log(
      `✓ ${a.symbol}  qty=${a.amount}  avg=¥${estimatedEntryPrice.toLocaleString("ja-JP", { maximumFractionDigits: 2 })}  cost≈¥${estimatedCost.toLocaleString("ja-JP", { maximumFractionDigits: 0 })}  + 3 stops`,
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
