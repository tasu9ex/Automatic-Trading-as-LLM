# 既知の問題・不整合一覧

最終更新: 2026-05-21

§1-§4, §8-§13, §15-§16, §18-§20, §22-§23, §25-§33 は一括修正で解消済 (commit 履歴は git log 参照)。
本ドキュメントは **現在未解決の項目のみ** に整理。

修正優先度の目安: **P0** = 研究・運用の正しさに直結 / **P1** = 障害・観測の穴 / **P2** = ドキュメント・将来機能

---

## P1 — 運用リスク・挙動のずれ

### 7. `price-monitor` 失敗時はサイクル継続

**症状**

- `preflight` 内で `runPriceMonitor` が throw しても catch してサイクル継続
- Discord に「逆指値判定がスキップ」と通知

**スコープ**

- `price-monitor` は **paper-trade 期間限定** の SL 模擬機構。real-mode (§14) では取引所側 SL を使うため削除予定。
- paper 期間は kill-switch (-50% DD) と LLM Exit (§2 で保有中は必ず実行されるようになった) でバックアップされる。
- 当面挙動変更なし。**§14 着手時に price-monitor 自体を削除**。

**関連ファイル**

- `src/lib/cycle/phases.ts` — `preflight`
- `src/lib/price-monitor/index.ts`

---

### 24. Allocator と Risk Clipper の per-coin cap が二重判定

**症状**

- Allocator 内: `perCoinCap = availableCash × perCoinMaxRatio` ([allocator/index.ts:31](src/lib/allocator/index.ts#L31))
- Risk Clipper 内: 同じ式で再度 cap ([clipper.ts:26](src/lib/risk/clipper.ts#L26))
- 共通定数は §20 で `src/lib/constants/risk.ts` に集約済 — 両者は同じ値を import するため不整合は出ない

**現状判断**

- 「2 段ガードとして安全側」の defensive redundancy として **許容**
- §17 (UI からリスクパラメータ調整) を実装するときに Allocator vs Clipper の責務分離を同時整理予定

**関連ファイル**

- `src/lib/allocator/index.ts`
- `src/lib/risk/clipper.ts`

---

## P2 — ドキュメント・未実装・保守

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

- MVP スコープ外。Phase 5c 着手時に対応。

---

### 14. `PAPER_TRADE=false` (実取引) は未実装

**症状**

- `placeEntryOrder` / `placeExitOrder` が REAL mode で throw
- GMO Private API 連携・fill worker は stub コメントのみ

**関連ファイル**

- `src/lib/executor/index.ts`
- `docs/todo.md` — 実発注切替は未着手

**備考**

- 実取引切替時に §7 の price-monitor も削除する (取引所 SL に置換)。

---

### 17. UI からリスクパラメータ変更が未実装

**要件**

- `docs/requirements.md` §4.4: ハードガードは UI から調整可能とする

**現状**

- 定数は `src/lib/constants/risk.ts` に集約済 (§20) だが、変更には deploy が必要。

**関連ファイル**

- `src/lib/constants/risk.ts`
- 想定: `src/app/page.tsx` (システム制御カード) に enabledable な数値入力フィールドを追加

---

### 21. `marketSnapshots.ohlcv_1h` レガシー列の最終 drop (部分対応中)

**症状**

- §32 で新カラム (`ohlcv_primary` / `ohlcv_long` / `primary_interval` / `long_interval` / `ticker`) に移行済
- `ohlcv_1h` は `jsonb NOT NULL` のまま残置、insert 時に常に `[]` を入れる暫定対応

**残作業**

- 古い行を query する箇所が無いことを確認した上で `ALTER TABLE market_snapshots DROP COLUMN ohlcv_1h` の migration を発行
- 同タイミングで `ohlcv_1m` / `ohlcv_1d` も drop してよい (新コードは新カラムしか読まないが、cycle 詳細ページの古い記録閲覧用に残すか要判断)

**関連ファイル**

- `src/db/schema/market-snapshots.ts`
- `src/lib/cycle/phases.ts` — `tier0Snapshots` (`ohlcv1h: []` の暫定 insert)

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
- 失敗ハンドリング: `src/lib/cycle/failure.ts`
- システム健全性: `src/lib/cycle/system-health.ts`
- リスク閾値: `src/lib/constants/risk.ts`
- Inngest: `src/lib/inngest/functions.ts`
