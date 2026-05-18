import { createLogger } from "@/lib/logging";
import { LangfuseClient } from "@langfuse/client";
import { getFallbackPromptConfig } from "./prompt-fallback-configs";
import type {
  CompiledPrompt,
  GetPromptOptions,
  PromptConfig,
  PromptName,
  PromptResolved,
} from "./prompt-types";

const logger = createLogger("prompts.langfuse-client");

let client: LangfuseClient | null = null;
let clientInitialized = false;

function getClient(): LangfuseClient | null {
  if (clientInitialized) return client;
  clientInitialized = true;
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  if (!publicKey || !secretKey) {
    logger.warn("LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY not set — Langfuse disabled");
    return null;
  }
  client = new LangfuseClient({
    publicKey,
    secretKey,
    baseUrl: process.env.LANGFUSE_BASE_URL,
  });
  return client;
}

function toStringVars(vars: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(vars).map(([k, v]) => [
      k,
      typeof v === "string" ? v : JSON.stringify(v, null, 2),
    ]),
  );
}

/**
 * Langfuse からプロンプトを取得して PromptResolved を返す。
 * 取得失敗時は null を返す (呼び出し元で fallback に切り替える)。
 */
export async function getPromptFromLangfuse(
  name: PromptName,
  vars: Record<string, unknown>,
  options: GetPromptOptions = {},
): Promise<PromptResolved | null> {
  const lf = getClient();
  if (!lf) return null;

  try {
    const p = await lf.prompt.get(name, {
      type: "chat",
      label: options.label ?? "production",
      version: options.version,
      maxRetries: options.maxRetries ?? 1,
      fetchTimeoutMs: options.fetchTimeoutMs ?? 3000,
      cacheTtlSeconds: options.cacheTtlSeconds ?? 300,
    });

    const messages = p.compile(toStringVars(vars)) as Array<{ role: string; content: string }>;
    let system: string | undefined;
    let user = "";
    for (const m of messages) {
      if (m.role === "system") system = m.content;
      else if (m.role === "user") user = m.content;
    }
    const compiled: CompiledPrompt = { system, user };

    const rawConfig = (p.promptResponse.config ?? {}) as Partial<PromptConfig>;
    const config: PromptConfig = {
      ...getFallbackPromptConfig(name),
      ...rawConfig,
    };

    return {
      compiled,
      config,
      metadata: {
        name,
        version: p.promptResponse.version,
        source: "langfuse",
        label: options.label ?? "production",
      },
    };
  } catch (err) {
    logger.warn({ err, name }, "Langfuse prompt fetch failed — falling back to catalog");
    return null;
  }
}
