import { describe, expect, it } from "vitest";
import { formatBars } from "./analyst";

describe("formatBars", () => {
  it("空配列は (データなし)", () => {
    expect(formatBars([], 10)).toBe("(データなし)");
  });

  it("OHLCV を ¥ 接頭 + カンマ区切りで整形", () => {
    const bars = [
      {
        openTime: Date.UTC(2026, 4, 22, 0, 0, 0),
        open: "12300000",
        high: "12450000",
        low: "12100000",
        close: "12400000",
        volume: "123.456",
      },
    ];
    const out = formatBars(bars, 10);
    expect(out).toContain("O=¥12,300,000");
    expect(out).toContain("H=¥12,450,000");
    expect(out).toContain("L=¥12,100,000");
    expect(out).toContain("C=¥12,400,000");
    expect(out).toContain("V=123.456");
  });

  it("maxRows で末尾切り出し", () => {
    const bars = Array.from({ length: 5 }, (_, i) => ({
      openTime: Date.UTC(2026, 4, 22) + i * 3600_000,
      open: String(1000 + i),
      high: String(1000 + i),
      low: String(1000 + i),
      close: String(1000 + i),
      volume: "1",
    }));
    const out = formatBars(bars, 2);
    expect(out.split("\n")).toHaveLength(2);
    expect(out).toContain("C=¥1,003");
    expect(out).toContain("C=¥1,004");
    expect(out).not.toContain("C=¥1,000");
  });
});
