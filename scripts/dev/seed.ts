import "dotenv/config";
import { db } from "@/db/client";
import { coins, portfolios, systemState } from "@/db/schema";

/**
 * 初期データ投入。
 * production と同じ 5 銘柄 (BTC / ETH / XRP / DOT / SOL) を enabled=true で投入。
 * 他銘柄も触りたい場合は `pnpm db:local:sync-coins` で GMO 全銘柄を取り込める。
 */
async function main() {
  console.log("Seeding...");

  await db
    .insert(coins)
    .values([
      {
        symbol: "BTC",
        name: "Bitcoin",
        minOrderSize: "0.0001",
        makerFeeRate: "-0.0001",
        takerFeeRate: "0.0005",
        enabled: true,
      },
      {
        symbol: "ETH",
        name: "Ethereum",
        minOrderSize: "0.01",
        makerFeeRate: "-0.0001",
        takerFeeRate: "0.0005",
        enabled: true,
      },
      {
        symbol: "XRP",
        name: "XRP",
        minOrderSize: "1",
        makerFeeRate: "-0.0001",
        takerFeeRate: "0.0005",
        enabled: true,
      },
      {
        symbol: "DOT",
        name: "Polkadot",
        minOrderSize: "0.1",
        makerFeeRate: "-0.0001",
        takerFeeRate: "0.0005",
        enabled: true,
      },
      {
        symbol: "SOL",
        name: "Solana",
        minOrderSize: "0.01",
        makerFeeRate: "-0.0001",
        takerFeeRate: "0.0005",
        enabled: true,
      },
    ])
    .onConflictDoNothing({ target: coins.symbol });
  console.log("✓ coins (5 銘柄 enabled)");

  await db
    .insert(portfolios)
    .values({
      strategyId: "trial-5",
      description: "実走テスト 5 銘柄",
      initialCashJpy: "500000",
      cashJpy: "500000",
    })
    .onConflictDoNothing({ target: portfolios.strategyId });
  console.log("✓ portfolios");

  await db
    .insert(systemState)
    .values({
      id: "singleton",
      state: "stopped",
      cycleIntervalHours: 24,
      // §17: リスクパラメータ初期値 (UI から変更可)
      perCoinMaxRatio: "0.250",
      portfolioDdTrigger: "0.500",
      autoPauseThreshold: 3,
    })
    .onConflictDoNothing({ target: systemState.id });
  console.log("✓ system_state");

  console.log("Done.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
