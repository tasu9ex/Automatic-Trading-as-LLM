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
import { Card, CardContent, CardDescription, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  CYCLE_INTERVAL_MINUTES,
  type CycleIntervalMinutes,
  formatIntervalLabel,
} from "@/lib/system-control/constants";
import { ChevronDown, Lock, LockOpen } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

export interface SystemControlsProps {
  state: string;
  killReason: string | null;
  cycleIntervalMinutes: CycleIntervalMinutes;
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

function nextScheduleText(args: {
  isRunning: boolean;
  isPaused: boolean;
  isStopped: boolean;
  nextScheduledAt: string | null;
}): string {
  if (args.isRunning && args.nextScheduledAt) {
    return new Date(args.nextScheduledAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
  }
  if (args.isPaused || args.isStopped) return "再開・起動後に決定";
  return "—";
}

interface ActionButtonsProps {
  effectiveState: "stopped" | "paused" | "running" | "killed" | string;
  emergencyStop: boolean;
  actionsDisabled: boolean;
  runAction: (
    title: string,
    action: () => Promise<SystemControlActionResult>,
    opts?: {
      message?: string;
      destructive?: boolean;
      optimisticTarget?: string;
      confirmLabel?: string;
    },
  ) => void;
}

function ActionButtons({
  effectiveState,
  emergencyStop,
  actionsDisabled,
  runAction,
}: ActionButtonsProps) {
  const isKilled = effectiveState === "killed";
  const isRunning = effectiveState === "running";
  const isStopped = effectiveState === "stopped";
  const isPaused = effectiveState === "paused";

  return (
    <div className="flex flex-wrap gap-2">
      {isStopped && (
        <Button
          disabled={actionsDisabled || isKilled}
          onClick={() =>
            runAction("システムを起動しますか?", startSystemAction, {
              message: "次のスケジュール枠から判定サイクルが開始します。",
              optimisticTarget: "running",
              confirmLabel: "起動する",
            })
          }
        >
          システム起動
        </Button>
      )}
      {isPaused && (
        <Button
          disabled={actionsDisabled || isKilled}
          onClick={() =>
            runAction("判定を再開しますか?", resumeSystemAction, {
              message: "緊急停止フラグが立っていれば同時に解除されます。",
              optimisticTarget: "running",
              confirmLabel: "再開する",
            })
          }
        >
          再開
        </Button>
      )}
      {isRunning && (
        <Button
          variant="outline"
          disabled={actionsDisabled}
          onClick={() =>
            runAction("LLM 判定を一時停止しますか?", pauseSystemAction, {
              message:
                "現在実行中のサイクルは最後まで完走し、停止は次サイクルから反映されます。\n進行中のサイクルも即座に止めたい場合は「緊急停止」を使ってください。",
              optimisticTarget: "paused",
              confirmLabel: "一時停止する",
            })
          }
        >
          一時停止
        </Button>
      )}
      {(isRunning || isPaused) && !emergencyStop && (
        <Button
          variant="destructive"
          disabled={actionsDisabled || isKilled}
          onClick={() =>
            runAction("🛑 緊急停止を実行しますか?", emergencyStopAction, {
              message:
                "進行中のサイクルを次の phase 境界で即座に中断します。\n次サイクルも停止します (再開ボタンで両方解除)。",
              destructive: true,
              optimisticTarget: "paused",
              confirmLabel: "緊急停止する",
            })
          }
        >
          緊急停止
        </Button>
      )}
      {emergencyStop && (
        <p className="text-amber-600 text-sm dark:text-amber-400">緊急停止中 (再開ボタンで解除)</p>
      )}
      {isKilled && (
        <p className="text-muted-foreground text-sm">
          Kill Switch 発動中です。再開は現状 DB 操作が必要です。
        </p>
      )}
    </div>
  );
}

export function SystemControls({
  state,
  killReason,
  cycleIntervalMinutes,
  nextScheduledAt,
  emergencyStop,
}: SystemControlsProps) {
  const router = useRouter();
  // 起動/停止/再開/緊急停止系 (= action) と、実行レート変更 (= interval) を独立トラッキング。
  // 全部一個の useTransition で pending 共有していると、実行レート保存中に起動ボタンも
  // グレーアウトする副作用がある。
  const [actionPending, startActionTransition] = useTransition();
  const [intervalPending, startIntervalTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [interval, setIntervalSel] = useState<CycleIntervalMinutes>(cycleIntervalMinutes);
  // ロック解除しないと操作できない (誤操作防止)
  const [unlocked, setUnlocked] = useState(false);

  useEffect(() => {
    setIntervalSel(cycleIntervalMinutes);
  }, [cycleIntervalMinutes]);

  // I: 楽観更新。click 直後に表示状態を切り替えて、router.refresh() を待たずに反応する。
  // server の state が optimistic と一致したら勝手に解消する (state を優先)。
  // 失敗時は runAction の catch で null に戻して prop の state に戻る。
  const [optimisticState, setOptimisticState] = useState<string | null>(null);
  const effectiveState = optimisticState && optimisticState !== state ? optimisticState : state;

  const isKilled = effectiveState === "killed";
  const isRunning = effectiveState === "running";
  const isStopped = effectiveState === "stopped";
  const isPaused = effectiveState === "paused";

  // B: window.confirm を ConfirmDialog に置換。dialog state は 1 つ持つ。
  const [confirm, setConfirm] = useState<{
    title: string;
    message?: string;
    destructive?: boolean;
    /** confirm ボタンのラベル (= ユーザーがこの dialog で「何をする」のか明示) */
    confirmLabel?: string;
    onConfirm: () => void;
    onCancel?: () => void;
  } | null>(null);

  function runAction(
    title: string,
    action: () => Promise<SystemControlActionResult>,
    opts?: {
      message?: string;
      destructive?: boolean;
      optimisticTarget?: string;
      confirmLabel?: string;
    },
  ) {
    setConfirm({
      title,
      message: opts?.message,
      destructive: opts?.destructive,
      confirmLabel: opts?.confirmLabel,
      onConfirm: () => {
        setConfirm(null);
        setError(null);
        if (opts?.optimisticTarget) setOptimisticState(opts.optimisticTarget);
        startActionTransition(async () => {
          const res = await action();
          if (!res.ok) {
            setOptimisticState(null); // 失敗 → 旧表示に戻す
            setError(res.error);
            return;
          }
          router.refresh();
        });
      },
    });
  }

  function onIntervalChange(minutes: CycleIntervalMinutes) {
    setIntervalSel(minutes);
    if (minutes === cycleIntervalMinutes) return;
    const label = formatIntervalLabel(minutes);
    setConfirm({
      title: `実行レートを「${label}」に変更`,
      message: isRunning ? "次のスケジュール枠から反映されます。" : "再開後に反映されます。",
      confirmLabel: "変更を保存",
      onConfirm: () => {
        setConfirm(null);
        setError(null);
        startIntervalTransition(async () => {
          const res = await setCycleIntervalAction(minutes);
          if (!res.ok) {
            setError(res.error);
            setIntervalSel(cycleIntervalMinutes);
            return;
          }
          router.refresh();
        });
      },
      onCancel: () => {
        setConfirm(null);
        setIntervalSel(cycleIntervalMinutes);
      },
    });
  }

  // action buttons (起動/停止/再開/緊急停止) は interval 変更とは独立
  const actionsDisabled = actionPending || !unlocked;
  // select disabled は interval pending のみ。actionPending とは独立
  const selectDisabled = intervalPending || !unlocked;

  return (
    <Card>
      <details>
        <summary className="flex cursor-pointer select-none items-center justify-between px-6 py-4 hover:bg-muted/30">
          <div>
            <CardTitle className="text-base">システム制御</CardTitle>
            <CardDescription>LLM 判定の停止・再開と実行間隔</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={stateBadgeVariant(effectiveState)}>
              {STATE_LABELS[effectiveState] ?? effectiveState}
            </Badge>
            <span className="flex items-center gap-1 text-muted-foreground text-xs">
              <ChevronDown className="size-3.5" /> 展開
            </span>
          </div>
        </summary>
        <CardContent className="flex flex-col gap-4 border-border border-t pt-4">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
              {unlocked ? (
                <>
                  <LockOpen className="size-3.5" /> 編集モード (再度押すとロックされます)
                </>
              ) : (
                <>
                  <Lock className="size-3.5" /> ロック中 — 制御操作には右のボタンを押してください
                </>
              )}
            </span>
            <Button
              type="button"
              variant={unlocked ? "outline" : "default"}
              size="sm"
              onClick={() => setUnlocked(!unlocked)}
            >
              {unlocked ? (
                <>
                  <Lock className="size-3.5" /> ロック
                </>
              ) : (
                <>
                  <LockOpen className="size-3.5" /> ロック解除
                </>
              )}
            </Button>
          </div>

          {killReason && <p className="text-destructive text-sm">Kill Switch: {killReason}</p>}

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <span className="text-muted-foreground text-xs">実行レート</span>
              <select
                className="h-8 rounded-lg border border-border bg-background px-2 text-sm disabled:opacity-50"
                value={interval}
                disabled={selectDisabled || isKilled}
                onChange={(e) => onIntervalChange(Number(e.target.value) as CycleIntervalMinutes)}
              >
                {CYCLE_INTERVAL_MINUTES.map((m) => (
                  <option key={m} value={m}>
                    {formatIntervalLabel(m)}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-muted-foreground text-xs">次回判定サイクル (JST)</span>
              <span className="font-mono text-sm">
                {nextScheduleText({ isRunning, isPaused, isStopped, nextScheduledAt })}
              </span>
            </div>
          </div>

          <ActionButtons
            effectiveState={effectiveState}
            emergencyStop={emergencyStop}
            actionsDisabled={actionsDisabled}
            runAction={runAction}
          />

          {error && <p className="text-destructive text-sm">{error}</p>}
        </CardContent>
      </details>
      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.title ?? ""}
        message={confirm?.message}
        destructive={confirm?.destructive}
        confirmLabel={confirm?.confirmLabel}
        onConfirm={() => confirm?.onConfirm()}
        onCancel={() => (confirm?.onCancel ? confirm.onCancel() : setConfirm(null))}
      />
    </Card>
  );
}
