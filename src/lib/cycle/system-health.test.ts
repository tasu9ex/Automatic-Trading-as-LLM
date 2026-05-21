import { describe, expect, it, vi } from "vitest";

vi.mock("@/db/client", () => {
  const where = vi.fn().mockReturnThis();
  const limit = vi.fn(async () => [
    {
      id: "singleton",
      state: "running",
      consecutiveFailures: 2,
      lastFailureKind: "transient",
      nextScheduledAt: new Date(),
    },
  ]);
  const from = vi.fn().mockReturnValue({ where, limit });
  const select = vi.fn().mockReturnValue({ from });
  return { db: { select } };
});

import { buildSystemHealth } from "./system-health";

const now = Date.now();
const freshSnap = {
  ticker: { last: "100", bid: "100", ask: "100", volume: "1" },
  fetchedAt: new Date(now - 5 * 60_000), // 5 分前
} as never;
const staleSnap = {
  ticker: { last: "100", bid: "100", ask: "100", volume: "1" },
  fetchedAt: new Date(now - 90 * 60_000), // 90 分前
} as never;
const noDataSnap = {
  ticker: { last: "0", bid: "0", ask: "0", volume: "0" },
  fetchedAt: new Date(now - 5 * 60_000),
} as never;

describe("buildSystemHealth", () => {
  it("classifies coins by ticker price and snapshot age", async () => {
    const result = await buildSystemHealth({
      strategyId: "trial-5",
      ctxs: [
        { coin: { symbol: "BTC" }, snap: freshSnap },
        { coin: { symbol: "ETH" }, snap: staleSnap },
        { coin: { symbol: "XRP" }, snap: noDataSnap },
      ],
    });
    expect(result.dataFreshness.BTC).toBe("fresh");
    expect(result.dataFreshness.ETH).toBe("stale");
    expect(result.dataFreshness.XRP).toBe("no_data");
    expect(result.knownSkipRisks).toEqual(["XRP"]);
  });

  it("forwards system_state values", async () => {
    const result = await buildSystemHealth({ strategyId: "trial-5", ctxs: [] });
    expect(result.consecutiveFailures).toBe(2);
    expect(result.lastFailureKind).toBe("transient");
    expect(result.killSwitchState).toBe("running");
  });
});
