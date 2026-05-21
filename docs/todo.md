# TODO — ダッシュボード + ビジネスロジック監査

ダッシュボード + サイクル / ビジネスロジックの監査結果を **5 phase に分割**。
各 phase 完了で 1 commit (= 1 Tier 単位)。**本番 push は全 phase 完了後に一括**。

タスク数: 53 (Tier S/A/B/C = 49 + Phase 5 リファクタ 4、取り下げ 3 除く)

---

## 設計方針 (確定済)

要件ドキュメント (`docs/requirements.md`) は前 commit で更新済。実装はこの方針に従う。

### 0.1 Critic 必須化 (fail-open 廃止)

Tier 0-3 は既に per-coin ALL-or-NOTHING (1 銘柄でも失敗 → サイクル全体 abort) のところ、Critic だけが fail-open で「審査抜きで売買発生」を許す非対称になっていた。これを ALL-or-NOTHING 原則に揃える。

[phases.ts:744-799](../src/lib/cycle/phases.ts#L744-L799) の try/catch を撤廃し、Critic 失敗は通常の failure path (`recordCycleFailure` 経由) に乗せる。実装は Phase 1 に含む。

### 0.2 ALL-or-NOTHING 原則の明文化

要件 §3.2 に新規追加済。Tier 0-3 / Critic いずれの失敗もサイクル全体を中断する。Exit のロット決済 "all-or-nothing" は別概念。

### 0.3 二段階 pause (通常 + 緊急)

- **通常 pause** (現状): state=paused → 現サイクル走り切り → 次サイクルから停止 (UI で挙動明示が必要、BB-1)
- **緊急 pause** (新機能): phase 冒頭で state チェック → サイクル中断 (BB-2、Phase 2 で実装)

### 取り下げタスク (調査の結果対応不要)

| ID | 理由 |
|---|---|
| OO | `troughPrice` は price-monitor が mark-to-market 更新済み (私の調査ミス) |
| CC | Z に統合 (両ファイル同一構造、同時修正で済む) |
| RR | 0.1 (fail-open 廃止) で消滅 |

---

## Phase 1: 致命的バグ修正 (Tier S、9 タスク)

**目的**: データ事故 / pause 機能不全 / DD (drawdown) 計算の見逃しを解消。完了で「最低限の事故予防」が成立。

**主要ファイル**: `cycle/failure.ts`, `cycle/phases.ts`, `kill-switch/index.ts`, `system-control/index.ts`, `cycle/queries.ts`, dashboard pages

### Phase 1 タスク

| # | ID | 対策 | 工数 |
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

### Phase 1 詳細

#### DD. 失敗 cycle の `cycles.completedAt` が永遠に NULL

[failure.ts:113-119](../src/lib/cycle/failure.ts#L113), [phases.ts:1034](../src/lib/cycle/phases.ts#L1034)

`recordCycleFailure` は `system_events` 書き込みのみで `cycles.completedAt` を更新しない。`completedAt` は `finalize` 成功時のみ set される。

**影響**:
- dashboard の `getRecentCyclesImpl` の判定 `cycle.completedAt ? "failed" : "in_flight"` で失敗 cycle が永遠に "実行中" バッジ表示
- `isCycleInFlight` も `completedAt IS NULL` を見るので、過去の失敗 cycle が「実行中」扱いになり銘柄 toggle がブロックされる

**対策**: `recordCycleFailure` の末尾に
```ts
await db.update(cycles).set({ completedAt: new Date() }).where(eq(cycles.id, args.cycleId));
```

#### EE. `finalize` が `state` を無条件で `"running"` に上書きする

[phases.ts:1012-1032](../src/lib/cycle/phases.ts#L1012-L1032)

cycle 実行中にダッシュボードから「一時停止」を押しても、cycle 完了時に paused → running に巻き戻る。ユーザーは止めたつもりが、次サイクル :00 cron で勝手に再開して売買が走る。

**対策**: `state` を上書きせず、`consecutiveFailures` / `lastFailureKind` / `lastCycleId` / `lastCycleAt` だけ更新

#### FF. Kill Switch の close で `lastPrice <= 0` が silent skip

[kill-switch/index.ts:152-164](../src/lib/kill-switch/index.ts#L152-L164)

DD 計算では 4 段フォールバック (ticker → snapshot → peak → avg) があるのに、close 実行段はフォールバック無し。`getTicker` 失敗 / 空配列で対象銘柄を close せず silent で次へ進む → 「kill switch 発動したのにポジションが残っている」状態になりうる。

**対策**: DD 計算と同じフォールバックロジックを close 段でも使う + close 失敗時に critical 通知

#### GG. Kill Switch close が逐次実行

[kill-switch/index.ts:150-176](../src/lib/kill-switch/index.ts#L150-L176)

緊急性が最も高い処理なのに N 銘柄あれば N × HTTP latency。「-50% DD で全 close」のはずが、close 中に更に値動きするタイムウィンドウが広がる。

**対策**: `Promise.all` で並列化、エラーは個別に collect して critical 通知

#### 0.1 Critic 必須化 (fail-open 廃止)

[phases.ts:744-799](../src/lib/cycle/phases.ts#L744-L799)

要件 §3.2 / §4.3.3.1 の方針 (ALL-or-NOTHING) に合わせて、Critic 失敗時の try/catch を撤廃。`runCritic` の失敗は `runPhase` の catch に流して `recordCycleFailure` 経由で通常の `llm_failure` event + Discord 通知 + `consecutiveFailures++` のパスに乗せる。

**注意**: `auto-skip` (buy 0 + exit 0 で Critic 呼び出しを節約) は対象外。「審査対象が無い」ケースで売買も発生しないため現状維持。

#### N. `isCycleInFlight` の 10 分窓ヒューリスティック

[queries.ts:455-466](../src/lib/cycle/queries.ts#L455-L466)

10 分超でハングした cycle は UI 上「実行中じゃない」扱いに → 「サイクル実行中は銘柄変更不可」ガードが破れる。DD と組み合わせると、失敗 cycle が永遠に 10 分窓に入らず "実行中" 扱いになる二重バグ。

**対策**: `system_state.lastCycleStartedAt` ベースに変える (migration なしの方針を採用)。`cycles.status` カラム追加は Phase 4 で再検討。

#### K. TZ 指定漏れ (時刻が UTC で表示される)

[page.tsx:118,132,160](../src/app/page.tsx#L118), [cycles/[id]/page.tsx:100,101,252](../src/app/cycles/[id]/page.tsx#L100)

`system-controls.tsx:133` だけ `timeZone: "Asia/Tokyo"` 指定、他は指定なし。SSR で Vercel サーバ TZ (UTC) でフォーマット → JST 18:00 のサイクルが「09:00」表示。

**対策**: 全 `toLocaleString` / `toLocaleDateString` に `timeZone: "Asia/Tokyo"` 指定、または共通フォーマッタ util

#### L. 「本日のサイクル数」が UTC 起算

[queries.ts:80-81](../src/lib/cycle/queries.ts#L80-L81)

`new Date().setHours(0,0,0,0)` を Vercel (UTC) で実行 → JST 9 時にリセットされる。

**対策**: `date-fns-tz` で JST 起算の境界を計算、または SQL の `AT TIME ZONE 'Asia/Tokyo'`

#### V. `startSystem` / `pauseSystem` の TOCTOU レース

[system-control/index.ts:64-99](../src/lib/system-control/index.ts#L64-L99)

Read row → check state → UPDATE の TOCTOU パターン。2 つのタブから同時押下で `system_events` に同種イベントが二重発火。

**対策**: `UPDATE ... SET state = '...' WHERE state IN (...) RETURNING *` に統一、row が無ければ「状態遷移不可」エラー

### Phase 1 完了条件

- [ ] DD/EE 修正で「失敗 cycle が完了扱いになる」「pause が cycle 完了で巻き戻らない」を手動確認
- [ ] FF/GG 修正後、kill-switch を模擬発動 (DD trigger に該当する portfolio をテスト DB に作る) して全 close 並列実行確認
- [ ] 0.1 Critic 必須化後、Critic API モック失敗で `recordCycleFailure` 経由になることを retry.test.ts で確認
- [ ] K/L 修正後、ダッシュボードの時刻表示が JST、本日カウントが JST 起算であることを目視確認
- [ ] N/V 修正後、長時間 cycle ハング時の UI 挙動 / 同時 pause 押下時の挙動を確認

### Phase 1 Commit message 案

```
fix: Tier S 致命的バグ修正 (失敗パス整合性 + Kill Switch + TZ + 状態判定)

- DD/EE/0.1: cycle 失敗パスの整合性 (completedAt 更新 + state 上書き廃止 + Critic 必須化)
- FF/GG: Kill Switch close のフォールバック追加 + 並列化
- K/L: ダッシュボード時刻表示と本日サイクル数を JST 起算に統一
- N/V: isCycleInFlight 窓判定の堅牢化 + system-control の TOCTOU 解消
```

---

## Phase 2: ロジック / パフォ / 運用整備 (Tier A、11 タスク)

**目的**: 失敗判定のロバスト化、ダッシュボードパフォの主要対策、運用観点 (Sentry / ログアウト) の整備、緊急 pause 機能の追加。

**主要ファイル**: `cycle/retry.ts`, `kill-switch/index.ts`, `cycle/phases.ts`, `cycle/queries.ts`, `app/actions/*`, dashboard components, db schema (BB-2 のみ migration)

### Phase 2 タスク

| # | ID | 対策 | 工数 |
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
| 20 | BB-2 | 緊急 pause 機能の新規追加 (migration あり) | 中 |

### Phase 2 詳細

#### P-1. GMO `getTicker()` が `getOpenPositions` の内側で同期実行

[queries.ts:171](../src/lib/cycle/queries.ts#L171)

30 秒 TTL の `unstable_cache` 内で外部 HTTP を待つ → ダッシュボード全体がブロック。GMO レイテンシ 200ms〜2s。

**対策**: ticker fetch を別の `unstable_cache` に切り出して並列化、または client side revalidate

#### P-2. `getCycleDetail` がキャッシュされていない

[queries.ts:290](../src/lib/cycle/queries.ts#L290)

完了済み cycle は immutable なのに毎回フル実行。

**対策**: `unstable_cache` でラップ。`completed_at` ありなら長 TTL、無しなら短 TTL の二段

#### LL. Critic に渡す `currentPositions` が price-monitor 反映前

[phases.ts:716-723](../src/lib/cycle/phases.ts#L716)

`ctxs` は preflight 時点のスナップショット。preflight 内 `runPriceMonitor` で SL 発動 → close されても ctxs は再構築されない。

**対策**: `runPriceMonitor` 後に positions を再 fetch して ctxs に反映

#### KK. `triggerAutoPauseDueToFailures` が `lastFailureKind` をクリアしない

[kill-switch/index.ts:218-233](../src/lib/kill-switch/index.ts#L218-L233)

auto-pause 時に `consecutiveFailures: 0` リセットするが `lastFailureKind` は手付かず。再開後に異種エラーが来ても「同 kind 継続」と誤判定。

**対策**: `lastFailureKind: null` も同時にリセット

#### II. `classifyError` がメッセージ文字列マッチに依存

[retry.ts:50-54](../src/lib/cycle/retry.ts#L50-L54)

`\b400\b` のような正規表現で HTTP status を検出 → `400000ms timeout` で誤検知。LLM プロバイダのエラーフォーマット変更で全分類が壊れる。

**対策**: HTTP status を Error の属性 (`err.status`, `err.response?.status`) から拾う。文字列マッチは fallback として残す

#### MM. DD 計算で `initial = 0` の NaN ガード無し

[kill-switch/index.ts:111](../src/lib/kill-switch/index.ts#L111)

`ddRatio = (initial - totalValue) / initial` で `initial = 0` → NaN → kill switch 発動しない。

**対策**: `if (initial <= 0) return false;`

#### JJ. price-monitor 失敗時にサイクル続行

[phases.ts:101-113](../src/lib/cycle/phases.ts#L101-L113)

逆指値判定が落ちても通知だけ吐いて続行 = SL 監視抜きで売買続行。0.1 で Critic 必須化したのに price-monitor だけ fail-open は思想がズレる。

**対策**: Critic 必須化と思想を揃えて price-monitor も必須化 (失敗 → サイクル中断)。phases.ts:101 の try/catch を撤廃して上位 `recordCycleFailure` に流す。

#### P (Sentry). Server action のエラーが Sentry に飛ばない

[coins.ts:34](../src/app/actions/coins.ts#L34), [system-control.ts:41](../src/app/actions/system-control.ts#L41)

`console.error` のみ。CLAUDE.md の運用方針 (Sentry 経由) と矛盾。

**対策**: `withResult` / catch 内に `Sentry.captureException(err)` を追加

#### U. ログアウト機能が無い

`signOut` / `logout` 不在、cookie 手動削除しか方法がない。

**対策**: ヘッダーに「ログアウト」ボタン + `supabase.auth.signOut()`

#### F. GMO 失敗バナー

[queries.ts:174](../src/lib/cycle/queries.ts#L174)

ticker fetch 失敗 → `avg price` にフォールバック → **含み損益が常に 0** で表示される (silent)。

**対策**: fetch 失敗フラグを返り値に含めて、ダッシュボードに「価格取得失敗 (建値表示中)」バナー

#### BB-2. 緊急 pause 機能の新規追加【新機能、migration あり】

通常 pause と別の「緊急停止」ボタンを追加。押下時の挙動:
- `system_state` に新フラグ (`emergency_stop boolean` または `state` enum に `emergency_paused` 追加) を立てる
- 各 phase の冒頭 (`tier0Snapshots` / `tier1` / ... / `finalize`) で読んで、立っていたら phase throw → サイクル全体 abort
- abort 後は `recordCycleFailure` 経路に乗せず、専用の `cycle_emergency_stopped` event を記録 (`consecutiveFailures` も増やさない)

**注意点**:
- Tier 0-2 で abort した場合 LLM コストは消費済み (受け入れる)
- 部分実行データ (snapshots / pre_analyst など) は DB に残る → 次サイクルで冪等性により skip 判定で活用される
- emergency stop 解除は手動 (UI の「再開」) で `state = paused` → 通常 pause と同じ流れに合流

**実装範囲**: schema 変更 + migration + phases.ts 各冒頭にチェック + UI ボタン + action

### Phase 2 完了条件

- [ ] P-1/P-2 後にダッシュボード初回 / 2 回目表示の体感速度向上を確認
- [ ] II/JJ/KK/LL/MM 修正後、retry.test.ts 周辺にケース追加して回帰防止
- [ ] U でログアウト → 再ログインの動線確認
- [ ] BB-2 で緊急 pause が phase ごとに効くことをローカルで確認 (各 phase 走行中に押す)
- [ ] Sentry に server action エラーが上がることを意図的なエラー注入で確認

### Phase 2 Commit message 案

```
feat/fix: Tier A ロジック整備 + ダッシュパフォ + 緊急 pause 機能

- P-1/P-2: GMO ticker 分離 + getCycleDetail キャッシュ
- LL/KK/II/MM/JJ: Critic 鮮度 + 失敗カウンタ + classify + DD ガード + price-monitor 必須化
- P(Sentry)/U/F: server action エラー追跡 + ログアウト + GMO バナー
- BB-2: 緊急 pause 機能 (新機能、system_state schema 追加)
```

---

## Phase 3: UX / セキュリティ (Tier B、13 タスク)

**目的**: ローディング / 操作感の改善、セキュリティ穴の塞ぎ、データ整合性の細部対応。

**主要ファイル**: dashboard components / pages, `lib/supabase/*`, `app/error.tsx` / `global-error.tsx`, `app/login/page.tsx`, `app/auth/callback/route.ts`

### Phase 3 タスク

| # | ID | 対策 | 工数 |
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

### Phase 3 詳細

#### A. ローディング / ストリーミング無し

`src/app/` 配下に `loading.tsx` 無し → コールド navigation で白画面。

**対策**: `app/loading.tsx` + Suspense 境界の切り出し

#### C. リアルタイム性無し

`nextScheduledAt` 静的、サイクル開始 / 終了で UI が更新されない。

**対策**: 30s ポーリング `router.refresh()` または Supabase Realtime / SSE

#### P-3. サイクル詳細の N+1 (銘柄ごと 3 クエリ)

[queries.ts:337-356](../src/lib/cycle/queries.ts#L337-L356)

**対策**: 1 つの JOIN クエリにまとめる (`market_snapshots LEFT JOIN ... LEFT JOIN ... LEFT JOIN decisions`)

#### B. `window.confirm()` 多用

[system-controls.tsx:62,79](../src/components/dashboard/system-controls.tsx#L62), [risk-params.tsx:43](../src/components/dashboard/risk-params.tsx#L43)

**対策**: shadcn/ui の `Dialog` / `AlertDialog` に置き換え

#### M. 認証が二重に走っている

middleware で `supabase.auth.getUser()`、page でも同じ呼び出し。`if (!user) return null;` は middleware redirect により到達不能。

**対策**: page 側の `getUser()` を削除、ユーザー情報が要るなら middleware で header 経由

#### Y. `/login` の `?error=` 素通し表示

[login/page.tsx:9,35](../src/app/login/page.tsx#L9)

任意文字列を画面表示できる → phishing 文言注入。

**対策**: error コードを enum で受けて、固定メッセージにマッピング

#### BB-1. 通常 pause の挙動を UI で明示

[Phase 1 で EE を修正すると "現サイクルは走り切る、次サイクルから停止" が確実な挙動になる]

**対策**: 確認ダイアログ or 状態表示で「現サイクルは完了まで走ります。停止は次サイクルから反映されます」を明示。BB-2 (緊急 pause) との使い分けもここで提示

#### X. `/auth/callback` の `next` パラメータ検証無し

[auth/callback/route.ts:11,17](../src/app/auth/callback/route.ts#L11)

現状は文字列連結で外部 redirect は構造上できないが、将来 `new URL(next)` リファクタで穴になる。

**対策**: `next.startsWith("/") && !next.startsWith("//")` ガード

#### Z. `error.tsx` / `global-error.tsx` が production でも stack trace 表示

[error.tsx:64-78](../src/app/error.tsx#L64-L78), [global-error.tsx:69-83](../src/app/global-error.tsx#L69-L83)

両方とも production で stack 露出 (CC の調査結果と統合)。

**対策**: `NODE_ENV === "production"` で stack 非表示、digest のみ案内。両ファイル同時に適用

#### O. `setCoinEnabledAction` に input validation 無し

[coins.ts:23-37](../src/app/actions/coins.ts#L23-L37)

存在しない `coinId` でも UPDATE 成功扱い (rowCount 見ていない)。

**対策**: `result.rowCount === 0` でエラー返す

#### PP. Paper mode の placeOrder → fillOrder が非 atomic

[executor/index.ts:112-133](../src/lib/executor/index.ts#L112-L133)

`placeOrder` 成功 + `fillOrder` 失敗 で `status=placed` のままの orphan order が残る。

**対策**: paper mode のとき `place + fill` を 1 transaction にまとめる

#### NN. Clipper の floor 多用で proposal 合計が縮む

[clipper.ts:43-44,53](../src/lib/risk/clipper.ts#L43)

端数切り捨てが連鎖して `totalCapRoom` に対して数 % 少なくなる → 現金が遊ぶ。

**対策**: 最後の銘柄に端数を寄せる、または floor を round に

#### S. 保有ポジションに含み損益が銘柄ごとに出ていない

[page.tsx:127-134](../src/app/page.tsx#L127-L134)

`unrealizedPnlJpy` は計算済みなのに表示していない。

**対策**: 銘柄行に `+¥1,234 (+2.3%)` 表示

### Phase 3 完了条件

- [ ] A/C で navigation 体感とリアルタイム性向上を確認
- [ ] B/Y/X/Z でセキュリティと UX のチェックリスト消化
- [ ] M で認証二重呼び出しが消えていることを Supabase logs で確認
- [ ] PP/NN/S で paper mode の orphan order ゼロ + 端数挙動 + 銘柄ごと損益表示

### Phase 3 Commit message 案

```
feat/fix: Tier B UX + セキュリティ + データ整合性

- A/C/P-3: Loading + リアルタイム + N+1 解消
- B/Y/X/Z: window.confirm → Dialog + ?error= enum + next 検証 + production stack 非表示
- M: 認証二重実行解消
- BB-1: 通常 pause UI 文言明示
- O/PP/NN/S: data 整合性 + 含み損益表示
```

---

## Phase 4: 整理・細部 (Tier C、16 タスク)

**目的**: 細かい UX 改善、index 追加、保守性向上。性能観点で重要度が高くないが、長期保守の負債を減らす。

**主要ファイル**: dashboard components, db schema (P-4 / P-5 で migration あり), `db/schema/enums.ts`

### Phase 4 タスク

| # | ID | 対策 | 工数 |
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

### Phase 4 詳細

#### P-4. `critic_outputs.created_at` index 追加

[queries.ts:103-111](../src/lib/cycle/queries.ts#L103-L111)

`cyclesToday` の `COUNT(*) WHERE createdAt >= today` 用 (将来効いてくる)。

#### P-5. `system_events.cycle_id` 直接カラム化

[queries.ts:309-319](../src/lib/cycle/queries.ts#L309-L319)

`payload->>'cycleId' = $1` の JSONB 検索 → seq scan。`cycle_id` 直接カラム化で index 付与。

#### G. "最終更新" インジケータが無い

**対策**: キャッシュ生成時刻を返り値に含めて表示

#### D. 全銘柄が pending 中に disable される

[coin-checklist.tsx:79](../src/components/dashboard/coin-checklist.tsx#L79)

**対策**: 銘柄ごとに pending 状態を持つ、または `useOptimistic`

#### E. 「保存中」フィードバックが弱い

**対策**: pending 中に spinner + "保存中..." テキスト

#### I. RiskParams / SystemControls に楽観更新なし

**対策**: `useOptimistic` で即時反映、失敗時のみロールバック

#### H. `recentCycles` の hard limit 20、ページング無し

[page.tsx:32](../src/app/page.tsx#L32)

**対策**: "もっと見る" ボタン、または `/cycles` 一覧ページ

#### J. Cycle 詳細はデフォルト全て閉じ + 全件 eager fetch

[cycles/[id]/page.tsx:185](../src/app/cycles/[id]/page.tsx#L185)

**対策**: default 展開状態を見直し、または銘柄ごとに lazy fetch

#### T. 「直近サイクル」表示の意味が曖昧

[page.tsx:117](../src/app/page.tsx#L117)

**対策**: 「最終完了」「最終開始」など明示

#### Q. RiskParams の NaN / 空入力ケース

[risk-params.tsx:27-30](../src/components/dashboard/risk-params.tsx#L27-L30)

**対策**: クライアント側で空 / NaN なら disable + ヒント表示

#### AA. cycle 詳細ページに `<title>` 反映なし

**対策**: `generateMetadata` で `サイクル {id.slice(0,8)} | LLM 自動売買`

#### R. `updateTag` + `revalidatePath` の実機検証

**実機検証**: `revalidatePath` を一時的に外して動作確認 → 不要なら削除 + コメント追加。問題出るようなら両方残しつつ「なぜ両方必要か」をコメント明記

#### W. 冪等パスで `system_events` が記録されない

[system-control/index.ts:43,69](../src/lib/system-control/index.ts#L43)

**対策**: 冪等パスでも軽い no-op event を書く、または「すでに ◯◯ 状態です」を UI に出す

#### QQ. `positions.status` / `orders.status` の magic string 散在

**対策**: `src/db/schema/enums.ts` に集約

#### SS. `expectedCloseCash` が「全 Exit 成功前提」

[phases.ts:674-682](../src/lib/cycle/phases.ts#L674)

Allocator / Critic に渡す `projectedCashJpy` は全 Exit 成功前提 → Critic は古い前提で判断 (Clipper 入力は refresh 済みなので最終的には吸収される)。低優先。

#### HH. `auto-skip` Critic が UI で本物 approve と区別不能 (任意)

0.1 で fail-open は廃止、`auto-skip` (buy 0 + exit 0 節約) のみ残る。UI 上で区別したいなら dashboard で `criticOutputs.llmModel === "auto-skip"` を別バッジ表示。

### Phase 4 完了条件

- [ ] P-4/P-5 の migration 適用 (本番反映前にローカルで検証)
- [ ] QQ で enum 統一後、grep で magic string ゼロを確認
- [ ] R 検証結果でコード簡素化
- [ ] 残りの UX 細部 (G/D/E/I/H/J/T/Q/AA/W) は触感確認

### Phase 4 Commit message 案

```
chore/refactor: Tier C 整理・細部

- P-4/P-5: critic_outputs / system_events の index / カラム整備 (migration あり)
- G/D/E/I/H/J/T/Q/AA: UX 細部の改善
- R/W/QQ/SS/HH: 整理 + データ整合性 + auto-skip UI 区別
```

---

## Phase 5: 複雑度警告の解消 / リファクタ (4 タスク)

**目的**: biome `noExcessiveCognitiveComplexity` の警告 4 件を解消。**Phase 4 完了 + paper mode サイクル動作確認の後**に実施 (売買中核を触るため、差分が観測可能な状態でやる)。

**前提**:
- Phase 1-4 の動作が paper mode で 1-2 サイクル正常完了していること
- biome の閾値 (25) は据え置き

### Phase 5 タスク

| # | 対象 | 現複雑度 | 工数 |
|---|---|---|---|
| 50 | `cycle/phases.ts` finalize | 86 | 大 |
| 51 | `cycle/phases.ts` tier3Decisions 内ループ | 33 | 中 |
| 52 | `tier0/fetch-snapshot.ts` fetchSnapshot | 28 | 小 |
| 53 | `app/page.tsx` recentCycles map (Badge 入れ子三項) | 33 | 小 |

### Phase 5 詳細

#### 50. finalize 分割 (複雑度 86 → ≤ 25)

[phases.ts:586](../src/lib/cycle/phases.ts#L586)

600 行超 / 売買判定の中核。以下 5 ブロックに切り出す:

1. **`buildFinalizeContext(cycleId, strategyId)`** — ctxs / portfolio / exitsToRun / projectedCashJpy / allocator proposal を組み立て
2. **`runCriticDecision(ctx)`** — Critic 呼び出し + criticOutputs 書き込み (skip 判定込み)
3. **`executeExits(ctx, critic)`** — Exit ループ
4. **`executeEntries(ctx, critic, refreshed)`** — Risk Clipper + Entry ループ
5. **`buildCycleNotification(ctx, results)`** — Discord 通知整形 + summary 返却

`finalize` 本体はこの 5 つを順に呼ぶオーケストレータに痩せる。

**注意**:
- exitOverrides / executedEntries / skippedEntries の受け渡しを引数 or 戻り値で明示
- 0.1 の Critic 必須化 (try/catch なし) を維持
- EE の `system_state.state` 非上書きを維持
- DD の `cycles.completedAt` 更新位置を維持
- ALL-or-NOTHING (Critic 失敗 = サイクル中断) を破らない

#### 51. tier3Decisions 内ループ分割 (複雑度 33 → ≤ 25)

[phases.ts:417](../src/lib/cycle/phases.ts#L417)

Entry decision と Exit decision の 2 ブロックを `runEntryForCoin(ctx)` / `runExitForCoin(ctx, openPos)` に切り出す。

#### 52. fetchSnapshot 分割 (複雑度 28 → ≤ 25)

[fetch-snapshot.ts:147](../src/lib/tier0/fetch-snapshot.ts#L147)

並列 fetch 後の required/optional 仕分けと degraded フォールバックを `partitionFetchResults` ヘルパーに抽出。

#### 53. recentCycles map (複雑度 33 → ≤ 25)

[page.tsx:149](../src/app/page.tsx#L149)

`criticDecision` の 5 段ネスト三項を `criticDecisionLabel(c)` / `criticDecisionVariant(c)` ヘルパーに抽出。

### Phase 5 完了条件

- [ ] biome lint 警告が 0 件 (もしくは新規導入される警告を許容しない)
- [ ] paper mode で 1 サイクル流して finalize 分割後も regression なし
- [ ] 既存テスト全通過 (`critic-mandatory.test.ts` の fail-open 検出がそのまま動くこと)

### Phase 5 Commit message 案

```
refactor: finalize 分割 + 残り複雑度警告解消

- finalize を 5 ブロックに分割 (buildContext / Critic / Exit / Entry / notify)
- tier3Decisions の Entry/Exit を抽出
- fetchSnapshot の required/optional 仕分けを抽出
- recentCycles map の Badge 入れ子三項をヘルパー化
```

---

## 全 Phase 完了後

- 全 commit を 1 PR にまとめる、または phase ごとに別 PR
- 本番 push 前にローカル + steady cycle で 1-2 サイクル動作確認 (paper mode)
- migration 順序確認 (Phase 2 BB-2 + Phase 4 P-5 + 二段リスクモデル + 銘柄シード再定義)
- 本番 push → `pnpm db:prod:migrate` → 動作確認
- Langfuse にセットされてる API コスト単価が正確か確認
- 二段リスクモデル (per-cycle / per-coin total) の値を UI から検証 — paper mode で挙動確認
  - 既定 `perCoinTotalMaxRatio = 1.0` (制限なし) で現状互換 → ユーザーが必要なら 0.4 等に絞る
- HWM-base DD (capital-injection-adjusted) を paper mode で動作確認
  - `pnpm capital:local deposit 100000` で入金 → HWM が +¥100k 上がること
  - kill-switch チェック時に HWM が自動で max 更新されること
  - 入金 UI フォームの追加 (現状は CLI のみ)
