import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { db } from "@/db/client";
import { coins, portfolios, positions, systemState } from "@/db/schema";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { and, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export default async function Home() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  // middleware で /login へ飛ばしているのでここに来る時点で user は必ず存在
  if (!user) return null;

  const MODEL = "opus-confidence";
  const [state, portfolio, openPositions] = await Promise.all([
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
      .select({ position: positions, coin: coins })
      .from(positions)
      .innerJoin(coins, eq(positions.coinId, coins.id))
      .where(and(eq(positions.model, MODEL), eq(positions.status, "open"))),
  ]);

  return (
    <main className="container mx-auto flex min-h-screen max-w-4xl flex-col gap-6 p-6">
      <header className="flex items-center justify-between">
        <h1 className="font-bold text-2xl">LLM Trading</h1>
        <div className="flex items-center gap-3">
          <span className="text-muted-foreground text-sm">{user.email}</span>
          <Badge variant={state?.state === "running" ? "default" : "destructive"}>
            {state?.state ?? "unknown"}
          </Badge>
        </div>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Portfolio</CardTitle>
          <CardDescription>Model: {MODEL}</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 text-sm">
          <div className="text-muted-foreground">Cash</div>
          <div className="text-right font-mono">
            ¥{Number(portfolio?.cashJpy ?? 0).toLocaleString("ja-JP", { maximumFractionDigits: 0 })}
          </div>
          <div className="text-muted-foreground">Initial</div>
          <div className="text-right font-mono">
            ¥
            {Number(portfolio?.initialCashJpy ?? 0).toLocaleString("ja-JP", {
              maximumFractionDigits: 0,
            })}
          </div>
          <div className="text-muted-foreground">Last cycle</div>
          <div className="text-right font-mono text-xs">
            {state?.lastCycleAt ? new Date(state.lastCycleAt).toLocaleString("ja-JP") : "—"}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Open Positions ({openPositions.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {openPositions.length === 0 ? (
            <p className="text-muted-foreground text-sm">なし</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {openPositions.map(({ position, coin }) => (
                <li key={position.id} className="flex items-center justify-between">
                  <span className="font-medium">{coin.symbol}</span>
                  <span className="font-mono text-muted-foreground">
                    {position.quantity} @ ¥{Number(position.avgEntryPrice).toLocaleString("ja-JP")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
