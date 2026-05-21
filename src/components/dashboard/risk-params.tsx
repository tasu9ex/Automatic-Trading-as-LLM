"use client";

import { setRiskParamsAction } from "@/app/actions/system-control";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export interface RiskParamsProps {
  perCoinMaxRatio: number;
  portfolioDdTrigger: number;
  autoPauseThreshold: number;
}

export function RiskParams({
  perCoinMaxRatio,
  portfolioDdTrigger,
  autoPauseThreshold,
}: RiskParamsProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [perCoin, setPerCoin] = useState((perCoinMaxRatio * 100).toFixed(1));
  const [dd, setDd] = useState((portfolioDdTrigger * 100).toFixed(1));
  const [threshold, setThreshold] = useState(String(autoPauseThreshold));
  const [confirmOpen, setConfirmOpen] = useState(false);

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
  const ddError = validateNumber(dd, 5, 99);
  const thresholdError = validateNumber(threshold, 1, 10);
  const hasInputError = !!(perCoinError || ddError || thresholdError);

  const dirty =
    !hasInputError &&
    (Math.abs(Number(perCoin) - perCoinMaxRatio * 100) > 0.05 ||
      Math.abs(Number(dd) - portfolioDdTrigger * 100) > 0.05 ||
      Number(threshold) !== autoPauseThreshold);

  // B: window.confirm を ConfirmDialog に置換。
  const confirmMessage = [
    `  1 銘柄上限          ${(perCoinMaxRatio * 100).toFixed(1)}% → ${perCoin}%`,
    `  Kill Switch DD     ${(portfolioDdTrigger * 100).toFixed(1)}% → ${dd}%`,
    `  連続失敗 auto-pause  ${autoPauseThreshold} → ${threshold}`,
    "",
    "次サイクルから反映されます。",
  ].join("\n");

  function doSave() {
    const perCoinRatio = Number(perCoin) / 100;
    const ddRatio = Number(dd) / 100;
    const thr = Number(threshold);
    setConfirmOpen(false);
    setError(null);
    startTransition(async () => {
      const res = await setRiskParamsAction({
        perCoinMaxRatio: perCoinRatio,
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

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">リスクパラメータ</CardTitle>
        <CardDescription>
          ハードガード閾値。次サイクル開始時に反映される。値は DB (system_state) に保存。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field
            label="1 銘柄上限 (%)"
            help="Allocator 計算後に Clipper が cap (現金 × この比率)"
            value={perCoin}
            min={1}
            max={100}
            step={0.1}
            onChange={setPerCoin}
            disabled={pending}
            error={perCoinError}
          />
          <Field
            label="Kill Switch DD (%)"
            help="ポートフォリオ DD がこの値以上 → 全 close + killed"
            value={dd}
            min={5}
            max={99}
            step={0.1}
            onChange={setDd}
            disabled={pending}
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
            disabled={pending}
            error={thresholdError}
          />
        </div>
        <div className="flex items-center justify-between">
          <Button onClick={() => setConfirmOpen(true)} disabled={!dirty || pending}>
            保存
          </Button>
          {error && <p className="text-destructive text-sm">{error}</p>}
        </div>
      </CardContent>
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
