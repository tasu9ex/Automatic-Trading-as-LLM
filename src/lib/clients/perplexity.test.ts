import { describe, expect, it } from "vitest";
import { afterDateFilter } from "./perplexity";

describe("afterDateFilter", () => {
  it("now - periodHours を MM/DD/YYYY (UTC) で返す", () => {
    // 2026-05-23 01:00 UTC
    const now = Date.UTC(2026, 4, 23, 1, 0, 0);
    expect(afterDateFilter(16, now)).toBe("05/22/2026");
  });

  it("月またぎ", () => {
    const now = Date.UTC(2026, 5, 1, 5, 0, 0); // 2026-06-01 05:00 UTC
    expect(afterDateFilter(48, now)).toBe("05/30/2026");
  });

  it("年またぎ", () => {
    const now = Date.UTC(2026, 0, 1, 5, 0, 0); // 2026-01-01 05:00 UTC
    expect(afterDateFilter(24, now)).toBe("12/31/2025");
  });
});
