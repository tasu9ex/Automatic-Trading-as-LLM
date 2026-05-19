import { MODEL_CATALOG } from "@/lib/clients/model-catalog";
import type { PromptConfig } from "@/lib/prompts/prompt-types";

export const LANGFUSE_PROMPT_CONFIG: PromptConfig = {
  ...MODEL_CATALOG["claude-haiku-4-5"],
  temperature: 0.2,
  maxTokens: 600,
  responseFormat: "json",
};
