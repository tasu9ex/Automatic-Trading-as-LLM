import { createAnthropic } from "@ai-sdk/anthropic";

/**
 * Anthropic client (Vercel AI SDK 経由)。
 * generateText / generateObject の両方を統一的に扱える。
 *
 * Usage:
 *   const result = await generateObject({
 *     model: anthropic("claude-opus-4-7"),
 *     schema: zodSchema,
 *     system, prompt,
 *   });
 */

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey && process.env.NODE_ENV !== "test") {
  // 起動時に警告のみ。実際呼ぶ時にエラーにする。
  console.warn("[anthropic] ANTHROPIC_API_KEY is not set");
}

export const anthropic = createAnthropic({
  apiKey: apiKey ?? "",
});
