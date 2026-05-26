/**
 * GMO 取扱銘柄カタログ + 現物 Tier 0 互換性チェック。
 *
 * Tier 0 ([src/lib/tier0/fetch-snapshot.ts]) は現物 symbol (例: "BTC", "DAI") で
 * ticker / orderbook / trades / klines を叩く。このスクリプトは /v1/symbols から
 * 取れる全現物銘柄に対して `?symbol=XXX` ticker を実際に叩き、全部 OK であることを確認する。
 */
import { getSymbols, getTicker } from "@/lib/clients/gmo";

async function probeSpot(symbol: string): Promise<boolean> {
  try {
    const r = await getTicker(symbol);
    return r.length > 0;
  } catch {
    return false;
  }
}

async function main() {
  const symbols = await getSymbols();
  const spot = Array.from(new Set(symbols.map((s) => s.symbol.replace(/_JPY$/, "")))).sort();

  console.log(`=== GMO 現物 ${spot.length} 銘柄を ?symbol=XXX で probe ===\n`);

  const results = await Promise.all(spot.map(async (s) => ({ symbol: s, ok: await probeSpot(s) })));

  const ok = results.filter((r) => r.ok).map((r) => r.symbol);
  const ng = results.filter((r) => !r.ok).map((r) => r.symbol);

  console.log(`[OK: ${ok.length}] ${ok.join(", ")}`);
  if (ng.length > 0) {
    console.error(`\n✗ [NG: ${ng.length}] ${ng.join(", ")}`);
    process.exit(1);
  }
  console.log("\n✓ 全現物銘柄が ticker で取れる");
}

main().catch((err) => {
  console.error("GMO catalog FAILED:", err);
  process.exit(1);
});
