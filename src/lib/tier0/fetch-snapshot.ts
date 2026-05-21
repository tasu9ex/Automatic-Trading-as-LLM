import {
  type OHLCBar,
  type Orderbook,
  type PublicTrade,
  type Ticker,
  getKlines,
  getOrderbook,
  getRecentTrades,
  getTicker,
} from "@/lib/clients/gmo";
import { callGrok } from "@/lib/clients/grok";
import { callPerplexity } from "@/lib/clients/perplexity";
import { createLogger } from "@/lib/logging";
import { getPrompt } from "@/lib/prompts";
import { withGenerationSpan } from "@/lib/telemetry";

const logger = createLogger("tier0.fetch-snapshot");

/** GMO がサポートする kline interval のうち本プロジェクトで使う subset */
export type KlineInterval = "1min" | "5min" | "15min" | "1hour" | "4hour" | "1day";

export interface FetchSnapshotInput {
  symbol: string; // 例: "BTC"
  /** プロジェクト正式名称 (例: "Bitcoin")、Tier 0 検索品質向上のため */
  name?: string;
  /** Tier 0 の検索対象期間 (時間)。デフォルト 24h。サイクル頻度に応じて呼出側で設定。 */
  periodHours?: number;
  /**
   * §32: サイクル間隔。primary/long TF の選択に使う。
   * 未指定なら 1h サイクル想定 (=primary 1hour / long 1day)。
   */
  cycleIntervalHours?: number;
}

export interface MicroMarket {
  /** スプレッド (ask - bid) / mid、% */
  spreadPct: number;
  /** top-5 bid サイズ合計 (流動性近似) */
  bidDepth5: number;
  /** top-5 ask サイズ合計 */
  askDepth5: number;
  /** 板の偏り: bidDepth5 / (bidDepth5 + askDepth5) → 0.5 が均衡、>0.5 が買い厚 */
  bidBias: number;
  /** 直近 N 約定の buy/sell 比率: BUY 件数 / 総件数 → 0.5 が均衡、>0.5 が買い優勢 */
  tradeBuyRatio: number;
  /** 観測した約定件数 */
  tradeCount: number;
}

export interface Snapshot {
  symbol: string;
  /** プロジェクト正式名称 (例: "Bitcoin")、symbol fallback あり */
  name: string;
  fetchedAt: Date;
  perplexitySummary: string;
  perplexityCitations: string[];
  grokSummary: string;
  grokCitations: string[];
  /** メイン TF (サイクル間隔と同じか近い粒度) */
  ohlcvPrimary: OHLCBar[];
  primaryInterval: KlineInterval;
  /** 長期 TF (中長期トレンド用、24h サイクルでは null) */
  ohlcvLong: OHLCBar[];
  longInterval: KlineInterval | null;
  ticker: { last: string; bid: string; ask: string; volume: string };
  /** 板情報 + 直近約定から計算したマイクロマーケット指標 */
  micro: MicroMarket | null;
}

/**
 * サイクル間隔 → primary / long TF のマッピング。
 *   1h  → primary 1hour  (~72 本 = 3 日) + long 1day (~30 本)
 *   3h  → primary 4hour  (~60 本 = 10 日) + long 1day
 *   6h  → primary 4hour  + long 1day
 *   24h → primary 1day   (~30 本) + long なし
 */
export function pickIntervals(cycleHours?: number): {
  primary: KlineInterval;
  long: KlineInterval | null;
} {
  if (!cycleHours || cycleHours <= 1) return { primary: "1hour", long: "1day" };
  if (cycleHours <= 6) return { primary: "4hour", long: "1day" };
  return { primary: "1day", long: null };
}

/**
 * GMO kline は interval により date format が違う:
 *   1min/5min/15min/30min → YYYYMMDD (日付指定)
 *   1hour/4hour/8hour/12hour → YYYY (年指定)
 *   1day → YYYY
 */
