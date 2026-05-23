/**
 * Critic に渡す `systemHealth` を決定論的に集計するヘルパー。§33。
 *
 * - 連続失敗カウンタ / 直近失敗種別 / system_state → DB から
 * - 銘柄ごとのデータ鮮度 → 各 ctx の snapshot.fetchedAt と ticker.last から計算
 * - knownSkipRisks → ticker.last <= 0 の銘柄 (executor が silent skip するもの)
 */

import { db } from "@/db/client";
import { systemState } from "@/db/schema";
import type { ErrorKind } from "@/lib/cycle/retry";
import type { DataFreshnessLevel, SystemHealth } from "@/lib/schemas/system-health";
import type { Snapshot } from "@/lib/tier0/fetch-snapshot";
import { eq } from "drizzle-orm";

import { SINGLETON_ID } from "@/lib/system-control/constants";
const FRESH_THRESHOLD_MS = 60 * 60_000; // 1 時間

type CoinCtx = {
  coin: { symbol: string };
  snap: Snapshot;
};

export interface BuildSystemHealthInput {
  strategyId: string;
  ctxs: CoinCtx[];
}

export async function buildSystemHealth(input: BuildSystemHealthInput): Promise<SystemHealth> {
  const state = (
    await db.select().from(systemState).where(eq(systemState.id, SINGLETON_ID)).limit(1)
  )[0];

  const dataFreshness: Record<string, DataFreshnessLevel> = {};
  const knownSkipRisks: string[] = [];
  const now = Date.now();

  for (const c of input.ctxs) {
    const sym = c.coin.symbol;
    const lastPrice = Number(c.snap.ticker.last) || 0;
    const fetchedMs = c.snap.fetchedAt instanceof Date ? c.snap.fetchedAt.getTime() : 0;
    const ageMs = now - fetchedMs;

    if (lastPrice <= 0) {
      dataFreshness[sym] = "no_data";
      knownSkipRisks.push(sym);
    } else if (ageMs > FRESH_THRESHOLD_MS) {
      dataFreshness[sym] = "stale";
    } else {
      dataFreshness[sym] = "fresh";
    }
  }

  const validKinds: ErrorKind[] = ["transient", "permanent", "quota"];
  const lastFailureKind =
    state?.lastFailureKind && validKinds.includes(state.lastFailureKind as ErrorKind)
      ? (state.lastFailureKind as ErrorKind)
      : null;

  const validStates = ["running", "paused", "killed", "stopped"] as const;
  const killSwitchState =
    state?.state && (validStates as readonly string[]).includes(state.state)
      ? (state.state as (typeof validStates)[number])
      : "running";

  return {
    consecutiveFailures: state?.consecutiveFailures ?? 0,
    lastFailureKind,
    killSwitchState,
    dataFreshness,
    knownSkipRisks,
  };
}
