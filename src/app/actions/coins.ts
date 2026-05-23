"use server";

import { db } from "@/db/client";
import { coins } from "@/db/schema";
import { eq } from "drizzle-orm";
import { type ServerActionResult, requireUser, withResult } from "./_helpers";

export type CoinToggleResult = ServerActionResult;

export async function setCoinEnabledAction(
  coinId: string,
  enabled: boolean,
): Promise<CoinToggleResult> {
  return withResult("coins", async () => {
    await requireUser();
    // O: 不正な coinId / 存在しない coinId を silent ignore にしない。
    // UUID v4 ライクな簡易検証 + UPDATE 行数チェック (存在しなければ rowCount 0)。
    if (typeof coinId !== "string" || !/^[0-9a-f-]{36}$/i.test(coinId)) {
      throw new Error("不正な coinId 形式です");
    }
    const updated = await db
      .update(coins)
      .set({ enabled, updatedAt: new Date() })
      .where(eq(coins.id, coinId))
      .returning({ id: coins.id });
    if (updated.length === 0) {
      throw new Error(`coinId が見つかりません: ${coinId}`);
    }
  });
}
