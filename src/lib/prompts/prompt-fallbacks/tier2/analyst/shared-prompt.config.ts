import { MODEL_CATALOG } from "@/lib/clients/model-catalog";
import type { PromptConfig } from "@/lib/prompts/prompt-types";

export const LANGFUSE_PROMPT_CONFIG: PromptConfig = {
  // 動作検証中は Haiku で全 Tier を回してコスト抑制 (安定後 claude-opus-4-7 に戻す)
  ...MODEL_CATALOG["claude-haiku-4-5"],
  temperature: 0.3,
  maxTokens: 2000,
  responseFormat: "json",
};
