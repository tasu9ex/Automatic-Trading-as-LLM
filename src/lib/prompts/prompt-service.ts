import { getPromptFromLangfuse } from "./langfuse-client";
import { getFallbackPromptConfig } from "./prompt-fallback-configs";
import { getFallbackPrompt } from "./prompt-fallbacks";
import type { GetPromptOptions, PromptName, PromptResolved } from "./prompt-types";

/**
 * プロンプト取得の高レベル API。
 *
 * Langfuse (production ラベル) を優先して取得。
 * 接続失敗 / タイムアウト時はコード内テンプレート + shared-prompt.config に自動フォールバック。
 */
export async function getPrompt(
  name: PromptName,
  vars: Record<string, unknown>,
  options?: GetPromptOptions,
): Promise<PromptResolved> {
  const fromLangfuse = await getPromptFromLangfuse(name, vars, options);
  if (fromLangfuse) return fromLangfuse;

  return {
    compiled: getFallbackPrompt(name, vars),
    config: getFallbackPromptConfig(name),
    metadata: { name, version: 0, source: "fallback" },
  };
}
