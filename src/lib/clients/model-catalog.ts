export type ThinkingLevel = "minimal" | "low" | "medium" | "high";

interface ModelConfig {
  model: string;
  thinkingLevel?: ThinkingLevel;
}

export const MODEL_CATALOG = {
  "gemini-2.5-flash-low": { model: "gemini-2.5-flash", thinkingLevel: "low" },
  "gemini-2.5-flash-medium": { model: "gemini-2.5-flash", thinkingLevel: "medium" },
  "gemini-2.5-flash-high": { model: "gemini-2.5-flash", thinkingLevel: "high" },
  "gemini-2.5-flash": { model: "gemini-2.5-flash" },
  "gemini-2.5-pro-low": { model: "gemini-2.5-pro", thinkingLevel: "low" },
  "gemini-2.5-pro-medium": { model: "gemini-2.5-pro", thinkingLevel: "medium" },
  "gemini-2.5-pro-high": { model: "gemini-2.5-pro", thinkingLevel: "high" },
  "gemini-2.5-pro": { model: "gemini-2.5-pro" },
} satisfies Record<string, ModelConfig>;
