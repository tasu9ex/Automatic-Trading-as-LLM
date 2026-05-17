import type { PromptConfig } from "@/lib/prompts/prompt-types";

/**
 * Langfuse プロンプト `analyst` の config ミラー。
 *
 * Langfuse の Config にコピーする JSON:
 *
 * ```json
 * {
 *   "model": "claude-opus-4-7",
 *   "temperature": 0.3,
 *   "maxTokens": 2000,
 *   "responseFormat": "json"
 * }
 * ```
 */
export const LANGFUSE_PROMPT_CONFIG: PromptConfig = {
  model: "claude-opus-4-7",
  temperature: 0.3,
  maxTokens: 2000,
  responseFormat: "json",
};
