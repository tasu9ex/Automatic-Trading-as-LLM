import { MODEL_CATALOG } from "@/lib/clients/model-catalog";
import type { PromptConfig } from "@/lib/prompts/prompt-types";

/**
 * Tier 0 Sentiment: 自由テキスト要約 (JSON ではない)。
 * Grok 4.3 (Responses API) + x_search/web_search ツールで agentic 検索。
 * クライアント側 (callGrok with useTools=true) で endpoint と tools を有効化する。
 */
export const LANGFUSE_PROMPT_CONFIG: PromptConfig = {
  ...MODEL_CATALOG["grok-4.3"],
  temperature: 0,
  maxTokens: 1500,
  responseFormat: "text",
};
