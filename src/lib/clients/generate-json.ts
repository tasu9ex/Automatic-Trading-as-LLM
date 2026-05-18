import { anthropic } from "@/lib/clients/anthropic";
import { google } from "@/lib/clients/google";
import { createLogger } from "@/lib/logging";
import { type ServiceName, runWith } from "@/lib/rate-limit";
import { recordLLMCall } from "@/lib/telemetry";
import { generateObject } from "ai";
import type { z } from "zod";

const logger = createLogger("clients.generate-json");

export interface GenerateJsonInput<T> {
  /** モデル ID。プレフィックスでプロバイダーを自動判定: */
  /**   "claude-*" → Anthropic / "gemini-*" → Google */
  modelId: string;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  temperature?: number;
  maxOutputTokens?: number;
  feature: string;
  metadata?: Record<string, string | number | boolean>;
}

function pickProvider(modelId: string): {
  model: ReturnType<typeof anthropic> | ReturnType<typeof google>;
  service: ServiceName;
} {
  if (modelId.startsWith("claude-")) {
    return { model: anthropic(modelId), service: "anthropic" };
  }
  if (modelId.startsWith("gemini-")) {
    return { model: google(modelId), service: "google" };
  }
  throw new Error(`Unknown model provider for: ${modelId}`);
}

/**
 * AI SDK の generateObject で型安全 JSON 出力。
 * Anthropic (Claude) と Google (Gemini) 両対応。
 * パース失敗時は 1 回リトライ。usage は telemetry.recordLLMCall に集計。
 */
export async function generateJson<T>(input: GenerateJsonInput<T>): Promise<T> {
  const { model, service } = pickProvider(input.modelId);

  const telemetry = {
    isEnabled: true,
    functionId: input.feature,
    metadata: {
      modelId: input.modelId,
      ...(input.metadata ?? {}),
    },
  };

  return runWith(service, async () => {
    try {
      const result = await generateObject({
        model,
        system: input.system,
        prompt: input.prompt,
        schema: input.schema,
        temperature: input.temperature ?? 0.2,
        maxOutputTokens: input.maxOutputTokens,
        experimental_telemetry: telemetry,
      });
      recordLLMCall(result.usage, {
        modelId: input.modelId,
        feature: input.feature,
        extraMetadata: input.metadata,
      });
      return result.object;
    } catch (err) {
      logger.warn({ err, feature: input.feature }, "First generation failed, retrying once");
      const result = await generateObject({
        model,
        system: input.system,
        prompt: input.prompt,
        schema: input.schema,
        temperature: input.temperature ?? 0.2,
        maxOutputTokens: input.maxOutputTokens,
        experimental_telemetry: { ...telemetry, functionId: `${input.feature}.retry` },
      });
      recordLLMCall(result.usage, {
        modelId: input.modelId,
        feature: `${input.feature}.retry`,
        extraMetadata: input.metadata,
      });
      return result.object;
    }
  });
}
