# MVP タスク分解

3 段階で進める:

- **Phase A**: 開発環境で各部品が動く (smoke test)
- **Phase B**: 開発環境/CLI で判定パイプライン全体が通しで動く
- **Phase C**: 本番(Vercel + Supabase + Inngest)にデプロイ、UI から運用開始

## Phase A: 開発環境で各部品が動く

ゴール: 「**この環境で必要な外部サービス全てに繋がる**」を確認する smoke test 完了。

### A-1. リポジトリ・開発環境

- [ ] Next.js (App Router) + TypeScript 初期化
- [ ] Biome (lint/format) 設定
- [ ] Knip (dead code) 設定
- [ ] Vitest セットアップ (テスト基盤)
- [ ] `.env.local` 雛形作成 (`.env.example` 含む)
- [ ] ディレクトリ構造を確定 (`lib/`, `app/`, `db/`, `scripts/`)

### A-2. データベース (Supabase + Drizzle)

- [ ] Supabase プロジェクト作成 (Free)
- [ ] Drizzle 初期セットアップ
- [ ] スキーマ定義 (10 テーブル: coins / market_snapshots / pre_analyst_outputs / analyst_outputs / decisions / orders / pending_orders / positions / trades / system_events)
- [ ] マイグレーション実行
- [ ] `coins` テーブルに **GMO 取引所形式 全銘柄 (20+)** の初期データ (手数料率・最小注文量含む)

### A-3. 外部 API 単発呼び出し確認

- [ ] **Anthropic API**: Haiku で hello world (`scripts/smoke/anthropic.ts`)
- [ ] **Anthropic API**: Opus で hello world
- [ ] **Perplexity API**: 「BTC の過去24hニュース」を取得 (`scripts/smoke/perplexity.ts`)
- [ ] **Grok API**: 「$BTC の X 過去24hセンチメント」を取得 (`scripts/smoke/grok.ts`)
- [ ] **GMO API**: 現在価格取得 (`scripts/smoke/gmo.ts`)
- [ ] **GMO API**: 1分足 / 日足取得
- [ ] **GMO API**: 取引所形式の対応銘柄リスト取得

### A-4. 観測・通知

- [ ] **Langfuse**: アカウント作成、API キー取得、SDK 接続、テストトレース送信
- [ ] **Sentry**: プロジェクト作成、Next.js 統合、テストエラー送信確認
- [ ] **Discord Webhook**: チャンネル作成、Embed 投稿テスト (`scripts/smoke/discord.ts`)

### A-5. プロンプト管理

- [ ] Langfuse に初期プロンプト登録:
  - `pre-analyst` (Tier 1 用、銘柄スクリーニング)
  - `analyst` (Tier 2 用、銘柄ごとの構造化分析。最初は全銘柄共通、Phase 5b 以降で銘柄別に分岐)
  - `entry-decision` / `exit-decision`
  - `critic`
- [ ] SDK から取得・コンパイル動作確認

### Phase A 完了条件

- 全 smoke test スクリプトが個別に成功
- 各サービスの認証・接続が確認できた
- 「**動かない箇所を Phase B 開始前に潰す**」段階

---

## Phase B: 開発環境/CLI で判定パイプラインが通しで動く

ゴール: **`npm run cycle:judgment` 一発で 1 サイクル完走、DB に結果が入る**。

### B-1. データ取得層 (Tier 0)

- [ ] `lib/tier0/perplexity.ts`: ニュース取得関数
- [ ] `lib/tier0/grok.ts`: X センチメント取得関数
- [ ] 取得結果を `market_snapshots` に保存
- [ ] 並列実行 (Promise.all)
- [ ] エラー時の前サイクル結果再利用ロジック
- [ ] Langfuse トレース埋め込み

### B-2. Tier 1 (Pre-Analyst)

- [ ] `lib/tier1/pre-analyst.ts`: Haiku で要約・スコア・skip_flag 生成
- [ ] JSON スキーマ定義 (Zod)
- [ ] `pre_analyst_outputs` に保存
- [ ] パース失敗時のリトライ
- [ ] Langfuse トレース

### B-3. Tier 2 (Market Analyst)

