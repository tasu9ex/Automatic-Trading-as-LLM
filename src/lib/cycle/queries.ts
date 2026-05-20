/**
 * ダッシュボード用のサイクル / ポートフォリオ クエリ。
 * 全て read-only。データソースは Drizzle (postgres user, RLS bypass)。
 */
import { db } from "@/db/client";
import {
  analystOutputs,
  coins,
  criticOutputs,
  cycles,
  decisions,
  marketSnapshots,
  portfolios,
  positions,
  preAnalystOutputs,
  systemState,
} from "@/db/schema";
import { getTicker } from "@/lib/clients/gmo";
import { createLogger } from "@/lib/logging";
import type { AnalystOutput } from "@/lib/schemas/llm-outputs";
import {
  type CycleIntervalHours,
  DEFAULT_CYCLE_INTERVAL_HOURS,
  isCycleIntervalHours,
} from "@/lib/system-control/constants";
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";

const logger = createLogger("cycle.queries");

const STRATEGY_ID = "trial-5";

export interface DashboardStats {
  state: string | undefined;
  killReason: string | null;
  cycleIntervalHours: CycleIntervalHours;
  nextScheduledAt: Date | null;
  lastCycleAt: Date | null;
  cashJpy: number;
  initialCashJpy: number;
  realizedPnlJpy: number;
  cyclesToday: number;
  cyclesTotal: number;
}

export async function getDashboardStats(): Promise<DashboardStats> {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [state, portfolio, realizedAgg, cyclesTodayAgg, cyclesTotalAgg] = await Promise.all([
    db
      .select()
      .from(systemState)
      .limit(1)
      .then((r) => r[0]),
    db
      .select()
      .from(portfolios)
      .where(eq(portfolios.strategyId, STRATEGY_ID))
      .limit(1)
      .then((r) => r[0]),
    // open / closed 問わず全 position の確定損益を合算 (部分決済 → open のまま realized 累積される)
    db
      .select({ sum: sql<string>`COALESCE(SUM(${positions.realizedPnlJpy}), 0)` })
      .from(positions)
      .where(eq(positions.strategyId, STRATEGY_ID))
      .then((r) => Number(r[0]?.sum ?? 0)),
    // critic_outputs.model は LLM モデル名なので portfolio モデルではフィルタしない
    // (現状 portfolio は1つなので全 critic = 全 cycle)
    db
      .select({ count: sql<string>`COUNT(*)` })
      .from(criticOutputs)
      .where(gte(criticOutputs.createdAt, todayStart))
      .then((r) => Number(r[0]?.count ?? 0)),
    db
      .select({ count: sql<string>`COUNT(*)` })
      .from(criticOutputs)
      .then((r) => Number(r[0]?.count ?? 0)),
  ]);

  const intervalRaw = state?.cycleIntervalHours ?? DEFAULT_CYCLE_INTERVAL_HOURS;
  const cycleIntervalHours = isCycleIntervalHours(intervalRaw)
    ? intervalRaw
    : DEFAULT_CYCLE_INTERVAL_HOURS;

  return {
    state: state?.state,
    killReason: state?.killReason ?? null,
    cycleIntervalHours,
    nextScheduledAt: state?.nextScheduledAt ?? null,
    lastCycleAt: state?.lastCycleAt ?? null,
    cashJpy: Number(portfolio?.cashJpy ?? 0),
    initialCashJpy: Number(portfolio?.initialCashJpy ?? 0),
    realizedPnlJpy: realizedAgg,
    cyclesToday: cyclesTodayAgg,
    cyclesTotal: cyclesTotalAgg,
  };
}

export interface OpenPositionRow {
  positionId: string;
  symbol: string;
  quantity: number;
  avgEntryPrice: number;
  currentPrice: number;
  marketValueJpy: number;
  unrealizedPnlJpy: number;
  openedAt: Date;
}

export async function getOpenPositions(): Promise<OpenPositionRow[]> {
  const rows = await db
    .select({ position: positions, coin: coins })
    .from(positions)
    .innerJoin(coins, eq(positions.coinId, coins.id))
    .where(and(eq(positions.strategyId, STRATEGY_ID), eq(positions.status, "open")))
    .orderBy(desc(positions.openedAt));

  if (rows.length === 0) return [];

  // 全銘柄ティッカー一括取得 (GMO API 1 コール、N 銘柄分)
  let priceMap = new Map<string, number>();
  try {
    const tickers = await getTicker();
    priceMap = new Map(tickers.map((t) => [t.symbol, Number(t.last)]));
  } catch (err) {
    logger.warn({ err }, "Ticker fetch failed in getOpenPositions, falling back to avg price");
  }

  return rows.map((r) => {
    const qty = Number(r.position.quantity);
    const avg = Number(r.position.avgEntryPrice);
    const current = priceMap.get(r.coin.symbol) ?? avg; // fallback: 建値で評価
    const marketValueJpy = qty * current;
    const unrealizedPnlJpy = (current - avg) * qty;
    return {
      positionId: r.position.id,
      symbol: r.coin.symbol,
      quantity: qty,
      avgEntryPrice: avg,
      currentPrice: current,
      marketValueJpy,
      unrealizedPnlJpy,
      openedAt: r.position.openedAt,
    };
  });
}

export interface RecentCycleRow {
  cycleId: string;
  criticDecision: string;
  criticReasoning: string | null;
  createdAt: Date;
  symbolCount: number;
}

