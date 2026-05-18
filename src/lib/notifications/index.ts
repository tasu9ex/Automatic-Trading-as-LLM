import { type DiscordChannel, type DiscordEmbed, sendDiscord } from "@/lib/clients/discord";

/**
 * 通知レベル → 色 + ルーティング先 webhook。
 * - info/success/warning   → "normal" channel (DISCORD_WEBHOOK_URL)
 * - error/critical         → "errors" channel (DISCORD_WEBHOOK_URL_ERRORS)
 *                            未設定なら normal にフォールバック
 */
const LEVEL_META: Record<NotifyLevel, { color: number; channel: DiscordChannel }> = {
  info: { color: 0x3498db, channel: "normal" },
  success: { color: 0x2ecc71, channel: "normal" },
  warning: { color: 0xf39c12, channel: "normal" },
  error: { color: 0xe74c3c, channel: "errors" },
  critical: { color: 0x8b0000, channel: "errors" },
};

export type NotifyLevel = "info" | "success" | "warning" | "error" | "critical";

export interface NotifyInput {
  level: NotifyLevel;
  title: string;
  /** Markdown 可、4096 文字以内 */
  body?: string;
  /** 構造化フィールド (各 1024 文字以内) */
  fields?: Record<string, string | number>;
}

function buildEmbed(input: NotifyInput, color: number): DiscordEmbed {
  const embed: DiscordEmbed = {
    title: input.title,
    color,
    timestamp: new Date().toISOString(),
    footer: { text: `${input.level.toUpperCase()} · LLM Trading` },
  };
  if (input.body) embed.description = input.body;
  if (input.fields) {
    embed.fields = Object.entries(input.fields).map(([name, value]) => ({
      name,
      value: String(value),
      inline: true,
    }));
  }
  return embed;
}

/**
 * 全通知のエントリポイント。
 * level に応じて自動で normal/errors webhook に振り分け。
 * 失敗してもアプリは継続(best-effort)。
 *
 * Usage:
 *   await notify({
 *     level: "success",
 *     title: "BTC Entry filled",
 *     body: "12,500 円 @ ¥15,234,560",
 *     fields: { qty: "0.00082", confidence: 0.78 },
 *   });
 */
export async function notify(input: NotifyInput): Promise<void> {
  const meta = LEVEL_META[input.level];
  await sendDiscord({ embeds: [buildEmbed(input, meta.color)] }, meta.channel);
}