- [ ] `lib/tier2/analyst.ts`: Opus でセクション別思考
- [ ] JSON スキーマ定義 (Fundamental / Sentiment / Technical / Synthesis)
- [ ] `analyst_outputs` に保存
- [ ] パース失敗時のリトライ
- [ ] Langfuse トレース

### B-4. Decision Layer

- [ ] `lib/decision/entry.ts`: Entry Decision (見解 → Buy/No + 確信度)
- [ ] `lib/decision/exit.ts`: Exit Decision (見解 + ポジ状態 → Hold/Close + 確信度)
- [ ] ポジション状態の組み立てロジック (建値、含み損益、保有期間、Entry 理由、保有中最大含み益損)
- [ ] `decisions` に保存
- [ ] Langfuse トレース

### B-5. Portfolio Allocator (コード)

- [ ] `lib/allocator/index.ts`: Confidence Weighted 計算
- [ ] インターフェース型: `Allocator[]` 拡張可能設計 (shadow 対応)
- [ ] 現金残高・既存ポジションを考慮
- [ ] ピラミッディング対応 (同銘柄追加購入)

### B-6. Critic LLM

- [ ] `lib/critic/index.ts`: 配分案レビュー
- [ ] approve / veto / modify の 3 値出力
- [ ] フェイルオープン実装 (API エラー時は配分案そのまま採用)
- [ ] veto 時の該当モデルスキップ
- [ ] `system_events` に拒否理由保存
- [ ] Langfuse トレース

### B-7. Risk Clipper

- [ ] `lib/risk/clipper.ts`: ハードガード適用
- [ ] **1 銘柄 25% 上限** (20+ 銘柄想定で集中防止)
- [ ] **1 銘柄 5,000円 下限** (最小発注、下回るとスキップ)
- [ ] 総投資率 100% 上限
- [ ] パラメータ DB 駆動化 (`coins` テーブル or 設定テーブル)

### B-8. Executor (仮想台帳)

- [ ] `lib/executor/index.ts`: 仮想約定処理
- [ ] 手数料控除 (`coins.taker_fee_rate`)
- [ ] `orders` / `trades` / `positions` 更新
- [ ] Entry 時に逆指値を `pending_orders` に自動配置 (建値 × 0.65、ピーク監視は別途)
- [ ] Exit 時に該当 pending_orders キャンセル

### B-9. 価格監視ループ

- [ ] `lib/price-monitor/index.ts`: 1 分足取得、pending_orders タッチ判定
- [ ] スリッページ 0.3% 控除
- [ ] タッチ時の仮想決済 + Discord 通知
- [ ] ピーク追跡 (`positions` に peak_price 更新)

### B-10. Kill Switch ロジック

- [ ] `lib/kill-switch/index.ts`: 発動条件チェック (DD -50%、連続失敗 3 回、約定失敗連発)
- [ ] 発動時の全クローズ
- [ ] `state` テーブル管理 (running / killed)
- [ ] Discord 緊急通知

### B-11. CLI ランナー

- [ ] `scripts/cycle/judgment.ts`: 1 サイクル実行
- [ ] `scripts/cycle/price-monitor.ts`: 価格監視 1 回実行
- [ ] `scripts/cycle/weekly-report.ts`: 週次レポート生成
- [ ] `scripts/dev/seed.ts`: 初期データ投入 (初期残高 25万)
- [ ] `npm run` スクリプト整備

### Phase B 完了条件

- `npm run cycle:judgment` でエラーなく完走
- DB に 1 サイクル分のデータが入る (market_snapshots, analyst_outputs, decisions, orders, positions, trades)
- Discord に通知が来る
- Langfuse にトレースが残る
- Sentry にエラーが上がらない (or 想定範囲内)
- 10 回連続実行しても安定

---

## Phase C: 本番デプロイ + UI

ゴール: **Vercel にデプロイ、UI からスマホで運用開始、24/7 自動運用稼働**。

### C-1. UI 実装 (Next.js App Router)

