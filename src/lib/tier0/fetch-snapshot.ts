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
import {
  type CycleIntervalMinutes,
  DEFAULT_CYCLE_INTERVAL_MINUTES,
  type KlineInterval,
  cycleMinutesToKlineInterval,
  isCycleIntervalMinutes,
} from "@/lib/system-control/constants";
import { withGenerationSpan } from "@/lib/telemetry";

const logger = createLogger("tier0.fetch-snapshot");

export type { KlineInterval };

/** LLM に渡す bar 本数。サイクル interval × 200 本に固定。 */
export const TARGET_BARS = 200;

export interface FetchSnapshotInput {
  symbol: string; // 例: "BTC"
  /** プロジェクト正式名称 (例: "Bitcoin")、Tier 0 検索品質向上のため */
  name?: string;
  /** Tier 0 の検索対象期間 (時間)。デフォルト 24h。サイクル頻度に応じて呼出側で設定。 */
  periodHours?: number;
  /** サイクル間隔（分）。Kline interval の 1:1 マッピングに使う。 */
  cycleIntervalMinutes?: number;
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
  /** サイクル interval と一致する Kline (直近 TARGET_BARS 本まで) */
  ohlcv: OHLCBar[];
  klineInterval: KlineInterval;
  ticker: { last: string; bid: string; ask: string; volume: string };
  /** 板情報 + 直近約定から計算したマイクロマーケット指標 */
  micro: MicroMarket | null;
}

/** date 形式の判定 (GMO 公式): YYYYMMDD = 1min/5min/10min/15min/30min/1hour */
function isDateParamInterval(interval: KlineInterval): boolean {
  return (
    interval === "1min" ||
    interval === "5min" ||
    interval === "15min" ||
    interval === "30min" ||
    interval === "1hour"
  );
}

function yyyymmddJst(d: Date): string {
  const jst = new Date(d.getTime() + 9 * 3600_000);
  return `${jst.getUTCFullYear()}${String(jst.getUTCMonth() + 1).padStart(2, "0")}${String(jst.getUTCDate()).padStart(2, "0")}`;
}

/** 1 リクエスト分の kline を取得。404 は空配列で吸収、それ以外は throw。 */
async function fetchOneKlineCall(
  symbol: string,
  interval: KlineInterval,
  param: string,
): Promise<OHLCBar[]> {
  try {
    return await getKlines(symbol, interval, param);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/GMO\s*404/i.test(msg)) throw err;
    logger.warn({ symbol, interval, param }, `${interval} kline 404, skipping`);
    return [];
  }
}

/** params リストを順番に叩いて TARGET_BARS 本集まったら打ち切り、openTime 昇順 + 末尾 TARGET_BARS を返す。 */
async function collectBars(
  symbol: string,
  interval: KlineInterval,
  params: Iterable<string>,
): Promise<OHLCBar[]> {
  const collected = new Map<number, OHLCBar>();
  for (const param of params) {
    const bars = await fetchOneKlineCall(symbol, interval, param);
    for (const bar of bars) collected.set(bar.openTime, bar);
    if (collected.size >= TARGET_BARS) break;
  }
  return Array.from(collected.values())
    .sort((a, b) => a.openTime - b.openTime)
    .slice(-TARGET_BARS);
}

function* daysBack(maxDays: number): IterableIterator<string> {
  for (let i = 0; i < maxDays; i++) {
    yield yyyymmddJst(new Date(Date.now() - i * 24 * 3600_000));
  }
}

function* yearsBack(maxYears: number): IterableIterator<string> {
  const yearNow = new Date().getUTCFullYear();
  for (let i = 0; i < maxYears; i++) yield String(yearNow - i);
}

/**
 * 指定 interval で TARGET_BARS 本以上が確保できるよう、必要に応じて過去日 / 過去年を merge して取得する。
 *
 * - YYYYMMDD 系 (30min / 1hour): 1 日分しか返らないので複数日 fetch して concat。
 *   30min なら 48本/日、1hour なら 24本/日 → 200 本に必要なのは数日〜10 日程度。safety upper bound: 20 日。
 * - YYYY 系 (4hour 以上): 当年で足りなければ前年も fetch して concat (最大 3 年遡及)。
 *   一般に 4hour × 1 年 ≒ 2100 本、1day × 1 年 ≒ 365 本なので大抵 1 回で足りる。
 */
