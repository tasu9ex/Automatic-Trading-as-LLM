# MVP タスク分解

最終更新: 2026-05-18

3 段階で進める:

- **Phase A**: 開発環境で各部品が動く (smoke test) ✅ **完了**
- **Phase B**: 開発環境/CLI で判定パイプライン全体が通しで動く ✅ **完了**
- **Phase C**: 本番(Vercel + Inngest + Supabase Cloud)にデプロイ、UI から運用開始 ✅ **ほぼ完了**

現状: 本番で 1h cron 稼働中。残作業は UI 操作系 (緊急停止 / 手動クローズ / 設定編集) と週次レポート。

## Phase A: 開発環境で各部品が動く

ゴール: 「**この環境で必要な外部サービス全てに繋がる**」を確認する smoke test 完了。

### A-1. リポジトリ・開発環境 ✅

- [x] Next.js (App Router) + TypeScript 初期化
- [x] Biome (lint/format) 設定
- [x] Knip (dead code) 設定
- [x] Vitest セットアップ (テスト基盤)
- [x] `.env.local` 雛形作成 (`.env.example` 含む)
- [x] ディレクトリ構造を確定 (`lib/`, `app/`, `db/`, `scripts/`)

### A-2. データベース (Supabase + Drizzle) ✅

- [x] Supabase プロジェクト作成 (Free) — ローカル Docker + Cloud 両方
- [x] Drizzle 初期セットアップ
- [x] スキーマ定義 (実際は **13 テーブル**: coins / market_snapshots / pre_analyst_outputs / analyst_outputs / decisions / orders / pending_orders / positions / trades / system_events / **portfolios** / **system_state** / **critic_outputs**)
- [x] マイグレーション実行 (RLS 付き、authenticated は SELECT のみ)
- [x] `coins` テーブルに **GMO 取引所形式 19 銘柄** の初期データ

### A-3. 外部 API 単発呼び出し確認 ⚠️ Gemini で代替

- [ ] **Anthropic API** — 意図的に未取得 (Gemini 無料枠で代替)
- [ ] **Perplexity API** — 同上、未設定なら "情報なし" フォールバック
- [ ] **Grok API** — 同上
- [x] **Gemini API**: `gemini-3.1-flash-lite` で全 LLM 段を実行 (`scripts/smoke/gemini.ts`)
- [x] **GMO Public API**: ticker / orderbook / trades / klines / symbols / status
- [x] **GMO Private API** (READ-ONLY): assets / latestExecutions (取引解禁時に書き込み追加予定)

### A-4. 観測・通知 ✅

- [x] **Langfuse**: アカウント作成、API キー取得、SDK 接続、OTel で trace 自動収集
- [x] **Sentry**: プロジェクト作成、Next.js 統合 (instrumentation.ts / instrumentation-client.ts)、Discord 連携 (beforeSend で forward)
- [x] **Discord Webhook**: 通常 / エラー 2 ch 分離 (`scripts/smoke/discord.ts`)

### A-5. プロンプト管理 ✅

- [x] Langfuse に 5 プロンプト登録 (production label):
  - `pre-analyst`, `analyst`, `entry-decision`, `exit-decision`, `critic`
- [x] SDK から取得・コンパイル動作確認 + コード fallback も実装

### Phase A 完了条件

- 全 smoke test スクリプトが個別に成功
- 各サービスの認証・接続が確認できた
- 「**動かない箇所を Phase B 開始前に潰す**」段階

---

## Phase B: 開発環境/CLI で判定パイプラインが通しで動く

ゴール: **`npm run cycle:judgment` 一発で 1 サイクル完走、DB に結果が入る**。

### B-1. データ取得層 (Tier 0) ✅

- [x] `lib/clients/perplexity.ts` / `lib/clients/grok.ts`: クライアント実装 (キー未設定なら throw → fetchSnapshot 側で "情報なし" フォールバック)
- [x] `lib/tier0/fetch-snapshot.ts`: 全ソースを `Promise.allSettled` で並列取得し、`market_snapshots` に保存
- [x] Langfuse OTel trace 自動取得