export async function getRecentCycles(limit = 15): Promise<RecentCycleRow[]> {
  // critic_outputs.model は LLM モデル名なのでフィルタしない
  const critics = await db
    .select()
    .from(criticOutputs)
    .orderBy(desc(criticOutputs.createdAt))
    .limit(limit);

  if (critics.length === 0) return [];

  const cycleIds = critics.map((c) => c.cycleId);

  // 各 cycleId に対する銘柄数を集計
  const symbolCounts = await db
    .select({
      cycleId: marketSnapshots.cycleId,
      count: sql<string>`COUNT(*)`,
    })
    .from(marketSnapshots)
    .where(sql`${marketSnapshots.cycleId} IN ${cycleIds}`)
    .groupBy(marketSnapshots.cycleId);
  const countByCycle = new Map(symbolCounts.map((r) => [r.cycleId, Number(r.count)]));

  return critics.map((c) => ({
    cycleId: c.cycleId,
    criticDecision: c.decision,
    criticReasoning: c.reasoning,
    createdAt: c.createdAt,
    symbolCount: countByCycle.get(c.cycleId) ?? 0,
  }));
}

export interface CycleDetail {
  cycleId: string;
  critic: {
    decision: string;
    reasoning: string | null;
    allocationProposal: unknown;
    adjustments: unknown;
    createdAt: Date;
  } | null;
  coins: Array<{
    symbol: string;
    snapshot: {
      perplexitySummary: string | null;
      perplexityCitations: string[];
      grokSummary: string | null;
      grokCitations: string[];
      fetchedAt: Date;
    } | null;
    preAnalyst: {
      summary: string;
      relevanceScore: number;
      skipFlag: boolean;
      reasoning: string | null;
    } | null;
    analyst: AnalystOutput | null;
    entryDecision: {
      result: string;
      confidence: number;
      reasoning: string | null;
    } | null;
    exitDecision: {
      result: string;
      confidence: number;
      reasoning: string | null;
    } | null;
  }>;
}

export async function getCycleDetail(cycleId: string): Promise<CycleDetail | null> {
  const critic = (
    await db.select().from(criticOutputs).where(eq(criticOutputs.cycleId, cycleId)).limit(1)
  )[0];

  const snapshots = await db
    .select({ snap: marketSnapshots, coin: coins })
    .from(marketSnapshots)
    .innerJoin(coins, eq(marketSnapshots.coinId, coins.id))
    .where(eq(marketSnapshots.cycleId, cycleId));

  if (!critic && snapshots.length === 0) return null;

  const coinSections = await Promise.all(
    snapshots.map(async ({ snap, coin }) => {
      const [preAnalyst, analyst] = await Promise.all([
        db
          .select()
          .from(preAnalystOutputs)
          .where(eq(preAnalystOutputs.snapshotId, snap.id))
          .limit(1)
          .then((r) => r[0]),
        db
          .select()
          .from(analystOutputs)
          .where(eq(analystOutputs.snapshotId, snap.id))
          .limit(1)
          .then((r) => r[0]),
      ]);

      const decisionsForCoin = analyst
        ? await db.select().from(decisions).where(eq(decisions.analystId, analyst.id))
        : [];
      const entryDecision = decisionsForCoin.find((d) => d.kind === "entry");
      const exitDecision = decisionsForCoin.find((d) => d.kind === "exit");

      return {
        symbol: coin.symbol,
        snapshot: {
          perplexitySummary: snap.perplexitySummary,
          perplexityCitations: (snap.perplexityCitations ?? []) as string[],
          grokSummary: snap.grokSummary,
          grokCitations: (snap.grokCitations ?? []) as string[],
          fetchedAt: snap.fetchedAt,
        },
        preAnalyst: preAnalyst
          ? {
              summary: preAnalyst.summary,
              relevanceScore: Number(preAnalyst.relevanceScore),
              skipFlag: preAnalyst.skipFlag,
              reasoning: preAnalyst.reasoning,
            }
          : null,
        analyst: analyst
          ? ({
              fundamental: analyst.fundamental,
              sentiment: analyst.sentiment,
              technical: analyst.technical,
              synthesis: analyst.synthesis,
            } as AnalystOutput)
          : null,
        entryDecision: entryDecision
          ? {
              result: entryDecision.result,
              confidence: Number(entryDecision.confidence),
              reasoning: entryDecision.reasoning,
            }
          : null,
        exitDecision: exitDecision
          ? {
              result: exitDecision.result,
              confidence: Number(exitDecision.confidence),
              reasoning: exitDecision.reasoning,
            }
          : null,
      };
    }),
  );

  return {
    cycleId,
    critic: critic
      ? {
          decision: critic.decision,
          reasoning: critic.reasoning,
          allocationProposal: critic.allocationProposal,
          adjustments: critic.adjustments,
          createdAt: critic.createdAt,
        }
      : null,
    coins: coinSections,
  };
}

export interface CoinChecklistRow {
  id: string;
  symbol: string;
  name: string;
  enabled: boolean;
}

export async function getCoinChecklist(): Promise<CoinChecklistRow[]> {
  const rows = await db
    .select({
      id: coins.id,
      symbol: coins.symbol,
      name: coins.name,
      enabled: coins.enabled,
    })
    .from(coins)
    .orderBy(coins.symbol);
  return rows;
}

/** completed_at が未セットで、開始から 30 分以内の cycle 行があれば実行中とみなす */
export async function isCycleInFlight(): Promise<boolean> {
  const since = new Date(Date.now() - 30 * 60_000);
  const row = (
    await db
      .select({ id: cycles.id })
      .from(cycles)
      .where(and(isNull(cycles.completedAt), gte(cycles.startedAt, since)))
      .limit(1)
  )[0];
  return !!row;
}
