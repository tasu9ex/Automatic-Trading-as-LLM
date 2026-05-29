/**
 * 損益 (PnL) 表示の共通ヘルパー。
 *
 * 日本株 convention: 上昇 / プラスは赤、下落 / マイナスは青。
 * ダッシュボード・サイクル詳細・入出金履歴など、符号を持つ金額表示すべてで使う。
 */

/** 符号に応じた Tailwind 文字色クラス。0 はクラス無し (親要素の色を継承)。 */
export function pnlColorClass(v: number): string {
  if (v > 0) return "text-red-500";
  if (v < 0) return "text-blue-500";
  return "";
}

/** 正数に "+" を付けて返す ("-" は number 側で付くのでそのまま)。0 は "+"。 */
export function pnlSign(v: number): "+" | "" {
  return v >= 0 ? "+" : "";
}
