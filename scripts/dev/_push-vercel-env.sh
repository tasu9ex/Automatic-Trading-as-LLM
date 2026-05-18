#!/bin/bash
#
# .env.production.local と .env.local から本番用 env を Vercel Production に push する。
# 既存値があれば上書き (vercel env rm → add)。
#
# Usage: bash scripts/dev/_push-vercel-env.sh
#
set -uo pipefail

# Vercel に登録すべきキー (INNGEST_DEV / ローカル Docker DB の値は除外)
KEYS_FROM_PROD=(
  NEXT_PUBLIC_SUPABASE_URL
  NEXT_PUBLIC_SUPABASE_ANON_KEY
  SUPABASE_SERVICE_ROLE_KEY
  DATABASE_URL
)
KEYS_FROM_LOCAL=(
  GOOGLE_GENERATIVE_AI_API_KEY
  ANTHROPIC_API_KEY
  PERPLEXITY_API_KEY
  XAI_API_KEY
  GMO_API_KEY
  GMO_API_SECRET
  LANGFUSE_PUBLIC_KEY
  LANGFUSE_SECRET_KEY
  LANGFUSE_BASE_URL
  NEXT_PUBLIC_SENTRY_DSN
  SENTRY_AUTH_TOKEN
  SENTRY_ORG
  SENTRY_PROJECT
  DISCORD_WEBHOOK_URL
  DISCORD_WEBHOOK_URL_ERRORS
)

cd "$(dirname "$0")/../.."

read_env_value() {
  local file="$1"
  local key="$2"
  grep -E "^${key}=" "$file" 2>/dev/null | head -n1 | sed -E "s/^${key}=//; s/^[\"']//; s/[\"']$//"
}

push_one() {
  local key="$1"
  local value="$2"
  if [ -z "$value" ]; then
    echo "  skip: $key (empty)"
    return
  fi
  # 既存削除 (失敗しても無視)
  vercel env rm "$key" production --yes >/dev/null 2>&1 || true
  # 追加
  printf "%s" "$value" | vercel env add "$key" production >/dev/null 2>&1 \
    && echo "  ✓ $key" \
    || echo "  ✗ $key (failed)"
}

echo "Pushing production env from .env.production.local:"
for k in "${KEYS_FROM_PROD[@]}"; do
  v=$(read_env_value ".env.production.local" "$k")
  push_one "$k" "$v"
done

echo "Pushing production env from .env.local:"
for k in "${KEYS_FROM_LOCAL[@]}"; do
  v=$(read_env_value ".env.local" "$k")
  push_one "$k" "$v"
done

echo "Done."
