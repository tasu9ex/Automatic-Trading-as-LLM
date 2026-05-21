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
  });

  // II: HTTP status を err 属性から拾う (文字列マッチ依存からの脱却)
  describe("status code based (II)", () => {
    it("err.status を最優先で見る (Anthropic / OpenAI SDK パターン)", () => {
      expect(classifyError({ status: 401, message: "auth" })).toBe("permanent");
      expect(classifyError({ status: 403, message: "auth" })).toBe("permanent");
      expect(classifyError({ status: 400, message: "bad" })).toBe("permanent");
      expect(classifyError({ status: 404 })).toBe("permanent");
      expect(classifyError({ status: 422 })).toBe("permanent");
      expect(classifyError({ status: 402 })).toBe("quota");
      expect(classifyError({ status: 429 })).toBe("transient");
      expect(classifyError({ status: 500 })).toBe("transient");
      expect(classifyError({ status: 503, message: "overloaded" })).toBe("transient");
    });

    it("err.response.status (axios / fetch wrapper パターン)", () => {
      expect(classifyError({ response: { status: 401 } })).toBe("permanent");
      expect(classifyError({ response: { status: 503 } })).toBe("transient");
    });

    it("err.statusCode (自作 wrapper パターン)", () => {
      expect(classifyError({ statusCode: 400 })).toBe("permanent");
      expect(classifyError({ statusCode: 500 })).toBe("transient");
    });

    it("status 属性があるとき文字列ベースの誤検出を避ける", () => {
      // 文字列に "400000ms timeout" が出ても status=503 が優先されて transient
      const err = Object.assign(new Error("timeout after 400000ms"), { status: 503 });
      expect(classifyError(err)).toBe("transient");
    });

    it("status が無いとき従来の文字列フォールバックが動く", () => {
      expect(classifyError(new Error("Anthropic 503: overloaded_error"))).toBe("transient");
      expect(classifyError(new Error("Grok 400: invalid_request_error"))).toBe("permanent");
    });
  });
});
