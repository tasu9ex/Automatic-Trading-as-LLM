import { generateJson } from "@/lib/clients/generate-json";
import { getPrompt } from "@/lib/prompts";
import { type EntryDecisionOutput, EntryDecisionOutputSchema } from "@/lib/schemas/llm-outputs";
import type { AnalystResult } from "@/lib/tier2/analyst";

export interface EntryDecisionResult {
  output: EntryDecisionOutput;
  promptVersion: string | null;
  llmModel: string;
}

/**
 * Entry Decision: Analyst 見解を元に Buy / No を判定。
 * 未保有銘柄に対して実行。
 */
export async function runEntryDecision(
  symbol: string,
  name: string,
  analyst: AnalystResult,
): Promise<EntryDecisionResult> {
  const resolved = await getPrompt("tier3/entry", {
    symbol,
    name,
    analyst_synthesis: JSON.stringify(analyst.output.synthesis, null, 2),
    analyst_full: JSON.stringify(analyst.output, null, 2),
  });

  const output = await generateJson<EntryDecisionOutput>({
    modelId: resolved.config.model,
    system: resolved.compiled.system ?? "",
    prompt: resolved.compiled.user,
    schema: EntryDecisionOutputSchema,
    temperature: resolved.config.temperature,
    maxOutputTokens: resolved.config.maxTokens,
    thinkingLevel: resolved.config.thinkingLevel,
    feature: "decision.entry",
    metadata: { symbol },
  });

  return {
    output,
    promptVersion:
      resolved.metadata.source === "langfuse" ? String(resolved.metadata.version) : null,
    llmModel: resolved.config.model,
  };
}
