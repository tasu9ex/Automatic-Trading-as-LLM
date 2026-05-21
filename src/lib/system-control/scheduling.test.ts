import { describe, expect, it } from "vitest";
import { computeNextScheduledAt } from "./scheduling";

describe("computeNextScheduledAt", () => {
  it("60min: next hour boundary (UTC)", () => {
    const from = new Date("2026-05-19T10:15:00.000Z");
    const next = computeNextScheduledAt(from, 60);
    expect(next.toISOString()).toBe("2026-05-19T11:00:00.000Z");
  });

  it("1440min (1day): next UTC midnight (= JST 09:00)", () => {
    const from = new Date("2026-05-19T01:00:00.000Z");
    const next = computeNextScheduledAt(from, 1440);
    expect(next.toISOString()).toBe("2026-05-20T00:00:00.000Z");
  });

  it("480min (8h): next 8-hour bucket", () => {
    const from = new Date("2026-05-19T07:30:00.000Z");
    const next = computeNextScheduledAt(from, 480);
    expect(next.toISOString()).toBe("2026-05-19T08:00:00.000Z");
  });

  it("30min: next half-hour boundary", () => {
    const from = new Date("2026-05-19T10:15:00.000Z");
    const next = computeNextScheduledAt(from, 30);
    expect(next.toISOString()).toBe("2026-05-19T10:30:00.000Z");
  });
});
