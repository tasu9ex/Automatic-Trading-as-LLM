import type { CompiledPrompt, PromptName } from "./prompt-types";

import {
  ANALYST_SYSTEM_PROMPT,
  ANALYST_USER_PROMPT,
} from "./prompt-fallbacks/analyst/shared-prompt";
import { CRITIC_SYSTEM_PROMPT, CRITIC_USER_PROMPT } from "./prompt-fallbacks/critic/shared-prompt";
import {
  ENTRY_DECISION_SYSTEM_PROMPT,
  ENTRY_DECISION_USER_PROMPT,
} from "./prompt-fallbacks/entry-decision/shared-prompt";
import {
  EXIT_DECISION_SYSTEM_PROMPT,
  EXIT_DECISION_USER_PROMPT,
} from "./prompt-fallbacks/exit-decision/shared-prompt";
import {
  PRE_ANALYST_SYSTEM_PROMPT,
  PRE_ANALYST_USER_PROMPT,
} from "./prompt-fallbacks/pre-analyst/shared-prompt";

const FALLBACK_TEMPLATES: Record<PromptName, { system: string; user: string }> = {
  "pre-analyst": { system: PRE_ANALYST_SYSTEM_PROMPT, user: PRE_ANALYST_USER_PROMPT },
  analyst: { system: ANALYST_SYSTEM_PROMPT, user: ANALYST_USER_PROMPT },
  "entry-decision": {
    system: ENTRY_DECISION_SYSTEM_PROMPT,
    user: ENTRY_DECISION_USER_PROMPT,
  },
  "exit-decision": {
    system: EXIT_DECISION_SYSTEM_PROMPT,
    user: EXIT_DECISION_USER_PROMPT,
  },
  critic: { system: CRITIC_SYSTEM_PROMPT, user: CRITIC_USER_PROMPT },
};

/**
 * {{key}} を vars[key] に置換する単純テンプレート。
 * 未定義キーは空文字に。Langfuse の compile 動作と同じ。
 */
function interpolate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/{{\s*([\w.-]+)\s*}}/g, (_, key) => {
    const value = vars[key];
    if (value === undefined || value === null) return "";
    if (typeof value === "string") return value;
    return JSON.stringify(value, null, 2);
  });
}

/**
 * Langfuse 接続失敗時の fallback プロンプト取得。
 * 変数を埋めて CompiledPrompt を返す。
 */
export function getFallbackPrompt(name: PromptName, vars: Record<string, unknown>): CompiledPrompt {
  const tpl = FALLBACK_TEMPLATES[name];
  return {
    system: interpolate(tpl.system, vars),
    user: interpolate(tpl.user, vars),
  };
}
