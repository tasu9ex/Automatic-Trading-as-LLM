import { Card, CardContent, CardDescription, CardTitle } from "@/components/ui/card";
import type { SystemEventRow } from "@/lib/cycle/queries";
import { formatJstDateTime } from "@/lib/format/datetime";
import Link from "next/link";

const KIND_JP: Record<string, string> = {
  system_started: "起動",
  system_paused: "一時停止",
  system_resumed: "再開",
  kill_switch_triggered: "Kill Switch",
  critic_veto: "Critic 拒否",
  critic_modify: "Critic 修正",
  llm_failure: "LLM 失敗",
  cycle_aborted: "サイクル中断",
  cycle_emergency_stopped: "緊急停止",
  human_intervention: "手動操作",
  price_monitor_triggered: "逆指値発火",
  data_fetch_failed: "データ取得失敗",
};

function severityColor(severity: string): string {
  switch (severity) {
    case "critical":
      return "text-red-600 dark:text-red-400";
    case "error":
      return "text-destructive";
    case "warning":
      return "text-amber-600 dark:text-amber-400";
    default:
      return "text-muted-foreground";
  }
}

export function RecentEvents({ events }: { events: SystemEventRow[] }) {
  return (
    <Card>
      <details>
        <summary className="flex cursor-pointer select-none items-center justify-between px-6 py-4 hover:bg-muted/30">
          <div>
            <CardTitle className="text-base">最近のイベント</CardTitle>
            <CardDescription>system_events 直近 {events.length} 件</CardDescription>
          </div>
          <span className="text-muted-foreground text-xs">▼ 展開</span>
        </summary>
        <CardContent className="border-border border-t pt-4">
          {events.length === 0 ? (
            <p className="text-muted-foreground text-sm">まだイベントはありません</p>
          ) : (
            <ul className="divide-y divide-border">
              {events.map((e) => (
                <li key={e.id} className="flex items-start justify-between gap-3 py-2 text-sm">
                  <div className="flex flex-col gap-0.5">
                    <span className="font-mono text-muted-foreground text-xs">
                      {formatJstDateTime(e.occurredAt)}
                    </span>
                    <span className="text-xs">
                      <span className={`font-medium ${severityColor(e.severity)}`}>
                        [{KIND_JP[e.kind] ?? e.kind}]
                      </span>{" "}
                      {e.message}
                    </span>
                  </div>
                  {e.cycleId && (
                    <Link
                      href={`/cycles/${e.cycleId}`}
                      className="font-mono text-muted-foreground text-xs hover:underline"
                    >
                      {e.cycleId.slice(0, 8)}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </details>
    </Card>
  );
}
