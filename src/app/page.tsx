import { CoinChecklist } from "@/components/dashboard/coin-checklist";
import { RiskParams } from "@/components/dashboard/risk-params";
import { SystemControls } from "@/components/dashboard/system-controls";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  getCoinChecklist,
  getDashboardStats,
  getOpenPositions,
  getRecentCycles,
  isCycleInFlight,
} from "@/lib/cycle/queries";
import { formatJstDate, formatJstDateTime } from "@/lib/format/datetime";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import Link from "next/link";

export const dynamic = "force-dynamic";

function jpy(n: number) {
  return `¥${n.toLocaleString("ja-JP", { maximumFractionDigits: 0 })}`;
}

export default async function Home() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const [stats, openPositions, recentCycles, coinChecklist, cycleInFlight] = await Promise.all([
    getDashboardStats(),
    getOpenPositions(),
    getRecentCycles(20),
    getCoinChecklist(),
    isCycleInFlight(),
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
      <header className="flex items-center justify-between">
        <h1 className="font-bold text-2xl">LLM Trading</h1>
        <span className="text-muted-foreground text-sm">ログイン中</span>
      </header>

      <SystemControls
        state={stats.state ?? "stopped"}
        killReason={stats.killReason}
        cycleIntervalHours={stats.cycleIntervalHours}
        nextScheduledAt={stats.nextScheduledAt?.toISOString() ?? null}
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
            <CardDescription>直近サイクル: {formatJstDateTime(stats.lastCycleAt)}</CardDescription>
          )}
        </CardHeader>
        <CardContent>
          {openPositions.length === 0 ? (
            <p className="text-muted-foreground text-sm">なし</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {openPositions.map((p) => (
                <li key={p.positionId} className="flex items-center justify-between">
                  <span className="font-medium">{p.symbol}</span>
                  <span className="font-mono text-muted-foreground text-xs">
                    {p.quantity} @ {jpy(p.avgEntryPrice)}・建玉日 {formatJstDate(p.openedAt)}
                  </span>
                </li>
              ))}
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
                            : c.criticDecision === "modify" || c.criticDecision === "in_flight"
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
                                  : c.criticDecision}
                      </Badge>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
