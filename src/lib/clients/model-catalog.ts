export type ThinkingLevel = "minimal" | "low" | "medium" | "high";

interface ModelConfig {
  model: string;
  thinkingLevel?: ThinkingLevel;
}

export const MODEL_CATALOG = {
  "gemini-3.1-flash-lite-low": { model: "gemini-3.1-flash-lite", thinkingLevel: "low" },
  "gemini-3.1-flash-lite-medium": { model: "gemini-3.1-flash-lite", thinkingLevel: "medium" },
  "gemini-3.1-flash-lite-high": { model: "gemini-3.1-flash-lite", thinkingLevel: "high" },
  "gemini-3.1-flash-lite": { model: "gemini-3.1-flash-lite" },
  "gemini-2.5-flash-low": { model: "gemini-2.5-flash", thinkingLevel: "low" },
  "gemini-2.5-flash-medium": { model: "gemini-2.5-flash", thinkingLevel: "medium" },
  "gemini-2.5-flash-high": { model: "gemini-2.5-flash", thinkingLevel: "high" },
  "gemini-2.5-flash": { model: "gemini-2.5-flash" },
  "gemini-2.5-pro-low": { model: "gemini-2.5-pro", thinkingLevel: "low" },
  "gemini-2.5-pro-medium": { model: "gemini-2.5-pro", thinkingLevel: "medium" },
  "gemini-2.5-pro-high": { model: "gemini-2.5-pro", thinkingLevel: "high" },
  "gemini-2.5-pro": { model: "gemini-2.5-pro" },

  // Anthropic (Tier 1〜4)
  "claude-haiku-4-5": { model: "claude-haiku-4-5" },
  "claude-sonnet-4-6": { model: "claude-sonnet-4-6" },
  "claude-opus-4-7": { model: "claude-opus-4-7" },

  // xAI Grok (Tier 0 — generateJson 経由ではないので参照のみ)
  "grok-4.20-non-reasoning": { model: "grok-4.20-0309-non-reasoning" },
  "grok-4.20-reasoning": { model: "grok-4.20-0309-reasoning" },
  "grok-4.3": { model: "grok-4.3" },

  // Perplexity (Tier 0 — 同上)
  "perplexity-sonar": { model: "sonar" },
  "perplexity-sonar-pro": { model: "sonar-pro" },
} satisfies Record<string, ModelConfig>;
