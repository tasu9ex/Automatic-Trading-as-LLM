import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getCycleDetail } from "@/lib/cycle/queries";
import Link from "next/link";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

function decisionVariant(result: string): "default" | "destructive" | "outline" {
  if (result === "buy" || result === "close" || result === "approve") return "default";
  if (result === "no" || result === "hold") return "outline";
  return "destructive";
}

export default async function CycleDetailPage({ params }: PageProps) {
  const { id } = await params;
  const detail = await getCycleDetail(id);
  if (!detail) notFound();

  return (
    <main className="container mx-auto flex min-h-screen max-w-5xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <Link href="/" className="text-muted-foreground text-xs hover:underline">
          ← back
        </Link>
        <h1 className="font-mono text-xl">Cycle {detail.cycleId.slice(0, 12)}</h1>
        {detail.critic && (
          <span className="text-muted-foreground text-xs">
            {new Date(detail.critic.createdAt).toLocaleString("ja-JP")}
          </span>
        )}
      </header>

      {detail.critic && (
        <Card>
          <CardHeader className="flex flex-row items-start justify-between">
            <div>
              <CardTitle>Critic</CardTitle>
              <CardDescription>配分案を承認/拒否/修正する最終チェック</CardDescription>
            </div>
            <Badge
              variant={
                detail.critic.decision === "approve"
                  ? "default"
                  : detail.critic.decision === "modify"
                    ? "outline"
                    : "destructive"
              }
            >
              {detail.critic.decision}
            </Badge>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {detail.critic.reasoning && (
              <div>
                <div className="mb-1 text-muted-foreground text-xs">Reasoning</div>
                <p className="whitespace-pre-wrap">{detail.critic.reasoning}</p>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3 pt-2 text-xs">
              <div>
                <div className="text-muted-foreground">Allocation proposal</div>
                <pre className="mt-1 overflow-x-auto rounded bg-muted p-2 font-mono">
                  {JSON.stringify(detail.critic.allocationProposal, null, 2)}
                </pre>
              </div>
              <div>
                <div className="text-muted-foreground">Adjustments</div>
                <pre className="mt-1 overflow-x-auto rounded bg-muted p-2 font-mono">
                  {JSON.stringify(detail.critic.adjustments, null, 2)}
                </pre>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {detail.coins.map((c) => (
        <Card key={c.symbol}>
          <CardHeader>
            <CardTitle>{c.symbol}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            {c.preAnalyst && (
              <section className="space-y-1">
                <div className="flex items-center gap-2">
                  <h3 className="font-semibold text-muted-foreground text-xs uppercase tracking-wide">
                    Pre-Analyst
                  </h3>
                  <Badge variant={c.preAnalyst.skipFlag ? "outline" : "default"}>
                    {c.preAnalyst.skipFlag ? "skip" : "proceed"}
                  </Badge>
                  <span className="text-muted-foreground text-xs">
                    relevance {c.preAnalyst.relevanceScore.toFixed(2)}
                  </span>
                </div>
                <p>{c.preAnalyst.summary}</p>
                {c.preAnalyst.reasoning && (
                  <p className="whitespace-pre-wrap text-muted-foreground text-xs">
                    {c.preAnalyst.reasoning}
                  </p>
                )}
              </section>
            )}

            {c.analyst && (
              <section className="space-y-2">
                <h3 className="font-semibold text-muted-foreground text-xs uppercase tracking-wide">
                  Analyst
                </h3>
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="rounded border border-border p-3 text-xs">
                    <div className="mb-1 flex items-center gap-2">
                      <span className="font-semibold">Fundamental</span>
                      <Badge variant="outline">{c.analyst.fundamental.impact}</Badge>
                      <span className="text-muted-foreground">
                        conf {c.analyst.fundamental.confidence.toFixed(2)}
                      </span>
                    </div>
                    <p className="whitespace-pre-wrap">{c.analyst.fundamental.notes}</p>
                    {c.analyst.fundamental.key_events.length > 0 && (
                      <ul className="mt-1 ml-4 list-disc text-muted-foreground">
                        {c.analyst.fundamental.key_events.map((e: string) => (
                          <li key={e}>{e}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div className="rounded border border-border p-3 text-xs">
                    <div className="mb-1 flex items-center gap-2">
                      <span className="font-semibold">Sentiment</span>
                      <Badge variant="outline">{c.analyst.sentiment.tone}</Badge>
                      <Badge variant="outline">{c.analyst.sentiment.trend}</Badge>
                      <span className="text-muted-foreground">
                        conf {c.analyst.sentiment.confidence.toFixed(2)}
                      </span>
                    </div>
                    <p className="whitespace-pre-wrap">{c.analyst.sentiment.notes}</p>
                  </div>
                  <div className="rounded border border-border p-3 text-xs">
                    <div className="mb-1 flex items-center gap-2">
                      <span className="font-semibold">Technical</span>
                      <Badge variant="outline">{c.analyst.technical.trend}</Badge>
                      <Badge variant="outline">vol {c.analyst.technical.volatility}</Badge>
                      <span className="text-muted-foreground">
                        conf {c.analyst.technical.confidence.toFixed(2)}
                      </span>
                    </div>
                    <div className="text-muted-foreground">
                      support: {c.analyst.technical.support} / resistance:{" "}
                      {c.analyst.technical.resistance}
                    </div>
                    <p className="mt-1 whitespace-pre-wrap">{c.analyst.technical.notes}</p>
                  </div>
                  <div className="rounded border border-foreground/40 bg-muted/40 p-3 text-xs">
                    <div className="mb-1 font-semibold">Synthesis</div>
                    <pre className="overflow-x-auto whitespace-pre-wrap font-mono">
                      {JSON.stringify(c.analyst.synthesis, null, 2)}
                    </pre>
                  </div>
                </div>
              </section>
            )}

            <section className="grid gap-3 md:grid-cols-2">
              {c.entryDecision && (
                <div className="rounded border border-border p-3">
                  <div className="mb-1 flex items-center gap-2">
                    <h4 className="font-semibold text-xs">Entry</h4>
                    <Badge variant={decisionVariant(c.entryDecision.result)}>
                      {c.entryDecision.result}
                    </Badge>
                    <span className="text-muted-foreground text-xs">
                      conf {c.entryDecision.confidence.toFixed(2)}
                    </span>
                  </div>
                  {c.entryDecision.reasoning && (
                    <p className="whitespace-pre-wrap text-xs">{c.entryDecision.reasoning}</p>
                  )}
                </div>
              )}
              {c.exitDecision && (
                <div className="rounded border border-border p-3">
                  <div className="mb-1 flex items-center gap-2">
                    <h4 className="font-semibold text-xs">Exit</h4>
                    <Badge variant={decisionVariant(c.exitDecision.result)}>
                      {c.exitDecision.result}
                    </Badge>
                    <span className="text-muted-foreground text-xs">
                      conf {c.exitDecision.confidence.toFixed(2)}
                    </span>
                  </div>
                  {c.exitDecision.reasoning && (
                    <p className="whitespace-pre-wrap text-xs">{c.exitDecision.reasoning}</p>
                  )}
                </div>
              )}
            </section>
          </CardContent>
        </Card>
      ))}
    </main>
  );
}
