"use client";

import { Button } from "@/components/ui/button";
import { useEffect } from "react";

/**
 * B: window.confirm の代替。Radix を入れずに最小限のモーダルを自作。
 *
 * 制約上、tab トラップやスクリーンリーダー周りは省略 (個人ツール、認証必須、内部利用のみ)。
 * 必要になったら shadcn/ui の Dialog (Radix) を導入して差し替える。
 */
export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "実行",
  cancelLabel = "キャンセル",
  destructive,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onCancel}
      onKeyDown={(e) => {
        if (e.key === "Enter") onConfirm();
      }}
    >
      <dialog
        open
        aria-modal="true"
        className="w-full max-w-md rounded-lg border border-border bg-card p-6 text-foreground shadow-lg"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <h2 className="mb-2 font-semibold text-lg">{title}</h2>
        {message && (
          <p className="mb-4 whitespace-pre-line text-muted-foreground text-sm">{message}</p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button variant={destructive ? "destructive" : "default"} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </dialog>
    </div>
  );
}
