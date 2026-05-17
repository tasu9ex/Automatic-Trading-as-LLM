/**
 * Langfuse 上のプロンプト(指定ラベル)とコード fallback の差分を検出する。
 *
 * 比較対象: system/user テキスト + config (model, temperature, maxTokens, ...)。
 * 比較値は固定フィクスチャを両者に同じく渡して interpolate した文字列。
 *
 * Usage:
 *   pnpm langfuse:verify
 *   pnpm langfuse:verify -- --label production
 *   pnpm langfuse:verify -- --only analyst
 *
 * 必要な env: LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY
 * 不一致あり → exit 1
 */

import { getFallbackPromptConfig } from "@/lib/prompts/prompt-fallback-configs";
import { getFallbackPrompt } from "@/lib/prompts/prompt-fallbacks";
import type { PromptName } from "@/lib/prompts/prompt-types";
import { LangfuseClient } from "@langfuse/client";

const PROMPT_NAMES: readonly PromptName[] = [
  "pre-analyst",
  "analyst",
  "entry-decision",
  "exit-decision",
  "critic",
] as const;

/** プレースホルダの値はそのまま {{var}} を残して比較する(両者で同じ ToText になる) */
const FIXTURE_VARS = new Proxy(
  {},
  {
    get: (_t, prop: string) => `{{${prop}}}`,
  },
) as Record<string, string>;

interface Mismatch {
  name: PromptName;
  field: string;
  expected: string;
  actual: string;
}

function diff(name: PromptName, field: string, a: unknown, b: unknown, out: Mismatch[]) {
  const A = typeof a === "string" ? a : JSON.stringify(a);
  const B = typeof b === "string" ? b : JSON.stringify(b);
  if (A !== B) out.push({ name, field, expected: A, actual: B });
}

async function verifyOne(
  client: LangfuseClient,
  name: PromptName,
  label: string,
): Promise<Mismatch[]> {
  const fallbackCompiled = getFallbackPrompt(name, FIXTURE_VARS);
  const fallbackConfig = getFallbackPromptConfig(name);

  const remote = await client.prompt.get(name, { label, type: "chat" });
  const remoteMessages = remote.prompt as Array<{ role: string; content: string }>;
  const remoteSystem = remoteMessages.find((m) => m.role === "system")?.content ?? "";
  const remoteUser = remoteMessages.find((m) => m.role === "user")?.content ?? "";

  // Langfuse は Mustache 形式 {{var}} なので、コードの interpolate と同じ結果になるよう
  // fallback 側でも {{var}} を残した状態(FIXTURE_VARS が proxy)で比較する。
  const remoteCompiled = {
    system: remoteSystem,
    user: remoteUser,
  };

  const mismatches: Mismatch[] = [];
  diff(name, "system", fallbackCompiled.system ?? "", remoteCompiled.system, mismatches);
  diff(name, "user", fallbackCompiled.user, remoteCompiled.user, mismatches);

  const remoteConfig = (remote.config ?? {}) as Record<string, unknown>;
  const fallbackConfigRec = fallbackConfig as unknown as Record<string, unknown>;
  for (const key of Object.keys(fallbackConfigRec)) {
    diff(name, `config.${key}`, fallbackConfigRec[key], remoteConfig[key], mismatches);
  }

  return mismatches;
}

function parseArgs(argv: string[]) {
  const out: { only?: string; label: string } = { label: "production" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--label") {
      const v = argv[++i];
      if (v) out.label = v;
    } else if (a === "--only") {
      out.only = argv[++i];
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.LANGFUSE_PUBLIC_KEY || !process.env.LANGFUSE_SECRET_KEY) {
    throw new Error("LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY missing in env");
  }
  const client = new LangfuseClient({
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    baseUrl: process.env.LANGFUSE_BASE_URL,
  });

  const targets: PromptName[] = args.only
    ? PROMPT_NAMES.includes(args.only as PromptName)
      ? [args.only as PromptName]
      : (() => {
          throw new Error(`unknown prompt name: ${args.only}`);
        })()
    : [...PROMPT_NAMES];

  const allMismatches: Mismatch[] = [];
  for (const name of targets) {
    try {
      const ms = await verifyOne(client, name, args.label);
      if (ms.length === 0) console.log(`✓ ${name} (label=${args.label})`);
      else {
        console.log(`✗ ${name} (label=${args.label}) — ${ms.length} mismatch(es)`);
        allMismatches.push(...ms);
      }
    } catch (e) {
      console.log(`✗ ${name}: ${(e as Error).message}`);
      allMismatches.push({
        name,
        field: "fetch",
        expected: "<remote prompt>",
        actual: (e as Error).message,
      });
    }
  }

  if (allMismatches.length > 0) {
    console.log("\n--- mismatches ---");
    for (const m of allMismatches) {
      console.log(`\n[${m.name}] ${m.field}`);
      console.log(`  expected: ${m.expected.slice(0, 200)}`);
      console.log(`  actual:   ${m.actual.slice(0, 200)}`);
    }
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
