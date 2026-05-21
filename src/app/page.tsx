import { signOutAction } from "@/app/actions/auth";
import { AutoRefresh } from "@/components/dashboard/auto-refresh";
import { CoinChecklist } from "@/components/dashboard/coin-checklist";
import { RiskParams } from "@/components/dashboard/risk-params";
import { SystemControls } from "@/components/dashboard/system-controls";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  getCoinChecklist,
  getDashboardStats,
  getOpenPositions,
  getRecentCycles,
  getTickerSnapshot,
  isCycleInFlight,
} from "@/lib/cycle/queries";
import { formatJstDate, formatJstDateTime } from "@/lib/format/datetime";
import Link from "next/link";

export const dynamic = "force-dynamic";

function jpy(n: number) {
  return `¥${n.toLocaleString("ja-JP", { maximumFractionDigits: 0 })}`;
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
  const [stats, openPositions, recentCycles, coinChecklist, cycleInFlight, ticker] =
    await Promise.all([
      getDashboardStats(),
      getOpenPositions(),
      getRecentCycles(cyclesLimit),
      getCoinChecklist(),
      isCycleInFlight(),
      getTickerSnapshot(),
    ]);

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
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-amber-700 text-sm dark:text-amber-300">
          <strong className="font-semibold">⚠ GMO ティッカー取得失敗</strong>{" "}
          含み損益は建値ベースで表示しています (実際の含み損益と乖離している可能性あり)。
        </div>
      )}

      <SystemControls
        state={stats.state ?? "stopped"}
        killReason={stats.killReason}
        cycleIntervalHours={stats.cycleIntervalHours}
        nextScheduledAt={stats.nextScheduledAt?.toISOString() ?? null}
        emergencyStop={stats.emergencyStop}
      />

      <CoinChecklist coins={coinChecklist} cycleInFlight={cycleInFlight} />

      <RiskParams
        perCoinMaxRatio={stats.perCoinMaxRatio}
        portfolioDdTrigger={stats.portfolioDdTrigger}
        autoPauseThreshold={stats.autoPauseThreshold}
      />

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>現金</CardDescription>
            <CardTitle className="font-mono text-lg">{jpy(stats.cashJpy)}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>実現損益</CardDescription>
            <CardTitle
              className={`font-mono text-lg ${
                stats.realizedPnlJpy >= 0 ? "text-emerald-500" : "text-red-500"
              }`}
            >
              {jpy(stats.realizedPnlJpy)}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>資産時価総額</CardDescription>
            <CardTitle className="font-mono text-lg">{jpy(equity)}</CardTitle>
            <CardDescription className="pt-1 text-xs">
              累計:{" "}
              <span className={totalPnl >= 0 ? "text-emerald-500" : "text-red-500"}>
                {jpy(totalPnl)} ({totalPnlPct.toFixed(2)}%)
              </span>
              {" / "}
              含み:{" "}
              <span className={unrealizedPnl >= 0 ? "text-emerald-500" : "text-red-500"}>
                {jpy(unrealizedPnl)}
              </span>
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
      </section>

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
            <ul className="space-y-2 text-sm">
              {openPositions.map((p) => {
                // S: 銘柄ごとの含み損益を表示。ticker 失敗時 (バナー表示中) は 0 / 0% になるため
                // current === avg なら含み P/L 行を出さない。
                const hasMtm = p.currentPrice !== p.avgEntryPrice;
                const pnlPct =
                  p.avgEntryPrice > 0
                    ? (p.unrealizedPnlJpy / (p.avgEntryPrice * p.quantity)) * 100
                    : 0;
                const pnlColor = p.unrealizedPnlJpy >= 0 ? "text-emerald-500" : "text-red-500";
                const sign = p.unrealizedPnlJpy >= 0 ? "+" : "";
                return (
                  <li key={p.positionId} className="flex items-center justify-between gap-3">
                    <span className="font-medium">{p.symbol}</span>
                    <div className="flex flex-col items-end text-xs">
                      <span className="font-mono text-muted-foreground">
                        {p.quantity} @ {jpy(p.avgEntryPrice)}・建玉日 {formatJstDate(p.openedAt)}
                      </span>
                      {hasMtm && (
                        <span className={`font-mono ${pnlColor}`}>
                          {sign}
                          {jpy(p.unrealizedPnlJpy)} ({sign}
                          {pnlPct.toFixed(2)}%)
                        </span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

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
                <li key={c.cycleId}>
                  <Link
                    href={`/cycles/${c.cycleId}`}
                    className="flex items-center justify-between gap-3 py-3 hover:bg-muted/30"
                  >
                    <div className="flex flex-col gap-1">
                      <span className="font-mono text-xs">{c.cycleId.slice(0, 8)}</span>
                      <span className="text-muted-foreground text-xs">
                        {formatJstDateTime(c.createdAt)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground text-xs">{c.symbolCount} 銘柄</span>
                      <Badge
                        variant={
                          c.criticDecision === "approve"
                            ? "default"
                            : c.criticDecision === "modify" ||
                                c.criticDecision === "in_flight" ||
                                c.criticDecision === "auto-skip"
                              ? "outline"
                              : "destructive"
                        }
                      >
                        {c.criticDecision === "approve"
                          ? "承認"
                          : c.criticDecision === "modify"
                            ? "修正"
                            : c.criticDecision === "veto"
                              ? "拒否"
                              : c.criticDecision === "failed"
                                ? "失敗"
                                : c.criticDecision === "in_flight"
                                  ? "実行中"
                                  : c.criticDecision === "auto-skip"
                                    ? "審査スキップ"
                                    : c.criticDecision}
                      </Badge>
                    </div>
                  </Link>
                </li>
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
