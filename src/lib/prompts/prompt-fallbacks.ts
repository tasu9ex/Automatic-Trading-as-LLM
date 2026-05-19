import type { CompiledPrompt, PromptName } from "./prompt-types";

import {
  TIER0_NEWS_SYSTEM_PROMPT,
  TIER0_NEWS_USER_PROMPT,
} from "./prompt-fallbacks/tier0/news/shared-prompt";
import {
  TIER0_SENTIMENT_SYSTEM_PROMPT,
  TIER0_SENTIMENT_USER_PROMPT,
} from "./prompt-fallbacks/tier0/sentiment/shared-prompt";
import {
  PRE_ANALYST_SYSTEM_PROMPT,
  PRE_ANALYST_USER_PROMPT,
} from "./prompt-fallbacks/tier1/pre-analyst/shared-prompt";
import {
  ANALYST_SYSTEM_PROMPT,
  ANALYST_USER_PROMPT,
} from "./prompt-fallbacks/tier2/analyst/shared-prompt";
import {
  ENTRY_DECISION_SYSTEM_PROMPT,
  ENTRY_DECISION_USER_PROMPT,
} from "./prompt-fallbacks/tier3/entry/shared-prompt";
import {
  EXIT_DECISION_SYSTEM_PROMPT,
  EXIT_DECISION_USER_PROMPT,
} from "./prompt-fallbacks/tier3/exit/shared-prompt";
import {
  CRITIC_SYSTEM_PROMPT,
  CRITIC_USER_PROMPT,
} from "./prompt-fallbacks/tier4/critic/shared-prompt";

const FALLBACK_TEMPLATES: Record<PromptName, { system: string; user: string }> = {
  "tier0/news": { system: TIER0_NEWS_SYSTEM_PROMPT, user: TIER0_NEWS_USER_PROMPT },
  "tier0/sentiment": { system: TIER0_SENTIMENT_SYSTEM_PROMPT, user: TIER0_SENTIMENT_USER_PROMPT },
  "tier1/pre-analyst": { system: PRE_ANALYST_SYSTEM_PROMPT, user: PRE_ANALYST_USER_PROMPT },
  "tier2/analyst": { system: ANALYST_SYSTEM_PROMPT, user: ANALYST_USER_PROMPT },
  "tier3/entry": { system: ENTRY_DECISION_SYSTEM_PROMPT, user: ENTRY_DECISION_USER_PROMPT },
  "tier3/exit": { system: EXIT_DECISION_SYSTEM_PROMPT, user: EXIT_DECISION_USER_PROMPT },
  "tier4/critic": { system: CRITIC_SYSTEM_PROMPT, user: CRITIC_USER_PROMPT },
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
