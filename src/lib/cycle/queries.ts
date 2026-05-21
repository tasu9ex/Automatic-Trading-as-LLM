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
  pendingOrders,
  portfolioCapitalEvents,
  portfolios,
  positions,
  preAnalystOutputs,
  systemEvents,
  systemState,
} from "@/db/schema";
import { getTicker } from "@/lib/clients/gmo";
import { createLogger } from "@/lib/logging";
import type { AnalystOutput } from "@/lib/schemas/llm-outputs";
import {
  type CycleIntervalMinutes,
  DEFAULT_CYCLE_INTERVAL_MINUTES,
  isCycleIntervalMinutes,
} from "@/lib/system-control/constants";
import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { unstable_cache } from "next/cache";

/**
 * ダッシュボードクエリ用のキャッシュタグ。
 * 30 秒 TTL で読み出しを軽量化。手動操作 (start/pause/銘柄 toggle) 後は
 * server action 側で `revalidateTag(DASHBOARD_CACHE_TAG)` を呼ぶことで即時無効化。
 */
export const DASHBOARD_CACHE_TAG = "dashboard";
const CACHE_REVALIDATE_SECONDS = 30;

const logger = createLogger("cycle.queries");

const STRATEGY_ID = "trial-5";

export interface DashboardStats {
  state: string | undefined;
  killReason: string | null;
  /** Kill Switch 発動時刻 */
  killedAt: Date | null;
  /** BB-2: 緊急停止フラグ */
  emergencyStop: boolean;
  /** 連続失敗カウント (auto-pause threshold まで残り何回か可視化用) */
  consecutiveFailures: number;
  /** 連続失敗の種別 ("transient" / "permanent" / "quota") */
  lastFailureKind: string | null;
  /** 累計 API コスト (USD) */
  cumulativeCostUsd: number;
  cycleIntervalMinutes: CycleIntervalMinutes;
  nextScheduledAt: Date | null;
  lastCycleAt: Date | null;
  cashJpy: number;
  initialCashJpy: number;
  /** HWM-base DD 表示用 */
  highWaterMarkJpy: number;
  realizedPnlJpy: number;
  cyclesToday: number;
  cyclesTotal: number;
  /** §17: UI で表示・調整するリスクパラメータ (system_state から) */
  perCoinMaxRatio: number;
  /** 段 2: per-coin 総エクスポージャ上限 (equity base、1.0 = 制限なし) */
  perCoinTotalMaxRatio: number;
  portfolioDdTrigger: number;
  autoPauseThreshold: number;
}

const _cachedDashboardStats = unstable_cache(() => getDashboardStatsImpl(), ["dashboard.stats"], {
  revalidate: CACHE_REVALIDATE_SECONDS,
  tags: [DASHBOARD_CACHE_TAG],
});

/** cache 越しに Date が string に化けるので Date に戻す */
export async function getDashboardStats(): Promise<DashboardStats> {
  const cached = await _cachedDashboardStats();
  return {
    ...cached,
    nextScheduledAt: reviveDate(cached.nextScheduledAt),
    lastCycleAt: reviveDate(cached.lastCycleAt),
    killedAt: reviveDate(cached.killedAt),
  };
}

function reviveDate(v: Date | string | null): Date | null {
  if (!v) return null;
  return v instanceof Date ? v : new Date(v);
}

