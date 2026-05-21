# CLAUDE.md

このリポで Claude (Claude Code) と作業するときの運用メモ。

## エラー調査

本番でエラー (`Something went wrong` / `digest: XXXXX` / サイクル中断通知) が出たら、まず **Sentry** を見る。

- Sentry Issues: digest と一致するイベントを開けば、stack trace 全文 / breadcrumbs / コンテキストが揃っている
- `error.tsx` / `global-error.tsx` で `Sentry.captureException()` を呼んでいるので、ブラウザ側で発生したエラーは Sentry に上がる
- サイクル中断は `recordCycleFailure` 経由で Discord 通知 + `system_events` 行 + Sentry にも上がるはず

順序:
1. **Sentry で event を開く** → message / stack / context を確認
2. 補足が欲しければ Inngest Cloud の Run History (サイクル系のみ)
3. それでも分からない時だけ `vercel logs <deployment-url> --json` でリアルタイム捕捉

Vercel CLI logs は "now から先" しか出ないので、過去のエラーには使えない。再現待ちが必要。

## デプロイフロー

1. `git push`(Vercel が deploy 開始)
2. **deploy 完了を待ってから** `pnpm db:prod:migrate` (新コードが空テーブルを触るのは無害、逆は落ちる)
3. ローカル確認は `pnpm db:local:migrate` + `pnpm dev`

## 環境変数

新規の API キーを追加するときは **両方** に入れる:
- ローカル: `.env.local`
- 本番: `vercel env add <NAME> production` → 再 deploy (空 commit でも push でも可)

`.env.production.local` は `pnpm db:prod:migrate` 用で、本番 Vercel が読むのは Vercel Env のみ。

## サイクル稼働の前提

1. `system_state.state = 'running'`(ダッシュボードから起動)
2. `coins.enabled = true` の銘柄が存在(ダッシュボードのチェックリスト)
3. **Inngest Cloud 側で function が Resume 状態**(これは UI から制御不可、Inngest Cloud で操作)
4. `next_scheduled_at` が現在以前

どれか欠けると毎時 :00 cron が skip される。

## リトライ戦略

エラー分類は `src/lib/cycle/retry.ts` の `classifyError`:
- **transient** (5xx / 429 / timeout / overloaded) → 階層リトライで吸収
- **permanent** (401 / 403 / 400 / env 未設定 / x-api-key 系) → 即 throw、サイクル失敗、Discord 🐛 通知
- **quota** (insufficient_quota / credit balance / 402) → 即 `system_state = paused`、Discord 💸 通知

`consecutiveFailures` は **同じ kind が続く間だけカウント**(異種が来たら 1 にリセット)。3 連続で kill-switch。

## ダッシュボードキャッシュ

`src/lib/cycle/queries.ts` の各クエリは `unstable_cache` で 30 秒 TTL + tag `dashboard`。
手動操作 (start / pause / 銘柄 toggle) の server action で `updateTag("dashboard")` を呼んで即時無効化。

`unstable_cache` を経由すると Date が JSON 化されて文字列になるので、ラッパーで `reviveDate()` を通すこと。Date 型を返すクエリを追加したら同じパターンを忘れない。

## マイグレーション

スキーマ変更:
1. `src/db/schema/*.ts` を編集
2. `pnpm db:generate` で migration 自動生成
3. RLS が必要な新テーブルなら migration の末尾に `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` + `CREATE POLICY ...` を手で追記
4. `pnpm db:local:migrate`(ローカル)→ コミット → push → `pnpm db:prod:migrate`(本番)

## 関連 ドキュメント

- `docs/requirements.md` — 設計要件
- `docs/todo.md` — 開発タスク
