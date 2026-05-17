import type { PromptConfig } from "@/lib/prompts/prompt-types";

/**
 * Langfuse プロンプト `entry-decision` の config ミラー。
 *
 * Langfuse の Config にコピーする JSON:
 *
 * ```json
 * {
 *   "model": "claude-opus-4-7",
 *   "temperature": 0.2,
 *   "maxTokens": 500,
 *   "responseFormat": "json"
 * }
 * ```
 */
export const LANGFUSE_PROMPT_CONFIG: PromptConfig = {
  model: "claude-opus-4-7",
  temperature: 0.2,
  maxTokens: 500,
  responseFormat: "json",
};
