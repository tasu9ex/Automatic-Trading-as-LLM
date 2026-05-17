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

/**
 * Discord Webhook 投稿。
 * webhook URL 未設定なら no-op (個人運用で通知不要時)。
 * 失敗してもアプリは継続(通知系は best-effort)。
 */
export async function sendDiscord(payload: WebhookPayload): Promise<void> {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) {
    logger.debug("DISCORD_WEBHOOK_URL not set, skipping notification");
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
      logger.warn({ status: res.status, body }, "Discord webhook failed");
    }
  } catch (err) {
    logger.warn({ err }, "Discord webhook threw");
  }
}
