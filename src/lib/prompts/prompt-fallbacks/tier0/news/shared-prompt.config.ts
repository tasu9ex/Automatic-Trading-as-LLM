import { MODEL_CATALOG } from "@/lib/clients/model-catalog";
import type { PromptConfig } from "@/lib/prompts/prompt-types";

/**
 * Tier 0 News: 自由テキスト要約 (JSON ではない)。
 * Perplexity Sonar (Web 検索ベース) で取得。
 */
export const LANGFUSE_PROMPT_CONFIG: PromptConfig = {
  ...MODEL_CATALOG["perplexity-sonar"],
  temperature: 0,
  maxTokens: 1500,
  responseFormat: "text",
};
