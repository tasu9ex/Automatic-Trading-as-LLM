import { LANGFUSE_PROMPT_CONFIG as TIER0_NEWS_CONFIG } from "./prompt-fallbacks/tier0/news/shared-prompt.config";
import { LANGFUSE_PROMPT_CONFIG as TIER0_SENTIMENT_CONFIG } from "./prompt-fallbacks/tier0/sentiment/shared-prompt.config";
import { LANGFUSE_PROMPT_CONFIG as PRE_ANALYST_CONFIG } from "./prompt-fallbacks/tier1/pre-analyst/shared-prompt.config";
import { LANGFUSE_PROMPT_CONFIG as ANALYST_CONFIG } from "./prompt-fallbacks/tier2/analyst/shared-prompt.config";
import { LANGFUSE_PROMPT_CONFIG as ENTRY_DECISION_CONFIG } from "./prompt-fallbacks/tier3/entry/shared-prompt.config";
import { LANGFUSE_PROMPT_CONFIG as EXIT_DECISION_CONFIG } from "./prompt-fallbacks/tier3/exit/shared-prompt.config";
import { LANGFUSE_PROMPT_CONFIG as CRITIC_CONFIG } from "./prompt-fallbacks/tier4/critic/shared-prompt.config";
import type { PromptConfig, PromptName } from "./prompt-types";

const FALLBACK_CONFIGS: Record<PromptName, PromptConfig> = {
  "tier0/news": TIER0_NEWS_CONFIG,
  "tier0/sentiment": TIER0_SENTIMENT_CONFIG,
  "tier1/pre-analyst": PRE_ANALYST_CONFIG,
  "tier2/analyst": ANALYST_CONFIG,
  "tier3/entry": ENTRY_DECISION_CONFIG,
  "tier3/exit": EXIT_DECISION_CONFIG,
  "tier4/critic": CRITIC_CONFIG,
};

export function getFallbackPromptConfig(name: PromptName): PromptConfig {
  return FALLBACK_CONFIGS[name];
}
