/**
 * ダッシュボード用のサイクル / ポートフォリオ クエリ。
 * 全て read-only。データソースは Drizzle (postgres user, RLS bypass)。
 */
import { db } from "@/db/client";
import {
  analystOutputs,
  coins,
  criticOutputs,
  decisions,
  marketSnapshots,
  portfolios,
  positions,
  preAnalystOutputs,
  systemState,
} from "@/db/schema";
import type { AnalystOutput } from "@/lib/schemas/llm-outputs";
import { and, desc, eq, gte, sql } from "drizzle-orm";

const MODEL = "opus-confidence";

export interface DashboardStats {
  state: string | undefined;
  lastCycleAt: Date | null;
  cashJpy: number;
  initialCashJpy: number;
  realizedPnlJpy: number;
  cyclesToday: number;
}

export async function getDashboardStats(): Promise<DashboardStats> {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [state, portfolio, realizedAgg, cyclesTodayAgg] = await Promise.all([
    db
      .select()
      .from(systemState)
      .limit(1)
      .then((r) => r[0]),
    db
      .select()
      .from(portfolios)
      .where(eq(portfolios.model, MODEL))
      .limit(1)
      .then((r) => r[0]),
    db
      .select({ sum: sql<string>`COALESCE(SUM(${positions.realizedPnlJpy}), 0)` })
      .from(positions)
      .where(and(eq(positions.model, MODEL), eq(positions.status, "closed")))
      .then((r) => Number(r[0]?.sum ?? 0)),
    // critic_outputs.model は LLM モデル名なので portfolio モデルではフィルタしない
    // (現状 portfolio は1つなので全 critic = 全 cycle)
    db
      .select({ count: sql<string>`COUNT(*)` })
      .from(criticOutputs)
      .where(gte(criticOutputs.createdAt, todayStart))
      .then((r) => Number(r[0]?.count ?? 0)),
  ]);

  return {
    state: state?.state,
    lastCycleAt: state?.lastCycleAt ?? null,
    cashJpy: Number(portfolio?.cashJpy ?? 0),
    initialCashJpy: Number(portfolio?.initialCashJpy ?? 0),
    realizedPnlJpy: realizedAgg,
    cyclesToday: cyclesTodayAgg,
  };
}

export interface OpenPositionRow {
  positionId: string;
  symbol: string;
  quantity: number;
  avgEntryPrice: number;
  openedAt: Date;
}

export async function getOpenPositions(): Promise<OpenPositionRow[]> {
  const rows = await db
    .select({ position: positions, coin: coins })
    .from(positions)
    .innerJoin(coins, eq(positions.coinId, coins.id))
    .where(and(eq(positions.model, MODEL), eq(positions.status, "open")))
    .orderBy(desc(positions.openedAt));

  return rows.map((r) => ({
    positionId: r.position.id,
    symbol: r.coin.symbol,
    quantity: Number(r.position.quantity),
    avgEntryPrice: Number(r.position.avgEntryPrice),
    openedAt: r.position.openedAt,
  }));
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
      grokSummary: string | null;
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
          grokSummary: snap.grokSummary,
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
