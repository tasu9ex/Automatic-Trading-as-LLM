# Automatic Trading as LLM

LLM 駆動の仮想通貨自動売買システム (個人運用、ペーパートレード MVP)。

## ドキュメント

- [要件定義](docs/requirements.md)
- [MVP タスク分解](docs/mvp-tasks.md)

## セットアップ

```bash
pnpm install
cp .env.example .env.local  # 値を埋める
pnpm dev
```

## スクリプト

| コマンド | 用途 |
|---------|------|
| `pnpm dev` | 開発サーバー |
| `pnpm build` | 本番ビルド |
| `pnpm lint` | Biome lint チェック |
| `pnpm lint:fix` | Biome 自動修正 |
| `pnpm format` | Biome フォーマット |
| `pnpm knip` | 未使用コード検出 |
| `pnpm test` | Vitest 実行 |
| `pnpm typecheck` | 型チェック |

## ディレクトリ

```
src/
  app/          Next.js App Router
  components/   UI コンポーネント
  db/           Drizzle スキーマ・クライアント
  lib/
    tier0/      情報収集 (Perplexity, Grok)
    tier1/      Pre-Analyst (Haiku 要約)
    tier2/      Analyst (Opus 分析)
    decision/   Entry/Exit 判定
    allocator/  Portfolio Allocator
    critic/     Critic LLM
    risk/       Risk Clipper
    executor/   仮想約定
    price-monitor/ 逆指値タッチ判定
    kill-switch/   システム停止
    shared/     共通ロジック (Next.js + Deno 両用)
scripts/
  smoke/        各 API 単発呼び出し確認
  cycle/        判定・価格監視・週次レポートの CLI
  dev/          シードなど開発用
tests/          Vitest テスト
```

## 技術スタック

Next.js 15 (App Router) / TypeScript / Tailwind + shadcn/ui / Supabase /
Drizzle / Inngest / Langfuse / Sentry / Biome / Knip / Vitest
