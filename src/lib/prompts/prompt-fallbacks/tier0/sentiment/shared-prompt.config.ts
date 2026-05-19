import { MODEL_CATALOG } from "@/lib/clients/model-catalog";
import type { PromptConfig } from "@/lib/prompts/prompt-types";

/**
 * Tier 0 Sentiment: 自由テキスト要約 (JSON ではない)。
 * Grok 4.20 non-reasoning (X ネイティブアクセス) で取得。
 */
export const LANGFUSE_PROMPT_CONFIG: PromptConfig = {
  ...MODEL_CATALOG["grok-4.20-non-reasoning"],
  temperature: 0.3,
  maxTokens: 800,
  responseFormat: "text",
};
