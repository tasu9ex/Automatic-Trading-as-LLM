# 既知の問題・不整合一覧

最終更新: 2026-05-21（一括修正完了）

コードベース全体レビューに基づく。**意図的に除外したもの**は末尾の「意図的な設計」に記載。

修正優先度の目安: **P0** = 研究・運用の正しさに直結 / **P1** = 障害・観測の穴 / **P2** = ドキュメント・将来機能

§18 以降は 2 回目レビューで追加された項目。

## ステータス一覧 (2026-05-21)

| § | 件名 | ステータス | コミット |
|---|---|---|---|
| §1 | Entry 仮説の永続化 | ✅ 完了 | 377f33a |
| §2 | skip_flag policy 統一 | ✅ 完了 | e8607ae |
| §3 | Critic フェイルオープン | ✅ 完了 | 74557e9 |
| §4 | Inngest finalize の recordCycleFailure | ✅ 完了 | f755e8e |
| §5 | モデル構成 (意図的) | ─ 対象外 | — |
| §6 | Shadow trading 未実装 | 🚧 スコープ外 | — |
| §7 | price-monitor 失敗時の挙動 | ─ paper 期間のみ存在、real-mode 移行 (§14) 時に削除予定 | — |
| §8 | Kill Switch ticker fallback | ✅ 完了 | c8af9bd |
| §9 | 部分決済後の SL rearm | ✅ 完了 | 8070043 |
| §10 | 配分計算 (手数料控除) | ✅ 完了 | 9628cf7 |
| §11 | Risk Clipper mark-to-market | ✅ 完了 | 9628cf7 |
| §12 | README と実装の不一致 | ✅ 完了 (本コミット) | — |
| §13 | .env.example に PAPER_TRADE | ✅ 完了 (本コミット) | — |
| §14 | PAPER_TRADE=false 未実装 | 🚧 スコープ外 (実取引移行時に着手) | — |
| §15 | phases.ts split | ✅ 部分完了 (failure handling を分離) | ed1146c |
| §16 | テスト追加 | ✅ 部分完了 (system-health / classifyError) | 916b769 |
| §17 | UI リスクパラメータ調整 | 🚧 スコープ外 | — |
| §18 | auto-pause unreachable | ✅ 完了 | f755e8e |
| §19 | Risk Clipper 後 refresh | ✅ 完了 | 9628cf7 |
| §20 | 重複定数集約 | ✅ 完了 | 713fcae |
| §21 | ohlcv_1h レガシー | ⚠️ 部分対応 (列残置、§32 と合流して将来 drop 予定) | 6fb25a5 |
| §22 | 死コード enum | ✅ 完了 | 73360e0 |
| §23 | isCycleInFlight 30 分 → 10 分 | ✅ 完了 | dfa8856 |
| §24 | Allocator/Clipper 重複 cap | 🚧 保留 (defensive redundancy として許容、将来 §17 と同時整理) | — |
| §25 | Pyramid troughPrice 対称更新 | ✅ 完了 | 8070043 |
| §26 | recordCycleFailure に kill-switch | ✅ 完了 | 89d77c3 / f755e8e |
| §27 | 1m kline 404 fallback | ✅ 完了 | 89d77c3 / 6fb25a5 |
| §28 | Discord 推定原因動的化 | ✅ 完了 | 89d77c3 |
| §29 | counter 表示クランプ | ✅ 完了 | 89d77c3 / f755e8e |
| §30 | ダッシュボード失敗 cycle 表示 | ✅ 完了 | 89d77c3 / dfa8856 |
| §31 | Entry executor silent skip | ✅ 完了 (§32 と合わせて根治) | 683c670 / 6fb25a5 |
| §32 | 動的 TF (Phase 1+2) | ✅ 完了 | 6fb25a5 |
| §33 | Critic systemHealth | ✅ 完了 | 916b769 |

残課題は **§6 / §14 / §17** (機能拡張系) + **§24** (defensive redundancy として許容) のみ。

---

## P0 — 機能バグ・設計上の穴

### 1. Entry 仮説がポジションに保存されない

**症状**

- Tier 3 Entry LLM は `expected_holding_days` / `target_price_jpy` / `exit_condition` を出力する
- `decisions` には `result` / `confidence` / `reasoning` のみ保存
- `finalize` の `executeEntry` に仮説フィールドを渡していない
- 結果、`positions.entry_*` は常に null のまま

**影響**

- Exit LLM は Entry 時の仮説を常に「なし」として判断する
- プロンプト（`tier3/exit` の reference-only 設計）の研究価値が失われる

**関連ファイル**

- `src/lib/cycle/phases.ts` — `tier3Decisions` の insert、`finalize` の `executeEntry`
- `src/lib/executor/index.ts` — `fillEntryOrder` は仮説を受け取れる
- `src/lib/schemas/llm-outputs.ts` — `EntryDecisionOutputSchema`

**修正の方向性**

- tier3 で LLM 出力を保持し、`executeEntry` に渡す
- または `decisions` に JSON 列を追加してダッシュボードからも参照可能にする

