"use client";

import {
  type SystemControlActionResult,
  emergencyStopAction,
  pauseSystemAction,
  resumeSystemAction,
  setCycleIntervalAction,
  startSystemAction,
} from "@/app/actions/system-control";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  CYCLE_INTERVAL_HOURS,
  type CycleIntervalHours,
  formatIntervalLabel,
} from "@/lib/system-control/constants";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

export interface SystemControlsProps {
  state: string;
  killReason: string | null;
  cycleIntervalHours: CycleIntervalHours;
  nextScheduledAt: string | null;
  /** BB-2: 緊急停止フラグが立っているか (UI バッジ + 再開ボタン文言) */
  emergencyStop: boolean;
}

const STATE_LABELS: Record<string, string> = {
  stopped: "未起動",
  running: "稼働中",
  paused: "一時停止",
  killed: "緊急停止 (Kill Switch)",
};

function stateBadgeVariant(state: string): "default" | "destructive" | "outline" {
  if (state === "running") return "default";
  if (state === "killed") return "destructive";
  return "outline";
}

export function SystemControls({
  state,
  killReason,
  cycleIntervalHours,
  nextScheduledAt,
  emergencyStop,
}: SystemControlsProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [interval, setIntervalHours] = useState<CycleIntervalHours>(cycleIntervalHours);

  useEffect(() => {
    setIntervalHours(cycleIntervalHours);
  }, [cycleIntervalHours]);

  const isKilled = state === "killed";
  const isRunning = state === "running";
  const isStopped = state === "stopped";
  const isPaused = state === "paused";

  function runAction(label: string, action: () => Promise<SystemControlActionResult>) {
    if (!window.confirm(`${label}しますか？`)) return;
    setError(null);
    startTransition(async () => {
      const res = await action();
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.refresh();
    });
  }

  function onIntervalChange(hours: CycleIntervalHours) {
    setIntervalHours(hours);
    if (hours === cycleIntervalHours) return;
    const label = formatIntervalLabel(hours);
    if (
      !window.confirm(
        `実行レートを「${label}」に変更します。${isRunning ? "次のスケジュール枠から" : "再開後"}反映されます。`,
      )
    ) {
      setIntervalHours(cycleIntervalHours);
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await setCycleIntervalAction(hours);
      if (!res.ok) {
        setError(res.error);
        setIntervalHours(cycleIntervalHours);
        return;
      }
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base">システム制御</CardTitle>
            <CardDescription>LLM 判定の停止・再開と実行間隔</CardDescription>
          </div>
          <Badge variant={stateBadgeVariant(state)}>{STATE_LABELS[state] ?? state}</Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {killReason && <p className="text-destructive text-sm">Kill Switch: {killReason}</p>}

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <span className="text-muted-foreground text-xs">実行レート</span>
            <select
              className="h-8 rounded-lg border border-border bg-background px-2 text-sm disabled:opacity-50"
              value={interval}
              disabled={pending || isKilled}
              onChange={(e) => onIntervalChange(Number(e.target.value) as CycleIntervalHours)}
            >
              {CYCLE_INTERVAL_HOURS.map((h) => (
                <option key={h} value={h}>
                  {formatIntervalLabel(h)}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-muted-foreground text-xs">次回判定サイクル (JST)</span>
            <span className="font-mono text-sm">
              {isRunning && nextScheduledAt
                ? new Date(nextScheduledAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })
                : isRunning
                  ? "—"
                  : isPaused || isStopped
                    ? "再開・起動後に決定"
                    : "—"}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {isStopped && (
            <Button
              disabled={pending || isKilled}
              onClick={() => runAction("システムを起動", startSystemAction)}
            >
              システム起動
            </Button>
          )}
          {isPaused && (
            <Button
              disabled={pending || isKilled}
              onClick={() => runAction("判定を再開", resumeSystemAction)}
            >
              再開
            </Button>
          )}
          {isRunning && (
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => runAction("LLM 判定を一時停止", pauseSystemAction)}
            >
              一時停止
            </Button>
          )}
          {(isRunning || isPaused) && !emergencyStop && (
            <Button
              variant="destructive"
              disabled={pending || isKilled}
              onClick={() =>
                runAction(
                  "🛑 緊急停止 (進行中のサイクルを即座に中断、次サイクルも停止) を実行",
                  emergencyStopAction,
                )
              }
            >
              緊急停止
            </Button>
          )}
          {emergencyStop && (
            <p className="text-amber-600 text-sm dark:text-amber-400">
              緊急停止中 (再開ボタンで解除)
            </p>
          )}
          {isKilled && (
            <p className="text-muted-foreground text-sm">
              Kill Switch 発動中です。再開は現状 DB 操作が必要です。
            </p>
          )}
        </div>

        {error && <p className="text-destructive text-sm">{error}</p>}
      </CardContent>
    </Card>
  );
}
