/**
 * Langfuse のモデル単価を登録/更新する。
 *
 * Anthropic / Google などの主要モデルは Langfuse の組み込み定義があるため通常不要。
 * Grok / Perplexity Sonar など組み込みにないモデルを使う場合、ここで pricing を登録する。
 *
 * Usage:
 *   pnpm tsx --env-file=.env.local scripts/langfuse/register-models.ts
 *
 * 必要 env: LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL
 *
 * 単価ソース:
 *   - Grok 4.3: xAI /v1/language-models API (2026-05 時点 $1.25 in / $2.5 out per 1M token)
 *   - Perplexity Sonar: 公式公開価格 ($1 in / $1 out per 1M token)
 *
 * Langfuse model API:
 *   inputPrice / outputPrice は USD per 1 token (×1e-6 で per-1M-token 表記から換算)
 */

interface ModelDef {
  modelName: string;
  matchPattern: string;
  inputPrice: number; // USD per token
  outputPrice: number;
  unit: "TOKENS";
  tokenizerId?: string;
  isLangfuseManaged: false;
}

const MODELS: ModelDef[] = [
  // Anthropic — catalog 名 (date サフィックスなし) でも価格マッチさせる
  {
    modelName: "claude-opus-4-7",
    matchPattern: "(?i)^claude-opus-4-7(-\\d{8})?$",
    inputPrice: 15 / 1_000_000,
    outputPrice: 75 / 1_000_000,
    unit: "TOKENS",
    isLangfuseManaged: false,
  },
  {
    modelName: "claude-sonnet-4-6",
    matchPattern: "(?i)^claude-sonnet-4-6(-\\d{8})?$",
    inputPrice: 3 / 1_000_000,
    outputPrice: 15 / 1_000_000,
    unit: "TOKENS",
    isLangfuseManaged: false,
  },
  {
    modelName: "claude-haiku-4-5",
    matchPattern: "(?i)^claude-haiku-4-5(-\\d{8})?$",
    inputPrice: 0.8 / 1_000_000,
    outputPrice: 4 / 1_000_000,
    unit: "TOKENS",
    isLangfuseManaged: false,
  },
  {
    modelName: "grok-4.3",
    matchPattern: "(?i)^grok-4\\.3$",
    inputPrice: 1.25 / 1_000_000,
    outputPrice: 2.5 / 1_000_000,
    unit: "TOKENS",
    isLangfuseManaged: false,
  },
  {
    modelName: "sonar",
    matchPattern: "(?i)^sonar$",
    inputPrice: 1 / 1_000_000,
    outputPrice: 1 / 1_000_000,
    unit: "TOKENS",
    isLangfuseManaged: false,
  },
  {
    modelName: "sonar-pro",
    matchPattern: "(?i)^sonar-pro$",
    inputPrice: 3 / 1_000_000,
    outputPrice: 15 / 1_000_000,
    unit: "TOKENS",
    isLangfuseManaged: false,
  },
];

async function main() {
  const baseUrl = process.env.LANGFUSE_BASE_URL;
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;

  if (!baseUrl || !publicKey || !secretKey) {
    throw new Error("Missing LANGFUSE_BASE_URL / LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY");
  }

  const auth = Buffer.from(`${publicKey}:${secretKey}`).toString("base64");

  for (const model of MODELS) {
    const res = await fetch(`${baseUrl}/api/public/models`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify(model),
    });

    if (res.ok) {
      console.log(`✓ ${model.modelName} registered`);
    } else if (res.status === 409) {
      console.log(`= ${model.modelName} already exists (skip)`);
    } else {
      console.error(`✗ ${model.modelName} failed: ${res.status} ${await res.text()}`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

export {};