---

### 2. `skip_flag=true` かつ保有中 → Exit LLM が走らない

**症状**

- Tier 2: `pre.skipFlag` なら Analyst をスキップ
- Tier 3: `analyst` 行がなければ Entry/Exit 両方スキップ（保有中でも Exit なし）

**影響**

- 保有ポジションの LLM Exit 判断がそのサイクルで行われない
- 保護は **price-monitor（逆指値 replay）** と **Kill Switch** のみに依存

**ドキュメントとの不一致**

| 文書 | 記載 |
|------|------|
| `docs/requirements.md` §3.1.1 Phase 5a | `skip_flag` は **記録のみ**、Tier 2 は全銘柄実行 |
| `docs/todo.md` | skip_flag **尊重**（実装に合わせた記述） |
| 実装 | skip_flag を尊重して Tier 2/3 をスキップ |

**関連ファイル**

- `src/lib/cycle/phases.ts` — `tier2Analyst`, `tier3Decisions`

**修正の方向性（いずれか）**

- 保有中は `skip_flag` を無視して Tier 2/3 Exit のみ必ず実行
- Phase 5a 方針に合わせ、Tier 2 は全銘柄実行（skip はログ・分析用のみ）

---

### 3. Critic API 失敗時がフェイルクローズ（要件はフェイルオープン）

**症状**

- `runCritic` は失敗時に throw
- `finalize` 全体が失敗し、Critic 以降の Exit/Entry が実行されない

**要件との不一致**

- `docs/requirements.md` §4.3.3.1: Critic API エラー → **フェイルオープン**（配分案そのまま採用）

**関連ファイル**

- `src/lib/critic/index.ts`
- `src/lib/cycle/phases.ts` — `finalize`

**修正の方向性**

- `finalize` 内で Critic を try/catch し、失敗時は `approve` + `llmModel: "fail-open"` 相当で Clipper へ進む
- `system_events` に記録

---

### 4. Inngest の `finalize` 失敗だけ `recordCycleFailure` されない

**症状**

- `tier0`〜`tier3` は `runStep` 内で失敗時に `recordCycleFailure` → throw
- `finalize` は単独の `step.run` で、失敗時に連続失敗カウンタ・通知パターンが揃わない

**影響**

- Inngest 経由と CLI (`judgment.ts`) で障害時の `system_state` 更新が不一致
- 連続失敗による auto-pause が期待どおり動かない場合がある

**関連ファイル**

- `src/lib/inngest/functions.ts`
- `src/lib/cycle/judgment.ts`（CLI は `finalize` も `recordCycleFailure` 対象）

**修正の方向性**

- `finalize` を `runStep` と同じラッパーで包む

---

### 18. 連続失敗による auto-pause が経路上 unreachable

**症状**