### B-2. Tier 1 (Pre-Analyst) ✅

- [x] `lib/tier1/pre-analyst.ts`: 軽量モデルで要約・スコア・skip_flag 生成
- [x] JSON スキーマ定義 (Zod)
- [x] `pre_analyst_outputs` に保存
- [x] パース失敗時のリトライ (generateJson が 1 回リトライ)
- [x] Langfuse トレース (`tier1.pre-analyst` feature)

### B-3. Tier 2 (Market Analyst) ✅

- [x] `lib/tier2/analyst.ts`: セクション別思考 (単一 LLM コール内で構造化)
- [x] JSON スキーマ定義 (Fundamental / Sentiment / Technical / Synthesis)
- [x] `analyst_outputs` に jsonb 保存
- [x] パース失敗時のリトライ
- [x] Langfuse トレース

### B-4. Decision Layer ✅

- [x] `lib/decision/entry.ts`: Entry Decision (buy/no + confidence)
- [x] `lib/decision/exit.ts`: Exit Decision (hold/close + confidence + reasoning)
- [x] ポジション状態の組み立てロジック (建値、含み損益、保有期間、Entry 理由、保有中最大含み益損)
- [x] `decisions` に保存
- [x] Langfuse トレース

### B-5. Portfolio Allocator (コード) ✅

- [x] `lib/allocator/index.ts`: Confidence Weighted + Equal Weight 計算
- [x] インターフェース型 (`SizingMethod` で切替、shadow 対応の拡張可能設計)
- [x] 現金残高・既存ポジションを考慮
- [x] ピラミッディング対応

### B-6. Critic LLM ✅

- [x] `lib/critic/index.ts`: 配分案レビュー
- [x] approve / veto / modify の 3 値出力
- [x] フェイルオープン実装
- [x] veto 時のスキップ + `system_events` 記録 + Discord 通知
- [x] Langfuse トレース

### B-7. Risk Clipper ✅

- [x] `lib/risk/clipper.ts`: ハードガード適用
- [x] 1 銘柄 25% 上限
- [x] 1 銘柄 5,000円 下限 (下回るとスキップ)
- [x] 総投資率 100% 上限
- [ ] パラメータ DB 駆動化 — 現状コード内定数、Phase D で設定ページ実装時に DB 化

### B-8. Executor (仮想台帳) ✅

- [x] `lib/executor/index.ts`: 仮想約定処理
- [x] 手数料控除 (`coins.taker_fee_rate`)
- [x] `orders` / `trades` / `positions` 更新
- [x] Entry 時に逆指値 3 本 (stop_limit_primary / stop_market_entry / stop_market_peak) を自動配置
- [x] Exit 時に該当 pending_orders を inactive 化

### B-9. 価格監視 (judgment cycle に統合) ✅

- [x] `lib/price-monitor/index.ts`: 1 分足 replay で逆指値タッチ判定 (since 引数で前回サイクル以降)
- [x] スリッページ 0.3% 控除
- [x] タッチ時の仮想決済 + Discord 通知
- [x] ピーク追跡 (`positions.peak_price` / `trough_price` 更新)
- 注: 独立 cron ではなく `runJudgmentCycle` 冒頭で実行する設計に変更
  (実マネー運用時 Phase E は GMO 側で動くので不要)

### B-10. Kill Switch ロジック ✅

- [x] `lib/kill-switch/index.ts`: 発動条件チェック (DD -50%、連続失敗 3 回)
- [x] 発動時の全クローズ
- [x] `system_state` テーブル管理 (running / killed)
- [x] Discord 緊急通知 (critical level)

### B-11. CLI ランナー

