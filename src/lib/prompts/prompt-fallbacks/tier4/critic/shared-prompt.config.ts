import { MODEL_CATALOG } from "@/lib/clients/model-catalog";
import type { PromptConfig } from "@/lib/prompts/prompt-types";

export const LANGFUSE_PROMPT_CONFIG: PromptConfig = {
  // Critic は最終ゲートで判断品質が効く。haiku が modify を「承認の確認」に誤用し
  // 空振り modify を出した実例があったため Sonnet に格上げ (他 Tier は haiku のまま)。
  ...MODEL_CATALOG["claude-sonnet-4-6"],
  temperature: 0,
  maxTokens: 2000,
  responseFormat: "json",
};
