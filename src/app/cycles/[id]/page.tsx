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

const DECISION_JP: Record<string, string> = {
  buy: "買い",
  no: "見送り",
  hold: "保持",
  close: "決済",
  approve: "承認",
  modify: "修正",
  veto: "拒否",
};
function jpDecision(v: string): string {
  return DECISION_JP[v] ?? v;
}

function isAllocationMap(v: unknown): v is Record<string, number> {
  return (
    v !== null &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    Object.values(v).every((x) => typeof x === "number")
  );
}

function AllocationView({ data, emptyLabel }: { data: unknown; emptyLabel: string }) {
  if (data === null || data === undefined) {
    return <p className="text-muted-foreground">{emptyLabel}</p>;
  }
  if (isAllocationMap(data)) {
    const entries = Object.entries(data);
    if (entries.length === 0) {
      return <p className="text-muted-foreground">配分なし</p>;
    }
    return (
      <ul className="space-y-1">
        {entries.map(([symbol, amount]) => (
          <li key={symbol} className="flex justify-between font-mono">
            <span>{symbol}</span>
            <span>¥{Math.round(amount).toLocaleString("ja-JP")}</span>
          </li>
        ))}
      </ul>
    );
  }
  // 想定外の形なら fallback で JSON
  return (
    <pre className="overflow-x-auto whitespace-pre-wrap font-mono">
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}

const STATUS_JP: Record<string, string> = {
  approve: "承認",
  modify: "修正",
  veto: "拒否",
  failed: "失敗",
  in_flight: "実行中",
};
function statusVariant(status: string): "default" | "destructive" | "outline" {
  if (status === "approve") return "default";
  if (status === "modify" || status === "in_flight") return "outline";
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
          ← 戻る
        </Link>
        <div className="flex items-center gap-3">
          <h1 className="font-mono text-xl">サイクル {detail.cycleId.slice(0, 12)}</h1>
          <Badge variant={statusVariant(detail.status)}>
            {STATUS_JP[detail.status] ?? detail.status}
          </Badge>
        </div>
        <span className="text-muted-foreground text-xs">
          開始 {new Date(detail.startedAt).toLocaleString("ja-JP")}
          {detail.completedAt && ` ・ 完了 ${new Date(detail.completedAt).toLocaleString("ja-JP")}`}
        </span>
      </header>

      {detail.abortReason && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base text-destructive">サイクル中断</CardTitle>
            <CardDescription>
              Phase: <code className="font-mono">{detail.abortReason.phase}</code> ・ 種別:{" "}
              <code className="font-mono">{detail.abortReason.kind}</code>
            </CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">
              {detail.abortReason.message}
            </pre>
          </CardContent>
        </Card>
      )}

      {detail.critic && (
        <Card>
          <CardHeader className="flex flex-row items-start justify-between">
            <div>
              <CardTitle>Critic レビュー</CardTitle>
              <CardDescription>配分案を承認・拒否・修正する最終チェック層</CardDescription>
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
              {jpDecision(detail.critic.decision)}
            </Badge>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {detail.critic.reasoning && (
              <div>
                <div className="mb-1 text-muted-foreground text-xs">判断理由</div>
                <p className="whitespace-pre-wrap">{detail.critic.reasoning}</p>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3 pt-2 text-xs">
              <div>
                <div className="mb-1 text-muted-foreground">配分案</div>
                <div className="rounded bg-muted p-2">
                  <AllocationView data={detail.critic.allocationProposal} emptyLabel="配分なし" />
                </div>
              </div>
              <div>
                <div className="mb-1 text-muted-foreground">修正内容</div>
                <div className="rounded bg-muted p-2">
                  <AllocationView
                    data={detail.critic.adjustments}
                    emptyLabel="修正なし (そのまま承認)"
                  />
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {detail.coins.map((c) => (
        <CoinCard key={c.symbol} c={c} />
      ))}
    </main>
  );
}

type CoinDetail = Awaited<ReturnType<typeof getCycleDetail>> extends { coins: infer A } | null
  ? A extends Array<infer T>
    ? T
    : never
  : never;

function CoinCard({ c }: { c: CoinDetail }) {
  return (
    <Card className="overflow-hidden p-0">
      <details className="group">
        <summary className="flex cursor-pointer select-none items-center justify-between gap-3 px-6 py-4 hover:bg-muted/30">
          <div className="flex items-center gap-3">
            <span className="font-bold text-lg">{c.symbol}</span>
            <span className="text-muted-foreground text-xs group-open:hidden">▶ 展開</span>
            <span className="hidden text-muted-foreground text-xs group-open:inline">▼ 閉じる</span>
          </div>
          <div className="flex items-center gap-2">
            <DecisionBadge label="Entry" decision={c.entryDecision} fallback="スキップ" />
            <DecisionBadge label="Exit" decision={c.exitDecision} fallback="対象外" />
          </div>
        </summary>
        <div className="space-y-4 border-border border-t px-6 py-4 text-sm">
          {c.snapshot && (
            <details className="rounded border border-border">
              <summary className="cursor-pointer select-none px-3 py-2 text-muted-foreground text-xs uppercase tracking-wide hover:bg-muted/30">
                <span className="inline-flex items-center gap-2">
                  Tier 0 (情報収集)
                  <Badge variant="default">実行</Badge>
                </span>
              </summary>
              <div className="space-y-3 border-border border-t p-3 text-xs">
                <div>
                  <div className="mb-1 font-semibold">Perplexity (ニュース・規制・マクロ)</div>
                  <p className="whitespace-pre-wrap text-muted-foreground">
                    {c.snapshot.perplexitySummary ?? "(取得失敗または未設定)"}
                  </p>
                  {c.snapshot.perplexityCitations.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {c.snapshot.perplexityCitations.map((url) => (
                        <li key={url} className="truncate">
                          <a
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-500 hover:underline"
                          >
                            {url}
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div>
                  <div className="mb-1 font-semibold">Grok (X センチメント・KOL)</div>
                  <p className="whitespace-pre-wrap text-muted-foreground">
                    {c.snapshot.grokSummary ?? "(取得失敗または未設定)"}
                  </p>
                  {c.snapshot.grokCitations.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {c.snapshot.grokCitations.map((url) => (
                        <li key={url} className="truncate">
                          <a
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-500 hover:underline"
                          >
                            {url}
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="text-muted-foreground">
                  取得時刻: {new Date(c.snapshot.fetchedAt).toLocaleString("ja-JP")}
                </div>
              </div>
            </details>
          )}

          {c.preAnalyst && (
            <details className="rounded border border-border">
              <summary className="cursor-pointer select-none px-3 py-2 text-muted-foreground text-xs uppercase tracking-wide hover:bg-muted/30">
                <span className="inline-flex items-center gap-2">
                  Tier 1 (Pre-Analyst スクリーニング)
                  <Badge variant="default">実行</Badge>
                  {c.preAnalyst.skipFlag && (
                    <span className="text-muted-foreground text-xs normal-case">
                      skip_flag=true (未保有銘柄は Tier 2 省略)
                    </span>
                  )}
                </span>
              </summary>
              <div className="space-y-1 border-border border-t p-3 text-xs">
                <p>{c.preAnalyst.summary}</p>
                {c.preAnalyst.reasoning && (
                  <p className="whitespace-pre-wrap text-muted-foreground">
                    {c.preAnalyst.reasoning}
                  </p>
                )}
              </div>
            </details>
          )}

          {c.analyst ? (
            <details className="rounded border border-border">
              <summary className="cursor-pointer select-none px-3 py-2 text-muted-foreground text-xs uppercase tracking-wide hover:bg-muted/30">
                <span className="inline-flex items-center gap-2">
                  Tier 2 (Analyst 市場見解)
                  <Badge variant="default">実行</Badge>
                </span>
              </summary>
              <div className="space-y-2 border-border border-t p-3">
                <div className="rounded border border-foreground/40 bg-muted/40 p-3 text-xs">
                  <div className="mb-1 font-semibold">統合見解</div>
                  <p className="whitespace-pre-wrap">{c.analyst.synthesis.reasoning}</p>
                </div>
                <div className="grid gap-3 md:grid-cols-3">
                  <div className="rounded border border-border p-3 text-xs">
                    <div className="mb-1 font-semibold">ファンダメンタル</div>
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
                    <div className="mb-1 font-semibold">センチメント</div>
                    <p className="whitespace-pre-wrap">{c.analyst.sentiment.notes}</p>
                  </div>
                  <div className="rounded border border-border p-3 text-xs">
                    <div className="mb-1 font-semibold">テクニカル</div>
                    <div className="text-muted-foreground">
                      サポート: {c.analyst.technical.support} ・ レジスタンス:{" "}
                      {c.analyst.technical.resistance}
                    </div>
                    <p className="mt-1 whitespace-pre-wrap">{c.analyst.technical.notes}</p>
                  </div>
                </div>
              </div>
            </details>
          ) : c.preAnalyst ? (
            <div className="rounded border border-border px-3 py-2">
              <div className="flex items-center gap-2 text-xs uppercase tracking-wide">
                <span className="font-semibold text-muted-foreground">Tier 2 (Analyst)</span>
                <Badge variant="outline">スキップ</Badge>
                <span className="text-muted-foreground normal-case">
                  Pre-Analyst skip_flag により省略
                </span>
              </div>
            </div>
          ) : null}

          <section className="space-y-2">
            <h3 className="font-semibold text-muted-foreground text-xs uppercase tracking-wide">
              Decision (売買判断)
            </h3>
            <div className="grid gap-3 md:grid-cols-2">
              {c.entryDecision ? (
                <div className="rounded border border-border p-3">
                  <div className="mb-1 flex items-center gap-2">
                    <h4 className="font-semibold text-xs">Entry (新規)</h4>
                    <Badge variant={decisionVariant(c.entryDecision.result)}>
                      {jpDecision(c.entryDecision.result)}
                    </Badge>
                    <span className="text-muted-foreground text-xs">
                      確信度 {c.entryDecision.confidence.toFixed(2)}
                    </span>
                  </div>
                  {c.entryDecision.reasoning && (
                    <p className="whitespace-pre-wrap text-xs">{c.entryDecision.reasoning}</p>
                  )}
                </div>
              ) : (
                <div className="rounded border border-border border-dashed p-3">
                  <div className="mb-1 flex items-center gap-2">
                    <h4 className="font-semibold text-muted-foreground text-xs">Entry (新規)</h4>
                    <Badge variant="outline">スキップ</Badge>
                  </div>
                  <p className="text-muted-foreground text-xs">
                    {c.preAnalyst?.skipFlag
                      ? "Pre-Analyst が skip_flag → Tier 2/3 省略"
                      : "判定なし (Tier 2 失敗 or 未到達)"}
                  </p>
                </div>
              )}
              {c.exitDecision ? (
                <div className="rounded border border-border p-3">
                  <div className="mb-1 flex items-center gap-2">
                    <h4 className="font-semibold text-xs">Exit (決済)</h4>
                    <Badge variant={decisionVariant(c.exitDecision.result)}>
                      {jpDecision(c.exitDecision.result)}
                    </Badge>
                    <span className="text-muted-foreground text-xs">
                      確信度 {c.exitDecision.confidence.toFixed(2)}
                    </span>
                  </div>
                  {c.exitDecision.reasoning && (
                    <p className="whitespace-pre-wrap text-xs">{c.exitDecision.reasoning}</p>
                  )}
                </div>
              ) : (
                <div className="rounded border border-border border-dashed p-3">
                  <div className="mb-1 flex items-center gap-2">
                    <h4 className="font-semibold text-muted-foreground text-xs">Exit (決済)</h4>
                    <Badge variant="outline">スキップ</Badge>
                  </div>
                  <p className="text-muted-foreground text-xs">保有ポジションなし、判定対象外</p>
                </div>
              )}
            </div>
          </section>
        </div>
      </details>
    </Card>
  );
}

function DecisionBadge({
  label,
  decision,
  fallback,
}: {
  label: string;
  decision: { result: string } | null;
  fallback: string;
}) {
  if (decision) {
    return (
      <Badge variant={decisionVariant(decision.result)} className="text-xs">
        {label}: {jpDecision(decision.result)}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-xs">
      {label}: {fallback}
    </Badge>
  );
}
