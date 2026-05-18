import {
  getExchangeStatus,
  getKlines,
  getOrderbook,
  getRecentTrades,
  getSymbols,
  getTicker,
} from "@/lib/clients/gmo";

const TODAY = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const THIS_YEAR = TODAY.slice(0, 4);

async function main() {
  console.log("=== GMO Smoke Test ===\n");

  const [status, tickers, symbols, book, trades, klines1min, klines1day] = await Promise.all([
    getExchangeStatus(),
    getTicker("BTC"),
    getSymbols(),
    getOrderbook("BTC"),
    getRecentTrades("BTC", 1, 5),
    getKlines("BTC", "1min", TODAY),
    getKlines("BTC", "1day", THIS_YEAR),
  ]);

  const btc = tickers[0];
  console.log(`[status] ${status}`);
  console.log(`[ticker] BTC last=${btc.last} ask=${btc.ask} bid=${btc.bid}`);
  console.log(
    `[symbols] ${symbols.length} 銘柄 (例: ${symbols
      .slice(0, 3)
      .map((s) => s.symbol)
      .join(", ")} ...)`,
  );
  console.log(
    `[orderbook] asks=${book.asks.length} bids=${book.bids.length} top-ask=${book.asks[0]?.price}`,
  );
  console.log(
    `[trades] 直近 ${trades.list.length} 件 最新=${trades.list[0]?.price} (${trades.list[0]?.side})`,
  );
  console.log(`[klines 1min] ${klines1min.length} 本`);
  console.log(`[klines 1day] ${klines1day.length} 本`);

  console.log("\n✓ GMO Public API — 全項目 OK");
}

main().catch((err) => {
  console.error("GMO smoke test FAILED:", err);
  process.exit(1);
});
