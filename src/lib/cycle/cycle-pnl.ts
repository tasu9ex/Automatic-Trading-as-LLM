/**
 * サイクルごとの評価損益 (mark-to-market) を再構築する。
 *
 * 「そのサイクルでの +/-」= そのサイクル時点の総資産 − 直前サイクル時点の総資産。
 *   総資産(equity) = 現金 + Σ(保有数量 × そのサイクルの snapshot 価格)
 *
 * 含み損益込み・取引所手数料込み (trade の price/fee に反映済み)。
 * LLM API コストは含めない (system_state.cumulativeCostUsd は別管理)。
 *
 * 過去サイクル時点の現金/保有を持つテーブルは無いので、
 * initialCash から trades + capital events を時系列 replay して各サイクル境界の
 * 状態を復元する。価格は market_snapshots(cycle_id, coin_id).ticker.last を使う
 * (= Tier3 がそのサイクルで見た現在価格)。
 *
 * 現金式は executor (calculateFill) と一致させる:
 *   buy:  cash -= price*qty + fee
 *   sell: cash += price*qty - fee
 * 保有数量の復元は trades と完全一致する。現金は逆指値タッチ等の強制約定で
 * trades.price に参照価格が入るケースがあり累積で僅差 (実測 ~0.6%) ズレ得るが、
 * 取引のあったサイクルにのみ効き、差分指標としては実用上問題ない。
 */

import { db } from "@/db/client";
import { cycles, marketSnapshots, portfolioCapitalEvents, portfolios, trades } from "@/db/schema";
import { asc, desc, eq, inArray, lt } from "drizzle-orm";
import { DEFAULT_STRATEGY_ID } from "./defaults";

interface CycleRef {
  id: string;
  startedAt: Date;
}

type Ev =
  | {
      t: number;
      kind: "trade";
      coinId: string;
      side: string;
      qty: number;
      price: number;
      fee: number;
    }
  | { t: number; kind: "capital"; signed: number };

type TradeRow = {
  coinId: string;
  side: string;
  quantity: string;
  price: string;
  fee: string;
  executedAt: Date;
};
type CapitalRow = { kind: string; amountJpy: string; occurredAt: Date };

