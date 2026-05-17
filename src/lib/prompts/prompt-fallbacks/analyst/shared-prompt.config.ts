import type { PromptConfig } from "@/lib/prompts/prompt-types";

/**
 * Langfuse プロンプト `analyst` の config ミラー。
 *
 * MVP は Gemini 2.5 Pro (無料枠 250 req/日)。Phase 5c で Opus と並走比較。
 *
 * Langfuse の Config にコピーする JSON:
 *
 * ```json
 * {
 *   "model": "gemini-2.5-pro",
 *   "temperature": 0.3,
 *   "maxTokens": 2000,
 *   "responseFormat": "json"
 * }
 * ```
 */
export const LANGFUSE_PROMPT_CONFIG: PromptConfig = {
  model: "gemini-2.5-pro",
  temperature: 0.3,
  maxTokens: 2000,
  responseFormat: "json",
};
