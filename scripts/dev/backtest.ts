/**
 * 戦略評価ハーネス v1 ランナー。
 *
 * Usage:
 *   pnpm backtest:prod          # 本番 OHLCV で全戦略 + ベンチマークを比較
 *   pnpm backtest:local
 *
 * market_snapshots の OHLCV (最新サイクルの各銘柄 200本 × 8h ≈ 66日) を使う。
 * 全銘柄を共通の openTime グリッドに揃え、現金 / BTC / 等金額 / モメンタムを
 * コスト控除後で比較する。LLM コストはかからない。
 */

import { db } from "@/db/client";
import { coins, cycles, marketSnapshots } from "@/db/schema";
import {
  type PriceMatrix,
  type Strategy,
  buyHold,
  cash,
  equalWeightHold,
  runBacktest,
  tsMomentum,
  xsMomentum,
} from "@/lib/backtest/engine";
import { desc, eq } from "drizzle-orm";

const COST_RATE = 0.001; // 片道 0.1% (実測 taker 0.05〜0.09% + スプレッド)
const BTC = "BTC";

interface Bar {
  openTime: number;
  close: number;
}

function parseBars(ohlcv: unknown): Bar[] {
  if (!Array.isArray(ohlcv)) return [];
  return ohlcv
    .map((b) => ({ openTime: Number((b as any).openTime), close: Number((b as any).close) }))
    .filter((b) => Number.isFinite(b.openTime) && b.close > 0)
    .sort((a, b) => a.openTime - b.openTime);
}

async function buildMatrix(): Promise<PriceMatrix> {
  const coinRows = await db.select().from(coins);
  const sym = new Map(coinRows.map((c) => [c.id, c.symbol]));
  const latest = (await db.select().from(cycles).orderBy(desc(cycles.startedAt)).limit(1))[0];
  const snaps = await db
    .select()
    .from(marketSnapshots)
    .where(eq(marketSnapshots.cycleId, latest.id));

  // 各銘柄の openTime→close
  const perSym = new Map<string, Map<number, number>>();
  for (const s of snaps) {
    const bars = parseBars(s.ohlcv);
    if (bars.length === 0) continue;
    perSym.set(sym.get(s.coinId) ?? s.coinId, new Map(bars.map((b) => [b.openTime, b.close])));
  }

  // 全銘柄で共通する openTime グリッド (intersection)
  const symbols = [...perSym.keys()];
  if (symbols.length === 0) throw new Error("no OHLCV data");
  let common: number[] = [...(perSym.get(symbols[0]) as Map<number, number>).keys()];
  for (const s of symbols.slice(1)) {
    const m = perSym.get(s) as Map<number, number>;
    common = common.filter((t) => m.has(t));
  }
  common.sort((a, b) => a - b);

  const close = symbols.map((s) => {
    const m = perSym.get(s) as Map<number, number>;
    return common.map((t) => m.get(t) as number);
  });

  return { times: common, symbols, close };
}

function fmtPct(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}
function fmtNum(n: number): string {
  return Number.isFinite(n) ? n.toFixed(2) : "—";
}

async function main() {
  const pm = await buildMatrix();
  const days = ((pm.times[pm.times.length - 1] - pm.times[0]) / 86_400_000).toFixed(0);
  console.log(
    `\n━━━ Backtest harness v1 ━━━\n銘柄=${pm.symbols.length}  バー=${pm.times.length} (8h, ≈${days}日)  コスト=片道${(COST_RATE * 100).toFixed(2)}%`,
  );
  console.log(
    `期間: ${new Date(pm.times[0]).toISOString().slice(0, 10)} → ${new Date(pm.times[pm.times.length - 1]).toISOString().slice(0, 10)}\n`,
  );

  const strategies: Strategy[] = [
    cash,
    buyHold(BTC),
    equalWeightHold(),
    tsMomentum(1),
    tsMomentum(3),
    tsMomentum(6),
    xsMomentum(3, 3),
    xsMomentum(6, 3),
  ];

  const opts = { costRate: COST_RATE, warmup: 6, regimeLookback: 3, btcSymbol: BTC };
  const results = strategies.map((s) => runBacktest(pm, s, opts));

  const w = Math.max(...results.map((r) => r.name.length), 16);
  console.log(
    `${"戦略".padEnd(w)}  ${"総ﾘﾀｰﾝ".padStart(8)}  ${"Sharpe".padStart(7)}  ${"最大DD".padStart(7)}  ${"上げ相場".padStart(8)}  ${"下げ相場".padStart(8)}  ${"turnover".padStart(8)}`,
  );
  console.log("─".repeat(w + 60));
  for (const r of results) {
    console.log(
      `${r.name.padEnd(w)}  ${fmtPct(r.totalReturnPct).padStart(8)}  ${fmtNum(r.sharpe).padStart(7)}  ${fmtPct(-r.maxDrawdownPct).padStart(7)}  ${fmtPct(r.upReturnPct).padStart(8)}  ${fmtPct(r.downReturnPct).padStart(8)}  ${r.avgTurnover.toFixed(2).padStart(8)}`,
    );
  }
  console.log(
    "\n注: in-sample・単一期間 (主に下げ相場)。上げ/レンジ相場での検証は別データが要る。",
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
