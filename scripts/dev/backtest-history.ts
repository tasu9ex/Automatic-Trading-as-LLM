/**
 * GMO 公開 klines を多周期×複数年で取得 → キャッシュ → 多レジーム検証。
 *
 * Usage: pnpm backtest:history
 *
 * 目的: 単一レジーム (live snapshot の66日) では分離できない「周期 vs 相場」を、
 * 公開 klines (認証不要) で 4h/8h/1day × 複数年 (= 上げ/レンジ/下げ全部) に広げて検証する。
 * 4分割 (≒レジーム別) で出し、戦略が相場に依らず正かを見る。
 *
 * 注意 (重要): ここの momentum/逆張りは毎バー全リバランス = turnover が高く、
 * 高頻度 (4h/8h) では取引コストが累積で支配的になり大きくマイナスに出る
 * (例: 5000バー × 片道0.1% ≈ -99%)。これは「高頻度・高回転は構造的に不利」
 * の裏付けであって edge 不在の証明ではない。低 turnover 版は将来課題。
 * ベンチマーク (現金 / BTC B&H / 等金額) の比較が主眼。
 *
 * キャッシュ: /tmp/gmo-klines-cache.json (消せば再取得)。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  type PriceMatrix,
  type Strategy,
  buyHold,
  cash,
  equalWeightHold,
  meanReversion,
  runBacktest,
  tsMomentum,
  xsMomentum,
} from "@/lib/backtest/engine";

const BASE = "https://api.coin.z.com/public";
const SYMBOLS = [
  "BTC",
  "ETH",
  "XRP",
  "LTC",
  "BCH",
  "XLM",
  "DOT",
  "ATOM",
  "LINK",
  "DOGE",
  "ADA",
  "SOL",
  "XTZ",
  "SUI",
];
const INTERVALS = ["4hour", "8hour", "1day"] as const;
const YEARS = ["2024", "2025", "2026"];
const CACHE = "/tmp/gmo-klines-cache.json";
const COST = 0.001;
const BTC = "BTC";

interface Bar {
  t: number;
  c: number;
}
type Cache = Record<string, Bar[]>; // key = `${sym}|${interval}`

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchYear(sym: string, interval: string, year: string): Promise<Bar[]> {
  try {
    const res = await fetch(`${BASE}/v1/klines?symbol=${sym}&interval=${interval}&date=${year}`);
    if (!res.ok) return [];
    const j = (await res.json()) as { status: number; data?: any[] };
    if (!Array.isArray(j.data)) return [];
    return j.data
      .map((b) => ({ t: Number(b.openTime), c: Number(b.close) }))
      .filter((b) => Number.isFinite(b.t) && b.c > 0);
  } catch {
    return [];
  }
}

async function buildCache(): Promise<Cache> {
  if (existsSync(CACHE)) {
    console.log("(cache hit)");
    return JSON.parse(readFileSync(CACHE, "utf8"));
  }
  const cache: Cache = {};
  let n = 0;
  for (const interval of INTERVALS)
    for (const sym of SYMBOLS) {
      let bars: Bar[] = [];
      for (const y of YEARS) {
        bars = bars.concat(await fetchYear(sym, interval, y));
        await sleep(120);
        n++;
      }
      const m = new Map(bars.map((b) => [b.t, b.c]));
      cache[`${sym}|${interval}`] = [...m.entries()]
        .map(([t, c]) => ({ t, c }))
        .sort((a, b) => a.t - b.t);
    }
  mkdirSync("/tmp", { recursive: true });
  writeFileSync(CACHE, JSON.stringify(cache));
  console.log(`fetched ${n} year-requests, cached.`);
  return cache;
}

function matrix(cache: Cache, interval: string): PriceMatrix {
  const per = new Map<string, Map<number, number>>();
  for (const sym of SYMBOLS) {
    const bars = cache[`${sym}|${interval}`];
    if (bars && bars.length > 50) per.set(sym, new Map(bars.map((b) => [b.t, b.c])));
  }
  // union of times; min coverage 60%
  const allTimes = new Set<number>();
  for (const m of per.values()) for (const t of m.keys()) allTimes.add(t);
  const times = [...allTimes].sort((a, b) => a - b);
  const symbols = [...per.keys()].filter((s) => (per.get(s)?.size ?? 0) >= times.length * 0.6);
  const close = symbols.map((s) => {
    const m = per.get(s) ?? new Map<number, number>();
    return times.map((t) => m.get(t) ?? Number.NaN);
  });
  return { times, symbols, close };
}

const pct = (n: number) => (!Number.isFinite(n) ? "  —  " : `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`);
const nm = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : " — ");
const slice = (pm: PriceMatrix, a: number, b: number): PriceMatrix => ({
  times: pm.times.slice(a, b),
  symbols: pm.symbols,
  close: pm.close.map((r) => r.slice(a, b)),
});

async function main() {
  const cache = await buildCache();
  for (const interval of INTERVALS) {
    const pm = matrix(cache, interval);
    if (pm.times.length < 20) {
      console.log(`\n[${interval}] データ不足`);
      continue;
    }
    const days = ((pm.times[pm.times.length - 1] - pm.times[0]) / 86400000).toFixed(0);
    const barsPerSeg = Math.floor(pm.times.length / 4);
    console.log(
      `\n══════ interval=${interval}  銘柄=${pm.symbols.length} バー=${pm.times.length} (~${days}日, ${pm.symbols.join(",")}) ══════`,
    );
    const opts = (L: number) => ({
      costRate: COST,
      warmup: Math.max(L, 1),
      regimeLookback: 3,
      btcSymbol: BTC,
    });
    const strats: [string, Strategy, number][] = [
      ["現金", cash, 1],
      ["BTC B&H", buyHold(BTC), 1],
      ["等金額B&H", equalWeightHold(), 1],
      ["TSモメンタムL3", tsMomentum(3), 3],
      ["TSモメンタムL6", tsMomentum(6), 6],
      ["XSモメL6t3", xsMomentum(6, 3), 6],
      ["逆張りL3", meanReversion(3, 3), 3],
    ];
    // 4分割 (≒レジーム別)。各セグメントの BTC リターンでレジームを示す
    console.log(
      `${"戦略".padEnd(16)} ${"全体".padStart(7)} ${"Sh".padStart(5)} | ${"Q1".padStart(7)} ${"Q2".padStart(7)} ${"Q3".padStart(7)} ${"Q4".padStart(7)}`,
    );
    const segLabel: string[] = [];
    for (let q = 0; q < 4; q++) {
      const seg = slice(pm, q * barsPerSeg, (q + 1) * barsPerSeg);
      const btc = runBacktest(seg, buyHold(BTC), opts(1));
      segLabel.push(pct(btc.totalReturnPct));
    }
    console.log(
      `${"(BTC=相場)".padEnd(16)} ${"".padStart(7)} ${"".padStart(5)} | ${segLabel.map((s) => s.padStart(7)).join(" ")}`,
    );
    for (const [name, st, L] of strats) {
      const f = runBacktest(pm, st, opts(L));
      const qs = [0, 1, 2, 3].map((q) =>
        pct(
          runBacktest(slice(pm, q * barsPerSeg, (q + 1) * barsPerSeg), st, opts(L)).totalReturnPct,
        ),
      );
      console.log(
        `${name.padEnd(16)} ${pct(f.totalReturnPct).padStart(7)} ${nm(f.sharpe).padStart(5)} | ${qs.map((s) => s.padStart(7)).join(" ")}`,
      );
    }
  }
}
main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
