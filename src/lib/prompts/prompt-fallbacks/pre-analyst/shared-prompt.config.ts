import type { PromptConfig } from "@/lib/prompts/prompt-types";

/**
 * Langfuse プロンプト `pre-analyst` の config ミラー。
 *
 * MVP は Gemini Flash (無料枠) でスクリーニング。Phase 5c で Haiku 等と並走比較。
 *
 * Langfuse の Config にコピーする JSON:
 *
 * ```json
 * {
 *   "model": "gemini-2.5-flash",
 *   "temperature": 0.2,
 *   "maxTokens": 600,
 *   "responseFormat": "json"
 * }
 * ```
 */
export const LANGFUSE_PROMPT_CONFIG: PromptConfig = {
  model: "gemini-2.5-flash",
  temperature: 0.2,
  maxTokens: 600,
  responseFormat: "json",
};
