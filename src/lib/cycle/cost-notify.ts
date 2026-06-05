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
import { formatJpy } from "@/lib/format/jpy";
import { createLogger } from "@/lib/logging";
import { notify } from "@/lib/notifications";
import { SINGLETON_ID } from "@/lib/system-control/constants";
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
    logger.warn({ cycleId }, "Cost fetch failed");
    await notify({
      level: "warning",
      title: "💰 コスト取得失敗",
      body: "Langfuse から該当サイクルの cost 取得不可。累計に加算されない。",
      fields: { サイクル: cycleId.slice(0, 8) },
    });
    return;
  }

  // 累計加算
  const state = (
    await db.select().from(systemState).where(eq(systemState.id, SINGLETON_ID)).limit(1)
  )[0];
  const prevCum = Number(state?.cumulativeCostUsd ?? 0);
  const newCum = prevCum + cost.totalCostUsd;
  await db
    .update(systemState)
    .set({ cumulativeCostUsd: newCum.toFixed(6), updatedAt: new Date() })
    .where(eq(systemState.id, SINGLETON_ID));

  // 累計のみ通知 (今回値 / モデル別内訳は Langfuse UI で見れば十分なので省く)。
  // 一部トレースが取得できなかった場合は過少計上の可能性を明示する。
  const partial = cost.failedTraceCount > 0;
  await notify({
    level: partial ? "warning" : "info",
    title: partial ? "💰 サイクルコスト集計 (一部欠落)" : "💰 サイクルコスト集計",
    fields: {
      "累計 (USD)": `$${newCum.toFixed(4)}`,
      "累計 (JPY)": formatJpy(newCum * USD_TO_JPY),
      ...(partial
        ? { 欠落トレース: `${cost.failedTraceCount}/${cost.traceCount} (過少計上の可能性)` }
        : {}),
    },
  });
}
