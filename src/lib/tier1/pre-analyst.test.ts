import type { Snapshot } from "@/lib/tier0/fetch-snapshot";
import { describe, expect, it } from "vitest";
import { buildPriceSnapshotText } from "./pre-analyst";

function snapshot(ohlcv: Snapshot["ohlcv"]): Snapshot {
  return {
    symbol: "BTC",
    name: "Bitcoin",
    klineInterval: "8hour",
    ohlcv,
    ticker: null,
    micro: null,
    perplexitySummary: "",
    perplexityCitations: [],
    grokSummary: "",
    grokCitations: [],
    fetchedAt: new Date(),
  } as unknown as Snapshot;
}

describe("buildPriceSnapshotText", () => {
  it("空配列は (価格データなし)", () => {
    expect(buildPriceSnapshotText(snapshot([]))).toBe("(価格データなし)");
  });

  it("¥ 接頭 + カンマ区切りで整形", () => {
    const out = buildPriceSnapshotText(
      snapshot([
        {
          openTime: Date.UTC(2026, 4, 22, 0, 0, 0),
          open: "12300000",
          high: "12450000",
          low: "12100000",
          close: "12400000",
          volume: "50.5",
        },
      ]),
    );
    expect(out).toContain("O=¥12,300,000");
    expect(out).toContain("C=¥12,400,000");
    expect(out).toContain("V=50.5");
    expect(out).toContain("[8hour]");
  });

  it("直近 3 本までに切り詰める", () => {
    const bars = Array.from({ length: 5 }, (_, i) => ({
      openTime: Date.UTC(2026, 4, 22) + i * 3600_000,
      open: String(1000 + i),
      high: String(1000 + i),
      low: String(1000 + i),
      close: String(1000 + i),
      volume: "1",
    }));
    const out = buildPriceSnapshotText(snapshot(bars));
    expect(out.split("\n")).toHaveLength(3);
    expect(out).toContain("C=¥1,002");
    expect(out).toContain("C=¥1,004");
    expect(out).not.toContain("C=¥1,000");
  });
});
