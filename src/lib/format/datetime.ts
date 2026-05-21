/**
 * 日時フォーマッタ (JST 固定)。
 *
 * Vercel サーバの TZ は UTC なので、`toLocaleString` を裸で呼ぶと SSR と CSR で
 * 表示がズレる (K)。dashboard / cycle 詳細では全て JST で表示するため、共通関数で
 * `timeZone: "Asia/Tokyo"` を強制する。
 */

const JST = "Asia/Tokyo";

export function formatJstDateTime(d: Date | string): string {
  const date = d instanceof Date ? d : new Date(d);
  return date.toLocaleString("ja-JP", { timeZone: JST });
}

export function formatJstDate(d: Date | string): string {
  const date = d instanceof Date ? d : new Date(d);
  return date.toLocaleDateString("ja-JP", { timeZone: JST });
}
