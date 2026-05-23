import { describe, expect, it } from "vitest";
import { periodAsIsoDate, periodAsMdy } from "./period-date";

describe("periodAsMdy", () => {
  it("now - periodHours を MM/DD/YYYY (UTC) で返す", () => {
    const now = Date.UTC(2026, 4, 23, 1, 0, 0);
    expect(periodAsMdy(16, now)).toBe("05/22/2026");
  });

  it("月またぎ", () => {
    const now = Date.UTC(2026, 5, 1, 5, 0, 0);
    expect(periodAsMdy(48, now)).toBe("05/30/2026");
  });

  it("年またぎ", () => {
    const now = Date.UTC(2026, 0, 1, 5, 0, 0);
    expect(periodAsMdy(24, now)).toBe("12/31/2025");
  });
});

describe("periodAsIsoDate", () => {
  it("now - periodHours を YYYY-MM-DD (UTC) で返す", () => {
    const now = Date.UTC(2026, 4, 23, 1, 0, 0);
    expect(periodAsIsoDate(16, now)).toBe("2026-05-22");
  });
});
