import { db } from "@/db/client";
import { cycles } from "@/db/schema";
import { eq } from "drizzle-orm";

/**
 * cycle 行を完了済 (completedAt = now) に更新。
 * "in_flight" 扱い (completedAt IS NULL) から外すことで、ダッシュボードの実行中判定や
 * isCycleInFlight が正しい状態を返す。
 *
 * 失敗 / 緊急停止 / 正常 finalize の 3 経路すべてから呼ばれる。
 */
export async function markCycleCompleted(cycleId: string): Promise<void> {
  await db.update(cycles).set({ completedAt: new Date() }).where(eq(cycles.id, cycleId));
}