export async function getDashboardStatsImpl(): Promise<DashboardStats> {
  // L: 「本日のサイクル数」は JST 起算で数える。Vercel サーバ TZ (UTC) で 0 時起算すると
  // JST 9:00 で日次リセットが走り、ユーザー体感とズレる。
  const jstTodayStart = sql`(date_trunc('day', now() AT TIME ZONE 'Asia/Tokyo')) AT TIME ZONE 'Asia/Tokyo'`;

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
      .where(sql`${criticOutputs.createdAt} >= ${jstTodayStart}`)
      .then((r) => Number(r[0]?.count ?? 0)),
    db
      .select({ count: sql<string>`COUNT(*)` })
      .from(criticOutputs)
      .then((r) => Number(r[0]?.count ?? 0)),
  ]);

  const intervalRaw = state?.cycleIntervalMinutes ?? DEFAULT_CYCLE_INTERVAL_MINUTES;
  const cycleIntervalMinutes = isCycleIntervalMinutes(intervalRaw)
    ? intervalRaw
    : DEFAULT_CYCLE_INTERVAL_MINUTES;

  return {
    state: state?.state,
    killReason: state?.killReason ?? null,
    killedAt: state?.killedAt ?? null,
    emergencyStop: state?.emergencyStop ?? false,
    consecutiveFailures: state?.consecutiveFailures ?? 0,
    lastFailureKind: state?.lastFailureKind ?? null,
    cumulativeCostUsd: Number(state?.cumulativeCostUsd ?? 0),
    cycleIntervalMinutes,
    nextScheduledAt: state?.nextScheduledAt ?? null,
    lastCycleAt: state?.lastCycleAt ?? null,
    cashJpy: Number(portfolio?.cashJpy ?? 0),
    initialCashJpy: Number(portfolio?.initialCashJpy ?? 0),
    highWaterMarkJpy: Number(portfolio?.highWaterMarkJpy ?? 0),
    realizedPnlJpy: realizedAgg,
    cyclesToday: cyclesTodayAgg,
    cyclesTotal: cyclesTotalAgg,
    perCoinMaxRatio: Number(state?.perCoinMaxRatio ?? 0.25),
    perCoinTotalMaxRatio: Number(state?.perCoinTotalMaxRatio ?? 1.0),
    portfolioDdTrigger: Number(state?.portfolioDdTrigger ?? 0.5),
    autoPauseThreshold: Number(state?.autoPauseThreshold ?? 3),
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

const _cachedOpenPositionsRaw = unstable_cache(
  () => getOpenPositionsRawImpl(),
  ["dashboard.open-positions-raw"],
  { revalidate: CACHE_REVALIDATE_SECONDS, tags: [DASHBOARD_CACHE_TAG] },
);

interface RawOpenPositionRow {
  positionId: string;
  symbol: string;
  quantity: number;
  avgEntryPrice: number;
  openedAt: Date;
}

/** P-1: ticker fetch を含まない DB-only 版。GMO レイテンシで dashboard 全体がブロックされるのを防ぐ */
export async function getOpenPositionsRawImpl(): Promise<RawOpenPositionRow[]> {
  const rows = await db
    .select({ position: positions, coin: coins })
    .from(positions)
    .innerJoin(coins, eq(positions.coinId, coins.id))
    .where(and(eq(positions.strategyId, STRATEGY_ID), eq(positions.status, "open")))
    .orderBy(desc(positions.openedAt));
  return rows.map((r) => ({
    positionId: r.position.id,
    symbol: r.coin.symbol,
    quantity: Number(r.position.quantity),
    avgEntryPrice: Number(r.position.avgEntryPrice),
    openedAt: r.position.openedAt,
  }));
}

export interface TickerSnapshot {
  /** symbol → last 価格。fetch 失敗時は空 */
  priceBySymbol: Record<string, number>;
  /** F: false なら dashboard でバナー表示 (含み損益が avg ベースで表示されている旨) */
  ok: boolean;
  fetchedAt: Date | string;
}

const _cachedTickerSnapshot = unstable_cache(
  () => getTickerSnapshotImpl(),
  ["dashboard.ticker-snapshot"],
  // ticker は短い TTL で独立リフレッシュ。失敗時も同じ TTL でキャッシュされ過剰リトライを防ぐ。
  { revalidate: CACHE_REVALIDATE_SECONDS, tags: [DASHBOARD_CACHE_TAG] },
);

export async function getTickerSnapshot(): Promise<TickerSnapshot> {
  const snap = await _cachedTickerSnapshot();
  return { ...snap, fetchedAt: reviveDate(snap.fetchedAt) ?? new Date(0) };
}

async function getTickerSnapshotImpl(): Promise<TickerSnapshot> {
  try {
    const tickers = await getTicker();
    const priceBySymbol: Record<string, number> = {};
    for (const t of tickers) {
      priceBySymbol[t.symbol] = Number(t.last);
    }
    return { priceBySymbol, ok: true, fetchedAt: new Date() };
  } catch (err) {
    logger.warn({ err }, "Ticker fetch failed, dashboard shows avg-price fallback");
    return { priceBySymbol: {}, ok: false, fetchedAt: new Date() };
  }
}

export async function getOpenPositions(): Promise<OpenPositionRow[]> {
  // P-1: ticker は別キャッシュで並列 fetch。GMO 失敗でも DB 部分は影響を受けない。
  const [rawRows, ticker] = await Promise.all([_cachedOpenPositionsRaw(), getTickerSnapshot()]);
  return rawRows.map((r) => {
    const current = ticker.priceBySymbol[r.symbol] ?? r.avgEntryPrice;
    return {
      positionId: r.positionId,
      symbol: r.symbol,
      quantity: r.quantity,
      avgEntryPrice: r.avgEntryPrice,
      currentPrice: current,
      marketValueJpy: r.quantity * current,
      unrealizedPnlJpy: (current - r.avgEntryPrice) * r.quantity,
      openedAt: reviveDate(r.openedAt) ?? new Date(0),
    };
  });
}

export interface RecentCycleRow {
  cycleId: string;
  /** "approve" / "veto" / "modify" / "failed" / "in_flight" */
  criticDecision: string;
  criticReasoning: string | null;
  createdAt: Date;
  symbolCount: number;
}

const _cachedRecentCycles = unstable_cache(
  (limit = 15) => getRecentCyclesImpl(limit),
  ["dashboard.recent-cycles"],
  { revalidate: CACHE_REVALIDATE_SECONDS, tags: [DASHBOARD_CACHE_TAG] },
);

export async function getRecentCycles(limit = 15): Promise<RecentCycleRow[]> {
  const rows = await _cachedRecentCycles(limit);
  return rows.map((r) => ({ ...r, createdAt: reviveDate(r.createdAt) ?? new Date(0) }));
}

/**
 * cycles テーブル起点に LEFT JOIN critic_outputs。
 * 失敗 cycle (critic_outputs 行なし) は "failed" (completed_at あり) または "in_flight" (completed_at なし) として表示。
 */
export async function getRecentCyclesImpl(limit = 15): Promise<RecentCycleRow[]> {
  const rows = await db
    .select({
      id: cycles.id,
      startedAt: cycles.startedAt,
      completedAt: cycles.completedAt,
      coinIds: cycles.coinIds,
      criticDecision: criticOutputs.decision,
      criticReasoning: criticOutputs.reasoning,
      // HH: auto-skip Critic を本物の approve と区別するため llmModel を読み出す
      criticModel: criticOutputs.llmModel,
    })
    .from(cycles)
    .leftJoin(criticOutputs, eq(criticOutputs.cycleId, cycles.id))
    .orderBy(desc(cycles.startedAt))
    .limit(limit);

  return rows.map((r) => {
    // HH: auto-skip (Critic 呼び出し節約) は approve と擬制されているが UI では別表示
    let decision: string;
    if (r.criticDecision) {
      decision = r.criticModel === "auto-skip" ? "auto-skip" : r.criticDecision;
    } else {
      decision = r.completedAt ? "failed" : "in_flight";
    }
    return {
      cycleId: r.id,
      criticDecision: decision,
      criticReasoning: r.criticReasoning,
      createdAt: r.startedAt,
      symbolCount: Array.isArray(r.coinIds) ? r.coinIds.length : 0,
    };
  });
}

export interface CycleDetail {
  cycleId: string;
  startedAt: Date;
  completedAt: Date | null;
  /** "approve" / "veto" / "modify" / "failed" / "in_flight" */
  status: string;
  abortReason: { phase: string; kind: string; message: string } | null;
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

/**
 * P-2: 完了 cycle は immutable なので `unstable_cache` でラップして毎回フル実行を避ける。
 * cycleId をキーに含めて per-cycle キャッシュ。in_flight cycle も同じ TTL でキャッシュされるが、
 * dashboard tag invalidation でサイクル完了時に無効化される。
 */
const _cachedCycleDetail = unstable_cache(
  (cycleId: string) => getCycleDetailImpl(cycleId),
  ["dashboard.cycle-detail"],
  { revalidate: CACHE_REVALIDATE_SECONDS, tags: [DASHBOARD_CACHE_TAG] },
);

export async function getCycleDetail(cycleId: string): Promise<CycleDetail | null> {
  const cached = await _cachedCycleDetail(cycleId);
  if (!cached) return null;
  // unstable_cache 越しに Date が文字列化されるので revive
  return {
    ...cached,
    startedAt: reviveDate(cached.startedAt) ?? new Date(0),
    completedAt: reviveDate(cached.completedAt),
    critic: cached.critic
      ? { ...cached.critic, createdAt: reviveDate(cached.critic.createdAt) ?? new Date(0) }
      : null,
    coins: cached.coins.map((c) => ({
      ...c,
      snapshot: c.snapshot
        ? { ...c.snapshot, fetchedAt: reviveDate(c.snapshot.fetchedAt) ?? new Date(0) }
        : null,
    })),
  };
}

async function getCycleDetailImpl(cycleId: string): Promise<CycleDetail | null> {
  // cycles テーブル起点 (失敗 cycle も含めて全部出る)
  const cycle = (await db.select().from(cycles).where(eq(cycles.id, cycleId)).limit(1))[0];
  if (!cycle) return null; // 不正な id のみ 404

  const [critic, snapshots, abortEvent] = await Promise.all([
    db
      .select()
      .from(criticOutputs)
      .where(eq(criticOutputs.cycleId, cycleId))
      .limit(1)
      .then((r) => r[0]),
    db
      .select({ snap: marketSnapshots, coin: coins })
      .from(marketSnapshots)
      .innerJoin(coins, eq(marketSnapshots.coinId, coins.id))
      .where(eq(marketSnapshots.cycleId, cycleId)),
    // 失敗 cycle の理由 (data_fetch_failed / llm_failure / cycle_aborted のいずれか、§22)
    db
      .select()
      .from(systemEvents)
      .where(
        and(
          sql`${systemEvents.kind} IN ('cycle_aborted', 'data_fetch_failed', 'llm_failure')`,
          // P-5: 直接カラム + index で seq scan を回避 (旧 JSONB 検索は backfill 済み)
          eq(systemEvents.cycleId, cycleId),
        ),
      )
      .orderBy(desc(systemEvents.occurredAt))
      .limit(1)
      .then((r) => r[0]),
  ]);

  const status = critic ? critic.decision : cycle.completedAt ? "failed" : "in_flight";
  const abortReason = abortEvent
    ? {
        phase:
          typeof (abortEvent.payload as Record<string, unknown>)?.phase === "string"
            ? String((abortEvent.payload as Record<string, unknown>).phase)
            : "unknown",
        kind:
          typeof (abortEvent.payload as Record<string, unknown>)?.kind === "string"
            ? String((abortEvent.payload as Record<string, unknown>).kind)
            : "unknown",
        message: abortEvent.message,
      }
    : null;

  // P-3: per-coin で 3 クエリ叩いていた N+1 を 3 つの bulk クエリに統合。
  // snapshots N 件 → preAnalyst / analyst / decisions それぞれ 1 クエリで全件取得 + Map で結合。
  const snapshotIds = snapshots.map((s) => s.snap.id);
  const preAnalysts =
    snapshotIds.length > 0
      ? await db
          .select()
          .from(preAnalystOutputs)
          .where(inArray(preAnalystOutputs.snapshotId, snapshotIds))
      : [];
  const analysts =
    snapshotIds.length > 0
      ? await db
          .select()
          .from(analystOutputs)
          .where(inArray(analystOutputs.snapshotId, snapshotIds))
      : [];
  const analystIds = analysts.map((a) => a.id);
  const decisionRows =
    analystIds.length > 0
      ? await db.select().from(decisions).where(inArray(decisions.analystId, analystIds))
      : [];

  const preAnalystBySnap = new Map(preAnalysts.map((p) => [p.snapshotId, p]));
  const analystBySnap = new Map(analysts.map((a) => [a.snapshotId, a]));
  const decisionsByAnalyst = new Map<string, typeof decisionRows>();
  for (const d of decisionRows) {
    const arr = decisionsByAnalyst.get(d.analystId) ?? [];
    arr.push(d);
    decisionsByAnalyst.set(d.analystId, arr);
  }

  const coinSections = snapshots.map(({ snap, coin }) => {
    const preAnalyst = preAnalystBySnap.get(snap.id);
    const analyst = analystBySnap.get(snap.id);
    const decisionsForCoin = analyst ? (decisionsByAnalyst.get(analyst.id) ?? []) : [];
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
  });

  return {
    cycleId,
    startedAt: cycle.startedAt,
    completedAt: cycle.completedAt,
    status,
    abortReason,
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

export const getCoinChecklist = unstable_cache(
  () => getCoinChecklistImpl(),
  ["dashboard.coin-checklist"],
  { revalidate: CACHE_REVALIDATE_SECONDS, tags: [DASHBOARD_CACHE_TAG] },
);

async function getCoinChecklistImpl(): Promise<CoinChecklistRow[]> {
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

export const isCycleInFlight = unstable_cache(
  () => isCycleInFlightImpl(),
  ["dashboard.in-flight"],
  { revalidate: CACHE_REVALIDATE_SECONDS, tags: [DASHBOARD_CACHE_TAG] },
);

/**
 * N: 「実行中」判定の堅牢化。
 *
 * DD 修正で失敗 cycle は recordCycleFailure 経由で completedAt が埋まるようになったので、
 * 残る「NULL のまま残留する」ケースは process kill 等のハードクラッシュのみ。
 * その上限を cycleIntervalMinutes (= 次サイクル cron の発火間隔) に揃える。
 *
 * 10 分固定窓だと、Inngest のリトライや一時的なハングで NULL が 10 分超 → "実行中じゃない"
 * 扱いになり、銘柄 toggle ガードが破れるバグがあった。
 */
async function isCycleInFlightImpl(): Promise<boolean> {
  const state = (
    await db
      .select({ cycleIntervalMinutes: systemState.cycleIntervalMinutes })
      .from(systemState)
      .where(eq(systemState.id, "singleton"))
      .limit(1)
  )[0];
  const intervalMinutes = state?.cycleIntervalMinutes ?? DEFAULT_CYCLE_INTERVAL_MINUTES;
  const since = new Date(Date.now() - intervalMinutes * 60_000);
  const row = (
    await db
      .select({ id: cycles.id })
      .from(cycles)
      .where(and(isNull(cycles.completedAt), gte(cycles.startedAt, since)))
      .limit(1)
  )[0];
  return !!row;
}

// =============================================================================
// 直近 system events (運用ログ可視化)
// =============================================================================

export interface SystemEventRow {
  id: string;
  kind: string;
  severity: string;
  message: string;
  cycleId: string | null;
  occurredAt: Date;
}

const _cachedRecentEvents = unstable_cache(
  (limit = 20) => getRecentEventsImpl(limit),
  ["dashboard.recent-events"],
  { revalidate: CACHE_REVALIDATE_SECONDS, tags: [DASHBOARD_CACHE_TAG] },
);

export async function getRecentSystemEvents(limit = 20): Promise<SystemEventRow[]> {
  const rows = await _cachedRecentEvents(limit);
  return rows.map((r) => ({ ...r, occurredAt: reviveDate(r.occurredAt) ?? new Date(0) }));
}

async function getRecentEventsImpl(limit: number): Promise<SystemEventRow[]> {
  const rows = await db
    .select({
      id: systemEvents.id,
      kind: systemEvents.kind,
      severity: systemEvents.severity,
      message: systemEvents.message,
      cycleId: systemEvents.cycleId,
      occurredAt: systemEvents.occurredAt,
    })
    .from(systemEvents)
    .orderBy(desc(systemEvents.occurredAt))
    .limit(limit);
  return rows;
}

// =============================================================================
// 入金 / 出金履歴
// =============================================================================

export interface CapitalEventRow {
  id: string;
  kind: "deposit" | "withdrawal";
  amountJpy: number;
  note: string | null;
  occurredAt: Date;
}

const _cachedCapitalEvents = unstable_cache(
  (limit = 20) => getCapitalEventsImpl(limit),
  ["dashboard.capital-events"],
  { revalidate: CACHE_REVALIDATE_SECONDS, tags: [DASHBOARD_CACHE_TAG] },
);

export async function getCapitalEvents(limit = 20): Promise<CapitalEventRow[]> {
  const rows = await _cachedCapitalEvents(limit);
  return rows.map((r) => ({ ...r, occurredAt: reviveDate(r.occurredAt) ?? new Date(0) }));
}

async function getCapitalEventsImpl(limit: number): Promise<CapitalEventRow[]> {
  const rows = await db
    .select({
      id: portfolioCapitalEvents.id,
      kind: portfolioCapitalEvents.kind,
      amountJpy: portfolioCapitalEvents.amountJpy,
      note: portfolioCapitalEvents.note,
      occurredAt: portfolioCapitalEvents.occurredAt,
    })
    .from(portfolioCapitalEvents)
    .where(eq(portfolioCapitalEvents.strategyId, STRATEGY_ID))
    .orderBy(desc(portfolioCapitalEvents.occurredAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    amountJpy: Number(r.amountJpy),
    note: r.note,
    occurredAt: r.occurredAt,
  }));
}

// =============================================================================
// ポジション詳細 (peak / trough / entry 情報 / 配置中の SL)
// =============================================================================

export interface PositionDetail {
  positionId: string;
  symbol: string;
  peakPrice: number;
  troughPrice: number;
  entryReason: string | null;
  entryExpectedHoldingDaysMin: number | null;
  entryExpectedHoldingDaysMax: number | null;
  entryTargetPriceJpy: number | null;
  entryExitCondition: string | null;
  realizedPnlJpy: number;
  /** 配置中の逆指値 (active=true のみ) */
  pendingOrders: Array<{
    id: string;
    kind: string;
    triggerPrice: number;
    limitPrice: number | null;
  }>;
}

const _cachedPositionDetails = unstable_cache(
  () => getPositionDetailsImpl(),
  ["dashboard.position-details"],
  { revalidate: CACHE_REVALIDATE_SECONDS, tags: [DASHBOARD_CACHE_TAG] },
);

export async function getPositionDetails(): Promise<PositionDetail[]> {
  return _cachedPositionDetails();
}

async function getPositionDetailsImpl(): Promise<PositionDetail[]> {
  const rows = await db
    .select({ position: positions, coin: coins })
    .from(positions)
    .innerJoin(coins, eq(positions.coinId, coins.id))
    .where(and(eq(positions.strategyId, STRATEGY_ID), eq(positions.status, "open")));

  if (rows.length === 0) return [];

  // open positions の配置中 SL を bulk fetch
  const positionIds = rows.map((r) => r.position.id);
  const slRows = await db
    .select()
    .from(pendingOrders)
    .where(and(inArray(pendingOrders.positionId, positionIds), eq(pendingOrders.active, true)));

  const slByPos = new Map<string, typeof slRows>();
  for (const s of slRows) {
    const arr = slByPos.get(s.positionId) ?? [];
    arr.push(s);
    slByPos.set(s.positionId, arr);
  }

  return rows.map((r) => ({
    positionId: r.position.id,
    symbol: r.coin.symbol,
    peakPrice: Number(r.position.peakPrice),
    troughPrice: Number(r.position.troughPrice),
    entryReason: r.position.entryReason,
    entryExpectedHoldingDaysMin: r.position.entryExpectedHoldingDaysMin
      ? Number(r.position.entryExpectedHoldingDaysMin)
      : null,
    entryExpectedHoldingDaysMax: r.position.entryExpectedHoldingDaysMax
      ? Number(r.position.entryExpectedHoldingDaysMax)
      : null,
    entryTargetPriceJpy: r.position.entryTargetPriceJpy
      ? Number(r.position.entryTargetPriceJpy)
      : null,
    entryExitCondition: r.position.entryExitCondition,
    realizedPnlJpy: Number(r.position.realizedPnlJpy ?? 0),
    pendingOrders: (slByPos.get(r.position.id) ?? []).map((s) => ({
      id: s.id,
      kind: s.kind,
      triggerPrice: Number(s.triggerPrice),
      limitPrice: s.limitPrice ? Number(s.limitPrice) : null,
    })),
  }));
}
