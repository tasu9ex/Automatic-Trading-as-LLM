/**
 * コード fallback を Langfuse に新規バージョンとして登録する。
 *
 * 既存バージョンは触らない (Langfuse は create するたびに新バージョン)。
 * ラベルは latest + production を自動付与。追加ラベルは --label で指定可。
 *
 * Usage:
 *   pnpm langfuse:register -- --name pre-analyst
 *   pnpm langfuse:register -- --name analyst --label staging
 *
 * 必要な env: LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY (.env.local)
 */

import { getFallbackPromptConfig } from "@/lib/prompts/prompt-fallback-configs";
import type { PromptName } from "@/lib/prompts/prompt-types";
import { LangfuseClient } from "@langfuse/client";

const PROMPT_NAMES: readonly PromptName[] = [
  "pre-analyst",
  "analyst",
  "entry-decision",
  "exit-decision",
  "critic",
] as const;

function parseArgs(argv: string[]) {
  const out: { name?: string; labels: string[] } = { labels: ["latest", "production"] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--name") {
      out.name = argv[++i];
    } else if (a === "--label") {
      const v = argv[++i];
      if (v) out.labels.push(v);
    }
  }
  return out;
}

async function loadPromptModule(name: PromptName) {
  const slug = name; // フォルダ名は PromptName と一致
  const mod = await import(`@/lib/prompts/prompt-fallbacks/${slug}/shared-prompt`);
  const entries = Object.entries(mod).filter(
    ([k, v]) => typeof v === "string" && /_SYSTEM_PROMPT$|_USER_PROMPT$/.test(k),
  );
  const system = entries.find(([k]) => k.endsWith("_SYSTEM_PROMPT"))?.[1] as string | undefined;
  const user = entries.find(([k]) => k.endsWith("_USER_PROMPT"))?.[1] as string | undefined;
  if (!system || !user) {
    throw new Error(`${name}: SYSTEM/USER prompt export not found`);
  }
  return { system, user };
}

async function registerOne(client: LangfuseClient, name: PromptName, labels: string[]) {
  const { system, user } = await loadPromptModule(name);
  const config = getFallbackPromptConfig(name);
  const prompt = await client.prompt.create({
    name,
    type: "chat",
    prompt: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    config,
    labels,
  });
  console.log(`✓ registered ${name} v${prompt.version} [${labels.join(", ")}]`);
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

  const targets: PromptName[] = args.name
    ? PROMPT_NAMES.includes(args.name as PromptName)
      ? [args.name as PromptName]
      : (() => {
          throw new Error(`unknown prompt name: ${args.name}`);
        })()
    : [...PROMPT_NAMES];

  for (const n of targets) {
    await registerOne(client, n, args.labels);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
