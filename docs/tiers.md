# Tier 別 入出力マップ

各層が「何を受け取り → 何を出し → どこに渡すか」をまとめた早見表。
コードと乖離したら更新する(authoritative なのはあくまでコード)。

## 設計原則: 「市場価格は JPY、ポートフォリオ金額は隠す」


| データ種別                         | Tier 0 | Tier 1 | Tier 2 | Tier 3           | Critic / Code |
| ----------------------------- | ------ | ------ | ------ | ---------------- | ------------- |
| 市場価格 (OHLCV / ticker、JPY 必須)  | ✅      | ✅      | ✅      | ✅ last_price_jpy | ✅             |
| ポートフォリオ金額 (cash / equity)     | ❌      | ❌      | ❌      | ❌                | ✅             |
| ポジション金額 (建値 / 保有量 / 含み損益 JPY) | ❌      | ❌      | ❌      | ❌                | ✅             |
| 含み損益 **%**                    | ❌      | ❌      | ❌      | ✅ Exit のみ        | ✅             |


→ Tier 0-3 は「マーケットを読む」「サイズを抽象 % で決める」役。
→ Critic + コードは「自分の財布事情を踏まえて最終調整」役。

---

## Tier 0 — Snapshot 収集

**役割**: 銘柄ごとの市場スナップショット(ニュース + センチメント + 価格 + 板)を集める。

### 入力


| ソース                   | 内容                                | 種別      |
| --------------------- | --------------------------------- | ------- |
| GMO Ticker API        | 直近価格 (last / bid / ask / volume)  | 外部 API  |
| GMO Kline API         | OHLCV 直近 200 本(サイクル interval と一致) | 外部 API  |
| GMO Orderbook API     | 板情報 (top-5 bids / asks)           | 外部 API  |
| GMO Recent Trades API | 直近 100 約定                         | 外部 API  |
| Perplexity Sonar Pro  | ニュース要約 (LLM 生成)                   | **LLM** |
| Grok                  | X (Twitter) センチメント要約 (LLM 生成)     | **LLM** |


### 出力 (`Snapshot` / `market_snapshots` テーブル)


| フィールド                 | 型                                                                     | 内容                    | 渡り先                           |
| --------------------- | --------------------------------------------------------------------- | --------------------- | ----------------------------- |
| `perplexitySummary`   | string (Markdown)                                                     | ニュース要約                | Tier 1 / Tier 2               |
| `perplexityCitations` | string[]                                                              | 引用 URL                | ダッシュボード表示                     |
| `grokSummary`         | string (Markdown)                                                     | センチメント要約              | Tier 1 / Tier 2               |
| `grokCitations`       | string[]                                                              | 引用 URL                | ダッシュボード表示                     |
| `ohlcv`               | OHLCBar[] (200)                                                       | サイクル interval の Kline | Tier 1 (3 本) / Tier 2 (200 本) |
| `klineInterval`       | string                                                                | "1hour" etc           | Tier 2 (prompt 内表記)           |
| `ticker`              | {last, bid, ask, volume}                                              | 価格                    | finalize (mtm 計算)             |
| `micro`               | {spreadPct, bidDepth5, askDepth5, bidBias, tradeBuyRatio, tradeCount} | 板 + 直近約定の集計           | Tier 2                        |


### ゴミなし

自由テキスト出力のため使われない enum 等は無し。

---

## Tier 1 — Pre-Analyst (Haiku)

**役割**: 軽量 LLM で銘柄スクリーニング。深掘り価値を判定。

### 入力


| 変数                   | 内容                    | 由来           |
| -------------------- | --------------------- | ------------ |
| `symbol`, `name`     | 銘柄識別                  | DB           |
| `perplexity_summary` | ニュース要約                | Tier 0       |
| `grok_summary`       | センチメント要約              | Tier 0       |
| `price_snapshot`     | OHLCV 直近 **3 本**(超軽量) | Tier 0       |
| `cycle_interval`     | "30 分" / "12 時間" 等    | system_state |


### 出力 (`PreAnalystOutputSchema` / `pre_analyst_outputs` テーブル)


| フィールド       | 型      | 内容                                   | 渡り先                            |
| ----------- | ------ | ------------------------------------ | ------------------------------ |
| `summary`   | string | 後続アナリストが見落とすと困るハイライト                 | Tier 2 (`pre_analyst_summary`) |
| `skip_flag` | bool   | true なら Tier 2 以降スキップ(**保有/未保有問わず**) | Tier 2 gate                    |
| `reasoning` | string | skip_flag の理由(1 行、ログ用)               | Tier 2 (JSON 内) / ダッシュボード      |


