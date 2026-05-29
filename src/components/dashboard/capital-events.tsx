import { Card, CardContent, CardDescription, CardTitle } from "@/components/ui/card";
import type { CapitalEventRow } from "@/lib/cycle/queries";
import { formatJstDateTime } from "@/lib/format/datetime";
import { pnlColorClass } from "@/lib/format/pnl";

function jpy(n: number) {
  return `¥${n.toLocaleString("ja-JP", { maximumFractionDigits: 0 })}`;
}

export function CapitalEvents({ events }: { events: CapitalEventRow[] }) {
  return (
    <Card>
      <details>
        <summary className="flex cursor-pointer select-none items-center justify-between px-6 py-4 hover:bg-muted/30">
          <div>
            <CardTitle className="text-base">入金 / 出金履歴</CardTitle>
            <CardDescription>
              capital_events 直近 {events.length} 件 (CLI `pnpm capital:local` で追加)
            </CardDescription>
          </div>
          <span className="text-muted-foreground text-xs">▼ 展開</span>
        </summary>
        <CardContent className="border-border border-t pt-4">
          {events.length === 0 ? (
            <p className="text-muted-foreground text-sm">まだ入金/出金はありません</p>
          ) : (
            <ul className="divide-y divide-border">
              {events.map((e) => (
                <li key={e.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span className="font-mono text-muted-foreground text-xs">
                    {formatJstDateTime(e.occurredAt)}
                  </span>
                  <span className={`font-medium ${pnlColorClass(e.kind === "deposit" ? 1 : -1)}`}>
                    {e.kind === "deposit" ? "↑ 入金" : "↓ 出金"} {jpy(e.amountJpy)}
                  </span>
                  {e.note && (
                    <span className="truncate text-muted-foreground text-xs">{e.note}</span>
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
