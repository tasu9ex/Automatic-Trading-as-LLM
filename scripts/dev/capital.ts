/**
 * 入金 / 出金 CLI。
 *
 * Usage:
 *   pnpm capital:local deposit 100000 [-- --note "追加入金"]
 *   pnpm capital:local withdraw 50000 [-- --note "利益確定"]
 *
 * portfolios.cashJpy / initialCashJpy / highWaterMarkJpy を同時に調整して、
 * Capital-injection-adjusted HWM の整合性を保つ。
 */

import { recordDeposit, recordWithdrawal } from "@/lib/capital";

function parseArgs(argv: string[]) {
  const [action, amountStr, ...rest] = argv;
  if (action !== "deposit" && action !== "withdraw") {
    console.error("Usage: capital deposit <amount> | capital withdraw <amount>");
    process.exit(1);
  }
  const amount = Number(amountStr);
  if (!Number.isFinite(amount) || amount <= 0) {
    console.error("amount must be a positive number");
    process.exit(1);
  }
  let note: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--note") note = rest[++i];
  }
  return { action, amount, note };
}

async function main() {
  const { action, amount, note } = parseArgs(process.argv.slice(2));
  const strategyId = "trial-5"; // 現状 singleton
  if (action === "deposit") {
    const res = await recordDeposit({ strategyId, amountJpy: amount, note });
    console.log(
      `✓ deposit ¥${amount.toLocaleString()} → cash ¥${res.newCashJpy.toLocaleString()} / initial ¥${res.newInitialCashJpy.toLocaleString()} / HWM ¥${res.newHwmJpy.toLocaleString()}`,
    );
  } else {
    const res = await recordWithdrawal({ strategyId, amountJpy: amount, note });
    console.log(
      `✓ withdraw ¥${amount.toLocaleString()} → cash ¥${res.newCashJpy.toLocaleString()} / initial ¥${res.newInitialCashJpy.toLocaleString()} / HWM ¥${res.newHwmJpy.toLocaleString()}`,
    );
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
