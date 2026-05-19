# TODO

最終更新: 2026-05-19

このファイルは旧 `docs/mvp-tasks.md` を引き継いだ「現役の作業リスト」です。
Phase A/B/C は構築完了済み、現在は Phase 5a (ペーパー検証) 進行中。

---

## ✅ 構築完了 (Phase A/B/C)

### Phase A: 開発環境セットアップ

- Next.js 16 + TypeScript + Biome + Knip + Vitest + lefthook
- Supabase Cloud + Drizzle (13 テーブル、RLS 設定済み)
- 外部 API smoke test: GMO / Gemini / Claude / Grok / Perplexity / Langfuse / Sentry / Discord (2ch)
- Langfuse プロンプト 7 本登録 (tier0/news, tier0/sentiment, tier1/pre-analyst, tier2/analyst, tier3/entry, tier3/exit, tier4/critic)

### Phase B: 判定パイプライン CLI 完走

- Tier 0 fetchSnapshot (Perplexity ニュース + Grok センチメント + GMO 価格)
- Tier 1 Pre-Analyst (Haiku) + skip_flag 尊重ロジック
- Tier 2 Analyst (Opus、4 セクション構造化)
- Tier 3 Entry/Exit Decision (Sonnet)
- Tier 4 Critic (Opus、approve/veto/modify)
- Allocator + Risk Clipper + Executor (仮想台帳)
- Kill Switch (DD -50% / 連続失敗 3)
- price-monitor を runJudgmentCycle 冒頭に統合 (since 引数で前回サイクル以降の 1m バー replay)

### Phase C: 本番デプロイ + UI

- Vercel デプロイ + GitHub auto-deploy
- Supabase Cloud Pooler 接続
- Inngest Cloud cron (1h、Marketplace 統合)
- 認証: Supabase Auth + GitHub OAuth + 事前 seed allowlist (signups 無効化)
- ダッシュボード (`/`、`/cycles/[id]`) — stats / open positions / recent cycles / Tier 別判断詳細
- 全 UI 日本語化、Discord 通知日本語化
- `pnpm status` CLI

---

## 🔁 進行中: Phase 5a プロンプト改善ループ

### モデル構成
- Tier 0 News: Perplexity sonar
- Tier 0 Sentiment: Grok-4.3 + x_search/web_search ツール
- Tier 1 Pre-Analyst: Claude Haiku 4.5
- Tier 2 Analyst: Claude Opus 4.7
- Tier 3 Entry/Exit: Claude Sonnet 4.6
- Tier 4 Critic: Claude Opus 4.7
- 月コスト想定 ~¥9-18k (skip_flag 効率次第)

### プロンプト改善タスク
- [ ] **Tier 2 Analyst** — 4 セクション (Fundamental/Sentiment/Technical/Synthesis) 出力の質と指示明確性
- [ ] **Tier 3 Entry** — Buy/No の閾値、確信度の calibration
- [ ] **Tier 3 Exit** — Hold/Close 判断の anchor 回避、保有期間考慮
- [ ] **Tier 4 Critic** — 配分案のチェック基準を明確化
- [ ] **Tier 1 Pre-Analyst** — skip_flag の精度向上
- [ ] **Tier 0 News/Sentiment** — クエリ最適化

### 通知改善
- [ ] Discord サイクル完了通知の情報量 (現在最小限) を増やすか検討
  - 候補: 上位 Buy シグナル銘柄、Critic 拒否時の理由
- [ ] Critic VETO/MODIFY 時の本文に詳細を入れる
- [ ] ポジション開閉時の損益サマリ強化

### 検討中 (現状日本語維持)
- [ ] **Tier 0 プロンプトを英語化**
  - 理由: Perplexity / Grok は英語訓練が主流、指示理解と検索クエリ品質が上がる可能性
  - 案 A: 指示は英語、出力は日本語指定 (ハイブリッド)
  - 案 B: 指示も出力も英語のまま、Tier 1 が英語→日本語に整理して消費
  - 当面は保守性優先で日本語維持、ペーパー運用で品質が物足りなければ切替

