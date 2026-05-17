import type { PromptConfig } from "@/lib/prompts/prompt-types";

/**
 * Langfuse プロンプト `pre-analyst` の config ミラー。
 *
 * Langfuse の Config にコピーする JSON:
 *
 * ```json
 * {
 *   "model": "claude-haiku-4-5-20251001",
 *   "temperature": 0.2,
 *   "maxTokens": 600,
 *   "responseFormat": "json"
 * }
 * ```
 */
export const LANGFUSE_PROMPT_CONFIG: PromptConfig = {
  model: "claude-haiku-4-5-20251001",
  temperature: 0.2,
  maxTokens: 600,
  responseFormat: "json",
};
