"use client";

import { setRiskParamsAction } from "@/app/actions/system-control";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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

  const dirty =
    Math.abs(Number(perCoin) - perCoinMaxRatio * 100) > 0.05 ||
    Math.abs(Number(dd) - portfolioDdTrigger * 100) > 0.05 ||
    Number(threshold) !== autoPauseThreshold;

  function onSave() {
    const perCoinRatio = Number(perCoin) / 100;
    const ddRatio = Number(dd) / 100;
    const thr = Number(threshold);
    const msg = [
      "リスクパラメータを更新します:",
      `  PER_COIN_MAX_RATIO  ${(perCoinMaxRatio * 100).toFixed(1)}% → ${perCoin}%`,
      `  PORTFOLIO_DD_TRIGGER ${(portfolioDdTrigger * 100).toFixed(1)}% → ${dd}%`,
      `  AUTO_PAUSE_THRESHOLD ${autoPauseThreshold} → ${thr}`,
      "次サイクルから反映されます。よろしいですか?",
    ].join("\n");
    if (!window.confirm(msg)) return;
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
          />
        </div>
        <div className="flex items-center justify-between">
          <Button onClick={onSave} disabled={!dirty || pending}>
            保存
          </Button>
          {error && <p className="text-destructive text-sm">{error}</p>}
        </div>
      </CardContent>
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
        className="h-8 rounded-lg border border-border bg-background px-2 font-mono text-sm disabled:opacity-50"
        value={props.value}
        min={props.min}
        max={props.max}
        step={props.step}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.value)}
      />
      <span className="text-muted-foreground text-xs">{props.help}</span>
    </div>
  );
}
