/**
 * サイクル完了後、Langfuse から cost を fetch して Discord 通知 + 累計に加算。
 *
 * 別 step / 別関数として finalize の後に呼ぶ:
 *   - Langfuse ingestion delay (15s) を吸収するため finalize 内では実行しない
 *   - 通知の責務を分離 ("サイクル完了" と "コスト集計" は別の関心)
 *
 * 累計は system_state.cumulativeCostUsd に加算。
 */

import { db } from "@/db/client";
import { systemState } from "@/db/schema";
import { createLogger } from "@/lib/logging";
import { notify } from "@/lib/notifications";
import { fetchCycleCost } from "@/lib/telemetry";
import { eq } from "drizzle-orm";

const logger = createLogger("cycle.cost-notify");

const USD_TO_JPY = 150;
const LANGFUSE_INGEST_WAIT_MS = 15_000;

export async function notifyCycleCost(cycleId: string): Promise<void> {
  // Langfuse ingestion 待ち
  await new Promise((r) => setTimeout(r, LANGFUSE_INGEST_WAIT_MS));

  const cost = await fetchCycleCost(cycleId);
  if (!cost) {
    logger.warn({ cycleId }, "Cost fetch failed, skip notification");
    return;
  }

  // 累計加算
  const state = (
    await db.select().from(systemState).where(eq(systemState.id, "singleton")).limit(1)
  )[0];
  const prevCum = Number(state?.cumulativeCostUsd ?? 0);
  const newCum = prevCum + cost.totalCostUsd;
  await db
    .update(systemState)
    .set({ cumulativeCostUsd: newCum.toFixed(6), updatedAt: new Date() })
    .where(eq(systemState.id, "singleton"));

  const modelLines = Object.entries(cost.observationsByModel)
    .sort(([, a], [, b]) => b.costUsd - a.costUsd)
    .map(([model, stat]) => `• ${model}: ${stat.count} 回 / $${stat.costUsd.toFixed(4)}`);

  await notify({
    level: "info",
    title: "💰 サイクルコスト集計",
    body: modelLines.length > 0 ? `**モデル別内訳**\n${modelLines.join("\n")}` : undefined,
    fields: {
      "今回 (USD)": `$${cost.totalCostUsd.toFixed(4)}`,
      "今回 (JPY)": `¥${Math.round(cost.totalCostUsd * USD_TO_JPY).toLocaleString()}`,
      "累計 (USD)": `$${newCum.toFixed(4)}`,
      "累計 (JPY)": `¥${Math.round(newCum * USD_TO_JPY).toLocaleString()}`,
    },
  });
}
