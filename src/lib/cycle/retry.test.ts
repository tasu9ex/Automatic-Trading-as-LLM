import { describe, expect, it } from "vitest";
import { classifyError } from "./retry";

describe("classifyError", () => {
  it("quota: insufficient_quota / credit balance / billing", () => {
    expect(classifyError(new Error("insufficient_quota"))).toBe("quota");
    expect(classifyError(new Error("Your credit balance is too low"))).toBe("quota");
    expect(classifyError(new Error("billing_hard_limit reached"))).toBe("quota");
    expect(classifyError(new Error("you have exceeded quota for the day"))).toBe("quota");
    expect(classifyError(new Error("402 Payment Required"))).toBe("quota");
  });

  it("permanent: env / 401 / 403 / 400 / 404 / 422", () => {
    expect(classifyError(new Error("PERPLEXITY_API_KEY is not set"))).toBe("permanent");
    expect(classifyError(new Error("invalid_api_key"))).toBe("permanent");
    expect(classifyError(new Error("Unauthorized"))).toBe("permanent");
    expect(classifyError(new Error("Perplexity 401: bad token"))).toBe("permanent");
    expect(classifyError(new Error("Anthropic 403: forbidden"))).toBe("permanent");
    expect(classifyError(new Error("Grok 400: invalid_request_error"))).toBe("permanent");
    expect(classifyError(new Error("Grok 404: model not found"))).toBe("permanent");
    expect(classifyError(new Error("422 unprocessable entity"))).toBe("permanent");

    // 実際に踏んだ Anthropic のエラー
    expect(classifyError(new Error("x-api-key header is required"))).toBe("permanent");
    expect(classifyError(new Error("Authorization header is missing"))).toBe("permanent");
    expect(classifyError(new Error("API key not found in request"))).toBe("permanent");
    expect(classifyError(new Error("incorrect_api_key"))).toBe("permanent");
  });

  it("transient: 5xx / 429 / timeout / overloaded / network", () => {
    expect(classifyError(new Error("Anthropic 503: overloaded_error"))).toBe("transient");
    expect(classifyError(new Error("rate_limit_exceeded"))).toBe("transient");
    expect(classifyError(new Error("Anthropic 429: too many requests"))).toBe("transient");
    expect(classifyError(new Error("fetch failed: ECONNRESET"))).toBe("transient");
    expect(classifyError(new Error("network timeout"))).toBe("transient");
    expect(classifyError(new Error("Anthropic 500: internal_server_error"))).toBe("transient");
  });

  it("non-Error values gracefully", () => {
    expect(classifyError("Unknown")).toBe("transient");
    expect(classifyError(null)).toBe("transient");
    expect(classifyError({ message: "401 unauthorized" })).toBe("transient"); // not Error instance
  });
});
