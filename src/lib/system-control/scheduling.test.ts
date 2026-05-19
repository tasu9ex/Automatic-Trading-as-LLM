import { describe, expect, it } from "vitest";
import { computeNextScheduledAt } from "./scheduling";

describe("computeNextScheduledAt", () => {
  it("1h: next hour boundary (UTC)", () => {
    const from = new Date("2026-05-19T10:15:00.000Z");
    const next = computeNextScheduledAt(from, 1);
    expect(next.toISOString()).toBe("2026-05-19T11:00:00.000Z");
  });

  it("24h: next UTC midnight (= JST 09:00)", () => {
    const from = new Date("2026-05-19T01:00:00.000Z");
    const next = computeNextScheduledAt(from, 24);
    expect(next.toISOString()).toBe("2026-05-20T00:00:00.000Z");
  });

  it("6h: next 6-hour bucket", () => {
    const from = new Date("2026-05-19T07:30:00.000Z");
    const next = computeNextScheduledAt(from, 6);
    expect(next.toISOString()).toBe("2026-05-19T12:00:00.000Z");
  });
});
