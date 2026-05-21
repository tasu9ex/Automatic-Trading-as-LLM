# TODO

ダッシュボード + サイクル / ビジネスロジックの監査結果。
カテゴリ別に整理。アルファベット記号 (A-SS) は調査時の発見順で、優先度は最後の表を参照。

---

## 0. 設計方針 (確定済)

### 0.1 Critic 必須化 (fail-open 廃止)

[phases.ts:744-799](../src/lib/cycle/phases.ts#L744-L799) の try/catch を撤廃し、Critic 失敗はサイクル中断扱いにする。

**Why**: Tier 0-3 は既に per-coin ALL-or-NOTHING (1 銘柄でも失敗 → サイクル全体 abort) のところ、Critic だけが fail-open で「審査抜きで売買発生」を許す非対称になっていた。これを ALL-or-NOTHING 原則に揃える。

**スコープ**:
- コード: `runCritic` の try/catch を外し、失敗を `runPhase` の catch に流す。`recordCycleFailure` 経由で `llm_failure` event + Discord 通知 + `consecutiveFailures++` の通常パスに乗る
- 要件ドキュメント: `docs/requirements.md` の §3.2 / §4.3.3.1 / §4.4.4 を更新済 (本 commit)
- `auto-skip` (buy 0 + exit 0 で Critic 呼び出し節約) は対象外 — 「審査対象が無い」ケースで売買も発生しないため

**トレードオフ**: Anthropic 障害でシステム全停止するが、transient 扱いなので復旧後の次サイクルで自動再開。

### 0.2 ALL-or-NOTHING 原則の明文化

要件 §3.2 に新規追加済。Tier 0-3 の per-coin、Critic、いずれの失敗もサイクル全体を中断する旨を明記。Exit のロット決済 "all-or-nothing" は別概念であることを注記。

---

## 1. 致命的バグ (即時対応)

### DD. 失敗 cycle の `cycles.completedAt` が永遠に NULL

[failure.ts:113-119](../src/lib/cycle/failure.ts#L113), [phases.ts:1034](../src/lib/cycle/phases.ts#L1034)

- `recordCycleFailure` は `system_events` 書き込みのみで `cycles.completedAt` を更新しない
- `completedAt` は `finalize` 成功時のみ set される
- 結果として失敗 cycle が dashboard で永遠に "実行中" バッジ表示 ([queries.ts:236](../src/lib/cycle/queries.ts#L236))、`isCycleInFlight` も誤って true に倒れて銘柄 toggle がブロックされる (10 分窓を抜けるまで)

**対策**: `recordCycleFailure` の末尾に
```ts
await db.update(cycles).set({ completedAt: new Date() }).where(eq(cycles.id, args.cycleId));
```

### EE. `finalize` が `state` を無条件で `"running"` に上書きする

[phases.ts:1012-1032](../src/lib/cycle/phases.ts#L1012-L1032)

- cycle 実行中にダッシュボードから「一時停止」を押しても、cycle 完了時に paused → running に巻き戻る
- ユーザーは止めたつもりが、次サイクル :00 cron で勝手に再開して売買が走る

**対策**: `state` を上書きせず、`consecutiveFailures` / `lastFailureKind` / `lastCycleId` / `lastCycleAt` だけ更新する

### FF. Kill Switch の close で `lastPrice <= 0` が silent skip

[kill-switch/index.ts:152-164](../src/lib/kill-switch/index.ts#L152-L164)

- DD 計算では 4 段フォールバック (ticker → snapshot → peak → avg) があるのに、close 実行段はフォールバック無し
- `getTicker` 失敗 / 空配列で対象銘柄を close せず silent で次へ進む
- 「kill switch 発動したのにポジションが残っている」状態になりうる

**対策**: DD 計算と同じフォールバックロジックを close 段でも使う + close 失敗時に critical 通知

### GG. Kill Switch close が逐次実行

[kill-switch/index.ts:150-176](../src/lib/kill-switch/index.ts#L150-L176)

- `for (const { coin } of open) { await getTicker(); await executeExit(); }`
- 緊急性が最も高い処理なのに N 銘柄あれば N × HTTP latency
- close 中に更に値動きするタイムウィンドウが広がる

**対策**: `Promise.all` で並列化、エラーは個別に collect して critical 通知

### V. `startSystem` / `pauseSystem` の TOCTOU レース

[system-control/index.ts:64-99](../src/lib/system-control/index.ts#L64-L99)

- Read row → check state → UPDATE の TOCTOU パターン
- 2 つのタブから同時押下で `system_events` に同種イベントが二重発火

**対策**: `UPDATE ... WHERE state IN (...) RETURNING *` に統一、row が無ければ「状態遷移不可」エラー

### K. TZ 指定漏れ (時刻が UTC で表示される)

[page.tsx:118,132,160](../src/app/page.tsx#L118), [cycles/[id]/page.tsx:100,101,252](../src/app/cycles/[id]/page.tsx#L100)

- `system-controls.tsx:133` だけ `timeZone: "Asia/Tokyo"` 指定、他は指定なし
- SSR で Vercel サーバ TZ (UTC) でフォーマット → JST 18:00 のサイクルが「09:00」表示

**対策**: 全 `toLocaleString` / `toLocaleDateString` に `timeZone: "Asia/Tokyo"` 指定、または共通フォーマッタ util

### L. 「本日のサイクル数」が UTC 起算

[queries.ts:80-81](../src/lib/cycle/queries.ts#L80-L81)

- `new Date().setHours(0,0,0,0)` を Vercel (UTC) で実行 → JST 9 時にリセットされる
- 真夜中に動いたサイクルが「本日」に入らない、または翌日のサイクルが入る

**対策**: `date-fns-tz` で JST 起算の境界を計算、または SQL の `AT TIME ZONE 'Asia/Tokyo'`

### N. `isCycleInFlight` の 10 分窓ヒューリスティック

[queries.ts:455-466](../src/lib/cycle/queries.ts#L455-L466)

- `completedAt IS NULL AND startedAt >= now()-10min`
- 10 分超でハングした cycle は UI 上「実行中じゃない」扱いに → 「サイクル実行中は銘柄変更不可」ガードが破れる
- DD と組み合わせると、失敗 cycle が永遠に 10 分窓に入らず "実行中" 扱いになる二重バグ

**対策**: `system_state.lastCycleStartedAt` ベース、または `cycles` に `status` カラム追加

### BB. Cycle 実行中の `pauseSystem` の整合性【調査完了、2 タスクに分割】

**調査結果**: 現サイクルは走り切る。
[functions.ts:69-104](../src/lib/inngest/functions.ts#L69-L104) で `state !== "running"` チェックは `preflight` step のみ。tier0-finalize step では再チェックしないので、ダッシュボードから「一時停止」を押しても押下後 ~5 分 (Tier 別 60s × 5 step) は cycle が走り続け、buy 注文が出る可能性がある。

#### BB-1. 通常 pause の挙動を UI で明示 【UX】

- ボタン押下時の確認ダイアログ or 状態表示で「現サイクルは完了まで走ります。停止は次サイクルから反映されます」を明示
- 「停止しました」表示が誤解を生まないようにする
- 工数: 小 (system-controls.tsx の confirm 文言 + state 表示の調整)

#### BB-2. 緊急 pause 機能の新規追加 【新機能】

- 通常 pause とは別の「緊急停止」ボタンを追加
- 押下時の挙動:
  - `system_state` に新フラグ (`emergency_stop boolean` または `state = 'emergency_paused'`) を立てる
  - 各 phase の冒頭 (`tier0Snapshots` / `tier1` / ... / `finalize`) で読んで、立っていたら phase throw → サイクル全体 abort
  - abort 後は `recordCycleFailure` 経路に乗せず、専用の `cycle_emergency_stopped` event を記録 (失敗とは別扱い、`consecutiveFailures` も増やさない)
- 工数: 中 (system_state schema 変更 + migration + phases.ts 各冒頭にチェック + UI 追加)
- 注意点:
  - Tier 0-2 で abort した場合 LLM コストは消費済み (受け入れる)
  - 部分実行されたデータ (snapshots / pre_analyst など) は DB に残る → 次サイクルで冪等性により skip 判定で活用される (これは既存の冪等パスで OK)
  - emergency stop 解除は手動 (UI の「再開」ボタン) で `state = paused` → 通常 pause と同じ流れに合流

---

## 2. ロジック / データ整合性

### II. `classifyError` がメッセージ文字列マッチに依存

[retry.ts:50-54](../src/lib/cycle/retry.ts#L50-L54)

- `\b400\b` のような正規表現で HTTP status を検出 → `400000ms timeout` で誤検知
- LLM プロバイダのエラーフォーマット変更で全分類が壊れる

**対策**: HTTP status を Error の属性 (`err.status`, `err.response?.status`) から拾う。文字列マッチは fallback として残す

### JJ. price-monitor 失敗時にサイクル続行

[phases.ts:101-113](../src/lib/cycle/phases.ts#L101-L113)

- 逆指値判定が落ちても通知だけ吐いて続行 = SL 監視抜きで売買続行
- 0.1 で Critic 必須化したのに price-monitor だけ fail-open は思想がズレる

**対策**: Critic 必須化と思想を揃えるなら price-monitor も必須化 (失敗 → サイクル中断)

### KK. `triggerAutoPauseDueToFailures` が `lastFailureKind` をクリアしない

[kill-switch/index.ts:218-233](../src/lib/kill-switch/index.ts#L218-L233)

- auto-pause 時に `consecutiveFailures: 0` リセットするが `lastFailureKind` は手付かず
- 再開後に異種エラーが来ても「同 kind 継続」と誤判定される

**対策**: `lastFailureKind: null` も同時にリセット

### LL. Critic に渡す `currentPositions` が price-monitor 反映前

[phases.ts:716-723](../src/lib/cycle/phases.ts#L716)

- `ctxs` は preflight 時点のスナップショット
- preflight 内 `runPriceMonitor` で SL 発動 → close されても ctxs は再構築されない
- Critic が「もう存在しない position」を保有中として判断する可能性

**対策**: `runPriceMonitor` 後に positions を再 fetch して ctxs に反映

### MM. DD 計算で `initial = 0` の NaN ガード無し

[kill-switch/index.ts:111](../src/lib/kill-switch/index.ts#L111)

- `ddRatio = (initial - totalValue) / initial` で `initial = 0` → NaN → kill switch 発動しない

**対策**: `if (initial <= 0) return false;`

### NN. Clipper の floor 多用で proposal 合計が縮む

[clipper.ts:43-44,53](../src/lib/risk/clipper.ts#L43)

- 端数切り捨てが連鎖して `totalCapRoom` に対して数 % 少なくなる → 現金が遊ぶ

**対策**: 最後の銘柄に端数を寄せる、または floor を round に

### OO. ~~`troughPrice` の更新が「ピラミ時のみ」~~ 【調査完了: 誤りだったので取り下げ】

[price-monitor/index.ts:155-163](../src/lib/price-monitor/index.ts#L155-L163) で `Math.min(troughPrice, recentLow)` で mark-to-market 更新されている。executor (ピラミ時) だけ見て誤判定していた。

`troughPnlJpy` は意味のある値で Exit decision に渡されている。修正不要。

### PP. Paper mode の placeOrder → fillOrder が非 atomic

[executor/index.ts:112-133](../src/lib/executor/index.ts#L112-L133)

- `placeOrder` 成功 + `fillOrder` 失敗 で `status=placed` のままの orphan order が残る
- 自動 cleanup なし

**対策**: paper mode のとき `place + fill` を 1 transaction にまとめる、または定期 worker で expire

### O. `setCoinEnabledAction` に input validation 無し

[coins.ts:23-37](../src/app/actions/coins.ts#L23-L37)

- 存在しない `coinId` でも UPDATE 成功扱い (rowCount 見ていない)

**対策**: `result.rowCount === 0` でエラー返す

### R. `updateTag` + `revalidatePath` を両方呼んでいる 【調査済み: 実機検証タスクに残す】

[coins.ts:30-31](../src/app/actions/coins.ts#L30-L31), [system-control.ts:34-35](../src/app/actions/system-control.ts#L34-L35)

**調査結果**:
- `page.tsx:16` で `export const dynamic = "force-dynamic"` 設定済 → Route Cache は無効
- `updateTag(DASHBOARD_CACHE_TAG)` で `unstable_cache` のタグ無効化は確実に動く
- `revalidatePath("/")` は Route Cache 無効状態では役割が限定的
- 理論上は `updateTag` のみで十分なはずだが、Next.js のバージョンと client Router Cache 挙動次第

**残タスク**: 実機で `revalidatePath` を一時的に外して動作確認 → 不要なら削除 + コメント追加。問題出るようなら両方残しつつ「なぜ両方必要か」をコメント明記

### W. 冪等パスで `system_events` が記録されない

[system-control/index.ts:43,69](../src/lib/system-control/index.ts#L43)

- すでに同じ状態なら早期 return → event 記録なし → 履歴が抜ける

**対策**: 冪等パスでも軽い no-op event を書く、または「すでに ◯◯ 状態です」を UI に出す

### SS. `expectedCloseCash` が「全 Exit 成功前提」

[phases.ts:674-682](../src/lib/cycle/phases.ts#L674)

- Allocator / Critic に渡す `projectedCashJpy` は全 Exit 成功前提
- Exit 一部失敗時、Critic は古い前提で判断 (Clipper 入力は refresh 済みなので最終的には吸収される)

**対策**: 致命的でないので低優先。気になるなら Critic 呼び出し直前に再計算

### HH. `auto-skip` Critic が UI で本物 approve と区別不能 (低優先)

- fail-open は 0.1 で廃止されるので消滅
- `auto-skip` (buy 0 + exit 0 節約) のみ残る、UI 上は区別したいなら別バッジ

---

## 3. パフォーマンス

### P-1. GMO `getTicker()` が `getOpenPositions` の内側で同期実行【最優先】

[queries.ts:171](../src/lib/cycle/queries.ts#L171)

- 30 秒 TTL の `unstable_cache` 内で外部 HTTP を待つ → ダッシュボード全体がブロック
- GMO レイテンシ 200ms〜2s

**対策**: ticker fetch を別の `unstable_cache` に切り出して並列化、または client side revalidate

### P-2. `getCycleDetail` がキャッシュされていない【最優先】

[queries.ts:290](../src/lib/cycle/queries.ts#L290)

- 完了済み cycle は immutable なのに毎回フル実行
- 戻る → 再度開く で毎回 DB 叩く

**対策**: `unstable_cache` でラップ。`completed_at` ありなら長 TTL、無しなら短 TTL の二段

### P-3. サイクル詳細の N+1 (銘柄ごと 3 クエリ)

[queries.ts:337-356](../src/lib/cycle/queries.ts#L337-L356)

- 5 銘柄なら 15 クエリ (preAnalyst + analyst + decisions)

**対策**: 1 つの JOIN クエリにまとめる (`market_snapshots LEFT JOIN ... LEFT JOIN ... LEFT JOIN decisions`)

### P-4. `COUNT(*)` フルスキャン × 2

[queries.ts:103-111](../src/lib/cycle/queries.ts#L103-L111)

- `cyclesTotal` (WHERE 無し) / `cyclesToday` (`created_at` index 未確認)

**対策**: counter カラム化、または `critic_outputs.created_at` index 追加

### P-5. `systemEvents` の JSONB 検索が unindexed

[queries.ts:309-319](../src/lib/cycle/queries.ts#L309-L319)

- `payload->>'cycleId' = $1` に index 無し → seq scan

**対策**: `(kind, (payload->>'cycleId'))` 部分 index、または `system_events.cycle_id` 直接カラム化

### M. 認証が二重に走っている

- middleware で `supabase.auth.getUser()`、page でも同じ呼び出し
- `if (!user) return null;` は middleware redirect により到達不能

**対策**: page 側の `getUser()` を削除、ユーザー情報が要るなら middleware で header 経由

### P-6. `dynamic = "force-dynamic"` + Supabase auth

[page.tsx:16,23-26](../src/app/page.tsx#L16-L26)

- `unstable_cache` の外なのでキャッシュ恩恵なし
- M の二重実行解消で副次的に改善

---

## 4. UX

### A. ローディング / ストリーミング無し

- `src/app/` 配下に `loading.tsx` 無し → コールド navigation で白画面

**対策**: `app/loading.tsx` + Suspense 境界の切り出し

### B. `window.confirm()` 多用

[system-controls.tsx:62,79](../src/components/dashboard/system-controls.tsx#L62), [risk-params.tsx:43](../src/components/dashboard/risk-params.tsx#L43)

**対策**: shadcn/ui の `Dialog` / `AlertDialog` に置き換え

### C. リアルタイム性無し

- `nextScheduledAt` 静的、サイクル開始 / 終了で UI が更新されない

**対策**: 30s ポーリング `router.refresh()` または Supabase Realtime / SSE

### D. 全銘柄が pending 中に disable される

[coin-checklist.tsx:79](../src/components/dashboard/coin-checklist.tsx#L79)

**対策**: 銘柄ごとに pending 状態を持つ、または `useOptimistic`

### E. 「保存中」フィードバックが弱い

**対策**: pending 中に spinner + "保存中..." テキスト

### F. GMO 失敗が silent (含み損益が見かけ上 0)

[queries.ts:174](../src/lib/cycle/queries.ts#L174)

**対策**: fetch 失敗フラグを返り値に含め、「価格取得失敗 (建値表示中)」バナー表示

### G. "最終更新" インジケータが無い

**対策**: キャッシュ生成時刻を返り値に含めて表示

### H. `recentCycles` の hard limit 20、ページング無し

[page.tsx:32](../src/app/page.tsx#L32)

**対策**: "もっと見る" ボタン、または `/cycles` 一覧ページ

### I. RiskParams / SystemControls に楽観更新なし

**対策**: `useOptimistic` で即時反映、失敗時のみロールバック

### J. Cycle 詳細はデフォルト全て閉じ + 全件 eager fetch

[cycles/[id]/page.tsx:185](../src/app/cycles/[id]/page.tsx#L185)

**対策**: default 展開状態を見直し、または銘柄ごとに lazy fetch

### S. 保有ポジションに含み損益が銘柄ごとに出ていない

[page.tsx:127-134](../src/app/page.tsx#L127-L134)

- `unrealizedPnlJpy` は計算済みなのに表示していない

**対策**: 銘柄行に `+¥1,234 (+2.3%)` 表示

### T. 「直近サイクル」表示の意味が曖昧

[page.tsx:117](../src/app/page.tsx#L117)

**対策**: 「最終完了」「最終開始」など明示

### Q. RiskParams の NaN / 空入力ケース

[risk-params.tsx:27-30](../src/components/dashboard/risk-params.tsx#L27-L30)

**対策**: クライアント側で空 / NaN なら disable + ヒント表示

### U. ログアウト機能が無い

- `signOut` / `logout` 不在、cookie 手動削除しか方法がない

**対策**: ヘッダーに「ログアウト」ボタン + `supabase.auth.signOut()`

### AA. cycle 詳細ページに `<title>` 反映なし

**対策**: `generateMetadata` で `サイクル {id.slice(0,8)} | LLM 自動売買`

---

## 5. セキュリティ・認証

### P (Sentry). Server action のエラーが Sentry に飛ばない

[coins.ts:34](../src/app/actions/coins.ts#L34), [system-control.ts:41](../src/app/actions/system-control.ts#L41)

- `console.error` のみ。CLAUDE.md の運用方針 (Sentry 経由) と矛盾

**対策**: `withResult` / catch 内に `Sentry.captureException(err)` を追加

### X. `/auth/callback` の `next` パラメータ検証無し

[auth/callback/route.ts:11,17](../src/app/auth/callback/route.ts#L11)

- 現状は文字列連結で外部 redirect は構造上できないが、将来 `new URL(next)` リファクタで穴になる

**対策**: `next.startsWith("/") && !next.startsWith("//")` ガード

### Y. `/login` の `?error=` 素通し表示

[login/page.tsx:9,35](../src/app/login/page.tsx#L9)

- 任意文字列を画面表示できる → phishing 文言注入 (XSS は React の escape で防げる)

**対策**: error コードを enum で受けて、固定メッセージにマッピング

### Z. `error.tsx` / `global-error.tsx` が production でも stack trace 表示 【Z + CC 統合】

[error.tsx:64-78](../src/app/error.tsx#L64-L78), [global-error.tsx:69-83](../src/app/global-error.tsx#L69-L83)

- 両方とも production で stack 露出 (CC の調査結果と統合)
- ファイルパス / バンドル構造が漏れる

**対策**: `NODE_ENV === "production"` で stack 非表示、digest のみ案内。両ファイル同時に適用

### CC. `global-error.tsx` の挙動確認【調査完了: Z と同じ問題、統合修正可】

[global-error.tsx](../src/app/global-error.tsx)

**調査結果**: error.tsx (Z) と同一構造。
- Sentry.captureException + console.error は OK
- error.message / digest / stack を画面表示 → **production でも stack 露出する** (Z と全く同じ)

**対策**: Z の修正 (`NODE_ENV === "production"` で stack 非表示) を `global-error.tsx` にも同時適用。両ファイル合わせて 1 タスク扱い

---

## 6. 整理 / 保守

### QQ. `positions.status` / `orders.status` の magic string 散在

- `"open"`, `"closed"`, `"placed"`, `"filled"`, `"expired"`, `"rejected"`, `"cancelled"` がリテラル散在

**対策**: `src/db/schema/enums.ts` に集約

### RR. (旧) fail-open Critic 中の systemHealth 無視

- 0.1 で fail-open 廃止により消滅
- `auto-skip` パスでは buy 0 + exit 0 なので systemHealth に意味なし → 対応不要

---

## 全体優先度サマリ

### Tier S: 最優先 (致命的バグ / データ事故防止)

| 順 | ID | 対策 | 工数 |
|---|---|---|---|
| 1 | DD | `cycles.completedAt` 更新漏れ修正 | 小 |
| 2 | EE | `state="running"` 上書き廃止 | 小 |
| 3 | FF | Kill Switch close フォールバック | 中 |
| 4 | GG | Kill Switch close 並列化 | 小 |
| 5 | 0.1 | Critic 必須化 (fail-open 廃止) | 中 |
| 6 | N | `isCycleInFlight` の窓判定見直し | 中 |
| 7 | K | TZ 指定追加 | 小 |
| 8 | L | `cyclesToday` の JST 起算化 | 小 |
| 9 | V | TOCTOU レース解消 | 中 |

### Tier A: 高優先 (ロジック整合性 / 主要パフォ)

| 順 | ID | 対策 | 工数 |
|---|---|---|---|
| 10 | P-1 | GMO ticker を `getOpenPositions` から分離 | 中 |
| 11 | P-2 | `getCycleDetail` を `unstable_cache` 化 | 小 |
| 12 | LL | Critic に渡す positions 鮮度 | 小 |
| 13 | KK | auto-pause で `lastFailureKind` リセット | 小 |
| 14 | II | `classifyError` を status code ベースに | 中 |
| 15 | MM | `initial = 0` ガード | 小 |
| 16 | JJ | price-monitor 失敗時の挙動再検討 | 中 |
| 17 | P (Sentry) | Server action → Sentry 送出 | 小 |
| 18 | U | ログアウト機能追加 | 小 |
| 19 | F | GMO 失敗バナー | 小 |
| 20 | BB-2 | 緊急 pause 機能の新規追加 (新機能) | 中 |

### Tier B: 中優先 (UX / セキュリティ / その他)

| 順 | ID | 対策 | 工数 |
|---|---|---|---|
| 21 | A | `loading.tsx` + Suspense | 小 |
| 22 | C | リアルタイム更新 | 中 |
| 23 | P-3 | サイクル詳細の N+1 を JOIN 化 | 中 |
| 24 | B | `window.confirm` → AlertDialog | 中 |
| 25 | M | 認証二重実行解消 | 中 |
| 26 | Y | `?error=` の enum 化 | 小 |
| 27 | BB-1 | 通常 pause の UI 文言明示 | 小 |
| 28 | X | `/auth/callback` next 検証 | 小 |
| 29 | Z | production で stack 非表示 (error.tsx + global-error.tsx 統合) | 小 |
| 30 | O | `setCoinEnabledAction` 検証 | 小 |
| 31 | PP | paper mode の place+fill atomic 化 | 小 |
| 32 | NN | Clipper floor の端数処理 | 小 |
| 33 | S | 含み損益銘柄ごと表示 | 小 |

### Tier C: 低優先 (整理 / 細部)

| 順 | ID | 対策 | 工数 |
|---|---|---|---|
| 34 | P-4 | `critic_outputs.created_at` index 追加 | 小 |
| 35 | P-5 | `system_events.cycle_id` 直接カラム化 | 中 |
| 36 | G | 「最終更新」表示 | 小 |
| 37 | D | 銘柄ごと pending | 小 |
| 38 | E | 保存中 spinner | 小 |
| 39 | I | 楽観更新 (RiskParams/SystemControls) | 中 |
| 40 | H | `recentCycles` ページング | 中 |
| 41 | J | Cycle 詳細の default 展開見直し | 小 |
| 42 | T | 「直近サイクル」ラベル明示 | 小 |
| 43 | Q | RiskParams 入力バリデーション | 小 |
| 44 | AA | cycle 詳細 `<title>` | 小 |
| 45 | R | `updateTag`/`revalidatePath` 実機検証 | 小 |
| 46 | W | 冪等パスの event 記録 | 小 |
| 47 | QQ | status magic string の enum 化 | 中 |
| 48 | SS | `expectedCloseCash` の前提見直し | 小 |
| 49 | HH | `auto-skip` の UI 区別 (任意) | 小 |

### 取り下げ (調査の結果対応不要)

| ID | 理由 |
|---|---|
| OO | `troughPrice` は price-monitor が mark-to-market 更新済み |
| CC | Z に統合 (両ファイル同一構造、同時修正) |
| RR | fail-open 廃止 (0.1) で消滅 |