- [ ] レイアウト・ナビ (モバイルファースト)
- [ ] **ダッシュボード**: 損益・ポジション・取引履歴
- [ ] **判断ログ**: Langfuse 埋め込み or 独自ビュー
- [ ] **週次タブ**: スコアリング結果表示
- [ ] **設定**: 銘柄パラメータ、Risk Clipper 閾値調整
- [ ] **緊急停止ボタン**: Kill Switch 手動発動
- [ ] **ポジション手動クローズ**: 個別決済
- [ ] **起動・再開ボタン**: state 切替
- [ ] **pending_orders 編集**: 逆指値手動変更

### C-2. 認証 (Supabase Auth + GitHub OAuth)

- [ ] Supabase Auth で GitHub プロバイダー有効化
- [ ] GitHub OAuth App 作成 (Settings → Developer settings → OAuth Apps)
  - Callback URL: `https://<project>.supabase.co/auth/v1/callback`
- [ ] `AUTHORIZED_GITHUB_LOGINS` env (カンマ区切り、例: `tasu9ex`)
- [ ] Middleware で全ページ保護:
  - 未ログイン → `/login` リダイレクト
  - ログイン済みだが `user_metadata.user_name` が許可リストにない → 403
- [ ] `/login` ページ (GitHub ログインボタンのみ)
- [ ] サインアップ無効化 (Magic Link / Email/Password を Supabase Dashboard で OFF)

### C-3. Inngest 統合

- [ ] Inngest アカウント作成、プロジェクト登録
- [ ] `app/api/inngest/route.ts`: Inngest endpoint
- [ ] `lib/inngest/functions.ts`: 判定サイクル関数
- [ ] step 分割 (Vercel Hobby 10 秒制限対応)
- [ ] 自動リトライ・並列度設定

### C-4. スケジューラ (Supabase pg_cron)

- [ ] pg_cron extension 有効化
- [ ] **JST 朝 9:00 (UTC 0:00)**: Inngest event 発火 (judgment、1日1回)
- [ ] 1min ごと: Edge Function 呼び出し (price monitor)
- [ ] 週 1: 週次レポート

### C-5. Supabase Edge Functions

- [ ] `supabase/functions/price-monitor`: 1 分足 + pending_orders 監視
- [ ] `supabase/functions/weekly-report`: 集計
- [ ] Deno 互換性確認 (Anthropic SDK、Drizzle 等)
- [ ] 共通ロジックを `lib/shared/` に分離 (Next.js / Deno 両用)

### C-6. Vercel デプロイ

- [ ] Vercel プロジェクト作成
- [ ] 環境変数登録 (API キー類、Supabase 接続、Inngest signing key 等)
- [ ] Supabase Vault に GMO API キー登録 (将来本番取引時用)
- [ ] デプロイ・動作確認
- [ ] カスタムドメイン (optional)

### C-7. 本番起動

- [ ] UI から初期残高 ¥250,000 + 対象銘柄 (GMO 取引所形式 全 20+ 銘柄) 登録
- [ ] Langfuse プロンプトを "production" ラベルで確定
- [ ] UI 「システム起動」ボタンで運用開始
- [ ] 24h 監視: エラー発生・コスト・成績
- [ ] 1 週間連続稼働を確認

### Phase C 完了条件

- スマホから UI 開いて損益確認できる
- 1 週間以上のサイクル成功率 95%+
- Phase 5b (利益検証) へ移行

---

## 全体タイムライン目安

| Phase | 期間 |
|-------|------|
| A (開発環境セットアップ) | 1 週 |
| B (パイプライン CLI 完走) | 2-3 週 |
| C (本番デプロイ + UI) | 1-2 週 |
| **合計 MVP 構築** | **4-6 週** |

その後:
- Phase 5a (システム検証) 1-2 週
- Phase 5b (利益検証) 4-12 週
- Phase 5c (モデル比較) 12 週+

## リスクと対策

| リスク | 対策 |
|-------|------|
| Deno 互換性で Edge Functions ハマる | Phase A-3 で先に動作確認、ダメなら Vercel Pro 切替検討 |
| LLM JSON パース失敗多発 | Zod スキーマ + 構造化出力 (response_format) を最初から使う |
| pg_cron がうまく動かない | Phase C-4 で先に hello world cron で確認 |
| Inngest Free 50k step 超過 | step 設計を粒度大きめに、価格監視は Inngest 経由しない |
| Vercel Hobby タイムアウト | Inngest step 分割で 10 秒制限を回避 |
