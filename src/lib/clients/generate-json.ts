import { anthropic } from "@/lib/clients/anthropic";
import { google } from "@/lib/clients/google";
import type { ThinkingLevel } from "@/lib/clients/model-catalog";
import { createLogger } from "@/lib/logging";
import { type ServiceName, runWith } from "@/lib/rate-limit";
import { recordLLMCall } from "@/lib/telemetry";
import { generateObject } from "ai";
import type { z } from "zod";

const logger = createLogger("clients.generate-json");

export interface GenerateJsonInput<T> {
  /** モデル ID。プレフィックスでプロバイダーを自動判定:
   *   "claude-*" → Anthropic
   *   "gemini-*" → Google
   */
  modelId: string;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  temperature?: number;
  maxOutputTokens?: number;
  /** Gemini のみ有効。Claude には無視される。 */
  thinkingLevel?: ThinkingLevel;
  feature: string;
  metadata?: Record<string, string | number | boolean>;
}

const THINKING_BUDGET: Record<ThinkingLevel, number> = {
  minimal: 128,
  low: 1024,
  medium: 8192,
  high: 24576,
};

type ProviderResult = {
  model: ReturnType<typeof anthropic> | ReturnType<typeof google>;
  service: ServiceName;
  providerOptions: { google: { thinkingConfig: { thinkingBudget: number } } } | undefined;
};

function pickProvider(modelId: string, thinkingLevel?: ThinkingLevel): ProviderResult {
  if (modelId.startsWith("claude-")) {
    return { model: anthropic(modelId), service: "anthropic", providerOptions: undefined };
  }
  if (modelId.startsWith("gemini-")) {
    const providerOptions = thinkingLevel
      ? { google: { thinkingConfig: { thinkingBudget: THINKING_BUDGET[thinkingLevel] } } }
      : undefined;
    return { model: google(modelId), service: "google", providerOptions };
  }
  throw new Error(`Unknown model provider for: ${modelId}`);
}

/**
 * AI SDK の generateObject で型安全 JSON 出力。
 * Anthropic (Claude) と Google (Gemini) 両対応。
 * Gemini は thinkingLevel で thinking を制御。
 * パース失敗時は 1 回リトライ。usage は telemetry.recordLLMCall に集計。
 */
export async function generateJson<T>(input: GenerateJsonInput<T>): Promise<T> {
  const { model, service, providerOptions } = pickProvider(input.modelId, input.thinkingLevel);

  const baseArgs = {
    model,
    system: input.system,
    prompt: input.prompt,
    schema: input.schema,
    temperature: input.temperature ?? 0.2,
    maxOutputTokens: input.maxOutputTokens,
    providerOptions,
  };

  async function call(featureId: string) {
    const result = await generateObject({
      ...baseArgs,
      experimental_telemetry: {
        isEnabled: true,
        functionId: featureId,
        metadata: { modelId: input.modelId, ...(input.metadata ?? {}) },
      },
    });
    recordLLMCall(result.usage, {
      modelId: input.modelId,
      feature: featureId,
      extraMetadata: input.metadata,
    });
    return result.object;
  }

  return runWith(service, async () => {
    try {
      return await call(input.feature);
    } catch (err) {
      logger.warn({ err, feature: input.feature }, "First generation failed, retrying once");
      return await call(`${input.feature}.retry`);
    }
  });
}