- `AUTO_PAUSE_THRESHOLD = 3` ([phases.ts:1021](src/lib/cycle/phases.ts#L1021)) と `CONSECUTIVE_FAILURES_TRIGGER = 3` ([kill-switch/index.ts:12](src/lib/kill-switch/index.ts#L12)) の二箇所で閾値定義
- 失敗通知本文に「(次回 auto pause)」と表示される ([phases.ts:1142](src/lib/cycle/phases.ts#L1142)) が、実際には何度失敗しても `state = paused` にならない

**経路の問題**

1. `recordCycleFailure` は `kind === "quota"` のときだけ `state = "paused"` ([phases.ts:1050](src/lib/cycle/phases.ts#L1050))。連続失敗カウンタ自体は閾値判定に使われない。
2. 閾値判定は `checkAndTriggerKillSwitch` 内 ([kill-switch/index.ts:58](src/lib/kill-switch/index.ts#L58)) だが、これは `finalize` ([phases.ts:869](src/lib/cycle/phases.ts#L869)) からしか呼ばれない。
3. 失敗 cycle は `finalize` に到達しないので呼ばれない。
4. たとえ `finalize` が成功して呼ばれても、その直前で `consecutiveFailures: 0` にリセット ([phases.ts:850, 859](src/lib/cycle/phases.ts#L850)) してから kill-switch を呼ぶため、`failureTriggered` は常に false。

**影響**

- 通知が嘘になる（「次回 pause」と書いておきながら pause しない）
- quota 以外の障害（transient / permanent）でシステムが永久にリトライし続ける
- §4 を修正して Inngest finalize でも `recordCycleFailure` が呼ばれるようにしても、この問題は **独立に残る**

**関連ファイル**

- `src/lib/cycle/phases.ts` — `recordCycleFailure`, `finalize`
- `src/lib/kill-switch/index.ts` — `checkAndTriggerKillSwitch`

**修正の方向性**

- `recordCycleFailure` 内で `newCount >= AUTO_PAUSE_THRESHOLD` のとき `state = "paused"` にする
- もしくは kill-switch の自動 pause 経路を `recordCycleFailure` からも呼べるよう抽出
- §20 の重複定数も同時に整理

---

## P1 — 運用リスク・挙動のずれ

### 6. Shadow trading・複数 strategy 未実装

**症状**

- `strategyId: "trial-5"` が Inngest / queries / seed 等にハードコード
- Allocator の `method`（equal / confidence）切替のみ
- モデル別ポートフォリオ並走・モデル別 Critic は未実装

**要件**

- `docs/requirements.md`: Phase 5c で shadow trading 並列比較

**関連ファイル**

- `src/lib/inngest/functions.ts`
- `src/lib/cycle/queries.ts`
- `scripts/dev/seed.ts`

**備考**

- MVP スコープ外として未実装なら、要件側に「未着手」と明記するのがよい

---

### 7. `price-monitor` 失敗時はサイクル継続

**症状**

- `preflight` 内で `runPriceMonitor` が throw しても catch してサイクル継続
- Discord に「逆指値判定がスキップ」と通知

**影響**

- §2 と組み合わさると、保有ポジションの判断経路が一時的に SL のみになりうる

**関連ファイル**

- `src/lib/cycle/phases.ts` — `preflight`
- `src/lib/price-monitor/index.ts`

**修正の方向性（方針決定が必要）**

- 失敗時は `paused` にする
- または保有あり + monitor 失敗時は Tier 3 Exit を必須にする

---

### 8. Kill Switch の DD 計算が楽観的になりうる

**症状**

- ティッカー取得失敗時、そのポジションを評価額に含めずスキップ（catch で握りつぶし）

**影響**

- ポートフォリオ DD が過小評価され、Kill Switch（-50%）が遅れる可能性

**関連ファイル**

- `src/lib/kill-switch/index.ts` — `checkAndTriggerKillSwitch`

**修正の方向性**

- 取得失敗時は前回価格・建値・サイクル snapshot 終値でフォールバック
- または「評価不能」として保守的に DD 計算

---

### 9. 部分決済後も逆指値（`pending_orders`）が更新されない

**症状**

- `fillExitOrder` は **全決済** 時のみ `pending_orders` を `active=false`
- 部分決済（`close_pct` < 100）では SL トリガーが建値ベースのまま残る
- ピラミッディング時は SL 再配置あり、部分決済時はなし

**関連ファイル**

- `src/lib/executor/index.ts` — `fillExitOrder`
- `src/lib/cycle/phases.ts` — `finalize` の `quantityRatio`

**修正の方向性**

- 部分決済後に残数量に合わせて SL を再計算・再配置

---

### 10. Allocator の projected cash が手数料・スリッページ無視

**症状**

- Critic 前の `expectedCloseCash = qty * lastPrice`（粗い見積もり）
- 実際の Exit 後 cash より大きめに見積もる可能性

**影響**

- Critic / Allocator が渡す `projectedCashJpy` がやや過大 → Entry 配分がやや大きめになりうる（軽微）

**関連ファイル**

- `src/lib/cycle/phases.ts` — `finalize`

---

### 11. Risk Clipper の `currentInvested` が原価ベース

**症状**

- `currentInvestedJpy = Σ(qty × avgEntryPrice)`（含み益は反映しない）
- `totalCapRoom = availableCash × totalMaxRatio - currentInvestedJpy`

**影響**

- 含み益が大きいと、実際の総エクスポージャより「余裕あり」と見え、新規 Entry の余地が広がりうる

**関連ファイル**

- `src/lib/cycle/phases.ts` — `finalize`
- `src/lib/risk/clipper.ts`

**備考**

- 要件の「100% 上限」を原価ベースで解釈しているか、時価ベースかを要件で明文化するとよい

---

### 19. Risk Clipper の `currentInvested` が Exit 約定前の snapshot

**症状**

- `finalize` line [798](src/lib/cycle/phases.ts#L798): `currentInvested = currentPositions.reduce((s, p) => s + p.qty * p.avgPrice, 0)`
- `currentPositions` は Exit 実行前の in-memory snapshot ([phases.ts:648-654](src/lib/cycle/phases.ts#L648-L654))
- `cashAfterExits` は Exit 後の DB から refresh されているのに、`currentInvested` は古いまま

**影響**

- Risk Clipper の `totalCapRoom = cashAfterExits * 1.0 - currentInvested` が **過小評価**
- 同サイクル内で Exit → 新規 Entry する場合、Exit したはずのポジション分が `currentInvested` に残るため、新規配分が clipped で削られる
- §11（原価ベース問題）とは独立の **タイミング**問題

**関連ファイル**

- `src/lib/cycle/phases.ts` — `finalize`

**修正の方向性**

- Exit 後に `positions` を DB から再取得して `currentInvested` を再計算
- もしくは Exit 実行後の現金 + 残ポジ原価で再構築

---

### 20. `AUTO_PAUSE_THRESHOLD` と `CONSECUTIVE_FAILURES_TRIGGER` の重複定義

**症状**

- 同じ値 `3` が二箇所で独立に定義されている
  - `phases.ts:1021`: `AUTO_PAUSE_THRESHOLD = 3`（通知の表示・カウンタ管理用）
  - `kill-switch/index.ts:12`: `CONSECUTIVE_FAILURES_TRIGGER = 3`（auto-pause 発火閾値用）

**影響**

- 片方だけ変更すると挙動が乖離（§18 とセットで起きやすい）
- 「閾値」のメンタルモデルが二重になる

**関連ファイル**

- `src/lib/cycle/phases.ts`
- `src/lib/kill-switch/index.ts`

**修正の方向性**

- 共通定数として `src/lib/constants/` に切り出して両方で import

---

## P2 — ドキュメント・未実装・保守

### 12. README と実装の不一致

| 項目 | README 等 | 実態 |
|------|-----------|------|
| Next.js バージョン | 15 表記あり | `package.json`: 16.x |
| `shared/` ディレクトリ | 記載あり | 存在しない |
| `tests/` | 記載あり | Vitest は `retry.test.ts`, `scheduling.test.ts` のみ |

---

### 13. `.env.example` に `PAPER_TRADE` がない

**症状**

- コードは `PAPER_TRADE`（デフォルト `true`）でペーパー/実発注を切替
- `.env.example` に未記載

**関連ファイル**

- `src/lib/executor/index.ts`
- `src/lib/price-monitor/index.ts`

---

### 14. `PAPER_TRADE=false` は未実装（誤設定でサイクル失敗）

**症状**

- `placeEntryOrder` / `placeExitOrder` が REAL mode で throw
- GMO Private API 連携・fill worker は stub コメントのみ

**関連ファイル**

- `src/lib/executor/index.ts`
- `docs/todo.md` — 実発注切替は未着手

---

### 15. `phases.ts` が 1100 行超のモノリス

**症状**

- パイプライン・DB・通知・障害処理が 1 ファイルに集中

**影響**

- レビュー・テスト・変更のコストが高い（ロジック破綻ではない）

---

### 16. テストカバレッジがパイプライン本体をカバーしない

**現状**

- `src/lib/cycle/retry.test.ts`
- `src/lib/system-control/scheduling.test.ts`

**未カバー例**

- Executor（約定・ピラミ・部分決済）
- Kill Switch
- Allocator + Risk Clipper + Critic 連携
- tier 間の skip / 冪等

---

### 17. UI からリスクパラメータ変更が未実装

**要件**

- `docs/requirements.md` §4.4: ハードガードは UI から調整可能とする

**実装**

- `RISK_PER_COIN_MAX_RATIO` 等は `phases.ts` 内定数

---

### 21. `marketSnapshots.ohlcv_1h` がレガシー列で常に空配列固定

**症状**

- `market_snapshots.ohlcv_1h` は `jsonb NOT NULL` ([market-snapshots.ts:14](src/db/schema/market-snapshots.ts#L14))
- `tier0Snapshots` で常に `ohlcv1h: []` を保存 ([phases.ts:206](src/lib/cycle/phases.ts#L206))
- 1h 足取得ロジックはコード中に存在しない

**影響**

- DB 領域の無駄
- スキーマを読んだ人が「1h 足を保存している」と誤解する

**関連ファイル**

- `src/db/schema/market-snapshots.ts`
- `src/lib/cycle/phases.ts` — `tier0Snapshots`

**修正の方向性**

- 列を drop する migration を発行
- もしくは 1h 足取得を復活させる（Tier 1/2 プロンプト改善で必要なら）

---

### 22. 宣言だけ存在する `system_event_kind` の死コード

**症状**

- `SYSTEM_EVENT_KINDS` に `"llm_failure"`, `"data_fetch_failed"` が定義されている ([enums.ts:64,68](src/lib/constants/enums.ts#L64))
- 実コード内で `kind: "llm_failure"` または `kind: "data_fetch_failed"` で `systemEvents` に insert している箇所は **無い**
- 失敗時は `kind: "cycle_aborted"` で一括処理

**影響**

- enum の意味が曖昧（実際の挙動を読まないと分からない）
- 監視・分析時にこれらの kind を期待してフィルタしても結果は常に空

**関連ファイル**

- `src/lib/constants/enums.ts`
- `src/db/schema/enums.ts`（pgEnum 派生元）

**修正の方向性**

- 不要なら enum と DB 側 pgEnum から削除
- 必要なら Tier 0 失敗を `data_fetch_failed`、Tier 1-4 失敗を `llm_failure` に細分化

---

### 23. `isCycleInFlight` の 30 分窓が実 cycle 時間と乖離

**症状**

- `isCycleInFlight` は「`completed_at` IS NULL かつ `started_at` が直近 30 分以内」の cycle 行を「実行中」とみなす ([queries.ts:381](src/lib/cycle/queries.ts#L381))
- 実際の cycle は per-Tier step 60s × 5 step ≒ 5 分以内に完結する設計

**影響**

- スタックした cycle と健全な cycle の区別がつかない
- 30 分間「実行中」表示のまま固まる

**関連ファイル**

- `src/lib/cycle/queries.ts`

**修正の方向性**

- 窓を 10 分以内に縮める
- もしくは `cycles.last_step_at` のような中間タイムスタンプを追加し、stale 判定を厳密化

---

### 24. Allocator と Risk Clipper の per-coin cap が二重判定

**症状**

- Allocator 内: `perCoinCap = availableCash × perCoinMaxRatio` ([allocator/index.ts:31](src/lib/allocator/index.ts#L31))
- Risk Clipper 内: 同じ式で再度 cap ([clipper.ts:26](src/lib/risk/clipper.ts#L26))
- 定数 `RISK_PER_COIN_MAX_RATIO = 0.25` 等は `phases.ts:55-57` でローカル定義され、両者へ別経路で伝播

**影響**

- 2 段ガードとして安全側だが、責務が重複しレビューしづらい
- 片方の閾値だけ変えると不整合（§17 とも関連）

**関連ファイル**

- `src/lib/allocator/index.ts`
- `src/lib/risk/clipper.ts`
- `src/lib/cycle/phases.ts`

**修正の方向性**

- Allocator は「理想比率の計算のみ」、Risk Clipper は「ハードガード適用のみ」と責務を分離
- 共通定数を `src/lib/constants/risk.ts` のような単一ソースに集約

---

### 25. Pyramid（追加 Entry）時に `troughPrice` が更新されない

**症状**

- `fillEntryOrder` で既存ポジに追加買いするとき、`peakPrice` は `Math.max(prev, executedPrice)` で更新 ([executor/index.ts:210](src/lib/executor/index.ts#L210))
- `troughPrice` は `prev` のまま保持（更新ロジックなし）

**影響**

- 通常は買い時に新規 trough は付かないので実害は小さい
- ただし peak / trough の対称性が崩れ、Exit プロンプトで参照する `peakPnlJpy` / `troughPnlJpy` の意味がやや揺らぐ

**関連ファイル**

- `src/lib/executor/index.ts` — `fillEntryOrder`

**修正の方向性**

- 対称的に `troughPrice: Math.min(prev, executedPrice)` で更新

---

### 26. `checkAndTriggerKillSwitch` が失敗パスで呼ばれない（auto-pause が永遠に来ない）

**問題**

- `recordCycleFailure` は `consecutiveFailures++` するが、**kill-switch チェックを呼んでいない**（[src/lib/cycle/phases.ts:1027-1080](src/lib/cycle/phases.ts#L1027-L1080)）
- `checkAndTriggerKillSwitch` は `finalize` の成功パスにしかない（[src/lib/cycle/phases.ts:869](src/lib/cycle/phases.ts#L869)）
- 結果、Discord 通知に「3/3 (次回 auto pause)」「4/3 (次回 auto pause)」が出ても **pause は来ない**（実観測: 2026-05-21 早朝 3〜5 時、ETH の 1m kline 404 で 4 連続失敗 + state=running のまま）
- 次に成功サイクルが来ると `consecutiveFailures = 0` リセット → kill-switch チェック発火 → でも counter は 0 なので発動しない（成功時に発動するのは不整合）

**関連**

- `src/lib/cycle/phases.ts:1027-1080` — `recordCycleFailure`
- `src/lib/kill-switch/index.ts:58` — `failureTriggered` 判定
- §18, §4 と関連

**修正の方向性**

- `recordCycleFailure` の最後で `checkAndTriggerKillSwitch({ strategyId })` を呼ぶ
- これで `consecutiveFailures >= 3` の瞬間に system_state を pause + Discord 通知

---

### 27. GMO `/v1/klines?interval=1min` が早朝に 404 を返してサイクル中断

**問題**

- 観測ケース: 2026-05-21 JST 03:04 / 04:02 / 05:02 に ETH の `1min` kline が 404
- Sentry breadcrumbs で確定: 同じ URL に対して 4 回連続 404、1d kline は 200
- 仮説: GMO は `interval=1min&date=YYYYMMDD` でその date に 1m バーが 0 件のとき 404 を返す
- 早朝 JST は新しい date が始まったばかりで低流動性銘柄は bar が無い時間帯がある
- `tier0` の必須ソースに含まれているのでサイクル全体 abort

**関連**

- `src/lib/clients/gmo.ts:121` — `getKlines`
- `src/lib/tier0/fetch-snapshot.ts:116` — 1min を `kline1mDate ?? todayYyyymmdd()` で叩く
- §26 のカウンタが進む原因

**修正の方向性**

- `getKlines` で 404 を捕捉して空配列 `[]` 扱いにする（または）
- `fetch-snapshot.ts` 内で 1min が空 → 前日 (JST yesterday) を再 fetch して結合
- 推奨は **「今日 + 前日」の 1m を取得して 1 本配列に統合**（早朝でも 24h 分くらいは確保できる）

---

### 28. Discord「推定原因」が固定文言で実エラーと矛盾する

**問題**

- `PHASE_HINTS["tier0-snapshots"]` は `"Perplexity / Grok / GMO API の一時障害"` 固定（[src/lib/cycle/phases.ts:984-1006](src/lib/cycle/phases.ts#L984-L1006)）
- 実際は GMO 1m kline だけ 404 だったが、通知では Perplexity / Grok まで疑わせる文面
- `error.message` には `"Tier 0 required sources failed for ETH: 1m kline"` と具体的に出ている

**関連**

- `src/lib/cycle/phases.ts:984-1006` — `PHASE_HINTS`
- `src/lib/cycle/phases.ts:1135-1170` — transient 通知

**修正の方向性**

- `error.message` から失敗ソース名を抽出（`Tier 0 required sources failed for X: SRC1, SRC2`）し、固定 hint より優先表示
- 該当ソースが推測できない場合のみ PHASE_HINTS にフォールバック

---

### 29. 連続失敗カウンタ表示が `4/3` まで進む（auto pause 表記が嘘）

**問題**

- `AUTO_PAUSE_THRESHOLD = 3` に対し `newCount` が 4, 5 ... と進む（§26 で実 pause しないため）
- Discord 表示は「4/3 (次回 auto pause)」を繰り返す
- ユーザから見て「次回」が永遠に来ない

**関連**

- §26
- `src/lib/cycle/phases.ts:1141-1170`

**修正の方向性**

- §26 と同時に修正される（3 で実際に pause すれば 4 以上にならない）
- フォールバックで表示用に `min(newCount, AUTO_PAUSE_THRESHOLD)` でクランプ

---

### 30. ダッシュボード「最近のサイクル」に失敗サイクルが出ない

**問題**

- `getRecentCycles` は `critic_outputs` 行を起点に作っている（[src/lib/cycle/queries.ts:209-237](src/lib/cycle/queries.ts#L209-L237)）
- 失敗サイクルは tier0/1/2/3 で abort するので `critic_outputs` 行を持たない
- 4 サイクル連続失敗中に「直近 0 サイクル / まだ実行されていません」となり、UI 上で何も起きてないように見える

**関連**

- `src/lib/cycle/queries.ts:188-237` — `RecentCycleRow` / `getRecentCycles`
- `src/db/schema/cycles.ts` — `cycles` テーブル（全サイクル分入っている）
- C2 で導入した `dashboard` cache の revalidate も関係

**修正の方向性**

- `cycles` テーブルを起点に LEFT JOIN `critic_outputs`
- `completed_at IS NULL` の行は「失敗 / 進行中」として表示（badge 出し分け）
- `criticDecision` が null の行は失敗扱い、reason 用に `system_events` から `cycle_aborted` を引いてもよい


今は実行中として表示される？？？
押すと404に飛びます

---

### 31. Entry executor が `lastPrice <= 0` で silent skip + Discord 通知が提案を表示

**症状**

- 観測ケース: 2026-05-21 JST 06:01 のサイクル。Critic 承認の Entry 3 銘柄 (BTC / XRP / SOL @ ¥125,000 each) が提案され、Discord 「🔁 サイクル完了」に 3 件表示されたが、実際は **BTC のみ約定**、entry 件数フィールドも 1。残現金からも BTC 1 件のみ実行が確定。
- `executeEntry` の前に `if (lastPrice <= 0) continue;` ([phases.ts:816](src/lib/cycle/phases.ts#L816)) があり、エラーログも通知も出さずに silent skip
- Discord の `buys` リストは `clipped.proposal` (= Critic 承認後の **提案**) を showing しているので、実行されなかった分も表示

**真因**

- `lastPrice = 0` は `loadSnapshot` で 1m bars 配列が空 → `ticker.last = "0"` ([phases.ts:204](src/lib/cycle/phases.ts#L204))
- §27 のフォールバックは GMO 404 のみカバー。**200 + 空配列** はフォールバックしないので空のまま DB に保存される

**影響**

- ユーザは「3 銘柄エントリ」と思い込むが実際は 1 銘柄のみ → 認知齟齬
- 「Entry が走らなかった理由」が一切通知されず、Sentry にも出ない (warn ログのみ)
- 累計コスト計算は問題なし（実約定のみ反映）だが UI 上の "新規 Entry" 内訳と矛盾

**関連ファイル**

- `src/lib/cycle/phases.ts` — `finalize` Entry ループ + `buys` 構築
- `src/lib/tier0/fetch-snapshot.ts` — `getKlines1mWithFallback`

**修正の方向性**

- Tier 0: 1m kline が 200 でも空配列なら前日にフォールバック (`getKlines1mWithFallback` 拡張)
- Executor: `lastPrice <= 0` のとき `skippedEntries` 配列に記録し、Discord body の `⚠️ Entry 未実行` セクションに reason 付きで出す
- 約定エラーで catch した場合も `skippedEntries` に push し、同じ表記で見せる

---

### 32. Tier 0 が渡す TF が実行レートと無関係に固定 (1m + 1d)

**症状**

- `fetchSnapshot` は **常に `1min` + `1day`** を取得 ([src/lib/tier0/fetch-snapshot.ts:116-117](src/lib/tier0/fetch-snapshot.ts#L116-L117))
- 一方サイクル間隔は 1h / 3h / 6h / 24h から選べる ([src/lib/system-control/constants.ts](src/lib/system-control/constants.ts))
- 1h サイクルでも 24h サイクルでも、LLM に渡る kline は **同じ 1m と 1d**

**設計上の問題**

- 1h サイクルなのに 1h kline が存在しない → エントリポイント判断の主役 TF が無い
- 24h サイクルに 1m を渡してもノイズしか入らない
- 1m はそもそも LLM のパターン抽出に向かず、§31 で見たように **早朝に空配列 → price=0 化** の事故源
- ticker.last を `loadSnapshot` で 1m 最後の close から疑似再構成しているのも、同じ依存

**あるべき形 (案)**

サイクル間隔ベースで「メイン TF (サイクル相当)」 + 「長期 TF (4-8 倍粗)」を動的に選ぶ。GMO interval 対応:

| サイクル | メイン TF | 長期 TF |
|---|---|---|
| 1h | `1hour` (~72 本 = 3 日) | `1day` (~30 本) |
| 3h | `4hour` (~60 本 = 10 日) | `1day` |
| 6h | `4hour` (~60 本 = 10 日) | `1day` |
| 24h | `1day` (~30 本) | (なし or `4hour` ~24 本) |

**影響**

- LLM の判断品質 (サイクル間隔と TF の整合)
- API コール数とトークン消費の削減 (1m 廃止)
- §31 の根本原因消滅 (ticker.last を kline 経由で再構成しなくなる)

**関連ファイル**

- `src/lib/tier0/fetch-snapshot.ts` — kline 取得ロジック
- `src/lib/cycle/phases.ts` — `loadSnapshot` (ticker 再構成)
- `src/db/schema/market-snapshots.ts` — `ohlcv_1m` / `ohlcv_1d` 列
- `src/lib/prompts/prompt-fallbacks/tier1/`, `tier2/` — kline を扱うプロンプト本体
- Langfuse 上の `tier1/pre-analyst` / `tier2/analyst` プロンプト

**修正の方向性 (段階的に)**

**Phase 1 (最小、価値の大半を取れる)**
- `fetchSnapshot` の `1min` 取得を廃止し、`1hour` (interval=`1hour`、date=YYYY 形式) に置換
- `getTicker` のレスポンスを直接 `market_snapshots.ticker_*` に保存 (もしくは新列 `ticker` jsonb)
- `loadSnapshot` の ticker 再構成ロジックを削除
- Tier 1/2 プロンプトの 1m 参照を 1h に置換

**Phase 2 (動的化)**
- `fetchSnapshot` に `cycleIntervalHours` を渡し、上表のマッピングで TF を選択
- `market_snapshots` に `primary_interval` / `long_interval` (text) を追加し、保存値が何の TF か明示
- Tier 1/2 プロンプトを「primary_bars / long_bars + interval メタ」前提に書き直す

**Phase 3 (任意)**
- 1m を取りたいユースケース (micro context) があれば別カラムで残す
- 長期 TF を 4-8 倍ルールではなく LLM 出力 (Tier 1 で要求) で動的指定

**スコープ感**

- Phase 1 のみ: schema 変更 1 件 + コード 50 行程度 + Langfuse プロンプト書き換え
- Phase 2 まで: schema 変更 1 件 + コード 100 行 + プロンプト全面書き換え (動的 TF 名展開)
- Phase 3: 別 PR

---

### 33. Critic に "システム健全性サマリ" を渡してデータ不全銘柄を自動的に弾けるようにする

**背景**

- 現状の Critic 入力は trading 文脈のみ (proposal / analyst summaries / decisions / positions / cash / risk params)
- システム健全性 (recent failures, data freshness, skipped executions) は Critic に見えない
- §31 のような「`ticker.last = 0` で executor が silent skip」されるケース、Critic は提案を素通しで approve してしまう
- 結果: ユーザが Discord で「3 件提案 / 1 件約定」の矛盾に気づくまで誰も止められない

**設計方針 (Option C)**

Critic に **trading 判断は委ねるが**、判断に必要な **決定論的なシステム健全性スナップ** を 1 フィールドとして注入する。

別 LLM (supervisor / postmortem) は当面導入しない。Discord 通知 + kill-switch + Sentry でシステム監視は足りる前提。

**注入する `systemHealth` (案)**

```ts
type SystemHealth = {
  consecutiveFailures: number;      // 直近の連続失敗カウンタ
  lastFailureKind: "transient" | "permanent" | "quota" | null;
  killSwitchState: "running" | "paused" | "killed";

  // 銘柄ごとのデータ取得状況。"fresh" / "stale" / "no_data"
  dataFreshness: Record<string, "fresh" | "stale" | "no_data">;

  // 当サイクルで executor が price=0 等で skip した銘柄 (もし事前判定で見える形にしたい場合)
  knownSkipRisks: string[];

  // 直近 N サイクルの成功率 (オプション)
  recentSuccessRate?: number;
};
```

Critic はこれを見て:
- `dataFreshness[X] === "no_data"` の銘柄を含む配分は **modify で 0 円に**
- `consecutiveFailures >= 2` の状態では新規 Entry を保守的に縮小、もしくは veto

**期待効果**

- §31 系の「データ無し銘柄に Entry 提案 → silent skip」の根本リスクが LLM 判断で抑制される
- システム健全性は **決定論的に集計** されるので LLM のハルシネーションに依存しない
- LLM コールは現状の Critic 1 回のみ、追加コストなし

**関連ファイル**

- `src/lib/critic/index.ts` — `CriticInput` に `systemHealth` 追加
- `src/lib/cycle/phases.ts` — `finalize` で systemHealth を集計してから `runCritic` を呼ぶ
- `src/lib/prompts/prompt-fallbacks/tier4/critic/` — プロンプトに systemHealth セクション追加
- Langfuse `tier4/critic` プロンプト

**修正の方向性**

1. `SystemHealth` 型を `src/lib/schemas/llm-outputs.ts` か新規 `src/lib/schemas/system-health.ts` に定義
2. `finalize` 内で systemHealth を集計するヘルパー (`buildSystemHealth(strategyId, ctxs)`) を追加
   - `consecutiveFailures` / `lastFailureKind` は `system_state` から
   - `dataFreshness` は `ctxs[i].snap.fetchedAt` と現在時刻、および `ticker.last` 値で判定
   - `knownSkipRisks` は `ctxs[i].snap.ticker.last <= 0` の銘柄
3. `CriticInput` に `systemHealth` 追加
4. プロンプトに systemHealth セクション (JSON で渡す) と判断指針を追記:
   - "data_freshness が `no_data` の銘柄に対する Entry は modify で 0 円にすること"
   - "consecutive_failures が 2 以上なら新規 Entry を 50% に縮小、3 以上なら全 veto"
5. Critic skip 条件 (§B の "0 buy + 0 exit") は維持 — systemHealth が悪くても trade 提案がゼロなら呼ぶ意味がない

**スコープ感**

- コード 50-80 行
- プロンプト 1 ファイル変更
- テスト: `buildSystemHealth` 単体 + Critic schema 検証
- 1 コミットで収まる規模

**今後検討 (本 issue では扱わない)**

- ポストモーテム LLM (障害時のみ Haiku で起動して原因サマリを Discord に投げる) は別 issue で
- supervisor LLM (毎サイクル監視役) は不採用

---

## 修正優先度（推奨）

| 順 | ID | 内容 |
|----|-----|------|
| 1 | §1 | Entry 仮説の永続化 |
| 2 | §26 | `recordCycleFailure` から kill-switch を呼ぶ（auto-pause が機能してない） |
| 3 | §32 | Tier 0 の TF をサイクル間隔から動的選択（1m 廃止 + 1h 追加で §31 の根治） |
| 4 | §33 | Critic に `systemHealth` を渡してデータ不全銘柄を modify で弾けるように |
| 5 | §27, §31 | GMO 1m kline 404 / 空配列 → 前日フォールバック + Entry skip 表示（§32 までの暫定対策） |
| 6 | §28, §29 | Discord 推定原因の動的化 + counter 表示クランプ |
| 7 | §30 | ダッシュボードに失敗 cycle を表示 |
| 6 | §18 | 連続失敗 auto-pause の経路修正（§4 / §20 と同時） |
| 7 | §2 | 保有中の Exit / skip_flag ポリシー統一 |
| 8 | §3 | Critic フェイルオープン |
| 9 | §4 | Inngest finalize の `recordCycleFailure` |
| 10 | §7–§9 | price-monitor / Kill Switch / 部分決済 SL（方針決定後） |
| 11 | §10–§11, §19 | 配分・リスク計算の精緻化（時価ベース + Exit 後 refresh） |
| 12 | §20, §24 | 重複定数・責務重複の集約 |
| 13 | §21–§23, §25 | レガシー列・死コード・小さな整合性 |
| 14 | §12–§17 | ドキュメント・env・テスト・リファクタ |

---

## 意図的な設計（本ドキュメントの対象外）

### 5. モデル構成の三重不一致（フォールバック全 Tier Haiku）

**意図**

- 動作検証・コスト抑制のため、フォールバック config で全 Tier を Haiku に統一している
- `docs/requirements.md`（Gemini 想定）や `docs/todo.md`（Haiku/Opus/Sonnet 本番想定）との差は **意図的**

**関連**

- `src/lib/prompts/prompt-fallbacks/tier*/shared-prompt.config.ts`
- Langfuse `production` プロンプトが別モデルなら、実行時はそちらが優先

---

## 参照

- 要件: `docs/requirements.md`
- 作業リスト: `docs/todo.md`
- パイプライン本体: `src/lib/cycle/phases.ts`
- Inngest: `src/lib/inngest/functions.ts`


サイクルページを開くのが遅い問題
(https://automatic-trading-as-llm.vercel.app/cycles/1cf45929-8940-466f-8b82-195f59d8fee5)
スケルトンだしておく？

そもそものクエリの問題？