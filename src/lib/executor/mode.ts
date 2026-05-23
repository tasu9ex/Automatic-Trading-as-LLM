/**
 * Paper / Real モード判定。env PAPER_TRADE が "false" でない限り paper (default true)。
 */
export function isPaperMode(): boolean {
  return (process.env.PAPER_TRADE ?? "true").toLowerCase() !== "false";
}