function dateParamFor(interval: KlineInterval): string {
  const isDate = interval === "1min" || interval === "5min" || interval === "15min";
  return isDate ? todayYyyymmdd() : currentYear();
}

function todayYyyymmdd(): string {
  return yyyymmddJst(new Date());
}

function yesterdayYyyymmdd(): string {
  return yyyymmddJst(new Date(Date.now() - 24 * 3600_000));
}

function yyyymmddJst(d: Date): string {
  const jst = new Date(d.getTime() + 9 * 3600_000);
  return `${jst.getUTCFullYear()}${String(jst.getUTCMonth() + 1).padStart(2, "0")}${String(jst.getUTCDate()).padStart(2, "0")}`;
}

function currentYear(): string {
  return String(new Date().getUTCFullYear());
}

/**
 * kline 取得 + フォールバック。
 * 日付指定 TF (1min/5min/15min) は早朝に 404 / 空配列が起きやすいため、空なら前日に再 fetch。
 * 年指定 TF (1hour 以上) は単純に取得。
 */
async function getKlinesWithFallback(symbol: string, interval: KlineInterval): Promise<OHLCBar[]> {
  const isDateBased = interval === "1min" || interval === "5min" || interval === "15min";
  const param = dateParamFor(interval);
  try {
    const bars = await getKlines(symbol, interval, param);
    if (bars.length > 0 || !isDateBased) return bars;
    const yesterday = yesterdayYyyymmdd();
    logger.warn(
      { symbol, interval, param, yesterday },
      `${interval} kline empty for today, falling back to yesterday`,
    );
    return await getKlines(symbol, interval, yesterday);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!isDateBased || !/GMO\s*404/i.test(msg)) throw err;
    const yesterday = yesterdayYyyymmdd();
    logger.warn(
      { symbol, interval, param, yesterday },
      `${interval} kline 404, falling back to yesterday`,
    );
    return await getKlines(symbol, interval, yesterday);
  }
}

/**
 * 1 銘柄のスナップショット (価格 + ニュース + センチメント) を並列取得。
 * 失敗時は必須ソース throw でサイクル中断、Orderbook/Trades は degraded で続行。
 */
