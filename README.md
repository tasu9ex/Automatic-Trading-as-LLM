# Automatic Trading as LLM

LLM を判断エンジンに据えた仮想通貨自動売買システム。執行はコード、判断は LLM。

> ⚠️ **個人運用・検証用途**。現状はペーパートレード MVP (フォワードテスト) 段階で、実資金は投入していない。本リポジトリは記録・公開を目的としたもので、投資助言ではない。

## 概要

「**どの LLM × どのプロンプト × どの情報源の組み合わせが利益を出せるか**」を、本番市場データに対するフォワードテストで検証することが目的のシステム。

長期ビジョンは **完全無人運用 (Human-out-of-the-loop) の LLM トレーダー**。MVP では人手介入を許容しつつ、後付けでメタ層 (Supervisor / 自動チューニング) を載せられるアーキテクチャを保つ。

- 対象: GMO コイン取引所形式の銘柄 (BTC / ETH ほか)
- 判定間隔: 検証期は 1h サイクル × 少数銘柄、運用期は 1d サイクル × 20+ 銘柄
- 評価: 絶対利益が第一指標、Buy & Hold は副指標
- 観測: 全 LLM コールを Langfuse、未補足例外を Sentry、業務イベントを Discord

## アーキテクチャ

判断パイプラインは **Tier 分離 + Analyst → Decision → Allocator → Critic → Risk → Executor** の多層構造。

```
┌─────────────────────────────────────────────────────────┐
│ Tier 0  情報収集    Perplexity (ニュース) / Grok (SNS)   │
│                     GMO public (OHLCV)                   │
├─────────────────────────────────────────────────────────┤
│ Tier 1  Pre-Analyst 軽量 LLM (Haiku 等)                  │
│                     要約・関連度・銘柄スクリーニング     │
├─────────────────────────────────────────────────────────┤
│ Tier 2  Analyst     重量 LLM (Opus / Sonnet / Gemini)    │
│                     Fundamental / Sentiment / Technical  │
│                     → Synthesis (方向性・確信度・根拠)   │
├─────────────────────────────────────────────────────────┤
│ Decision            Entry LLM / Exit LLM (銘柄ごと)      │
├─────────────────────────────────────────────────────────┤
│ Allocator           コード。Equal / Confidence Weighted  │
├─────────────────────────────────────────────────────────┤
│ Critic LLM          配分案を承認 / 拒否 / 修正           │
├─────────────────────────────────────────────────────────┤
│ Risk Clipper        コード。総投資率・銘柄上限の硬制約   │
├─────────────────────────────────────────────────────────┤
│ Executor            ペーパー台帳 (将来: GMO Private API) │
└─────────────────────────────────────────────────────────┘
```

各段の実装は [src/lib/](src/lib/) 配下に対応するディレクトリ (`tier0/`, `tier1/`, `decision/`, `allocator/`, `critic/`, `risk/`, `executor/`) として分かれている。

## 主要な設計判断

- **執行はコード、判断は LLM** — LLM に発注機能を持たせない (Function Calling での発注も禁止)。判断と執行の責任を物理的に分離し、LLM 暴走時の被害を限定する。
- **LLM 階層化 (Haiku → Sonnet / Opus)** — 20+ 銘柄を全て重量モデルに通すとコスト過大。軽量モデルで全銘柄スクリーニング → 通過分のみ重量モデル、というコスト/精度トレードオフ。Tier 1 の Skip 判定精度は初期は反事実検証のため記録のみ。
- **Analyst を Decision から分離** — 同一の市場見解を Entry / Exit で参照可能にし、Langfuse 上で「見解の質」と「判断の質」を独立評価する。
- **Critic + Risk Clipper の二段ガード** — LLM Critic が配分案の妥当性を判断 (柔軟だが確率的)、Risk Clipper がコードで硬制約 (確実だが硬直的)。LLM の暴走と限界の両方をカバー。
- **ALL-or-NOTHING** — 判断パイプラインのどの段でも失敗したらサイクル全体を中断 (フェイルクローズ)。「審査が抜けたまま売買が走る」事故を構造的に防ぐ。連続失敗で Kill Switch 発火。
- **paper-trade デフォルト** — `PAPER_TRADE=true` が既定値。実取引切替は環境変数の明示変更が必須。
- **Inngest による cron** — Vercel serverless の 60s timeout を回避しつつ、cron + リトライ + 観測を一元化。
- **Shadow Trading 対応設計** — 複数モデルに同一スナップショットを投げ、モデルごとに仮想ポジション台帳を別管理 (Phase 5c)。

## 技術スタック

- **Frontend / Runtime**: Next.js 16 (App Router, Turbopack) / React / TypeScript / Tailwind + shadcn/ui
- **データ層**: Supabase (Postgres + Auth) / Drizzle ORM
- **オーケストレーション**: Inngest (cron + retry)
- **LLM**: Anthropic Claude (Haiku / Sonnet / Opus) / Google Gemini / Perplexity / xAI Grok — Vercel AI SDK 経由
- **観測**: Langfuse (LLM trace + cost) / Sentry (例外) / Discord (業務通知)
- **品質**: Biome / Knip / Vitest / lefthook

## セットアップ

```bash
pnpm install
cp .env.example .env.local   # API キー等を埋める
pnpm db:local:migrate
pnpm dev
```

主要な開発スクリプトは [package.json](package.json) を参照。代表的なもの:

| コマンド | 用途 |
|---|---|
| `pnpm dev` | 開発サーバー |
| `pnpm test` | Vitest |
| `pnpm typecheck` | 型チェック |
| `pnpm db:local:migrate` | ローカル DB マイグレーション |
| `pnpm smoke:local:*` | 各 API クライアントの単発疎通確認 |
| `pnpm cycle:local:judgment` | 判断サイクルをローカルで 1 回実行 |
| `pnpm status:local` | サイクル稼働状況の確認 |

## 通知・運用

| 種別 | 経路 |
|---|---|
| 取引・サイクル系 (BUY/SELL/Critic/Kill Switch) | `notify()` → Discord webhook |
| 未補足エラー・例外 | Sentry → Discord (Sentry Dashboard で連携) |

エラー分類 ([src/lib/cycle/retry.ts](src/lib/cycle/retry.ts)):

- **transient** (5xx / 429 / timeout / overloaded) → 階層リトライで吸収
- **permanent** (401 / 403 / 400 / env 未設定) → 即 throw、サイクル失敗、🐛 通知
- **quota** (insufficient_quota / credit balance / 402) → 即 `system_state = paused`、💸 通知

同種エラー 3 連続で Kill Switch 発火 (自動 pause)。

## ドキュメント

- [要件定義 (docs/requirements.md)](docs/requirements.md) — 設計の正本
- [開発タスク (docs/todo.md)](docs/todo.md)
- [運用メモ (CLAUDE.md)](CLAUDE.md) — Claude Code との作業用メモ (エラー調査・デプロイフロー等)

## ライセンス

未設定 (公開はしているが再利用ライセンスは付与していない)。