### 注

- 保有銘柄でも `skip_flag=true` なら Tier 2/3 まるごとスキップ。
「市場に変化がなければ Exit 判断も不要」というポリシー。
trailing SL / Kill Switch は price-monitor が独立に動くので安全網は維持される

---

## Tier 2 — Analyst (Opus)

**役割**: 重量 LLM で銘柄ごとの市場見解(4 セクション統合)。

### 入力


| 変数                             | 内容                           | 由来           |
| ------------------------------ | ---------------------------- | ------------ |
| `symbol`, `name`               | 銘柄識別                         | DB           |
| `pre_analyst_summary`          | Tier 1 の全出力 JSON             | Tier 1       |
| `perplexity_summary`           | ニュース全文                       | Tier 0       |
| `grok_summary`                 | センチメント全文                     | Tier 0       |
| `kline_interval`, `bars_count` | "1hour", "200" 等             | Tier 0       |
| `ohlcv_brief`                  | OHLCV テキスト(200 本)            | Tier 0       |
| `micro_market`                 | spread/depth/buyRatio (JSON) | Tier 0       |
| `cycle_interval`               | サイクル間隔                       | system_state |


### 出力 (`AnalystOutputSchema` / `analyst_outputs` テーブル)


| フィールド                     | 型                                   | 内容                                  | 渡り先                                   |
| ------------------------- | ----------------------------------- | ----------------------------------- | ------------------------------------- |
| `fundamental.notes`       | string                              | ファンダ自由記述                            | Tier 3 (`analyst_full`) / Critic      |
| `fundamental.confidence`  | 0-1                                 | 観測用                                 | ダッシュボード                               |
| `sentiment.notes`         | string                              | センチメント自由記述                          | Tier 3 / Critic                       |
| `sentiment.confidence`    | 0-1                                 | 観測用                                 | ダッシュボード                               |
| `technical.notes`         | string                              | テクニカル自由記述(S/R / トレンドなどは notes 内で言及) | Tier 3 / Critic                       |
| `technical.confidence`    | 0-1                                 | 観測用                                 | ダッシュボード                               |
| `**synthesis.direction`** | `long_bias` / `flat` / `short_bias` | **Analyst の主結論**                    | Tier 3 / Critic                       |
| `synthesis.confidence`    | 0-1                                 | direction 確信度                       | ダッシュボード                               |
| `synthesis.reasoning`     | string                              | 3 セクション統合の根拠                        | Tier 3 (`analyst_synthesis`) / Critic |


---

## Tier 3 — Entry / Exit Decision (Sonnet)

**Tier 3 はポートフォリオ金額を一切見ない**(価格は Analyst の text 内のみ)。サイズは抽象 % で表現。

### 3a. Entry Decision

**役割**: 未保有銘柄について「Buy or No」+ サイズ判断(抽象 %)。

### 入力


| 変数                  | 内容                             | 由来           |
| ------------------- | ------------------------------ | ------------ |
| `symbol`, `name`    | 銘柄識別                           | DB           |
| `analyst_synthesis` | Analyst の synthesis セクション JSON | Tier 2       |
| `analyst_full`      | Analyst の全出力 JSON              | Tier 2       |
| `last_price_jpy`    | 現在価格(ticker、JPY)               | Tier 0       |
| `cycle_interval`    | サイクル間隔                         | system_state |


→ portfolio / position の JPY は渡さない(`last_price_jpy` は市場価格 = 公開事実なので可)。
   サイズ判断は「max を 100 とした時、何 % 使う?」だけ問う。

### 出力 (`EntryDecisionOutputSchema` / `decisions` テーブル kind=entry)


| フィールド        | 型                | 内容                   | 渡り先                         |
| ------------ | ---------------- | -------------------- | --------------------------- |
| `decision`   | `buy` / `no`     | 判定                   | Allocator (filter) / Critic |
| `confidence` | 0-1              | 観測専用(Critic にも渡さない)  | ダッシュボード                     |
| `size_pct`   | int 1-100 | null | max の何 % 投入(buy 時必須) | Allocator → JPY 変換 / Critic |
| `reasoning`  | string           | 判断根拠                 | ダッシュボード / Critic            |


---

### 3b. Exit Decision

**役割**: 保有銘柄について「Hold or Close」+ 決済比率(抽象 %)。

### 入力


