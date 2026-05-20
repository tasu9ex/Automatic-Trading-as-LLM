# 既知の問題・不整合一覧

最終更新: 2026-05-20（2 回目レビュー追記）

コードベース全体レビューに基づく。**意図的に除外したもの**は末尾の「意図的な設計」に記載。

修正優先度の目安: **P0** = 研究・運用の正しさに直結 / **P1** = 障害・観測の穴 / **P2** = ドキュメント・将来機能

§18 以降は 2 回目レビューで追加された項目。

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

## 修正優先度（推奨）

| 順 | ID | 内容 |
|----|-----|------|
| 1 | §1 | Entry 仮説の永続化 |
| 2 | §18 | 連続失敗 auto-pause の経路修正（§4 / §20 と同時） |
| 3 | §2 | 保有中の Exit / skip_flag ポリシー統一 |
| 4 | §3 | Critic フェイルオープン |
| 5 | §4 | Inngest finalize の `recordCycleFailure` |
| 6 | §7–§9 | price-monitor / Kill Switch / 部分決済 SL（方針決定後） |
| 7 | §10–§11, §19 | 配分・リスク計算の精緻化（時価ベース + Exit 後 refresh） |
| 8 | §20, §24 | 重複定数・責務重複の集約 |
| 9 | §21–§23, §25 | レガシー列・死コード・小さな整合性 |
| 10 | §12–§17 | ドキュメント・env・テスト・リファクタ |

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
