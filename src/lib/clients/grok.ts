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
  /** true: Responses API + x_search ツール (Tier 0 sentiment 向け、X 投稿のみ検索) */
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
  /**
   * costUsd は xAI が返す実課金額 (トークン + server-side tool 全部込み)。
   * Langfuse の単価推定ではなくこの実額を cost として計上する。
   */
  usage: { inputTokens: number; outputTokens: number; costUsd?: number };
}

/** 1 USD = 10^10 ticks (xAI usage.cost_in_usd_ticks の単位) */
const USD_TICKS = 10_000_000_000;

/** xAI usage オブジェクト共通の cost / tool フィールド */
interface XaiUsageExtras {
  /** トークン + tool invocation 全部込みの実課金額 (ticks)。1 USD = 10^10 ticks */
  cost_in_usd_ticks?: number;
  /** 課金対象として成功した server-side tool の呼び出し回数マップ */
  server_side_tool_usage?: Record<string, number>;
}

interface ResponsesApiOutputItem {
  type: string;
  role?: string;
  content?: Array<{ type: string; text?: string }>;
  action?: { type?: string; sources?: Array<{ type?: string; url?: string }> };
}

interface ResponsesApiResponse {
  output?: ResponsesApiOutputItem[];
  usage?: { input_tokens?: number; output_tokens?: number } & XaiUsageExtras;
  /** Agent Tools API は top-level に citations URL 配列を返す */
  citations?: string[];
}

interface ChatApiResponse {
  choices: Array<{ message: { content: string } }>;
  usage: { prompt_tokens: number; completion_tokens: number } & XaiUsageExtras;
}

/** ticks → USD 変換 (未定義なら undefined: Langfuse 側の単価推定にフォールバック) */
function ticksToUsd(ticks: number | undefined): number | undefined {
  return typeof ticks === "number" ? ticks / USD_TICKS : undefined;
}

/**
 * xAI Grok API 呼び出し。
 *
 * 2 モード:
 *   - useTools=false (デフォルト): /v1/chat/completions、純粋な chat 完了
 *   - useTools=true: /v1/responses + Agent Tools (x_search のみ)
 *     → リアルタイム X 投稿を Grok が自律的に取得・要約 (Web/ニュースは Perplexity 担当)
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
      costUsd: ticksToUsd(json.usage.cost_in_usd_ticks),
    },
  };
}

async function callGrokWithTools(req: GrokRequest, apiKey: string): Promise<GrokResponse> {
  const input: Array<{ role: "system" | "user"; content: string }> = [];
  if (req.systemPrompt) input.push({ role: "system", content: req.systemPrompt });
  input.push({ role: "user", content: req.userPrompt });

  // Grok は x_search (X 投稿) のみ。Web/ニュースは Perplexity (tier0/news) が担当する
  // ため web_search は外す (重複 + ツール呼び出し代の削減)。棲み分け: Grok=X センチメント。
  // 検索期間は tool config 側で渡す (旧 search_parameters は 410 deprecated)。
  const xTool: Record<string, unknown> = { type: "x_search" };
  if (req.periodHours != null && req.periodHours > 0) {
    xTool.from_date = periodAsIsoDate(req.periodHours);
  }

  const body: Record<string, unknown> = {
    model: req.model ?? "grok-4.3",
    input,
    tools: [xTool],
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

  // citations: 1) top-level の citations (Agent Tools API 標準) 2) *_search_call の sources
  // (x_search_call 等) 3) 本文中 [[N]](url) インライン
  const fromTop = json.citations ?? [];
  const fromSearchCalls = (json.output ?? [])
    .filter((o) => o.type.endsWith("_search_call"))
    .flatMap((o) => o.action?.sources ?? [])
    .map((s) => s.url)
    .filter((u): u is string => typeof u === "string");
  const inline = [...content.matchAll(/\[\[\d+\]\]\(([^)]+)\)/g)].map((m) => m[1] as string);
  const citations = [...new Set([...fromTop, ...fromSearchCalls, ...inline])];

  const costUsd = ticksToUsd(json.usage?.cost_in_usd_ticks);
  // server-side tool (web_search / x_search) の実呼び出し回数をログに残す。
  // costUsd にこのツール代も含まれているので、内訳の可視化用。
  if (json.usage?.server_side_tool_usage) {
    logger.info(
      { model: req.model ?? "grok-4.3", costUsd, tools: json.usage.server_side_tool_usage },
      "Grok tool usage",
    );
  }

  return {
    content,
    citations,
    usage: {
      inputTokens: json.usage?.input_tokens ?? 0,
      outputTokens: json.usage?.output_tokens ?? 0,
      costUsd,
    },
  };
}