| 変数                                  | 内容                     | 由来           |
| ----------------------------------- | ---------------------- | ------------ |
| `symbol`, `name`                    | 銘柄識別                   | DB           |
| `analyst_synthesis`, `analyst_full` | Tier 2 出力              | Tier 2       |
| `last_price_jpy`                    | 現在価格(ticker、JPY)       | Tier 0       |
| `position_state`                    | **含み損益 % + 保有期間日数** のみ | finalize で計算 |
| `cycle_interval`                    | サイクル間隔                 | system_state |


→ 建値・保有量・含み損益 JPY・peak/trough・Entry 理由はすべて非表示。
   含み損益 % = `(現在価値 - 建値コスト) / 建値コスト × 100`
   `last_price_jpy` は市場価格(公開事実)なので渡す。

### 出力 (`ExitDecisionOutputSchema` / `decisions` テーブル kind=exit)


| フィールド        | 型                | 内容                  | 渡り先                                     |
| ------------ | ---------------- | ------------------- | --------------------------------------- |
| `decision`   | `hold` / `close` | 判定                  | execution-plan / Executor               |
| `confidence` | 0-1              | 観測専用(Critic にも渡さない) | ダッシュボード                                 |
| `close_pct`  | int 1-100        | 決済比率(部分決済可)         | execution-plan / Critic 修正可能 / Executor |
| `reasoning`  | string           | 判断根拠                | ダッシュボード / Critic                        |


---

## コード層: Allocator + Risk Clipper(LLM ではない)

**役割**: Entry 出力 + 既存ポジション + 現金 から「実行直前の計画」を作る純関数。
LLM が抽象 % で語ったものを **ここで初めて JPY 額に変換**。

### 入力


|                  | 内容                                                     | 由来              |
| ---------------- | ------------------------------------------------------ | --------------- |
| `signals`        | 各銘柄の entry (`size_pct`) / exit (`close_pct`) / 既存ポジション | Tier 3          |
| `currentCashJpy` | 現金                                                     | portfolios テーブル |
| `riskParams`     | perCoinMaxRatio / perCoinTotalMaxRatio                 | system_state    |


### 内部処理

1. Exit dry-run: `qty × close_pct/100 × 現在価格 × (1 - fee)` → 期待回収 cash
2. `max_budget = currentCash × perCoinMaxRatio` を計算
3. Allocator: `proposal[sym] = max_budget × (size_pct / 100)`
4. Risk Clipper: 段 2 (per-coin total cap) + portfolio total cap proportional scale + floor remainder

### 出力 (`ExecutionPlan`)


| フィールド              | 内容                                                         | 渡り先               |
| ------------------ | ---------------------------------------------------------- | ----------------- |
| `entries`          | Clipper 適用済の Entry 配分 (symbol → jpy)                       | Critic / Executor |
| `exits`            | Exit 予定 (symbol → {closePct, qtyToClose, expectedCashJpy}) | Critic / Executor |
| `currentPositions` | サイクル開始時の mtm                                               | Critic / ダッシュボード  |
| `plannedPositions` | 実行後の見込み mtm                                                | Critic / ダッシュボード  |
| `projectedCashJpy` | Exit 後の見込み現金                                               | Critic            |
| `clipperChanges`   | Clipper が削った変更ログ                                           | Critic / ダッシュボード  |


---

## Tier 4 — Critic (Opus)

**役割**: 実行計画を最終チェック。approve / veto / modify。
**Tier 2/3 の全文** + ポートフォリオ金額 + リスクパラメータを統合して判断。

### 入力


| 変数                       | 内容                                                                                          | 由来                     |
| ------------------------ | ------------------------------------------------------------------------------------------- | ---------------------- |
| `execution_plan`         | 上記 ExecutionPlan 全体 (JPY 換算後)                                                               | Allocator + Clipper    |
| `analyst_full_by_symbol` | symbol → Analyst 全フィールド(**confidence 除く**: notes / direction / reasoning)                   | Tier 2                 |
| `decisions_by_symbol`    | symbol → entry/exit 全フィールド(**confidence 除く**: decision / size_pct or close_pct / reasoning) | Tier 3                 |
| `symbol_to_name`         | symbol → 正式名称                                                                               | coins                  |
| `cash_jpy`, `equity_jpy` | 実値                                                                                          | portfolios + positions |
| `system_health`          | dataFreshness / knownSkipRisks / consecutiveFailures / lastFailureKind                      | system_state + 集計      |
| `cycle_interval`         | サイクル間隔                                                                                      | system_state           |