- [x] `scripts/cycle/judgment.ts`: 1 サイクル実行 (薄いラッパー、本体は `lib/cycle/judgment.ts`)
- [x] `scripts/dev/status.ts` (`pnpm status`): ポートフォリオ / open positions / 最近サイクル を colored CLI 表示
- [x] `scripts/dev/seed.ts`: 初期データ投入
- [x] `scripts/dev/sync-coins.ts`: GMO 銘柄同期
- [x] `scripts/dev/set-enabled-coins.ts`: 銘柄 enable 切替 (CLI 引数で指定可)
- [x] `scripts/dev/seed-positions-from-gmo.ts`: GMO 保有から仮想ポジション生成 (テスト用)
- [x] `scripts/dev/test-kill-switch.ts`: Kill switch 発動テスト
- [x] `scripts/dev/seed-auth-user.ts`: Supabase Admin API でユーザー seed
- [x] `scripts/langfuse/{register,verify,list-traces}.ts`: プロンプト管理 + trace 確認
- [ ] `scripts/cycle/weekly-report.ts`: 週次レポート — **未実装**
- [x] `npm run` スクリプト整備

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

- [x] レイアウト (モバイル想定の幅、シンプル)
- [x] **ダッシュボード** (`/`): stats grid (cash / realized P/L / total P/L / cycles today)、open positions、recent 20 cycles
- [x] **判断ログ** (`/cycles/[id]`): Critic + 銘柄別 Pre-Analyst / Analyst (4 セクション構造化) / Entry & Exit decisions
- [ ] **週次タブ**: スコアリング結果表示 — **未実装**
- [ ] **設定**: 銘柄パラメータ、Risk Clipper 閾値調整 — **未実装**
- [ ] **緊急停止ボタン**: Kill Switch 手動発動 — **未実装**
- [ ] **ポジション手動クローズ**: 個別決済 — **未実装**
- [ ] **起動・再開ボタン**: state 切替 — **未実装**
- [ ] **pending_orders 編集**: 逆指値手動変更 — **未実装**

### C-2. 認証 (Supabase Auth + GitHub OAuth + 事前 seed allowlist) ✅

- [x] Supabase Auth で GitHub プロバイダー有効化
- [x] GitHub OAuth App 作成 (Callback URL: `https://<project>.supabase.co/auth/v1/callback`)
- [x] 事前 seed allowlist:
  - `scripts/dev/seed-auth-user.ts` で Admin API ユーザー seed
  - Supabase Dashboard で新規 signup を Disable
  - OAuth ログイン時 email 一致で seed 済みユーザーに identity リンク
  - (要件にあった `AUTHORIZED_GITHUB_LOGINS` env 方式は採用せず、より堅牢な事前 seed 方式に)
- [x] Middleware (`src/middleware.ts`): 未ログインは `/login` リダイレクト、`/api/inngest` は除外
- [x] `/login` ページ
- [x] `/auth/callback` で OAuth コード → session 交換
- [x] RLS ポリシー: 全 13 テーブルで authenticated SELECT のみ、service_role はバイパス

### C-3. Inngest 統合 ✅

- [x] Inngest アカウント作成、Workspace 作成
- [x] Vercel Marketplace integration でキー自動注入
- [x] `app/api/inngest/route.ts`: Inngest endpoint
- [x] `lib/inngest/functions.ts`: `judgmentCron` (毎時 0 分 UTC、retries: 1)
- [x] step.run でラップ、Vercel Hobby 60 秒 timeout 内で完走
- [x] 自動リトライ + ジョブダッシュボード可視化

### C-4. スケジューラ (Inngest cron に統一)

- 設計変更: pg_cron / Supabase Edge Functions は不採用
- [x] Inngest cron `0 * * * *` (毎時、Phase 5a)
- [ ] Phase 5b で `0 0 * * *` に変更予定 (JST 9 時 = UTC 0 時、銘柄数を増やすタイミング)
- [ ] 週次レポート cron — **未実装**

### C-5. ~~Supabase Edge Functions~~ 不採用

- 設計変更: 価格監視は `runJudgmentCycle` 冒頭に統合、週次レポートは Inngest cron で対応予定

### C-6. Vercel デプロイ ✅

