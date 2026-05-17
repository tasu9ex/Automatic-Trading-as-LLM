import { createLogger } from "@/lib/logging";
import { runWith } from "@/lib/rate-limit";

const logger = createLogger("clients.gmo");

/** GMO コイン Public API ベース URL (認証不要、価格取得用) */
const PUBLIC_BASE = "https://api.coin.z.com/public";

export interface OHLCBar {
  openTime: number; // unix ms
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

export interface Ticker {
  symbol: string;
  ask: string;
  bid: string;
  last: string;
  high: string;
  low: string;
  volume: string;
  timestamp: string;
}

interface GmoPublicResponse<T> {
  status: number;
  data: T;
  responsetime: string;
}

async function gmoGet<T>(path: string): Promise<T> {
  return runWith("gmo", async () => {
    const res = await fetch(`${PUBLIC_BASE}${path}`);
    if (!res.ok) {
      const body = await res.text();
      logger.error({ status: res.status, path, body }, "GMO API error");
      throw new Error(`GMO ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as GmoPublicResponse<T>;
    if (json.status !== 0) {
      throw new Error(`GMO non-zero status: ${json.status}`);
    }
    return json.data;
  });
}

/**
 * 現在のティッカー (現物 BTC, ETH 等)。
 */
export async function getTicker(symbol?: string): Promise<Ticker[]> {
  const path = symbol ? `/v1/ticker?symbol=${symbol}` : "/v1/ticker";
  return gmoGet<Ticker[]>(path);
}

/**
 * KLine (OHLC) 取得。interval: 1min, 5min, 15min, 30min, 1hour, 4hour, 8hour, 12hour, 1day, ...
 * date: YYYYMMDD (1min-30min) or YYYY (1hour-)
 */
export async function getKlines(
  symbol: string,
  interval: "1min" | "5min" | "15min" | "30min" | "1hour" | "4hour" | "1day",
  date: string,
): Promise<OHLCBar[]> {
  const data = await gmoGet<OHLCBar[]>(
    `/v1/klines?symbol=${symbol}&interval=${interval}&date=${date}`,
  );
  return data;
}
