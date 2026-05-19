import {
  type OHLCBar,
  type Orderbook,
  type PublicTrade,
  getKlines,
  getOrderbook,
  getRecentTrades,
  getTicker,
} from "@/lib/clients/gmo";
import { callGrok } from "@/lib/clients/grok";
import { callPerplexity } from "@/lib/clients/perplexity";
import { createLogger } from "@/lib/logging";
import { getPrompt } from "@/lib/prompts";
import { recordLLMCall } from "@/lib/telemetry";

const logger = createLogger("tier0.fetch-snapshot");

export interface FetchSnapshotInput {
  symbol: string; // 例: "BTC"
  /** プロジェクト正式名称 (例: "Bitcoin")、Tier 0 検索品質向上のため */
  name?: string;
  /** Tier 0 の検索対象期間 (時間)。デフォルト 24h。サイクル頻度に応じて呼出側で設定。 */
  periodHours?: number;
  /** 1d 足の取得対象年 (YYYY, デフォルト現在年) */
  klineYear?: string;
  /** 1m 足の取得対象日 (YYYYMMDD, デフォルト本日 JST) */
  kline1mDate?: string;
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
  ohlcv1m: OHLCBar[];
  ohlcv1d: OHLCBar[];
  ticker: { last: string; bid: string; ask: string; volume: string };
  /** 板情報 + 直近約定から計算したマイクロマーケット指標 */
  micro: MicroMarket | null;
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

function todayYyyymmdd(): string {
  const now = new Date();
  // JST 換算で YYYYMMDD
  const jst = new Date(now.getTime() + 9 * 3600_000);
  return `${jst.getUTCFullYear()}${String(jst.getUTCMonth() + 1).padStart(2, "0")}${String(jst.getUTCDate()).padStart(2, "0")}`;
}

function currentYear(): string {
  return String(new Date().getUTCFullYear());
}

/**
 * 1 銘柄のスナップショット (価格 + ニュース + センチメント) を並列取得。
 * 失敗時は部分的なデータと "情報なし" マーカーを返す(LLM 側で慎重判断する想定)。
 */
export async function fetchSnapshot(input: FetchSnapshotInput): Promise<Snapshot> {
  const { symbol } = input;
  const name = input.name ?? symbol; // フルネーム未指定なら symbol を fallback
  const periodHours = input.periodHours ?? 24;
  const symbolJpy = `${symbol}_JPY`;

  // Tier 0 プロンプト + config を Langfuse / fallback から取得
  const [newsPrompt, sentimentPrompt] = await Promise.all([
    getPrompt("tier0/news", { symbol, name, period_hours: periodHours }),
    getPrompt("tier0/sentiment", { symbol, name, period_hours: periodHours }),
  ]);

  const [tickerRes, ohlcv1mRes, ohlcv1dRes, orderbookRes, tradesRes, perplexityRes, grokRes] =
    await Promise.allSettled([
      getTicker(symbolJpy),
      getKlines(symbolJpy, "1min", input.kline1mDate ?? todayYyyymmdd()),
      getKlines(symbolJpy, "1day", input.klineYear ?? currentYear()),
      getOrderbook(symbolJpy),
      getRecentTrades(symbolJpy, 1, 100),
      callPerplexity({
        model: newsPrompt.config.model,
        systemPrompt: newsPrompt.compiled.system,
        userPrompt: newsPrompt.compiled.user,
        maxTokens: newsPrompt.config.maxTokens,
      }),
      callGrok({
        model: sentimentPrompt.config.model,
        systemPrompt: sentimentPrompt.compiled.system,
        userPrompt: sentimentPrompt.compiled.user,
        maxTokens: sentimentPrompt.config.maxTokens,
        useTools: true,
      }),
    ]);

  // Tier 0 LLM コスト記録 (AI SDK 経由ではないため手動で recordLLMCall)
  if (perplexityRes.status === "fulfilled") {
    recordLLMCall(perplexityRes.value.usage, {
      modelId: newsPrompt.config.model,
      feature: "tier0.news",
      extraMetadata: { symbol },
    });
  }
  if (grokRes.status === "fulfilled") {
    recordLLMCall(grokRes.value.usage, {
      modelId: sentimentPrompt.config.model,
      feature: "tier0.sentiment",
      extraMetadata: { symbol },
    });
  }

  const fetchResults: ReadonlyArray<readonly [string, PromiseSettledResult<unknown>]> = [
    ["Ticker", tickerRes],
    ["1m kline", ohlcv1mRes],
    ["1d kline", ohlcv1dRes],
    ["Orderbook", orderbookRes],
    ["Trades", tradesRes],
    ["Perplexity", perplexityRes],
    ["Grok", grokRes],
  ];
  for (const [label, res] of fetchResults) {
    if (res.status !== "fulfilled") {
      logger.warn({ symbol, err: res.reason }, `${label} fetch failed`);
    }
  }

  const ticker = tickerRes.status === "fulfilled" ? tickerRes.value[0] : undefined;
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
    ohlcv1m: ohlcv1mRes.status === "fulfilled" ? ohlcv1mRes.value : [],
    ohlcv1d: ohlcv1dRes.status === "fulfilled" ? ohlcv1dRes.value : [],
    ticker: {
      last: ticker?.last ?? "0",
      bid: ticker?.bid ?? "0",
      ask: ticker?.ask ?? "0",
      volume: ticker?.volume ?? "0",
    },
    micro,
  };
}