export async function fetchSnapshot(input: FetchSnapshotInput): Promise<Snapshot> {
  const { symbol } = input;
  const name = input.name ?? symbol;
  const periodHours = input.periodHours ?? 24;
  const symbolJpy = `${symbol}_JPY`;
  const { primary, long } = pickIntervals(input.cycleIntervalHours);

  const [newsPrompt, sentimentPrompt] = await Promise.all([
    getPrompt("tier0/news", { symbol, name, period_hours: periodHours }),
    getPrompt("tier0/sentiment", { symbol, name, period_hours: periodHours }),
  ]);

  const [tickerRes, primaryBarsRes, longBarsRes, orderbookRes, tradesRes, perplexityRes, grokRes] =
    await Promise.allSettled([
      getTicker(symbolJpy),
      getKlinesWithFallback(symbolJpy, primary),
      long ? getKlinesWithFallback(symbolJpy, long) : Promise.resolve([] as OHLCBar[]),
      getOrderbook(symbolJpy),
      getRecentTrades(symbolJpy, 1, 100),
      withGenerationSpan(
        { modelId: newsPrompt.config.model, feature: "tier0.news", extraMetadata: { symbol } },
        async () => {
          const r = await callPerplexity({
            model: newsPrompt.config.model,
            systemPrompt: newsPrompt.compiled.system,
            userPrompt: newsPrompt.compiled.user,
            maxTokens: newsPrompt.config.maxTokens,
          });
          return { result: r, usage: r.usage };
        },
      ),
      withGenerationSpan(
        {
          modelId: sentimentPrompt.config.model,
          feature: "tier0.sentiment",
          extraMetadata: { symbol },
        },
        async () => {
          const r = await callGrok({
            model: sentimentPrompt.config.model,
            systemPrompt: sentimentPrompt.compiled.system,
            userPrompt: sentimentPrompt.compiled.user,
            maxTokens: sentimentPrompt.config.maxTokens,
            useTools: true,
          });
          return { result: r, usage: r.usage };
        },
      ),
    ]);

  // 必須ソース: Ticker + primary kline + (long があれば long) + Perplexity + Grok
  const requiredResults: Array<readonly [string, PromiseSettledResult<unknown>]> = [
    ["Ticker", tickerRes],
    [`${primary} kline`, primaryBarsRes],
    ["Perplexity", perplexityRes],
    ["Grok", grokRes],
  ];
  if (long) requiredResults.push([`${long} kline`, longBarsRes]);

  const failures = requiredResults.filter(([, res]) => res.status !== "fulfilled");
  if (failures.length > 0) {
    for (const [label, res] of failures) {
      logger.warn(
        { symbol, err: res.status === "rejected" ? res.reason : undefined },
        `${label} fetch failed`,
      );
    }
    const labels = failures.map(([l]) => l).join(", ");
    throw new Error(`Tier 0 required sources failed for ${symbol}: ${labels}`);
  }

  for (const [label, res] of [
    ["Orderbook", orderbookRes],
    ["Trades", tradesRes],
  ] as const) {
    if (res.status !== "fulfilled") {
      logger.warn({ symbol, err: res.reason }, `${label} fetch failed (degraded, micro=null)`);
    }
  }

  const ticker: Ticker | undefined =
    tickerRes.status === "fulfilled" ? tickerRes.value[0] : undefined;
  const micro =
    orderbookRes.status === "fulfilled" && tradesRes.status === "fulfilled"
      ? summarizeMicro(orderbookRes.value, tradesRes.value.list)
      : null;

  return {
    symbol,
    name,
    fetchedAt: new Date(),
    perplexitySummary:
      perplexityRes.status === "fulfilled" ? perplexityRes.value.content : "情報なし",
    perplexityCitations:
      perplexityRes.status === "fulfilled" ? (perplexityRes.value.citations ?? []) : [],
    grokSummary: grokRes.status === "fulfilled" ? grokRes.value.content : "情報なし",
    grokCitations: grokRes.status === "fulfilled" ? (grokRes.value.citations ?? []) : [],
    ohlcvPrimary: primaryBarsRes.status === "fulfilled" ? primaryBarsRes.value : [],
    primaryInterval: primary,
    ohlcvLong: longBarsRes.status === "fulfilled" ? longBarsRes.value : [],
    longInterval: long,
    ticker: {
      last: ticker?.last ?? "0",
      bid: ticker?.bid ?? "0",
      ask: ticker?.ask ?? "0",
      volume: ticker?.volume ?? "0",
    },
    micro,
  };
}

function summarizeMicro(book: Orderbook, trades: PublicTrade[]): MicroMarket | null {
  const topBid = Number(book.bids[0]?.price ?? 0);
  const topAsk = Number(book.asks[0]?.price ?? 0);
  if (topBid <= 0 || topAsk <= 0) return null;

  const mid = (topBid + topAsk) / 2;
  const spreadPct = ((topAsk - topBid) / mid) * 100;
  const bidDepth5 = book.bids.slice(0, 5).reduce((s, e) => s + Number(e.size), 0);
  const askDepth5 = book.asks.slice(0, 5).reduce((s, e) => s + Number(e.size), 0);
  const totalDepth = bidDepth5 + askDepth5;
  const bidBias = totalDepth > 0 ? bidDepth5 / totalDepth : 0.5;

  const buyCount = trades.filter((t) => t.side === "BUY").length;
  const tradeBuyRatio = trades.length > 0 ? buyCount / trades.length : 0.5;

  return {
    spreadPct: Number(spreadPct.toFixed(4)),
    bidDepth5: Number(bidDepth5.toFixed(6)),
    askDepth5: Number(askDepth5.toFixed(6)),
    bidBias: Number(bidBias.toFixed(4)),
    tradeBuyRatio: Number(tradeBuyRatio.toFixed(4)),
    tradeCount: trades.length,
  };
}
