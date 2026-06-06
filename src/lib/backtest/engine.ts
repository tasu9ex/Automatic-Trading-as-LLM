/**
 * 戦略評価ハーネス (v1): 価格ベースのバックテスト + ベンチマーク比較。
 *
 * 目的: 「ある戦略が、コスト控除後に、現金 / BTC / 単純ルールを上回るか」を
 * 過去 OHLCV で公平に測る。LLM コストはかからない (価格データのみ)。
 *
 * 設計:
 *   - PriceMatrix: 全銘柄を同一の時間グリッド (8h バー) に揃えた close 行列
 *   - Strategy: バー t までの情報で「次バー [t, t+1) を保有する目標ウェイト」を返す
 *     (long-only, Σweight ≤ 1, 残りは現金)。look-ahead を避けるため close[t] までしか見ない
 *   - runBacktest: バーを進めて turnover コストを引きつつ equity を複利で更新
 *   - メトリクス: 総リターン / Sharpe / 最大DD / turnover / レジーム別 (BTC上昇/下降)
 */

export interface PriceMatrix {
  times: number[]; // openTime (ms) per bar, 昇順, length T
  symbols: string[]; // length N
  close: number[][]; // [N][T]
}

export type Weights = Map<string, number>; // symbol -> weight (long-only)

export interface Strategy {
  name: string;
  /** close[*][0..t] までの情報で、次バー保有のウェイトを返す。 */
  weights(pm: PriceMatrix, t: number): Weights;
}

export interface BacktestOpts {
  /** 片道 turnover あたりのコスト率 (手数料+スプレッド)。例 0.001 = 0.1% */
  costRate: number;
  /** signal 計算に必要な最小バー数 (この前は評価しない) */
  warmup: number;
  /** レジーム判定 (BTC 上昇/下降) の lookback バー数 */
  regimeLookback: number;
  btcSymbol: string;
}

export interface BacktestResult {
  name: string;
  equity: number[]; // length = 評価バー数+1, equity[0]=1
  totalReturnPct: number;
  sharpe: number; // 年率化
  maxDrawdownPct: number;
  avgTurnover: number; // バーあたり平均 turnover
  upReturnPct: number; // BTC上昇バーのみの累積
  downReturnPct: number; // BTC下降バーのみの累積
  bars: number;
}

const BARS_PER_YEAR = (365.25 * 24) / 8; // 8h バー

const idx = (pm: PriceMatrix, sym: string): number => pm.symbols.indexOf(sym);

function ret(pm: PriceMatrix, sym: string, t: number, h: number): number | null {
  const i = idx(pm, sym);
  if (i < 0) return null;
  const a = pm.close[i][t - h];
  const b = pm.close[i][t];
  if (!a || !b) return null;
  return b / a - 1;
}

// ─────────────────────────── strategies ───────────────────────────

export const cash: Strategy = { name: "現金", weights: () => new Map() };

export function buyHold(sym: string): Strategy {
  return { name: `${sym} B&H`, weights: () => new Map([[sym, 1]]) };
}

export function equalWeightHold(): Strategy {
  return {
    name: "全銘柄 等金額B&H",
    weights: (pm) => {
      const w = 1 / pm.symbols.length;
      return new Map(pm.symbols.map((s) => [s, w]));
    },
  };
}

/** time-series momentum: 過去 L バスでプラスの銘柄のみ等金額ロング、無ければ現金。 */
export function tsMomentum(L: number): Strategy {
  return {
    name: `TSモメンタム(L=${L})`,
    weights: (pm, t) => {
      const longs = pm.symbols.filter((s) => {
        const r = ret(pm, s, t, L);
        return r != null && r > 0;
      });
      if (longs.length === 0) return new Map();
      const w = 1 / longs.length;
      return new Map(longs.map((s) => [s, w]));
    },
  };
}

