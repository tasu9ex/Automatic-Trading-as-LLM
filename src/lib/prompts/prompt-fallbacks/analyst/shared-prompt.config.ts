import { MODEL_CATALOG } from "@/lib/clients/model-catalog";
import type { PromptConfig } from "@/lib/prompts/prompt-types";

export const LANGFUSE_PROMPT_CONFIG: PromptConfig = {
  ...MODEL_CATALOG["gemini-2.5-flash-low"],
  temperature: 0.3,
  maxTokens: 2000,
  responseFormat: "json",
};
