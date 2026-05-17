import { getFallbackPromptConfig } from "./prompt-fallback-configs";
import { getFallbackPrompt } from "./prompt-fallbacks";
import type { GetPromptOptions, PromptName, PromptResolved } from "./prompt-types";

/**
 * プロンプト取得の高レベル API。
 *
 * 現状: 常に fallback (コード内テンプレート) を返す。
 * 将来: Langfuse client を入れて Langfuse 優先 + 失敗時 fallback の挙動にする。
 *
 * @see langfuse-client.ts (未実装、Phase B で追加)
 */
export async function getPrompt(
  name: PromptName,
  vars: Record<string, unknown>,
  _options?: GetPromptOptions,
): Promise<PromptResolved> {
  const compiled = getFallbackPrompt(name, vars);
  const config = getFallbackPromptConfig(name);
  return {
    compiled,
    config,
    metadata: {
      name,
      version: 0,
      source: "fallback",
    },
  };
}