→ Tier 2/3 の confidence は **意図的に Critic に渡さない**(LLM の自己申告で判断材料に向かないため)。
→ `risk_params` も渡さない。adjustments が pct ベース化したことで、ハードガード違反は構造的に発生しなくなったため(Schema で pct ≤ 100 強制、JPY 換算と総額調整はコード = Clipper の責任)。
   リスク状況は `execution_plan.clipperChanges` で「何が削られたか」が読めるので、Critic は暗黙に把握できる。

### 出力 (`CriticOutputSchema` / `critic_outputs` テーブル)


| フィールド               | 型                                | 内容                                | 渡り先                                    |
| ------------------- | -------------------------------- | --------------------------------- | -------------------------------------- |
| `decision`          | `approve` / `veto` / `modify`    | 最終判定                              | Executor 起動可否 / ダッシュボード Badge          |
| `confidence`        | 0-1                              | Critic 自身の判断確信度(観測用)              | ダッシュボード                                |
| `adjustments.buys`  | record<symbol, int 0-100> | null | entries の **size_pct** 上書き(0 で個別除外) | applyModify → Allocator 再計算 → Executor |
| `adjustments.exits` | record<symbol, int 0-100> | null | exits の **close_pct** 上書き(0 で個別 Exit キャンセル) | applyModify → Executor |
| `reasoning`         | string                           | 判断根拠                              | ダッシュボード                                |


→ adjustments は **JPY ではなく pct ベース** に統一(Entry/Exit と同じ単位、対称性確保)。
  Critic も「max の 80% → 50% に絞れ」のような相対的判断で済む。

### 派生(DB に格納する非 LLM 値)

- `executionPlan` (jsonb): LLM 入力をそのまま保存(再現性のため)
- `modifiedPositions` (jsonb): `applyModify(plan, adjustments)` の結果

---

## 全体フロー図

```
[Tier 0: Snapshot]
  Perplexity + Grok + GMO API
       │
       ├─► summary + citations + ohlcv + ticker + micro
       │
[Tier 1: Pre-Analyst (Haiku)]
  ← summary, ohlcv(3本), grok, perplexity
       │
       ├─► summary + skip_flag + reasoning
       │
[Tier 2: Analyst (Opus)]
  ← pre_analyst + summary + grok + ohlcv(200本) + micro
       │
       ├─► fundamental/sentiment/technical (notes+conf)
       │   + synthesis (direction + conf + reasoning)
       │
[Tier 3: Entry/Exit (Sonnet)] ────────── 並列実行 (portfolio JPY 非表示、市場価格は OK)
  Entry ← analyst + last_price_jpy         Exit ← analyst + last_price_jpy + 含み損益% + 保有日数
       │                                          │
       ├─► decision + confidence + size_pct       ├─► decision + confidence + close_pct
       │     (1-100、max の何%)                   │     (1-100、保有量の何%)
       │                                          │
       └──────────┬───────────────────────────────┘
                  │
[Allocator + Clipper] (コード、純関数、ここで初めて JPY 化)
  ← signals (size_pct / close_pct) + currentCash + riskParams
       │
       ├─► ExecutionPlan (entries JPY / exits JPY / projected / clipperChanges)
       │
[Tier 4: Critic (Opus)]
  ← execution_plan + analyst_full + decisions(confidence 除く) + cash/equity/system_health
    (risk_params は渡さない: adjustments が pct なのでハードガード違反は構造的に起きない)
       │
       ├─► approve / veto / modify
       │   + confidence + adjustments {buys: pct, exits: pct} + reasoning
       │
[Executor]
  ← final plan (Critic 適用済、JPY)
       │
       ├─► Exit 約定 → Entry 約定 → positions / orders 更新
       │
[State Update / Kill Switch / Cost Notify]
```

---

## 重要な設計ポリシー

1. **冪等性**: 各 phase で DB 存在チェック → 既に書かれてる行はスキップ(retry 安全)
2. **ALL-or-NOTHING**: 1 銘柄でも retry 後失敗で phase throw → サイクル全体 abort、`consecutiveFailures++`
3. **保守的サイジング**: Entry の `max_budget` は **現在 cash ベース**(Exit 見込み回収を含めない)。Exit が約定失敗してもサイクル全体が破綻しないように
4. **JPY 抽象化**: Tier 0-3 は portfolio / position の JPY を見ない。サイズは Entry の `size_pct` と Exit の `close_pct` で % 表現。コード層と Critic だけが JPY を扱う
5. **confidence は観測専用**: 全 tier の confidence は LLM の自己申告で、Allocator / Critic も値を判断材料に使わない
6. **Critic は最終ゲート**: Clipper 適用済の数字を見て判断 → approve なら即発注、veto なら全停止