function fetchEnoughBars(symbol: string, interval: KlineInterval): Promise<OHLCBar[]> {
  const params = isDateParamInterval(interval) ? daysBack(20) : yearsBack(3);
  return collectBars(symbol, interval, params);
}

function resolveKlineInterval(cycleMinutesRaw: number | undefined): KlineInterval {
  const minutes =
    cycleMinutesRaw !== undefined && isCycleIntervalMinutes(cycleMinutesRaw)
      ? (cycleMinutesRaw as CycleIntervalMinutes)
      : DEFAULT_CYCLE_INTERVAL_MINUTES;
  return cycleMinutesToKlineInterval(minutes);
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
  const klineInterval = resolveKlineInterval(input.cycleIntervalMinutes);

  const [newsPrompt, sentimentPrompt] = await Promise.all([
    getPrompt("tier0/news", { symbol, name, period_hours: periodHours }),
    getPrompt("tier0/sentiment", { symbol, name, period_hours: periodHours }),
  ]);

  const [tickerRes, klineRes, orderbookRes, tradesRes, perplexityRes, grokRes] =
    await Promise.allSettled([
      getTicker(symbolJpy),
      fetchEnoughBars(symbolJpy, klineInterval),
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
            periodHours,
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
            periodHours,
          });
          return { result: r, usage: r.usage };
        },
      ),
    ]);

  // 必須ソース: Ticker + Kline + Perplexity + Grok
  const requiredResults: Array<readonly [string, PromiseSettledResult<unknown>]> = [
    ["Ticker", tickerRes],
    [`${klineInterval} kline`, klineRes],
    ["Perplexity", perplexityRes],
    ["Grok", grokRes],
  ];

  const failures = requiredResults.filter(([, res]) => res.status !== "fulfilled");
  if (failures.length > 0) {
    for (const [label, res] of failures) {
      logger.warn(
        { symbol, err: res.status === "rejected" ? res.reason : undefined },
        `${label} fetch failed`,
      );
    }
    throw buildRequiredSourcesError(symbol, failures);
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
    ohlcv: klineRes.status === "fulfilled" ? klineRes.value : [],
    klineInterval,
    ticker: {
      last: ticker?.last ?? "0",
      bid: ticker?.bid ?? "0",
      ask: ticker?.ask ?? "0",
      volume: ticker?.volume ?? "0",
    },
    micro,
  };
}

/**
 * Tier 0 必須ソース失敗を構造化して伝えるエラー。
 *
 * message は `<labels> (<label>: <reason>... | ...)` 形式で Sentry の breadcrumb なしでも
 * 原因まで読める。consumer 側は labels 配列を直接読めるので message を regex parse しなくて済む。
 */
export class RequiredSourcesFailedError extends Error {
  constructor(
    readonly symbol: string,
    readonly failures: ReadonlyArray<{ label: string; reasonMessage: string }>,
    options?: { cause?: unknown },
  ) {
    const labels = failures.map((f) => f.label).join(", ");
    const reasons = failures.map((f) => `${f.label}: ${f.reasonMessage}`).join(" | ");
    super(`Tier 0 required sources failed for ${symbol}: ${labels} (${reasons})`, options);
    this.name = "RequiredSourcesFailedError";
  }
}

function buildRequiredSourcesError(
  symbol: string,
  failures: Array<readonly [string, PromiseSettledResult<unknown>]>,
): RequiredSourcesFailedError {
  const structured = failures.map(([label, res]) => ({
    label,
    reasonMessage: reasonText(res),
  }));
  const firstRejected = failures.find(([, r]) => r.status === "rejected");
  const cause = firstRejected?.[1].status === "rejected" ? firstRejected[1].reason : undefined;
  return new RequiredSourcesFailedError(symbol, structured, { cause });
}

function reasonText(res: PromiseSettledResult<unknown>): string {
  if (res.status !== "rejected") return "<unknown>";
  const msg = res.reason instanceof Error ? res.reason.message : String(res.reason);
  return msg.slice(0, 200);
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
