# Automatic Trading as LLM

LLM 駆動の仮想通貨自動売買システム (個人運用、ペーパートレード MVP)。

## ドキュメント

- [要件定義](docs/requirements.md)
- [TODO / 進行中タスク](docs/todo.md)

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
  app/          Next.js App Router (page / cycles / actions / api/inngest)
  components/   UI コンポーネント (dashboard / ui)
  db/           Drizzle スキーマ・クライアント
  lib/
    tier0/      情報収集 (Perplexity, Grok, GMO public)
    tier1/      Pre-Analyst (Haiku 要約)
    tier2/      Analyst (Opus 分析)
    decision/   Entry/Exit 判定 (Sonnet)
    allocator/  Portfolio Allocator
    critic/     Critic LLM
    risk/       Risk Clipper
    executor/   約定 (paper / real)
    price-monitor/ 逆指値タッチ判定 (paper-trade のみ、§14 で実取引切替時に移行)
    kill-switch/   システム停止
    cycle/      パイプライン (phases / failure / system-health / queries / retry)
    constants/  リスク閾値の単一ソース (risk.ts)
    schemas/    LLM 出力 / SystemHealth zod スキーマ
    prompts/    Langfuse + fallback プロンプト
    clients/    各 API クライアント
scripts/
  smoke/        各 API 単発呼び出し確認
  langfuse/     プロンプト登録・検証
  dev/          シード・各種開発用
src/lib/cycle/retry.test.ts などのインライン Vitest テスト
```

## 技術スタック

Next.js 16 (App Router, Turbopack) / TypeScript / Tailwind + shadcn/ui / Supabase /
Drizzle / Inngest / Langfuse / Sentry / Biome / Knip / Vitest

## 通知設計

Discord 1 チャンネル垂れ流し:

| 種別 | 経路 |
|------|------|
| 取引・サイクル系 (BUY/SELL/Critic/Kill Switch) | `notify()` → Discord webhook |
| 未補足エラー・例外 | Sentry → Discord (Sentry Dashboard で連携) |

### Sentry → Discord 連携手順 (Sentry Dashboard 側、5 分)

1. Sentry にログイン → 対象プロジェクト選択
2. **Settings → Integrations → Discord** で `Add to Project`
3. Discord OAuth で自分のサーバー・チャンネルを許可
4. **Alerts → Create Alert Rule**
   - Condition: `An issue is first seen` (新規エラー時)
   - Action: `Send a notification via Discord` → 通知先チャンネルを選択
5. 必要なら `Issue is frequent` (繰り返しエラー閾値) ルールも追加

これで:
- `notify()` → 業務イベント (取引・判定結果) を Discord に直接送信
- Sentry → 未補足エラーの詳細を保存、サマリを Discord に転送(stack trace は Sentry リンクで)
