/**
 * Langfuse プロンプト解決 + JSON 生成の共通ラッパー。
 *
 * 各 LLM ランナー (pre-analyst / analyst / entry / exit / critic) が同じ手順を
 * 繰り返していたので一本化:
 *   1. getPrompt(name, vars) で Langfuse → fallback の順に解決
 *   2. generateJson に config を展開して渡す
 *   3. {output, promptVersion, llmModel} を返す
 */

import { generateJson } from "@/lib/clients/generate-json";
import { getPrompt } from "@/lib/prompts";
import type { PromptName } from "@/lib/prompts/prompt-types";
import type { z } from "zod";

export interface RunPromptedJsonInput<T> {
  promptName: PromptName;
  vars: Record<string, unknown>;
  schema: z.ZodType<T>;
  feature: string;
  metadata?: Record<string, string | number | boolean>;
}

export interface RunPromptedJsonResult<T> {
  output: T;
  promptVersion: string | null;
  llmModel: string;
}

export async function runPromptedJson<T>(
  input: RunPromptedJsonInput<T>,
): Promise<RunPromptedJsonResult<T>> {
  const resolved = await getPrompt(input.promptName, input.vars);
  const output = await generateJson<T>({
    modelId: resolved.config.model,
    system: resolved.compiled.system ?? "",
    prompt: resolved.compiled.user,
    schema: input.schema,
    temperature: resolved.config.temperature,
    maxOutputTokens: resolved.config.maxTokens,
    thinkingLevel: resolved.config.thinkingLevel,
    feature: input.feature,
    metadata: input.metadata,
  });
  return {
    output,
    promptVersion:
      resolved.metadata.source === "langfuse" ? String(resolved.metadata.version) : null,
    llmModel: resolved.config.model,
  };
}
