import { anthropic } from "@/lib/clients/anthropic";
import { createLogger } from "@/lib/logging";
import { runWith } from "@/lib/rate-limit";
import { recordLLMCall } from "@/lib/telemetry";
import { generateObject } from "ai";
import type { z } from "zod";

const logger = createLogger("clients.generate-json");

export interface GenerateJsonInput<T> {
  modelId: string; // 例: "claude-opus-4-7"
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  temperature?: number;
  maxOutputTokens?: number;
  /** トレース用ラベル */
  feature: string;
  /** メタデータ (銘柄など) */
  metadata?: Record<string, string | number | boolean>;
}

/**
 * Vercel AI SDK の generateObject で JSON 出力を取得。
 * Zod スキーマで型安全に、失敗時はリトライ 1 回。
 * usage は telemetry.recordLLMCall に渡してコスト集計。
 *
 * 現状は Anthropic 専用 (Opus / Sonnet / Haiku)。Gemini は Phase 5c で追加。
 */
export async function generateJson<T>(input: GenerateJsonInput<T>): Promise<T> {
  return runWith("anthropic", async () => {
    try {
      const result = await generateObject({
        model: anthropic(input.modelId),
        system: input.system,
        prompt: input.prompt,
        schema: input.schema,
        temperature: input.temperature ?? 0.2,
        maxOutputTokens: input.maxOutputTokens,
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
        model: anthropic(input.modelId),
        system: input.system,
        prompt: input.prompt,
        schema: input.schema,
        temperature: input.temperature ?? 0.2,
        maxOutputTokens: input.maxOutputTokens,
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
