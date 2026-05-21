import "dotenv/config";
import { db } from "@/db/client";
import { coins, portfolios, systemState } from "@/db/schema";
import { syncCoinsFromGmo } from "@/lib/coins/sync";
import { inArray, sql } from "drizzle-orm";

/**
 * 初期データ投入。
 *
 * 仕様:
 *   1. GMO 全銘柄を coins テーブルに取り込み (sync-coins ロジック流用、新規は enabled=false)
 *   2. BTC / ETH / XRP / DOT / SOL の 5 銘柄を enabled=true に上書き (初期有効銘柄)
 *   3. portfolio / system_state をデフォルト値で投入
 *
 * UI から好きな銘柄を有効化できる。GMO で扱われなくなった銘柄は自動 disabled に倒される。
 */

const DEFAULT_ENABLED_SYMBOLS = ["BTC", "ETH", "XRP", "DOT", "SOL"] as const;

async function main() {
  console.log("Seeding...");

  console.log("→ GMO 全銘柄を同期中...");
  const syncResult = await syncCoinsFromGmo();
  console.log(
    `✓ coins synced (total=${syncResult.total} inserted=${syncResult.inserted} updated=${syncResult.updated})`,
  );

  // 初期有効銘柄を強制 enable に。
  // - seed は冪等。既に UI で off にされていても初期 5 銘柄に戻す (= 初期化)。
  const updated = await db
    .update(coins)
    .set({ enabled: true, updatedAt: new Date() })
    .where(inArray(coins.symbol, [...DEFAULT_ENABLED_SYMBOLS]))
    .returning({ symbol: coins.symbol });
  console.log(`✓ initial enabled: ${updated.map((u) => u.symbol).join(", ")}`);

  // 念のため: それ以外の銘柄が誤って enabled=true になっていれば disable に倒す
  // (シード初期化として「5 銘柄 enabled」をきっちり担保)
  await db
    .update(coins)
    .set({ enabled: false, updatedAt: new Date() })
    .where(
      sql`${coins.symbol} NOT IN (${sql.join(
        DEFAULT_ENABLED_SYMBOLS.map((s) => sql`${s}`),
        sql`, `,
      )})`,
    );

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
