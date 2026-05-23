import { periodAsIsoDate } from "@/lib/clients/period-date";
import { withClientRetry } from "@/lib/clients/retry";
import { createLogger } from "@/lib/logging";
import { runWith } from "@/lib/rate-limit";

const logger = createLogger("clients.grok");

const CHAT_URL = "https://api.x.ai/v1/chat/completions";
const RESPONSES_URL = "https://api.x.ai/v1/responses";

export interface GrokRequest {
  model?: string;
  systemPrompt?: string;
  userPrompt: string;
  maxTokens?: number;
  /** true: Responses API + web_search + x_search ツール (Tier 0 sentiment 向け) */
  useTools?: boolean;
  /**
   * useTools=true 時に検索期間を tool 側で絞る (時間)。
   * `from_date = now - periodHours` を YYYY-MM-DD (UTC) で渡す。
   */
  periodHours?: number;
}

export interface GrokResponse {
  content: string;
  /** Responses API 経由の場合、引用元 URL 配列 */
  citations?: string[];
  usage: { inputTokens: number; outputTokens: number };
}

interface ResponsesApiOutputItem {
  type: string;
  role?: string;
  content?: Array<{ type: string; text?: string }>;
  action?: { type?: string; sources?: Array<{ type?: string; url?: string }> };
}

interface ResponsesApiResponse {
  output?: ResponsesApiOutputItem[];
  usage?: { input_tokens?: number; output_tokens?: number };
  /** Agent Tools API は top-level に citations URL 配列を返す */
  citations?: string[];
}

interface ChatApiResponse {
  choices: Array<{ message: { content: string } }>;
  usage: { prompt_tokens: number; completion_tokens: number };
}

/**
 * xAI Grok API 呼び出し。
 *
 * 2 モード:
 *   - useTools=false (デフォルト): /v1/chat/completions、純粋な chat 完了
 *   - useTools=true: /v1/responses + Agent Tools (web_search + x_search)
 *     → リアルタイム X 投稿 + Web 記事を Grok が自律的に取得・要約
 *
 * NOTE: 旧 search_parameters API は 410 で deprecated。tools 側に from_date を渡す。
 */
export async function callGrok(req: GrokRequest): Promise<GrokResponse> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) throw new Error("XAI_API_KEY is not set");

  return runWith("grok", () =>
    withClientRetry(
      () => (req.useTools ? callGrokWithTools(req, apiKey) : callGrokChat(req, apiKey)),
      { label: req.useTools ? "grok-responses" : "grok-chat" },
    ),
  );
}

async function callGrokChat(req: GrokRequest, apiKey: string): Promise<GrokResponse> {
  const messages: Array<{ role: "system" | "user"; content: string }> = [];
  if (req.systemPrompt) messages.push({ role: "system", content: req.systemPrompt });
  messages.push({ role: "user", content: req.userPrompt });

  const res = await fetch(CHAT_URL, {
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
    logger.error({ status: res.status, body }, "Grok chat API error");
    throw new Error(`Grok ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = (await res.json()) as ChatApiResponse;
  return {
    content: json.choices[0]?.message?.content ?? "",
    usage: {
      inputTokens: json.usage.prompt_tokens,
      outputTokens: json.usage.completion_tokens,
    },
  };
}

async function callGrokWithTools(req: GrokRequest, apiKey: string): Promise<GrokResponse> {
  const input: Array<{ role: "system" | "user"; content: string }> = [];
  if (req.systemPrompt) input.push({ role: "system", content: req.systemPrompt });
  input.push({ role: "user", content: req.userPrompt });

  // 検索期間は tool config 側で渡す (旧 search_parameters は 410 deprecated)。
  // web_search / x_search いずれも from_date (ISO YYYY-MM-DD) を受ける。
  const webTool: Record<string, unknown> = { type: "web_search" };
  const xTool: Record<string, unknown> = { type: "x_search" };
  if (req.periodHours != null && req.periodHours > 0) {
    const fromDate = periodAsIsoDate(req.periodHours);
    webTool.from_date = fromDate;
    xTool.from_date = fromDate;
  }

  const body: Record<string, unknown> = {
    model: req.model ?? "grok-4.3",
    input,
    tools: [webTool, xTool],
    max_output_tokens: req.maxTokens ?? 800,
  };

  const res = await fetch(RESPONSES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    logger.error({ status: res.status, body: text }, "Grok responses API error");
    throw new Error(`Grok ${res.status}: ${text.slice(0, 200)}`);
  }

  const json = (await res.json()) as ResponsesApiResponse;

  // output 配列から最初の assistant message を抽出
  const assistantMessage = (json.output ?? []).find(
    (o) => o.type === "message" && o.role === "assistant",
  );
  const textParts = (assistantMessage?.content ?? [])
    .filter((c) => c.type === "output_text" && typeof c.text === "string")
    .map((c) => c.text as string);
  const content = textParts.join("\n").trim();

  // citations: 1) top-level の citations (Agent Tools API 標準) 2) web_search_call の sources
  // 3) 本文中 [[N]](url) インライン
  const fromTop = json.citations ?? [];
  const fromSearchCalls = (json.output ?? [])
    .filter((o) => o.type === "web_search_call")
    .flatMap((o) => o.action?.sources ?? [])
    .map((s) => s.url)
    .filter((u): u is string => typeof u === "string");
  const inline = [...content.matchAll(/\[\[\d+\]\]\(([^)]+)\)/g)].map((m) => m[1] as string);
  const citations = [...new Set([...fromTop, ...fromSearchCalls, ...inline])];

  return {
    content,
    citations,
    usage: {
      inputTokens: json.usage?.input_tokens ?? 0,
      outputTokens: json.usage?.output_tokens ?? 0,
    },
  };
}
