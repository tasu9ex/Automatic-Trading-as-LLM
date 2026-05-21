"use client";

import { setCoinEnabledAction } from "@/app/actions/coins";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardTitle } from "@/components/ui/card";
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
  const [, startTransition] = useTransition();
  const [optimistic, setOptimistic] = useState<Record<string, boolean>>({});
  // D + E: 銘柄ごとに pending 状態を持つ。全銘柄を disable せず、操作中の銘柄だけ spinner 表示。
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  // ロック解除しないと toggle できない (誤操作防止)
  const [unlocked, setUnlocked] = useState(false);

  const enabledCount = coins.reduce((acc, c) => acc + ((optimistic[c.id] ?? c.enabled) ? 1 : 0), 0);

  function onToggle(coinId: string, next: boolean) {
    setOptimistic((prev) => ({ ...prev, [coinId]: next }));
    setPendingIds((prev) => new Set(prev).add(coinId));
    setError(null);
    startTransition(async () => {
      const res = await setCoinEnabledAction(coinId, next);
      setPendingIds((prev) => {
        const nextSet = new Set(prev);
        nextSet.delete(coinId);
        return nextSet;
      });
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
      <details>
        <summary className="flex cursor-pointer select-none items-center justify-between px-6 py-4 hover:bg-muted/30">
          <div>
            <CardTitle className="text-base">対象銘柄</CardTitle>
            <CardDescription>
              判定サイクルで分析する銘柄 ({enabledCount}/{coins.length} 有効)
            </CardDescription>
          </div>
          <span className="text-muted-foreground text-xs">▼ 展開</span>
        </summary>
        <CardContent className="flex flex-col gap-3 border-border border-t pt-4">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground text-xs">
              {unlocked
                ? "🔓 編集モード (再度押すとロックされます)"
                : "🔒 ロック中 — チェック切替には右のボタンを押してください"}
            </span>
            <Button
              type="button"
              variant={unlocked ? "outline" : "default"}
              size="sm"
              onClick={() => setUnlocked(!unlocked)}
            >
              {unlocked ? "🔒 ロック" : "🔓 ロック解除"}
            </Button>
          </div>

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
                const isPending = pendingIds.has(c.id);
                return (
                  <li key={c.id}>
                    <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/40">
                      <input
                        type="checkbox"
                        className="size-4 accent-foreground"
                        checked={checked}
                        disabled={isPending || !unlocked}
                        onChange={(e) => onToggle(c.id, e.target.checked)}
                      />
                      <span className="font-medium">{c.symbol}</span>
                      <span className="truncate text-muted-foreground text-xs">{c.name}</span>
                      {isPending && (
                        <span
                          className="ml-auto inline-block size-3 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground"
                          aria-label="保存中"
                        />
                      )}
                    </label>
                  </li>
                );
              })}
            </ul>
          )}

          {error && <p className="text-destructive text-sm">{error}</p>}
        </CardContent>
      </details>
    </Card>
  );
}
