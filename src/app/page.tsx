import { signOutAction } from "@/app/actions/auth";
import { AutoRefresh } from "@/components/dashboard/auto-refresh";
import { CapitalEvents } from "@/components/dashboard/capital-events";
import { CoinChecklist } from "@/components/dashboard/coin-checklist";
import { RecentEvents } from "@/components/dashboard/recent-events";
import { RiskParams } from "@/components/dashboard/risk-params";
import { SystemControls } from "@/components/dashboard/system-controls";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  type OpenPositionRow,
  type PositionDetail,
  type RecentCycleRow,
  getCapitalEvents,
  getCoinChecklist,
  getDashboardStats,
  getOpenPositions,
  getPositionDetails,
  getRecentCycles,
  getRecentSystemEvents,
  getTickerSnapshot,
  isCycleInFlight,
} from "@/lib/cycle/queries";
import { criticStatusLabel, criticStatusVariant } from "@/lib/format/critic-decision";
import { formatJstDate, formatJstDateTime } from "@/lib/format/datetime";
import { formatJpy } from "@/lib/format/jpy";
import { pnlColorClass, pnlSign } from "@/lib/format/pnl";
import { AlertTriangle } from "lucide-react";
import Link from "next/link";

export const dynamic = "force-dynamic";

function CycleRow({ c }: { c: RecentCycleRow }) {
  return (
    <li>
      <Link
        href={`/cycles/${c.cycleId}`}
        className="flex items-center justify-between gap-3 py-3 hover:bg-muted/30"
      >
        <div className="flex flex-col gap-1">
          <span className="font-mono text-xs">{c.cycleId.slice(0, 8)}</span>
          <span className="text-muted-foreground text-xs">{formatJstDateTime(c.createdAt)}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-xs">{c.symbolCount} 銘柄</span>
          <Badge variant={criticStatusVariant(c.criticDecision)}>
            {criticStatusLabel(c.criticDecision)}
          </Badge>
        </div>
      </Link>
    </li>
  );
}

function PositionRow({ p, detail }: { p: OpenPositionRow; detail: PositionDetail | undefined }) {
  // S: 銘柄ごとの含み損益を表示。ticker 失敗時 (バナー表示中) は 0 / 0% になるため
  // current === avg なら含み P/L 行を出さない。
  const hasMtm = p.currentPrice !== p.avgEntryPrice;
  const pnlPct =
    p.avgEntryPrice > 0 ? (p.unrealizedPnlJpy / (p.avgEntryPrice * p.quantity)) * 100 : 0;
  const pnlColor = pnlColorClass(p.unrealizedPnlJpy);
  const sign = pnlSign(p.unrealizedPnlJpy);
  return (
    <li className="rounded-md hover:bg-muted/30">
      <details>
        <summary className="flex cursor-pointer select-none items-center justify-between gap-3 px-2 py-1.5">
          <span className="font-medium">{p.symbol}</span>
          <div className="flex flex-col items-end text-xs">
            <span className="font-mono text-muted-foreground">
              {p.quantity} @ {formatJpy(p.avgEntryPrice)}・建玉日 {formatJstDate(p.openedAt)}
            </span>
            {hasMtm && (
              <span className={`font-mono ${pnlColor}`}>
                {sign}
                {formatJpy(p.unrealizedPnlJpy)} ({sign}
                {pnlPct.toFixed(2)}%)
              </span>
            )}
          </div>
        </summary>
        {detail && <PositionDetailPanel detail={detail} />}
      </details>
    </li>
  );
}

