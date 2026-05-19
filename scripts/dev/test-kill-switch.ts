/**
 * Kill switch 発動テスト。
 *   1. portfolio.cashJpy を一時的に低くして DD -50% を作る
 *   2. checkAndTriggerKillSwitch を直接呼ぶ
 *   3. 全 open ポジションがクローズされ、system_state = 'killed' になる
 *   4. テスト後に cashJpy / state を元に戻す
 */
import { db } from "@/db/client";
import { portfolios, systemState } from "@/db/schema";
import { checkAndTriggerKillSwitch } from "@/lib/kill-switch";
import { eq } from "drizzle-orm";

const STRATEGY_ID = "trial-5";

async function main() {
  const before = (
    await db.select().from(portfolios).where(eq(portfolios.strategyId, STRATEGY_ID)).limit(1)
  )[0];
  if (!before) throw new Error("portfolio not found");

  const initial = Number(before.initialCashJpy);
  const sabotaged = Math.floor(initial * 0.1); // initial の 10% → DD > 50% を確実に作る

  console.log(`Original cashJpy: ¥${Number(before.cashJpy).toLocaleString("ja-JP")}`);
  console.log(`Sabotaging to: ¥${sabotaged.toLocaleString("ja-JP")}`);

  await db
    .update(portfolios)
    .set({ cashJpy: sabotaged.toFixed(4) })
    .where(eq(portfolios.strategyId, STRATEGY_ID));

  // killed 状態だと終了させたいので一旦 running に戻す
  await db
    .update(systemState)
    .set({ state: "running", killReason: null, killedAt: null })
    .where(eq(systemState.id, "singleton"));

  console.log("\n=== Running checkAndTriggerKillSwitch ===");
  const triggered = await checkAndTriggerKillSwitch({ strategyId: STRATEGY_ID });
  console.log(`triggered=${triggered}`);

  const after = (
    await db.select().from(systemState).where(eq(systemState.id, "singleton")).limit(1)
  )[0];
  console.log(`\nsystem_state.state = ${after?.state}`);
  console.log(`killReason = ${after?.killReason}`);
  console.log(`killedAt = ${after?.killedAt?.toISOString()}`);

  // 復元
  console.log("\n=== Restoring ===");
  await db
    .update(portfolios)
    .set({ cashJpy: before.cashJpy })
    .where(eq(portfolios.strategyId, STRATEGY_ID));
  await db
    .update(systemState)
    .set({ state: "running", killReason: null, killedAt: null })
    .where(eq(systemState.id, "singleton"));
  console.log("Restored portfolio cash and state.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
