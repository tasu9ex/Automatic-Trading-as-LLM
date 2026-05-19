import "dotenv/config";
import { db } from "@/db/client";
import { coins, portfolios, systemState } from "@/db/schema";

/**
 * 初期データ投入。
 * 銘柄リストは MVP の足がかり (BTC + ETH のみ)。
 * Phase A smoke test で GMO API から取引所形式 全銘柄をフェッチして上書きする想定。
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
      },
      {
        symbol: "ETH",
        name: "Ethereum",
        minOrderSize: "0.01",
        makerFeeRate: "-0.0001",
        takerFeeRate: "0.0005",
      },
    ])
    .onConflictDoNothing({ target: coins.symbol });
  console.log("✓ coins");

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