### 改善ループの進め方
1. プロンプト編集 (`tier{N}/shared-prompt.ts`)
2. ローカル `pnpm cycle:judgment` (BTC 1 銘柄) で実行
3. ダッシュボード `/cycles/[id]` + Langfuse trace で出力確認
4. DB に保存された snapshot/analyst/decision を `pnpm status` 等で検証
5. 改善必要なら 1 に戻る、満足なら次の Tier へ

---

## 📋 Phase 5a 締めて Phase 5b 移行前

- [ ] `pnpm langfuse:register` で調整済みプロンプトを production label に
- [ ] 本番 DB で 19 銘柄全部 enable (`set-enabled-coins.ts -- 全銘柄`)
- [ ] 数サイクル本番自動稼働を監視 (Discord 通知 + Inngest dashboard)
- [ ] 1〜2 週間のデータ蓄積

---

## 🚀 Phase 5b: 1d × 19 銘柄 本格稼働

- [ ] Inngest cron を `0 * * * *` → `0 0 * * *` (UTC 0 時 = JST 朝 9 時) に変更
- [ ] Prompt caching 有効化 (Anthropic SDK の `cache_control` を Tier 2 system prompt に)
  - Opus 入力単価 $15 → $1.50 (90% OFF)、月コスト数千円減
- [ ] 4-12 週間運用、PnL / Sharpe / 最大 DD 観測
- [ ] **損益分岐資本の逆算** — 観測リターン率から「実マネーで何 ¥ 投入が経済合理的か」算出
- [ ] 週次レポート生成スクリプト (`scripts/cycle/weekly-report.ts`) + Discord 送信

---

## ⏳ Phase 5c: モデル比較 (Shadow Trading)

- [ ] Tier 2 で Opus と Gemini Pro / GPT-5 を並列実行
- [ ] モデルごとに独立した portfolio で PnL 比較
- [ ] 配分手法 (Equal Weight vs Confidence Weighted) も並列
- [ ] 統計的有意な差が出るまで 12 週+

---

## 🟢 Phase 5d/5e: 実マネー β → 本格運用

### β 段階 (¥500k 〜 ¥1M、慎重に)
- [ ] GMO Private API に書き込みエンドポイント実装 (`POST /v1/order` etc.)
- [ ] read-only key → 書き込み権限 key に切替 (環境変数で分離管理)
- [ ] `executor` をペーパー → 実発注に切替 (`PAPER_TRADE=false` フラグ)
- [ ] 価格監視 (`runPriceMonitor`) を実発注フェーズで除去 — GMO 取引所側 SL を信頼
- [ ] 小額で実取引、システム信頼性確認

### 本格運用 (¥2-5M 以上、戦略の経済性確認後)
- [ ] Kill Switch 閾値を本番値で締め直し (DD -30% など慎重に)
- [ ] Sentry エラー監視強化
- [ ] 24/7 安定稼働

---

## 📦 任意 (優先度低)

- [ ] UI 操作系 (緊急停止 / 手動クローズ / 銘柄enable切替) — 現状 CLI のみ
- [ ] 資産推移チャート (recharts)
- [ ] LLM コスト集計ビュー (Langfuse 連携 or 独自集計)
- [ ] カスタムドメイン (vercel.app から自前ドメインへ)
- [ ] Supabase Vault に GMO API キー移行 (実取引フェーズで)

---

## 🔧 設計変更で不採用 (歴史)

| 当初計画 | 実装 |
|---|---|
| pg_cron | Inngest cron に一本化 |
| Supabase Edge Functions (price-monitor) | runJudgmentCycle 冒頭に統合 |
| AUTHORIZED_GITHUB_LOGINS env | Admin API 事前 seed + signups 無効化に変更 |
| サイクル 1d 一本 | Phase 5a で 1h、Phase 5b で 1d に切替 |
