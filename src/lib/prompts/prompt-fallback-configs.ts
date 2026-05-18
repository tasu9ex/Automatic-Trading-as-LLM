import { LANGFUSE_PROMPT_CONFIG as ANALYST_CONFIG } from "./prompt-fallbacks/analyst/shared-prompt.config";
import { LANGFUSE_PROMPT_CONFIG as CRITIC_CONFIG } from "./prompt-fallbacks/critic/shared-prompt.config";
import { LANGFUSE_PROMPT_CONFIG as ENTRY_DECISION_CONFIG } from "./prompt-fallbacks/entry-decision/shared-prompt.config";
import { LANGFUSE_PROMPT_CONFIG as EXIT_DECISION_CONFIG } from "./prompt-fallbacks/exit-decision/shared-prompt.config";
import { LANGFUSE_PROMPT_CONFIG as PRE_ANALYST_CONFIG } from "./prompt-fallbacks/pre-analyst/shared-prompt.config";
import type { PromptConfig, PromptName } from "./prompt-types";

const FALLBACK_CONFIGS: Record<PromptName, PromptConfig> = {
  "pre-analyst": PRE_ANALYST_CONFIG,
  analyst: ANALYST_CONFIG,
  "entry-decision": ENTRY_DECISION_CONFIG,
  "exit-decision": EXIT_DECISION_CONFIG,
  critic: CRITIC_CONFIG,
};

export function getFallbackPromptConfig(name: PromptName): PromptConfig {
  return FALLBACK_CONFIGS[name];
}
