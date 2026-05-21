"use client";

import { setCoinEnabledAction } from "@/app/actions/coins";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export interface CoinChecklistItem {
  id: string;
  symbol: string;
  name: string;
  enabled: boolean;
}

export interface CoinChecklistProps {
  coins: CoinChecklistItem[];
  cycleInFlight: boolean;
}

export function CoinChecklist({ coins, cycleInFlight }: CoinChecklistProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [optimistic, setOptimistic] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  const enabledCount = coins.reduce((acc, c) => acc + ((optimistic[c.id] ?? c.enabled) ? 1 : 0), 0);

  function onToggle(coinId: string, next: boolean) {
    setOptimistic((prev) => ({ ...prev, [coinId]: next }));
    setError(null);
    startTransition(async () => {
      const res = await setCoinEnabledAction(coinId, next);
      if (!res.ok) {
        setOptimistic((prev) => {
          const { [coinId]: _, ...rest } = prev;
          return rest;
        });
        setError(res.error);
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
            <CardTitle className="text-base">対象銘柄</CardTitle>
            <CardDescription>
              判定サイクルで分析する銘柄 ({enabledCount}/{coins.length} 有効)
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {cycleInFlight && (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-amber-700 text-xs dark:text-amber-300">
            🔄 サイクル実行中 — 銘柄の変更は次サイクルから反映されます
          </p>
        )}

        {coins.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            銘柄が未登録です。`pnpm db:local:sync-coins` で同期してください。
          </p>
        ) : (
          <ul className="grid gap-1.5 sm:grid-cols-2 md:grid-cols-3">
            {coins.map((c) => {
              const checked = optimistic[c.id] ?? c.enabled;
              return (
                <li key={c.id}>
                  <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/40">
                    <input
                      type="checkbox"
                      className="size-4 accent-foreground"
                      checked={checked}
                      disabled={pending}
                      onChange={(e) => onToggle(c.id, e.target.checked)}
                    />
                    <span className="font-medium">{c.symbol}</span>
                    <span className="truncate text-muted-foreground text-xs">{c.name}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}

        {error && <p className="text-destructive text-sm">{error}</p>}
      </CardContent>
    </Card>
  );
}
