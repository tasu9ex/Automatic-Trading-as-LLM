/**
 * Quick CLI status: ポートフォリオ / open positions / 最近サイクル を一覧表示。
 *
 * Usage:
 *   pnpm status                     # 本番 DB
 *   pnpm status:local              # ローカル DB
 */
// CLI からは unstable_cache を経由しない (Next.js runtime 不在で invariant エラーになる)
import {
  getDashboardStatsImpl as getDashboardStats,
  getOpenPositionsImpl as getOpenPositions,
  getRecentCyclesImpl as getRecentCycles,
} from "@/lib/cycle/queries";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";

function jpy(n: number): string {
  return `¥${n.toLocaleString("ja-JP", { maximumFractionDigits: 0 })}`;
}

function pnlColor(n: number): string {
  if (n > 0) return GREEN;
  if (n < 0) return RED;
  return RESET;
}

function rel(d: Date | null): string {
  if (!d) return "—";
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

async function main() {
  const [stats, openPositions, recentCycles] = await Promise.all([
    getDashboardStats(),
    getOpenPositions(),
    getRecentCycles(8),
  ]);

  const equity =
    stats.cashJpy + openPositions.reduce((acc, p) => acc + p.quantity * p.avgEntryPrice, 0);
  const totalPnl = equity + stats.realizedPnlJpy - stats.initialCashJpy;
  const totalPnlPct = stats.initialCashJpy > 0 ? (totalPnl / stats.initialCashJpy) * 100 : 0;

  console.log(`\n${BOLD}━━━ Portfolio ━━━${RESET}`);
  const stateColor = stats.state === "running" ? GREEN : stats.state === "killed" ? RED : YELLOW;
  console.log(`  State           ${stateColor}${stats.state ?? "unknown"}${RESET}`);
  console.log(`  Cycle interval  ${stats.cycleIntervalHours}h`);
  console.log(`  Next scheduled  ${stats.nextScheduledAt ? rel(stats.nextScheduledAt) : "—"}`);
  if (stats.killReason) console.log(`  Kill reason     ${stats.killReason}`);
  console.log(`  Last cycle      ${rel(stats.lastCycleAt)}`);
  console.log(`  Cash            ${jpy(stats.cashJpy)}`);
  console.log(`  Initial         ${jpy(stats.initialCashJpy)}`);
  console.log(
    `  Realized P/L    ${pnlColor(stats.realizedPnlJpy)}${jpy(stats.realizedPnlJpy)}${RESET}`,
  );
  console.log(
    `  Total P/L       ${pnlColor(totalPnl)}${jpy(totalPnl)} (${totalPnlPct.toFixed(2)}%)${RESET}`,
  );
  console.log(`  Cycles today    ${stats.cyclesToday}`);

  console.log(`\n${BOLD}━━━ Open Positions (${openPositions.length}) ━━━${RESET}`);
  if (openPositions.length === 0) {
    console.log(`  ${DIM}なし${RESET}`);
  } else {
    for (const p of openPositions) {
      const days = Math.floor((Date.now() - p.openedAt.getTime()) / 86_400_000);
      console.log(
        `  ${CYAN}${p.symbol.padEnd(5)}${RESET} qty=${p.quantity} @ ${jpy(p.avgEntryPrice)} ${DIM}(${days}d held)${RESET}`,
      );
    }
  }

  console.log(`\n${BOLD}━━━ Recent Cycles ━━━${RESET}`);
  if (recentCycles.length === 0) {
    console.log(`  ${DIM}まだ実行されていません${RESET}`);
  } else {
    for (const c of recentCycles) {
      const color =
        c.criticDecision === "approve" ? GREEN : c.criticDecision === "modify" ? YELLOW : RED;
      console.log(
        `  ${DIM}${c.cycleId.slice(0, 8)}${RESET}  ${color}${c.criticDecision.padEnd(7)}${RESET}  ${c.symbolCount}銘柄  ${DIM}${rel(c.createdAt)}${RESET}`,
      );
    }
  }
  console.log();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
