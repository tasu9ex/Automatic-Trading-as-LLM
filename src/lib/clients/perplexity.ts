import { periodAsMdy } from "@/lib/clients/period-date";
import { withClientRetry } from "@/lib/clients/retry";
import { createLogger } from "@/lib/logging";
import { runWith } from "@/lib/rate-limit";

const logger = createLogger("clients.perplexity");

const BASE_URL = "https://api.perplexity.ai/chat/completions";

export interface PerplexityRequest {
  model?: string;
  systemPrompt?: string;
  userPrompt: string;
  maxTokens?: number;
  /**
   * 検索対象期間 (時間)。指定時は API レベルで rec filter + after_date filter をかけ、
   * プロンプト指示無視による古ニュース流入を防ぐ。
   */
  periodHours?: number;
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

  return runWith("perplexity", () =>
    withClientRetry(() => callPerplexityOnce(req, apiKey), { label: "perplexity" }),
  );
}

async function callPerplexityOnce(
  req: PerplexityRequest,
  apiKey: string,
): Promise<PerplexityResponse> {
  const messages: Array<{ role: "system" | "user"; content: string }> = [];
  if (req.systemPrompt) messages.push({ role: "system", content: req.systemPrompt });
  messages.push({ role: "user", content: req.userPrompt });

  const body: Record<string, unknown> = {
    model: req.model ?? "sonar-pro",
    messages,
    max_tokens: req.maxTokens ?? 800,
  };
  if (req.periodHours != null && req.periodHours > 0) {
    // Perplexity API は search_recency_filter と search_after_date_filter の併用を 400 で弾く
    // (`invalid_date_filter_combination`)。after_date の方が日付精度で絞れるのでこちら一本。
    body.search_after_date_filter = periodAsMdy(req.periodHours);
  }

  const res = await fetch(BASE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
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
}
