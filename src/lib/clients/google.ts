import { createGoogleGenerativeAI } from "@ai-sdk/google";

/**
 * Google Generative AI (Gemini) client。
 * 無料枠が大きく、検証期 MVP は完全無料で運用可能。
 *
 * Free tier (2026 時点目安):
 *   - gemini-2.5-pro:   250 req/日, 150万 token/分
 *   - gemini-2.5-flash: 1500 req/日
 */

const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
if (!apiKey && process.env.NODE_ENV !== "test") {
  console.warn("[google] GOOGLE_GENERATIVE_AI_API_KEY is not set");
}

export const google = createGoogleGenerativeAI({
  apiKey: apiKey ?? "",
});