/** mean-reversion (逆張り): 過去 L バーで最も下げた K 銘柄を等金額ロング。 */
export function meanReversion(L: number, K: number): Strategy {
  return {
    name: `逆張り(L=${L},worst${K})`,
    weights: (pm, t) => {
      const scored = pm.symbols
        .map((s) => ({ s, r: ret(pm, s, t, L) }))
        .filter((x): x is { s: string; r: number } => x.r != null)
        .sort((a, b) => a.r - b.r); // 昇順 = 下げた順
      const worst = scored.slice(0, K);
      if (worst.length === 0) return new Map();
      const w = 1 / worst.length;
      return new Map(worst.map((x) => [x.s, w]));
    },
  };
}

/** cross-sectional momentum: 過去 L バーのリターン上位 K 銘柄を等金額ロング。 */
export function xsMomentum(L: number, K: number): Strategy {
  return {
    name: `XSモメンタム(L=${L},top${K})`,
    weights: (pm, t) => {
      const scored = pm.symbols
        .map((s) => ({ s, r: ret(pm, s, t, L) }))
        .filter((x): x is { s: string; r: number } => x.r != null)
        .sort((a, b) => b.r - a.r);
      const top = scored.slice(0, K).filter((x) => x.r > 0); // 上位でもマイナスなら持たない
      if (top.length === 0) return new Map();
      const w = 1 / top.length;
      return new Map(top.map((x) => [x.s, w]));
    },
  };
}

// ─────────────────────────── engine ───────────────────────────

export function runBacktest(
  pm: PriceMatrix,
  strategy: Strategy,
  opts: BacktestOpts,
): BacktestResult {
  const T = pm.times.length;
  const equity: number[] = [1];
  const barReturns: number[] = [];
  const upRets: number[] = [];
  const downRets: number[] = [];
  let prevW: Weights = new Map();
  let turnoverSum = 0;
  let steps = 0;
  const btcI = idx(pm, opts.btcSymbol);

  for (let t = opts.warmup; t < T - 1; t++) {
    const w = strategy.weights(pm, t);

    // turnover = Σ|w - prevW| (両 map の union)
    let turnover = 0;
    const keys = new Set([...w.keys(), ...prevW.keys()]);
    for (const k of keys) turnover += Math.abs((w.get(k) ?? 0) - (prevW.get(k) ?? 0));
    const cost = turnover * opts.costRate;

    // 次バーのリターン
    let barRet = 0;
    for (const [s, weight] of w) {
      const r = ret(pm, s, t + 1, 1);
      if (r != null) barRet += weight * r;
    }
    const net = barRet - cost;
    equity.push(equity[equity.length - 1] * (1 + net));
    barReturns.push(net);
    turnoverSum += turnover;
    steps++;

    // レジーム分類 (バー t での BTC トレンド)
    if (btcI >= 0) {
      const btcNow = pm.close[btcI][t];
      const btcPast = pm.close[btcI][t - opts.regimeLookback];
      if (btcNow && btcPast) (btcNow >= btcPast ? upRets : downRets).push(net);
    }

    prevW = w;
  }

  return {
    name: strategy.name,
    equity,
    totalReturnPct: (equity[equity.length - 1] - 1) * 100,
    sharpe: sharpeAnnualized(barReturns),
    maxDrawdownPct: maxDrawdown(equity) * 100,
    avgTurnover: steps ? turnoverSum / steps : 0,
    upReturnPct: (cumprod(upRets) - 1) * 100,
    downReturnPct: (cumprod(downRets) - 1) * 100,
    bars: steps,
  };
}

function cumprod(rs: number[]): number {
  let e = 1;
  for (const r of rs) e *= 1 + r;
  return e;
}

function sharpeAnnualized(rs: number[]): number {
  if (rs.length < 2) return Number.NaN;
  const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
  const variance = rs.reduce((a, b) => a + (b - mean) ** 2, 0) / (rs.length - 1);
  const sd = Math.sqrt(variance);
  if (sd === 0) return Number.NaN;
  return (mean / sd) * Math.sqrt(BARS_PER_YEAR);
}

function maxDrawdown(equity: number[]): number {
  let peak = equity[0];
  let maxDD = 0;
  for (const e of equity) {
    if (e > peak) peak = e;
    const dd = (peak - e) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}
