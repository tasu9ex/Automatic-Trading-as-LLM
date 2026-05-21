/**
 * GMO Public API スモーク。
 * - ステータス / ティッカー / シンボル / 板 / 約定
 * - cycle interval (30min/1h/4h/8h/12h/1day) 全 6 種で getKlines が正しい date param で本数を返すこと
 *
 * §仕様 (GMO 公式):
 *   YYYYMMDD: 1min / 5min / 10min / 15min / 30min / 1hour
 *   YYYY    : 4hour / 8hour / 12hour / 1day / 1week / 1month
 */
import {
  getExchangeStatus,
  getKlines,
  getOrderbook,
  getRecentTrades,
  getSymbols,
  getTicker,
} from "@/lib/clients/gmo";
import type { KlineInterval } from "@/lib/system-control/constants";

const SYMBOL = "BTC_JPY";

function todayYyyymmddJst(): string {
  const jst = new Date(Date.now() + 9 * 3600_000);
  return `${jst.getUTCFullYear()}${String(jst.getUTCMonth() + 1).padStart(2, "0")}${String(jst.getUTCDate()).padStart(2, "0")}`;
}
function yesterdayYyyymmddJst(): string {
  const jst = new Date(Date.now() - 24 * 3600_000 + 9 * 3600_000);
  return `${jst.getUTCFullYear()}${String(jst.getUTCMonth() + 1).padStart(2, "0")}${String(jst.getUTCDate()).padStart(2, "0")}`;
}

const THIS_YEAR = String(new Date().getUTCFullYear());

interface CycleKlineCase {
  cycleLabel: string;
  interval: KlineInterval;
  /** YYYYMMDD or YYYY */
  param: string;
  paramKind: "YYYYMMDD" | "YYYY";
}

const CASES: CycleKlineCase[] = [
  { cycleLabel: "30min", interval: "30min", param: todayYyyymmddJst(), paramKind: "YYYYMMDD" },
  { cycleLabel: "1h", interval: "1hour", param: todayYyyymmddJst(), paramKind: "YYYYMMDD" },
  { cycleLabel: "4h", interval: "4hour", param: THIS_YEAR, paramKind: "YYYY" },
  { cycleLabel: "8h", interval: "8hour", param: THIS_YEAR, paramKind: "YYYY" },
  { cycleLabel: "12h", interval: "12hour", param: THIS_YEAR, paramKind: "YYYY" },
  { cycleLabel: "1day", interval: "1day", param: THIS_YEAR, paramKind: "YYYY" },
];

async function main() {
  console.log("=== GMO Smoke Test ===\n");

  const [status, tickers, symbols, book, trades] = await Promise.all([
    getExchangeStatus(),
    getTicker("BTC"),
    getSymbols(),
    getOrderbook(SYMBOL),
    getRecentTrades(SYMBOL, 1, 5),
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

  console.log("\n=== Cycle Interval × Kline (date param 仕様検証) ===");
  let failures = 0;
  for (const c of CASES) {
    let bars = await getKlines(SYMBOL, c.interval, c.param);
    let extraNote = "";
    // YYYYMMDD 系 (30min/1hour): 早朝はまだ空のことがあるので yesterday へ fallback
    if (bars.length === 0 && c.paramKind === "YYYYMMDD") {
      const y = yesterdayYyyymmddJst();
      bars = await getKlines(SYMBOL, c.interval, y);
      extraNote = ` (fallback ${y})`;
    }
    const ok = bars.length > 0;
    console.log(
      `  [${ok ? "✓" : "✗"}] cycle=${c.cycleLabel.padEnd(5)} interval=${c.interval.padEnd(6)} param=${c.param} (${c.paramKind})${extraNote} → ${bars.length} 本`,
    );
    if (!ok) failures++;
  }

  if (failures > 0) {
    console.error(`\n✗ ${failures}/${CASES.length} 件失敗 — date param 仕様を再確認`);
    process.exit(1);
  }

  console.log(`\n✓ GMO Public API — 全 ${CASES.length} cycle interval OK`);
}

main().catch((err) => {
  console.error("GMO smoke test FAILED:", err);
  process.exit(1);
});