function PositionDetailPanel({ detail }: { detail: PositionDetail }) {
  const pnlClass = pnlColorClass(detail.realizedPnlJpy);
  return (
    <div className="border-border border-t px-3 py-2 text-xs">
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono">
        <div className="text-muted-foreground">peak / trough</div>
        <div>
          {formatJpy(detail.peakPrice)} / {formatJpy(detail.troughPrice)}
        </div>
        <div className="text-muted-foreground">実現損益 (部分決済)</div>
        <div className={pnlClass}>{formatJpy(detail.realizedPnlJpy)}</div>
      </div>
      {detail.entryReason && (
        <div className="mt-2">
          <div className="text-muted-foreground">エントリー理由</div>
          <p className="whitespace-pre-wrap">{detail.entryReason}</p>
        </div>
      )}
      {detail.pendingOrders.length > 0 && (
        <div className="mt-2">
          <div className="text-muted-foreground">配置中の逆指値 (active)</div>
          <ul className="mt-1 ml-2 space-y-0.5">
            {detail.pendingOrders.map((s) => (
              <li key={s.id} className="font-mono">
                {s.kind}: trigger {formatJpy(s.triggerPrice)}
                {s.limitPrice !== null && ` / limit ${formatJpy(s.limitPrice)}`}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// H: recentCycles の表示件数。?cycles=N で増やせる。"もっと見る" は同じ page を高い limit で再 fetch。
const DEFAULT_CYCLE_LIMIT = 20;
const CYCLE_LIMIT_STEP = 20;
const MAX_CYCLE_LIMIT = 200;

export default async function Home({
  searchParams,
}: {
  searchParams?: Promise<{ cycles?: string }>;
}) {
  const params = await searchParams;
  const rawLimit = Number(params?.cycles);
  const cyclesLimit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), MAX_CYCLE_LIMIT)
      : DEFAULT_CYCLE_LIMIT;

  // M: 認証は middleware (updateSession) が一手に担う。未ログインは middleware で /login へ
  //    redirect されるためここに到達しない。重複 getUser() の Supabase 往復を削減。
  const [
    stats,
    openPositions,
    recentCycles,
    coinChecklist,
    cycleInFlight,
    ticker,
    recentEvents,
    capitalEvents,
    positionDetails,
  ] = await Promise.all([
    getDashboardStats(),
    getOpenPositions(),
    getRecentCycles(cyclesLimit),
    getCoinChecklist(),
    isCycleInFlight(),
    getTickerSnapshot(),
    getRecentSystemEvents(20),
    getCapitalEvents(20),
    getPositionDetails(),
  ]);
  const positionDetailsById = new Map(positionDetails.map((d) => [d.positionId, d]));

  // 時価評価: 現金 + 全 open position の (現在価格 × qty) - 元本
  // realized は cash に既に反映済みなので加算しない (二重計上回避)
  const marketValue = openPositions.reduce((acc, p) => acc + p.marketValueJpy, 0);
  const equity = stats.cashJpy + marketValue;
  const totalPnl = equity - stats.initialCashJpy;
  const totalPnlPct = stats.initialCashJpy > 0 ? (totalPnl / stats.initialCashJpy) * 100 : 0;
  const unrealizedPnl = openPositions.reduce((acc, p) => acc + p.unrealizedPnlJpy, 0);

  return (
    <main className="container mx-auto flex min-h-screen max-w-5xl flex-col gap-6 p-6">
      <AutoRefresh />
      <header className="flex items-center justify-between">
        <h1 className="font-bold text-2xl">LLM Trading</h1>
        <div className="flex items-center gap-3">
          {/* G: dashboard 全体の最終更新時刻を表示。auto-refresh (30s polling) で更新される */}
          <span className="text-muted-foreground text-xs">
            更新: {formatJstDateTime(new Date())}
          </span>
          <form action={signOutAction}>
            <Button type="submit" variant="ghost" size="sm">
              ログアウト
            </Button>
          </form>
        </div>
      </header>

      {!ticker.ok && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-amber-700 text-sm dark:text-amber-300">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>
            <strong className="font-semibold">GMO ティッカー取得失敗</strong>{" "}
            含み損益は建値ベースで表示しています (実際の含み損益と乖離している可能性あり)。
          </span>
        </div>
      )}

      <SystemControls
        state={stats.state ?? "stopped"}
        killReason={stats.killReason}
        cycleIntervalMinutes={stats.cycleIntervalMinutes}
        nextScheduledAt={stats.nextScheduledAt?.toISOString() ?? null}
        emergencyStop={stats.emergencyStop}
      />

      <CoinChecklist coins={coinChecklist} cycleInFlight={cycleInFlight} />

      <RiskParams
        perCoinMaxRatio={stats.perCoinMaxRatio}
        perCoinTotalMaxRatio={stats.perCoinTotalMaxRatio}
        portfolioDdTrigger={stats.portfolioDdTrigger}
        autoPauseThreshold={stats.autoPauseThreshold}
      />

      {/* HWM-base DD (現在の Kill Switch 距離感) */}
      {(() => {
        const hwm = stats.highWaterMarkJpy;
        const ddFromHwm = hwm > 0 ? (hwm - equity) / hwm : 0;
        const ddPct = (ddFromHwm * 100).toFixed(2);
        const triggerPct = (stats.portfolioDdTrigger * 100).toFixed(1);
        const ddColor =
          ddFromHwm >= 0.5 * stats.portfolioDdTrigger ? "text-red-500" : "text-muted-foreground";
        return (
          <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>現金</CardDescription>
                <CardTitle className="font-mono text-lg">{formatJpy(stats.cashJpy)}</CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>実現損益</CardDescription>
                <CardTitle className={`font-mono text-lg ${pnlColorClass(stats.realizedPnlJpy)}`}>
                  {formatJpy(stats.realizedPnlJpy)}
                </CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>資産時価総額</CardDescription>
                <CardTitle className="font-mono text-lg">{formatJpy(equity)}</CardTitle>
                <CardDescription className="pt-1 text-xs">
                  累計:{" "}
                  <span className={pnlColorClass(totalPnl)}>
                    {formatJpy(totalPnl)} ({totalPnlPct.toFixed(2)}%)
                  </span>
                  {" / "}
                  含み:{" "}
                  <span className={pnlColorClass(unrealizedPnl)}>{formatJpy(unrealizedPnl)}</span>
                </CardDescription>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>本日 / 累計 サイクル</CardDescription>
                <CardTitle className="font-mono text-lg">
                  {stats.cyclesToday} / {stats.cyclesTotal}
                </CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>HWM (資産ピーク)</CardDescription>
                <CardTitle className="font-mono text-lg">{formatJpy(hwm)}</CardTitle>
                <CardDescription className={`pt-1 text-xs ${ddColor}`}>
                  現在 DD: {ddPct}% / Kill 閾値: {triggerPct}%
                </CardDescription>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>連続失敗</CardDescription>
                <CardTitle
                  className={`font-mono text-lg ${
                    stats.consecutiveFailures > 0 ? "text-amber-600 dark:text-amber-400" : ""
                  }`}
                >
                  {stats.consecutiveFailures} / {stats.autoPauseThreshold}
                </CardTitle>
                {stats.lastFailureKind && (
                  <CardDescription className="pt-1 text-xs">
                    種別: {stats.lastFailureKind}
                  </CardDescription>
                )}
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>累計 API コスト (USD)</CardDescription>
                <CardTitle className="font-mono text-lg">
                  ${stats.cumulativeCostUsd.toFixed(2)}
                </CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Kill Switch 状態</CardDescription>
                <CardTitle
                  className={`font-mono text-lg ${
                    stats.state === "killed" ? "text-red-500" : "text-emerald-500"
                  }`}
                >
                  {stats.state === "killed" ? "発動中" : "未発動"}
                </CardTitle>
                {stats.killedAt && (
                  <CardDescription className="pt-1 text-xs">
                    {formatJstDateTime(stats.killedAt)}
                  </CardDescription>
                )}
              </CardHeader>
            </Card>
          </section>
        );
      })()}

      <Card>
        <CardHeader>
          <CardTitle>保有ポジション ({openPositions.length})</CardTitle>
          {stats.lastCycleAt && (
            <CardDescription>
              {/* T: 「直近サイクル」が start なのか complete なのかが曖昧だった。
                  system_state.lastCycleAt は finalize 成功時 or 失敗 record 時に更新されるので
                  「最終完了」が正確 */}
              最終完了サイクル: {formatJstDateTime(stats.lastCycleAt)}
            </CardDescription>
          )}
        </CardHeader>
        <CardContent>
          {openPositions.length === 0 ? (
            <p className="text-muted-foreground text-sm">なし</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {openPositions.map((p) => (
                <PositionRow
                  key={p.positionId}
                  p={p}
                  detail={positionDetailsById.get(p.positionId)}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <RecentEvents events={recentEvents} />
      <CapitalEvents events={capitalEvents} />

      <Card>
        <CardHeader>
          <CardTitle>最近のサイクル</CardTitle>
          <CardDescription>直近 {recentCycles.length} サイクル</CardDescription>
        </CardHeader>
        <CardContent>
          {recentCycles.length === 0 ? (
            <p className="text-muted-foreground text-sm">まだ実行されていません</p>
          ) : (
            <ul className="divide-y divide-border">
              {recentCycles.map((c) => (
                <CycleRow key={c.cycleId} c={c} />
              ))}
            </ul>
          )}
          {/* H: もっと見る — 上限まで段階的に増やす。fetched 件数 == 現 limit なら次がある可能性 */}
          {recentCycles.length >= cyclesLimit && cyclesLimit < MAX_CYCLE_LIMIT && (
            <div className="mt-3 flex justify-center">
              <Link
                href={`/?cycles=${Math.min(cyclesLimit + CYCLE_LIMIT_STEP, MAX_CYCLE_LIMIT)}`}
                className="rounded-md border border-border px-3 py-1 text-muted-foreground text-xs hover:bg-muted/40"
              >
                もっと見る (+{CYCLE_LIMIT_STEP})
              </Link>
            </div>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