- [x] Vercel プロジェクト作成 (`automatic-trading-as-llm`)
- [x] GitHub Auto-deploy 接続 (`vercel git connect`)
- [x] 環境変数登録 (`scripts/dev/_push-vercel-env.sh` で一括 push)
- [x] Vercel Marketplace 経由で Inngest signing keys 自動注入
- [x] Pooler URL (Session mode, port 5432) で Vercel から Supabase Cloud 接続
- [x] デプロイ・動作確認 (`vercel --prod --yes`)
- [ ] カスタムドメイン (optional、未実施)
- [ ] Supabase Vault に GMO API キー — 現状 Vercel env vars、Phase E (実取引) で再検討

### C-7. 本番起動 ✅

- [x] 初期残高 ¥250,000 + 対象銘柄 BTC/ETH (Phase 5a で 2 銘柄、Phase 5b で全 19 銘柄に拡大)
- [x] Langfuse プロンプト 5 本を "production" ラベルで確定 (`pnpm langfuse:register` で `latest + production` 自動付与)
- [x] Inngest cron 毎時自動実行 (UI 起動ボタンは未実装、起動は cron + DB seed で完結)
- 🟡 24h 監視: 進行中
- 🟡 1 週間連続稼働: 進行中

### Phase C 完了条件

- [x] スマホから UI 開いて損益確認できる (`/`、`/cycles/[id]`)
- [ ] 1 週間以上のサイクル成功率 95%+ (運用中、Phase 5a)
- [ ] Phase 5b (利益検証) へ移行

### Phase C 残作業

- UI 操作系: 緊急停止 / 手動クローズ / 起動・再開 / pending_orders 編集 / 設定編集
- 週次レポート (`scripts/cycle/weekly-report.ts` + Inngest cron + UI 表示)
- カスタムドメイン (任意)

---

## Phase D 案: 観測強化 (運用しながら追加)

- 資産推移グラフ (recharts)
- LLM コスト集計ビュー (Langfuse 連携 or 独自集計)
- 銘柄管理 UI (現状は `pnpm tsx scripts/dev/set-enabled-coins.ts` CLI)
- システム起動・停止トグル (現状は cron 任せ、 Phase D で UI から制御)

## Phase E 案: 実マネー運用

- GMO 読み取り専用キーを書き込み権限キーに昇格 (or 別キー発行)
- `lib/clients/gmo-private.ts` に `placeOrder` / `cancelOrder` 等を追加 (現状 read-only)
- `executor` を仮想台帳更新 → GMO 発注に切替
- 価格監視を GMO 取引所側に委譲 (`runPriceMonitor` 廃止)
- 小額 (数千円) から段階的にスケール

---

## 全体タイムライン目安

| Phase | 計画 | 実績 |
|-------|------|------|
| A (開発環境セットアップ) | 1 週 | ✅ |
| B (パイプライン CLI 完走) | 2-3 週 | ✅ |
| C (本番デプロイ + UI 最小) | 1-2 週 | ✅ |
| **合計 MVP 構築** | **4-6 週** | **完了** |

現状の段階:
- **Phase 5a (システム検証、現在)**: 1h × 2 銘柄で 1-2 週稼働、安定性確認
- Phase 5b (利益検証): 1d × 全 19 銘柄に切替、4-12 週
- Phase 5c (モデル比較): Shadow trading 有効化、12 週+

## リスクと対策

| リスク | 対策 |
|-------|------|
| Deno 互換性で Edge Functions ハマる | Phase A-3 で先に動作確認、ダメなら Vercel Pro 切替検討 |
| LLM JSON パース失敗多発 | Zod スキーマ + 構造化出力 (response_format) を最初から使う |
| pg_cron がうまく動かない | Phase C-4 で先に hello world cron で確認 |
| Inngest Free 50k step 超過 | step 設計を粒度大きめに、価格監視は Inngest 経由しない |
| Vercel Hobby タイムアウト | Inngest step 分割で 10 秒制限を回避 |
