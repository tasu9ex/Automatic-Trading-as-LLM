import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getDashboardStats, getOpenPositions, getRecentCycles } from "@/lib/cycle/queries";
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

  const [stats, openPositions, recentCycles] = await Promise.all([
    getDashboardStats(),
    getOpenPositions(),
    getRecentCycles(20),
  ]);

  const equity =
    stats.cashJpy + openPositions.reduce((acc, p) => acc + p.quantity * p.avgEntryPrice, 0);
  const totalPnl = equity + stats.realizedPnlJpy - stats.initialCashJpy;
  const totalPnlPct = stats.initialCashJpy > 0 ? (totalPnl / stats.initialCashJpy) * 100 : 0;

  return (
    <main className="container mx-auto flex min-h-screen max-w-5xl flex-col gap-6 p-6">
      <header className="flex items-center justify-between">
        <h1 className="font-bold text-2xl">LLM Trading</h1>
        <div className="flex items-center gap-3">
          <span className="text-muted-foreground text-sm">{user.email}</span>
          <Badge variant={stats.state === "running" ? "default" : "destructive"}>
            {stats.state ?? "unknown"}
          </Badge>
        </div>
      </header>

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
            <CardDescription>累計損益</CardDescription>
            <CardTitle
              className={`font-mono text-lg ${totalPnl >= 0 ? "text-emerald-500" : "text-red-500"}`}
            >
              {jpy(totalPnl)} ({totalPnlPct.toFixed(2)}%)
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>本日のサイクル数</CardDescription>
            <CardTitle className="font-mono text-lg">{stats.cyclesToday}</CardTitle>
          </CardHeader>
        </Card>
      </section>

      <Card>
        <CardHeader>
          <CardTitle>保有ポジション ({openPositions.length})</CardTitle>
          {stats.lastCycleAt && (
            <CardDescription>
              直近サイクル: {new Date(stats.lastCycleAt).toLocaleString("ja-JP")}
            </CardDescription>
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
                    {p.quantity} @ {jpy(p.avgEntryPrice)}・建玉日{" "}
                    {new Date(p.openedAt).toLocaleDateString("ja-JP")}
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
                        {new Date(c.createdAt).toLocaleString("ja-JP")}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground text-xs">{c.symbolCount} 銘柄</span>
                      <Badge
                        variant={
                          c.criticDecision === "approve"
                            ? "default"
                            : c.criticDecision === "modify"
                              ? "outline"
                              : "destructive"
                        }
                      >
                        {c.criticDecision}
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