function tickerLast(t: unknown): number | null {
  if (!t || typeof t !== "object") return null;
  const last = (t as { last?: unknown }).last;
  const n = last == null ? Number.NaN : Number(last);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** trades + capital events を時刻昇順の単一イベント列にマージ。 */
function buildEvents(allTrades: TradeRow[], capitalEvents: CapitalRow[]): Ev[] {
  const events: Ev[] = [];
  for (const tr of allTrades) {
    events.push({
      t: tr.executedAt.getTime(),
      kind: "trade",
      coinId: tr.coinId,
      side: tr.side,
      qty: Number(tr.quantity),
      price: Number(tr.price),
      fee: Number(tr.fee),
    });
  }
  for (const ce of capitalEvents) {
    const amt = Number(ce.amountJpy);
    events.push({
      t: ce.occurredAt.getTime(),
      kind: "capital",
      signed: ce.kind === "deposit" ? amt : -amt,
    });
  }
  events.sort((a, b) => a.t - b.t);
  return events;
}

interface ReplayState {
  cash: number;
  cumCapital: number;
  holdings: Map<string, number>;
  lastTradePrice: Map<string, number>;
}

/** 1 イベントを state に適用 (executor と同じ現金式)。 */
function applyEvent(st: ReplayState, e: Ev): void {
  if (e.kind === "capital") {
    st.cash += e.signed;
    st.cumCapital += e.signed;
    return;
  }
  const q = st.holdings.get(e.coinId) ?? 0;
  if (e.side === "buy") {
    st.cash -= e.price * e.qty + e.fee;
    st.holdings.set(e.coinId, q + e.qty);
  } else {
    st.cash += e.price * e.qty - e.fee;
    st.holdings.set(e.coinId, q - e.qty);
  }
  st.lastTradePrice.set(e.coinId, e.price);
}

/** state の保有を当該サイクルの snapshot 価格で評価した総資産。 */
function valueEquity(
  st: ReplayState,
  cycleId: string,
  priceByCycleCoin: Map<string, number>,
): number {
  let equity = st.cash;
  for (const [coinId, qty] of st.holdings) {
    if (Math.abs(qty) < 1e-9) continue;
    const price =
      priceByCycleCoin.get(`${cycleId}:${coinId}`) ?? st.lastTradePrice.get(coinId) ?? 0;
    equity += qty * price;
  }
  return equity;
}

/**
 * cyclesNewestFirst で渡されたサイクルそれぞれの「評価損益(対前サイクル差分)」を返す。
 * 直前サイクルが取れない最古サイクルは null。
 */
export async function computeCyclePnls(
  cyclesNewestFirst: CycleRef[],
): Promise<Map<string, number | null>> {
  const result = new Map<string, number | null>();
  if (cyclesNewestFirst.length === 0) return result;

  const oldest = cyclesNewestFirst[cyclesNewestFirst.length - 1];

  const [portfolio, baseline, capitalEvents, allTrades] = await Promise.all([
    db
      .select({ initialCashJpy: portfolios.initialCashJpy })
      .from(portfolios)
      .where(eq(portfolios.strategyId, DEFAULT_STRATEGY_ID))
      .limit(1)
      .then((r) => r[0]),
    // baseline: 最古表示サイクルより前で最新の cycle (最古サイクルの prev equity 基準)
    db
      .select({ id: cycles.id, startedAt: cycles.startedAt })
      .from(cycles)
      .where(lt(cycles.startedAt, oldest.startedAt))
      .orderBy(desc(cycles.startedAt))
      .limit(1)
      .then((r) => r[0] as CycleRef | undefined),
    db
      .select({
        kind: portfolioCapitalEvents.kind,
        amountJpy: portfolioCapitalEvents.amountJpy,
        occurredAt: portfolioCapitalEvents.occurredAt,
      })
      .from(portfolioCapitalEvents)
      .where(eq(portfolioCapitalEvents.strategyId, DEFAULT_STRATEGY_ID))
      .orderBy(asc(portfolioCapitalEvents.occurredAt)),
    db
      .select({
        coinId: trades.coinId,
        side: trades.side,
        quantity: trades.quantity,
        price: trades.price,
        fee: trades.fee,
        executedAt: trades.executedAt,
      })
      .from(trades)
      .where(eq(trades.strategyId, DEFAULT_STRATEGY_ID))
      .orderBy(asc(trades.executedAt)),
  ]);

  // 価格参照のため、表示サイクル + baseline の snapshot を一括取得。
  const cycleIds = cyclesNewestFirst.map((c) => c.id);
  if (baseline) cycleIds.push(baseline.id);
  const snaps = await db
    .select({
      cycleId: marketSnapshots.cycleId,
      coinId: marketSnapshots.coinId,
      ticker: marketSnapshots.ticker,
    })
    .from(marketSnapshots)
    .where(inArray(marketSnapshots.cycleId, cycleIds));

  const priceByCycleCoin = new Map<string, number>();
  for (const s of snaps) {
    const last = tickerLast(s.ticker);
    if (last != null) priceByCycleCoin.set(`${s.cycleId}:${s.coinId}`, last);
  }

  // 時系列昇順のサイクル列 (baseline 先頭)。各サイクルの「締め」= 次サイクルの startedAt。
  const timelineAsc = [...cyclesNewestFirst].reverse();
  const timeline: CycleRef[] = baseline ? [baseline, ...timelineAsc] : timelineAsc;

  const events = buildEvents(allTrades, capitalEvents);
  const st: ReplayState = {
    cash: Number(portfolio?.initialCashJpy ?? 0),
    cumCapital: 0,
    holdings: new Map(),
    lastTradePrice: new Map(),
  };

  // 各サイクル境界での equity / cumCapital を記録 (cutoff = 次サイクルの startedAt)。
  const equityAt = new Map<string, number>();
  const cumCapAt = new Map<string, number>();
  let evIdx = 0;
  for (let i = 0; i < timeline.length; i++) {
    const cur = timeline[i];
    const cutoff = timeline[i + 1]?.startedAt.getTime() ?? Number.POSITIVE_INFINITY;
    while (evIdx < events.length && events[evIdx].t < cutoff) {
      applyEvent(st, events[evIdx++]);
    }
    equityAt.set(cur.id, valueEquity(st, cur.id, priceByCycleCoin));
    cumCapAt.set(cur.id, st.cumCapital);
  }

  // 差分を計算 (capital flow を除去)。baseline 自身は返さない。
  for (let i = 1; i < timeline.length; i++) {
    const cur = timeline[i];
    const prev = timeline[i - 1];
    const eqCur = equityAt.get(cur.id);
    const eqPrev = equityAt.get(prev.id);
    if (eqCur == null || eqPrev == null) {
      result.set(cur.id, null);
      continue;
    }
    const capDelta = (cumCapAt.get(cur.id) ?? 0) - (cumCapAt.get(prev.id) ?? 0);
    result.set(cur.id, eqCur - eqPrev - capDelta);
  }
  if (!baseline && timeline.length > 0) result.set(timeline[0].id, null);

  return result;
}
