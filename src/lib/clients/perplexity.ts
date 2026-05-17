import { createLogger } from "@/lib/logging";
import { runWith } from "@/lib/rate-limit";

const logger = createLogger("clients.perplexity");

const BASE_URL = "https://api.perplexity.ai/chat/completions";

export interface PerplexityRequest {
  model?: string;
  systemPrompt?: string;
  userPrompt: string;
  maxTokens?: number;
}

export interface PerplexityResponse {
  content: string;
  citations: string[];
  usage: { inputTokens: number; outputTokens: number };
}

/**
 * Perplexity Sonar API 呼び出し(チャット完了形式)。
 * sonar-pro: 報道機関ソース付き要約に強い。
 * 引用は citations フィールドに URL 配列で返る。
 */
export async function callPerplexity(req: PerplexityRequest): Promise<PerplexityResponse> {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) throw new Error("PERPLEXITY_API_KEY is not set");

  return runWith("perplexity", async () => {
    const messages: Array<{ role: "system" | "user"; content: string }> = [];
    if (req.systemPrompt) messages.push({ role: "system", content: req.systemPrompt });
    messages.push({ role: "user", content: req.userPrompt });

    const res = await fetch(BASE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: req.model ?? "sonar-pro",
        messages,
        max_tokens: req.maxTokens ?? 800,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      logger.error({ status: res.status, body }, "Perplexity API error");
      throw new Error(`Perplexity ${res.status}: ${body.slice(0, 200)}`);
    }

    const json = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
      citations?: string[];
      usage: { prompt_tokens: number; completion_tokens: number };
    };

    return {
      content: json.choices[0]?.message?.content ?? "",
      citations: json.citations ?? [],
      usage: {
        inputTokens: json.usage.prompt_tokens,
        outputTokens: json.usage.completion_tokens,
      },
    };
  });
}
