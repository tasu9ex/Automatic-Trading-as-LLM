import { createLogger } from "@/lib/logging";
import { runWith } from "@/lib/rate-limit";

const logger = createLogger("clients.grok");

const BASE_URL = "https://api.x.ai/v1/chat/completions";

export interface GrokRequest {
  model?: string;
  systemPrompt?: string;
  userPrompt: string;
  maxTokens?: number;
}

export interface GrokResponse {
  content: string;
  usage: { inputTokens: number; outputTokens: number };
}

/**
 * xAI Grok API 呼び出し。
 * X (Twitter) リアルタイムデータへのネイティブアクセスを持つため、
 * SNS センチメント・KOL 発言取得に強い。
 */
export async function callGrok(req: GrokRequest): Promise<GrokResponse> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) throw new Error("XAI_API_KEY is not set");

  return runWith("grok", async () => {
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
        model: req.model ?? "grok-4.20-0309-non-reasoning",
        messages,
        max_tokens: req.maxTokens ?? 800,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      logger.error({ status: res.status, body }, "Grok API error");
      throw new Error(`Grok ${res.status}: ${body.slice(0, 200)}`);
    }

    const json = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage: { prompt_tokens: number; completion_tokens: number };
    };

    return {
      content: json.choices[0]?.message?.content ?? "",
      usage: {
        inputTokens: json.usage.prompt_tokens,
        outputTokens: json.usage.completion_tokens,
      },
    };
  });
}
