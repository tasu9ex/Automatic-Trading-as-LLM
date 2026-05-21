"use client";

import { setRiskParamsAction } from "@/app/actions/system-control";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export interface RiskParamsProps {
  perCoinMaxRatio: number;
  /** 段 2: per-coin 総エクスポージャ上限 (equity base、1.0 = 制限なし) */
  perCoinTotalMaxRatio: number;
  portfolioDdTrigger: number;
  autoPauseThreshold: number;
}

export function RiskParams({
  perCoinMaxRatio,
  perCoinTotalMaxRatio,
  portfolioDdTrigger,
  autoPauseThreshold,
}: RiskParamsProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [perCoin, setPerCoin] = useState((perCoinMaxRatio * 100).toFixed(1));
  const [perCoinTotal, setPerCoinTotal] = useState((perCoinTotalMaxRatio * 100).toFixed(1));
  const [dd, setDd] = useState((portfolioDdTrigger * 100).toFixed(1));
  const [threshold, setThreshold] = useState(String(autoPauseThreshold));
  const [confirmOpen, setConfirmOpen] = useState(false);
  // ロック解除しないと編集できない (誤操作防止)。default は locked。
  const [unlocked, setUnlocked] = useState(false);

  // Q: 入力バリデーション。空 / NaN / 範囲外で保存ボタンを disable + ヒント表示。
  // サーバ側 (setRiskParamsAction) でも同じ範囲を再チェックする (defence in depth)。
  function validateNumber(raw: string, min: number, max: number): string | null {
    if (raw.trim() === "") return "値が空です";
    const n = Number(raw);
    if (!Number.isFinite(n)) return "数値ではありません";
    if (n < min) return `${min} 以上を指定してください`;
    if (n > max) return `${max} 以下を指定してください`;
    return null;
  }
  const perCoinError = validateNumber(perCoin, 1, 100);
  const perCoinTotalError = validateNumber(perCoinTotal, 1, 100);
  const ddError = validateNumber(dd, 5, 99);
  const thresholdError = validateNumber(threshold, 1, 10);
  const hasInputError = !!(perCoinError || perCoinTotalError || ddError || thresholdError);

  const dirty =
    !hasInputError &&
    (Math.abs(Number(perCoin) - perCoinMaxRatio * 100) > 0.05 ||
      Math.abs(Number(perCoinTotal) - perCoinTotalMaxRatio * 100) > 0.05 ||
      Math.abs(Number(dd) - portfolioDdTrigger * 100) > 0.05 ||
      Number(threshold) !== autoPauseThreshold);

  // B: window.confirm を ConfirmDialog に置換。
  const confirmMessage = [
    `  段 1 (per-cycle buy) ${(perCoinMaxRatio * 100).toFixed(1)}% → ${perCoin}%`,
    `  段 2 (per-coin total) ${(perCoinTotalMaxRatio * 100).toFixed(1)}% → ${perCoinTotal}%`,
    `  Kill Switch DD       ${(portfolioDdTrigger * 100).toFixed(1)}% → ${dd}%`,
    `  連続失敗 auto-pause   ${autoPauseThreshold} → ${threshold}`,
    "",
    "次サイクルから反映されます。",
  ].join("\n");

  function doSave() {
    const perCoinRatio = Number(perCoin) / 100;
    const perCoinTotalRatio = Number(perCoinTotal) / 100;
    const ddRatio = Number(dd) / 100;
    const thr = Number(threshold);
    setConfirmOpen(false);
    setError(null);
    startTransition(async () => {
      const res = await setRiskParamsAction({
        perCoinMaxRatio: perCoinRatio,
        perCoinTotalMaxRatio: perCoinTotalRatio,
        portfolioDdTrigger: ddRatio,
        autoPauseThreshold: thr,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.refresh();
    });
  }

  const inputsDisabled = pending || !unlocked;

  return (
    <Card>
      <details>
        <summary className="flex cursor-pointer select-none items-center justify-between px-6 py-4 hover:bg-muted/30">
          <div>
            <CardTitle className="text-base">リスクパラメータ</CardTitle>
            <CardDescription>
              ハードガード閾値。次サイクル開始時に反映される。値は DB (system_state) に保存。
            </CardDescription>
          </div>
          <span className="text-muted-foreground text-xs">▼ 展開</span>
        </summary>
        <CardContent className="flex flex-col gap-4 border-border border-t pt-4">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground text-xs">
              {unlocked
                ? "🔓 編集モード (保存するか、ロックすると元に戻ります)"
                : "🔒 ロック中 — 値を変更するには右のボタンを押してください"}
            </span>
            <Button
              type="button"
              variant={unlocked ? "outline" : "default"}
              size="sm"
              onClick={() => {
                if (unlocked) {
                  // ロックに戻す: 編集内容を破棄
                  setPerCoin((perCoinMaxRatio * 100).toFixed(1));
                  setPerCoinTotal((perCoinTotalMaxRatio * 100).toFixed(1));
                  setDd((portfolioDdTrigger * 100).toFixed(1));
                  setThreshold(String(autoPauseThreshold));
                  setError(null);
                }
                setUnlocked(!unlocked);
              }}
              disabled={pending}
            >
              {unlocked ? "🔒 ロック" : "🔓 ロック解除"}
            </Button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field
              label="段 1: per-cycle 上限 (%)"
              help="1 サイクル内の 1 銘柄あたり新規 buy 上限 (現金 × この比率)"
              value={perCoin}
              min={1}
              max={100}
              step={0.1}
              onChange={setPerCoin}
              disabled={inputsDisabled}
              error={perCoinError}
            />
            <Field
              label="段 2: per-coin 総上限 (%)"
              help="1 銘柄の総エクスポージャ上限 (時価総額 × この比率、100% = 制限なし)"
              value={perCoinTotal}
              min={1}
              max={100}
              step={0.1}
              onChange={setPerCoinTotal}
              disabled={inputsDisabled}
              error={perCoinTotalError}
            />
            <Field
              label="最大 DD (HWM 比) (%)"
              help="HWM (資産時価総額のピーク) からの DD がこの値以上 → 全 close + killed"
              value={dd}
              min={5}
              max={99}
              step={0.1}
              onChange={setDd}
              disabled={inputsDisabled}
              error={ddError}
            />
            <Field
              label="連続失敗 auto-pause"
              help="この回数の連続失敗で paused"
              value={threshold}
              min={1}
              max={10}
              step={1}
              onChange={setThreshold}
              disabled={inputsDisabled}
              error={thresholdError}
            />
          </div>
          <div className="flex items-center justify-between">
            <Button onClick={() => setConfirmOpen(true)} disabled={!dirty || pending || !unlocked}>
              保存
            </Button>
            {error && <p className="text-destructive text-sm">{error}</p>}
          </div>
        </CardContent>
      </details>
      <ConfirmDialog
        open={confirmOpen}
        title="リスクパラメータを更新しますか?"
        message={confirmMessage}
        onConfirm={doSave}
        onCancel={() => setConfirmOpen(false)}
      />
    </Card>
  );
}

interface FieldProps {
  label: string;
  help: string;
  value: string;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  /** Q: validation エラー文 (null なら OK) */
  error?: string | null;
  onChange: (next: string) => void;
}

function Field(props: FieldProps) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-muted-foreground text-xs" htmlFor={`risk-${props.label}`}>
        {props.label}
      </label>
      <input
        id={`risk-${props.label}`}
        type="number"
        className={`h-8 rounded-lg border bg-background px-2 font-mono text-sm disabled:opacity-50 ${
          props.error ? "border-destructive" : "border-border"
        }`}
        value={props.value}
        min={props.min}
        max={props.max}
        step={props.step}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.value)}
      />
      {props.error ? (
        <span className="text-destructive text-xs">{props.error}</span>
      ) : (
        <span className="text-muted-foreground text-xs">{props.help}</span>
      )}
    </div>
  );
}
