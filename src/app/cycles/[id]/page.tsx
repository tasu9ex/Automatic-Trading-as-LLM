import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getCycleDetail } from "@/lib/cycle/queries";
import { criticStatusLabel, criticStatusVariant } from "@/lib/format/critic-decision";
import { formatJstDateTime } from "@/lib/format/datetime";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CriticPlanView } from "./critic-plan-view";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

// AA: タブ / ブックマーク識別のため cycle id を title に反映
export async function generateMetadata({ params }: PageProps) {
  const { id } = await params;
  return {
    title: `サイクル ${id.slice(0, 8)} | LLM 自動売買`,
  };
}

/** Entry/Exit/Critic decision の Badge variant (trade-decision 専用、buy/close/no/hold を扱う) */
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
          <Badge variant={criticStatusVariant(detail.status)}>
            {criticStatusLabel(detail.status)}
          </Badge>
        </div>
        <span className="text-muted-foreground text-xs">
          開始 {formatJstDateTime(detail.startedAt)}
          {detail.completedAt && ` ・ 完了 ${formatJstDateTime(detail.completedAt)}`}
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
              <CardDescription>
                実行計画 (Exit + Entry、Clipper 適用済) を承認・拒否・修正する最終ゲート
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
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
              {detail.critic.confidence !== null && (
                <span className="text-muted-foreground text-xs">
                  確信度 {detail.critic.confidence.toFixed(2)}
                </span>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            {detail.critic.reasoning && (
              <div>
                <div className="mb-1 text-muted-foreground text-xs">判断理由</div>
                <p className="whitespace-pre-wrap">{detail.critic.reasoning}</p>
              </div>
            )}
            {detail.critic.adjustments !== null && (
              <div>
                <div className="mb-1 text-muted-foreground text-xs">
                  adjustments (raw、pct ベース)
                </div>
                <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono text-xs">
                  {JSON.stringify(detail.critic.adjustments, null, 2)}
                </pre>
              </div>
            )}
            <CriticPlanView
              decision={detail.critic.decision}
              executionPlan={detail.critic.executionPlan}
              modifiedPositions={detail.critic.modifiedPositions}
            />
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
  // J: アクション (買い / 売り) があった銘柄は default 展開。それ以外は閉じたまま。
  // 見たい情報の手前に手数を 1 つ減らす。
  const hadAction = c.entryDecision?.result === "buy" || c.exitDecision?.result === "close";
  return (
    <Card className="overflow-hidden p-0">
      <details className="group" open={hadAction}>
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
                  取得時刻: {formatJstDateTime(c.snapshot.fetchedAt)}
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
                  <div className="mb-1 flex items-center justify-between font-semibold">
                    <span>統合見解</span>
                    <span className="text-muted-foreground">
                      方向 {c.analyst.synthesis.direction} ・ 信頼度{" "}
                      {c.analyst.synthesis.confidence.toFixed(2)}
                    </span>
                  </div>
                  <p className="whitespace-pre-wrap">{c.analyst.synthesis.reasoning}</p>
                </div>
                <div className="grid gap-3 md:grid-cols-3">
                  <div className="rounded border border-border p-3 text-xs">
                    <div className="mb-1 flex items-center justify-between font-semibold">
                      <span>ファンダメンタル</span>
                      <span className="text-muted-foreground">
                        信頼度 {c.analyst.fundamental.confidence.toFixed(2)}
                      </span>
                    </div>
                    <p className="whitespace-pre-wrap">{c.analyst.fundamental.notes}</p>
                  </div>
                  <div className="rounded border border-border p-3 text-xs">
                    <div className="mb-1 flex items-center justify-between font-semibold">
                      <span>センチメント</span>
                      <span className="text-muted-foreground">
                        信頼度 {c.analyst.sentiment.confidence.toFixed(2)}
                      </span>
                    </div>
                    <p className="whitespace-pre-wrap">{c.analyst.sentiment.notes}</p>
                  </div>
                  <div className="rounded border border-border p-3 text-xs">
                    <div className="mb-1 flex items-center justify-between font-semibold">
                      <span>テクニカル</span>
                      <span className="text-muted-foreground">
                        信頼度 {c.analyst.technical.confidence.toFixed(2)}
                      </span>
                    </div>
                    <p className="whitespace-pre-wrap">{c.analyst.technical.notes}</p>
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
            {(c.lastPriceJpy !== null || c.unrealizedPnlPct !== null) && (
              <div className="flex items-center gap-3 text-muted-foreground text-xs">
                {c.lastPriceJpy !== null && (
                  <span>現在価格 ¥{c.lastPriceJpy.toLocaleString()}</span>
                )}
                {c.unrealizedPnlPct !== null && (
                  <span
                    className={
                      c.unrealizedPnlPct > 0
                        ? "text-emerald-500"
                        : c.unrealizedPnlPct < 0
                          ? "text-red-500"
                          : ""
                    }
                  >
                    含み損益 {c.unrealizedPnlPct >= 0 ? "+" : ""}
                    {c.unrealizedPnlPct.toFixed(2)}%
                  </span>
                )}
              </div>
            )}
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
                    {c.entryDecision.sizePct !== null && (
                      <span className="text-muted-foreground text-xs">
                        size {c.entryDecision.sizePct}%
                      </span>
                    )}
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
                    {c.exitDecision.result === "close" && c.exitDecision.closePct !== null && (
                      <span className="text-muted-foreground text-xs">
                        close {c.exitDecision.closePct}%
                      </span>
                    )}
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
