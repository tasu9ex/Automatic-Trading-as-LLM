import { type DiscordEmbed, sendDiscord } from "@/lib/clients/discord";

/**
 * 通知レベル → 色マッピング(Discord Embed)。
 * MVP は 1 チャンネル垂れ流し、色だけで重要度を示す。
 */
const COLOR_BY_LEVEL = {
  info: 0x3498db, // blue
  success: 0x2ecc71, // green
  warning: 0xf39c12, // orange
  error: 0xe74c3c, // red
  critical: 0x8b0000, // dark red
} as const;

export type NotifyLevel = keyof typeof COLOR_BY_LEVEL;

export interface NotifyInput {
  level: NotifyLevel;
  title: string;
  /** Markdown 可、4096 文字以内 */
  body?: string;
  /** 構造化フィールド (各 1024 文字以内) */
  fields?: Record<string, string | number>;
}

function buildEmbed(input: NotifyInput): DiscordEmbed {
  const embed: DiscordEmbed = {
    title: input.title,
    color: COLOR_BY_LEVEL[input.level],
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
  await sendDiscord({ embeds: [buildEmbed(input)] });
}
