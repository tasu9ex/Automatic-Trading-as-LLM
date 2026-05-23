/**
 * 円表記の共通フォーマッタ。
 *
 * Discord 通知 / ダッシュボード / Critic ビューが全部「¥1,234,567」で揃うように。
 * Math.round で整数化してから toLocaleString。ja-JP / en-US は整数表示では同一なので
 * en-US 固定 (Vercel サーバ TZ が UTC でもブレないように)。
 */

/** `¥1,234,567` (整数化) */
export function formatJpy(v: number): string {
  return `¥${Math.round(v).toLocaleString("en-US")}`;
}

/** `+¥1,234` / `-¥567` (符号付き; 0 は `+¥0`) */
export function formatJpySigned(v: number): string {
  const sign = v >= 0 ? "+" : "-";
  return `${sign}${formatJpy(Math.abs(v))}`;
}
