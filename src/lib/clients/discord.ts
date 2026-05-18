import { createLogger } from "@/lib/logging";

const logger = createLogger("clients.discord");

export interface DiscordEmbed {
  /** タイトル(60 文字以内推奨) */
  title: string;
  /** 本文 (Markdown 可、4096 文字以内) */
  description?: string;
  /** 色 (16 進整数、e.g. 0xff0000 で赤) */
  color?: number;
  /** key/value フィールド (各 1024 文字以内、最大 25 個) */
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  /** ISO 8601 タイムスタンプ */
  timestamp?: string;
  footer?: { text: string };
}

interface WebhookPayload {
  content?: string;
  embeds?: DiscordEmbed[];
}

export type DiscordChannel = "normal" | "errors";

function pickWebhookUrl(channel: DiscordChannel): string | undefined {
  if (channel === "errors") {
    return process.env.DISCORD_WEBHOOK_URL_ERRORS ?? process.env.DISCORD_WEBHOOK_URL;
  }
  return process.env.DISCORD_WEBHOOK_URL;
}

/**
 * Discord Webhook 投稿。
 *   channel="normal": DISCORD_WEBHOOK_URL (BUY/SELL/Critic/Cycle done 等)
 *   channel="errors": DISCORD_WEBHOOK_URL_ERRORS (Sentry/CRASH/Kill Switch)
 *                     未設定なら DISCORD_WEBHOOK_URL にフォールバック
 *
 * webhook URL 全未設定なら no-op。失敗してもアプリは継続。
 */
export async function sendDiscord(
  payload: WebhookPayload,
  channel: DiscordChannel = "normal",
): Promise<void> {
  const url = pickWebhookUrl(channel);
  if (!url) {
    logger.debug({ channel }, "Discord webhook URL not set, skipping");
    return;
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text();
      logger.warn({ status: res.status, body, channel }, "Discord webhook failed");
    }
  } catch (err) {
    logger.warn({ err, channel }, "Discord webhook threw");
  }
}
