import { createLogger } from "@/lib/logging";
import { runWith } from "@/lib/rate-limit";

const logger = createLogger("clients.gmo");

/** GMO コイン Public API ベース URL (認証不要、市場情報取得用) */
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

export interface OrderbookEntry {
  price: string;
  size: string;
}

export interface Orderbook {
  symbol: string;
  asks: OrderbookEntry[]; // 売り注文 (price asc)
  bids: OrderbookEntry[]; // 買い注文 (price desc)
}

export interface PublicTrade {
  price: string;
  size: string;
  side: "BUY" | "SELL";
  timestamp: string;
}

export interface SymbolInfo {
  symbol: string;
  minOrderSize: string;
  maxOrderSize: string;
  sizeStep: string;
  /** 取引所形式の最小注文サイズ等 */
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
    // HTTP 200 でも JSON 内 status が 0 以外なら失敗 (メンテ / レート制限 / 銘柄不在 など)。
    // body 全文をログに残さないと「HTTP 200 なのに失敗扱い」のトラブルシュートが不可能になる。
    const text = await res.text();
    let json: GmoPublicResponse<T>;
    try {
      json = JSON.parse(text) as GmoPublicResponse<T>;
    } catch (parseErr) {
      logger.error({ path, body: text.slice(0, 500), parseErr }, "GMO JSON parse failed");
      throw new Error(`GMO JSON parse failed (path=${path}): ${text.slice(0, 200)}`);
    }
    if (json.status !== 0) {
      logger.error(
        { path, gmoStatus: json.status, body: text.slice(0, 500) },
        "GMO non-zero status",
      );
      throw new Error(
        `GMO non-zero status: ${json.status} (path=${path}, body=${text.slice(0, 200)})`,
      );
    }
    return json.data;
  });
}

/**
 * 取引所稼働状況。
 * status: "OPEN" / "MAINTENANCE" / "PREOPEN"
 */
export async function getExchangeStatus(): Promise<"OPEN" | "MAINTENANCE" | "PREOPEN"> {
  const data = await gmoGet<{ status: "OPEN" | "MAINTENANCE" | "PREOPEN" }>("/v1/status");
  return data.status;
}

/**
 * 現在のティッカー (現物 BTC, ETH 等)。
 */
export async function getTicker(symbol?: string): Promise<Ticker[]> {
  const path = symbol ? `/v1/ticker?symbol=${symbol}` : "/v1/ticker";
  return gmoGet<Ticker[]>(path);
}

/**
 * 板情報 (bid/ask 各 20 階層程度)。流動性スコア・スプレッド計算に使う。
 */
export async function getOrderbook(symbol: string): Promise<Orderbook> {
  return gmoGet<Orderbook>(`/v1/orderbooks?symbol=${symbol}`);
}

/**
 * 直近の約定一覧。買い/売り方向比率からマイクロセンチメントを取れる。
 * page: 1-based, count: 1-100
 */
export async function getRecentTrades(
  symbol: string,
  page = 1,
  count = 100,
): Promise<{ list: PublicTrade[]; pagination: { currentPage: number; count: number } }> {
  return gmoGet<{ list: PublicTrade[]; pagination: { currentPage: number; count: number } }>(
    `/v1/trades?symbol=${symbol}&page=${page}&count=${count}`,
  );
}

/**
 * KLine (OHLC) 取得。
 * date 形式 (GMO 公式仕様):
 *   YYYYMMDD: 1min / 5min / 10min / 15min / 30min / 1hour
 *   YYYY    : 4hour / 8hour / 12hour / 1day / 1week / 1month
 * 注: 日替わりは JST 06:00。
 */
export async function getKlines(
  symbol: string,
  interval: "1min" | "5min" | "15min" | "30min" | "1hour" | "4hour" | "8hour" | "12hour" | "1day",
  date: string,
): Promise<OHLCBar[]> {
  return gmoGet<OHLCBar[]>(`/v1/klines?symbol=${symbol}&interval=${interval}&date=${date}`);
}

/**
 * 取引所形式の対応銘柄リスト + 注文制約。
 * MVP では coins テーブルの初期データ同期に使う。
 */
export async function getSymbols(): Promise<SymbolInfo[]> {
  return gmoGet<SymbolInfo[]>("/v1/symbols");
}
