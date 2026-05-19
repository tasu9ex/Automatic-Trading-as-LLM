import type { ThinkingLevel } from "@/lib/clients/model-catalog";

export type PromptName =
  | "tier0/news"
  | "tier0/sentiment"
  | "tier1/pre-analyst"
  | "tier2/analyst"
  | "tier3/entry"
  | "tier3/exit"
  | "tier4/critic";

export interface GetPromptOptions {
  label?: string;
  version?: number;
  maxRetries?: number;
  fetchTimeoutMs?: number;
  cacheTtlSeconds?: number;
}

export interface CompiledPrompt {
  system?: string;
  user: string;
}

export interface PromptMetadata {
  name: PromptName;
  version: number;
  source: "langfuse" | "fallback";
  label?: string;
}

export interface PromptConfig {
  model: string;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: "text" | "json";
  thinkingLevel?: ThinkingLevel;
}

export interface PromptResolved {
  compiled: CompiledPrompt;
  config: PromptConfig;
  metadata: PromptMetadata;
}
