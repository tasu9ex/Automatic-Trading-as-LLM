import { type OHLCBar, getKlines, getTicker } from "@/lib/clients/gmo";
import { callGrok } from "@/lib/clients/grok";
import { callPerplexity } from "@/lib/clients/perplexity";
import { createLogger } from "@/lib/logging";

const logger = createLogger("tier0.fetch-snapshot");

export interface FetchSnapshotInput {
  symbol: string; // 例: "BTC"
  /** 1d 足の取得対象年 (YYYY, デフォルト現在年) */
  klineYear?: string;
  /** 1m 足の取得対象日 (YYYYMMDD, デフォルト本日 JST) */
  kline1mDate?: string;
}

export interface Snapshot {
  symbol: string;
  fetchedAt: Date;
  perplexitySummary: string;
  grokSummary: string;
  ohlcv1m: OHLCBar[];
  ohlcv1d: OHLCBar[];
  ticker: { last: string; bid: string; ask: string; volume: string };
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
  const symbolJpy = `${symbol}_JPY`;

  const [tickerRes, ohlcv1mRes, ohlcv1dRes, perplexityRes, grokRes] = await Promise.allSettled([
    getTicker(symbolJpy),
    getKlines(symbolJpy, "1min", input.kline1mDate ?? todayYyyymmdd()),
    getKlines(symbolJpy, "1day", input.klineYear ?? currentYear()),
    callPerplexity({
      userPrompt: `${symbol} (仮想通貨) と暗号資産市場全体の過去 24h のニュース・規制・マクロ動向・機関投資家の動き・大口取引・技術アップデートを要約してください。引用元 URL も含めてください。500字程度。`,
    }),
    callGrok({
      userPrompt: `$${symbol} および暗号資産全体について、過去 24 時間の X (Twitter) のセンチメント、KOL (Key Opinion Leader) の発言、ミーム的なトレンドを要約してください。500 字程度。`,
    }),
  ]);

  if (tickerRes.status !== "fulfilled") {
    logger.warn({ symbol, err: tickerRes.reason }, "Ticker fetch failed");
  }
  if (ohlcv1mRes.status !== "fulfilled") {
    logger.warn({ symbol, err: ohlcv1mRes.reason }, "1m kline fetch failed");
  }
  if (ohlcv1dRes.status !== "fulfilled") {
    logger.warn({ symbol, err: ohlcv1dRes.reason }, "1d kline fetch failed");
  }
  if (perplexityRes.status !== "fulfilled") {
    logger.warn({ symbol, err: perplexityRes.reason }, "Perplexity fetch failed");
  }
  if (grokRes.status !== "fulfilled") {
    logger.warn({ symbol, err: grokRes.reason }, "Grok fetch failed");
  }

  const ticker = tickerRes.status === "fulfilled" ? tickerRes.value[0] : undefined;
  return {
    symbol,
    fetchedAt: new Date(),
    perplexitySummary:
      perplexityRes.status === "fulfilled" ? perplexityRes.value.content : "情報なし",
    grokSummary: grokRes.status === "fulfilled" ? grokRes.value.content : "情報なし",
    ohlcv1m: ohlcv1mRes.status === "fulfilled" ? ohlcv1mRes.value : [],
    ohlcv1d: ohlcv1dRes.status === "fulfilled" ? ohlcv1dRes.value : [],
    ticker: {
      last: ticker?.last ?? "0",
      bid: ticker?.bid ?? "0",
      ask: ticker?.ask ?? "0",
      volume: ticker?.volume ?? "0",
    },
  };
}
