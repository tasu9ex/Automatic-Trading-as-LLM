# 仮想通貨 LLM 自動売買システム — 要件定義 (MVP)

**プロジェクト名**: Automatic-Trading-as-LLM

最終更新: 2026-05-18

## 1. 目的

LLM を判断エンジンとして組み込んだ仮想通貨自動売買システムの実現可能性を検証する。
MVP では実資金を投入せず、本番市場データに対するペーパートレード(フォワードテスト)で
**「どの LLM・どのプロンプト・どの情報源の組み合わせが利益を出せるか」** を
検証することを主目的とする。

第一指標は **絶対利益 (元手より増えたか)**。Buy & Hold との比較は副指標(参考)。

### 1.1 最終ゴール: 完全無人運用 (Human-out-of-the-loop)

長期ビジョンは **「人間が一切介入しない完全自律 LLM トレーダー」** の確立。
利用形態は **個人の自己資金運用のみ**(法人化・他人資金運用は法規制で人間責任者必須のため対象外)。

MVP は人間介入を許容するが、設計判断は以下の原則に従う:

- **将来の無人化を阻害しない**: 「人間が判断する」ことを前提とする UI/フローを作らない
- **観測可能性を最初から組み込む**: 後から自動化する際に必要なデータ(判断ログ、評価指標)を最初から蓄積
- **メタ層を後付け可能に**: Critic, Supervisor 等の上位 LLM 層を追加できるアーキテクチャを保つ

無人化フェーズ:

| Phase | 内容 |
|-------|------|
| 1 (MVP) | 人間介入あり、データ蓄積期 |
| 2 | メタ LLM (Supervisor) 導入、プロンプト自動チューニング、モデル自動淘汰 |
| 3 | 自動ガバナンス層完成、人間介入は例外対応のみ |
| 4 | 完全無人運用 |

## 2. スコープ

### 2.1 In Scope (MVP)

- GMO コイン **取引所形式の全銘柄(20+)** を対象とするペーパートレード
- 意思決定間隔は段階的に切り替える:
  - **Phase 5a (検証期、現状)**: **1 時間ごと UTC 0 分 × 2 銘柄 (BTC/ETH)**。データ取得速度を優先、無料枠 (Vercel Hobby 60s timeout + Gemini RPM/RPD) に収まる範囲
  - **Phase 5b/5c (本格運用期)**: **1 日 1 回 JST 朝 9:00 × 20+ 銘柄** (要件本来のスイングトレード設計)
- 銘柄ごとに専用プロンプト/閾値を持つ LLM 判断エージェント
- **Tier 1 で全銘柄スクリーニング → Tier 2 は通過分のみ**
- 複数 LLM モデルの **shadow trading 並列比較** (Phase 5c)
- ダッシュボード(損益・ポジション・取引履歴閲覧)
- 手動介入(緊急停止、ポジションクローズ)
- Langfuse による LLM コール観測・評価

#### 2.1.1 Phase 5b 以降で 1日1回 × 多銘柄を採用する根拠

LLM の構造的優位を最大限活かす設計:
- **「多銘柄から選ぶ」が LLM 得意領域**: 人間が時間的にできない仕事
- **日足はノイズ少**: 1h より判断材料がクリーン
- **1日のニュースサイクルに整合**: 朝ニュース → 1日の動きというリズム
- **Tier 1 スクリーニングが本質的に機能**: 20+ 銘柄を Haiku が要約、上位だけ Opus
- **「機会なし」デッドロック回避**: 少銘柄だと「ずっと Entry/Exit できない」リスクあり、多銘柄なら常に機会あり
- **コスト効率**: 1d × 20銘柄 のほうが 1h × 2銘柄 より安い

#### 2.1.2 Phase 5a で 1h × 少数銘柄に絞る理由

- パイプライン全体のバグ早期発見のためサイクル回数を稼ぐ
- Gemini 無料枠 (15 RPM、約 500 RPD) と Vercel Hobby (60秒 function timeout) に収まる範囲が **1h × 2-4銘柄**
- 2 週間程度回したら戦略を Phase 5b に切り替え (cron を `0 0 * * *` UTC、銘柄を `enabled = true` 全件)

### 2.2 Out of Scope (MVP)

- 実資金での発注(本番取引はフェーズ 2 以降)
- レバレッジ・先物・DEX 対応
- スキャルピング/HFT
- 複数取引所同時運用
- バックテスト(過去データ再生)
  - 理由: ニュース/SNS の過去データ取得が困難。LLM の未来情報リークも考慮しフォワードテスト一本に絞る

## 3. アーキテクチャ方針

### 3.1 多層構造 (Tier 分離 + Analyst → Entry/Exit → Allocator → Critic → Clipper → Executor)

```
┌──────────────────────────────────────────────────────────┐
│ Tier 0: 情報収集 (Grok / Perplexity 等)                   │
│   ニュース・SNS の生テキスト取得                          │
└──────────────────────────────────────────────────────────┘
                              ↓
┌──────────────────────────────────────────────────────────┐
│ Tier 1: Pre-Analyst (軽量 LLM, MVP: gemini-3.1-flash-lite) │
│   役割: 要約・ノイズ除去・関連度スコア                    │
│        + Tier 2 呼び出し要否フラグ (skip_flag, reason)    │
│   出力: 構造化サマリ                                      │
└──────────────────────────────────────────────────────────┘
                              ↓
┌──────────────────────────────────────────────────────────┐
│ Tier 2: Market Analyst (重量 LLM, 銘柄ごと 1 呼び出し)    │
│   セクション別思考 (単一コール内で構造化):                 │
│     1. Fundamental / 2. Sentiment / 3. Technical          │
│     4. Synthesis → 最終市場見解 (方向性・確信度・根拠)    │
│   インターフェースは Analyst[] 拡張可能設計                │
└──────────────────────────────────────────────────────────┘
                              ↓
   ┌──────────────────┐         ┌─────────────────────────┐
   │ Entry Decision   │         │ Exit Decision (LLM)     │
   │ (LLM)            │         │ 入力: 見解 + ポジション状態 │
   │ 入力: 見解のみ    │         │ 出力: Hold / Close      │
   │ 出力: Buy + 確信度│        │                         │
   └──────────────────┘         └─────────────────────────┘
                              ↓
┌──────────────────────────────────────────────────────────┐
│ Portfolio Allocator (コード、非 LLM、全銘柄バッチ同期)    │
│   入力: 全銘柄の判定 + 現ポジション + 現金残高             │
│   方式: Equal Weight / Confidence Weighted (shadow 並走)  │
│   出力: 銘柄ごとの目標投資額                              │
└──────────────────────────────────────────────────────────┘
                              ↓
┌──────────────────────────────────────────────────────────┐
│ Critic LLM (承認/拒否/修正)                                │
│   入力: 配分案 + Analyst 見解 + 現ポジ + 現金              │
│   出力: approve / veto / modify(adjustments)              │
│   shadow trading: モデルごとに Critic を持つ              │
│   失敗時: サイクル中断 (ALL-or-NOTHING、§4.4.4 で詳述)      │
└──────────────────────────────────────────────────────────┘
                              ↓
┌──────────────────────────────────────────────────────────┐
│ Risk Clipper (コード、非 LLM)                             │
│   総投資率/銘柄上限/Kill Switch のハードガード             │
└──────────────────────────────────────────────────────────┘
                              ↓
┌──────────────────────────────────────────────────────────┐
│ Executor (コード、非 LLM)                                 │
│   ペーパートレード台帳 (将来: GMO API 発注)                │
└──────────────────────────────────────────────────────────┘
```

### 3.1.1 Tier 1 Skip 判定の運用ポリシー

20+ 銘柄を全て Tier 2 (重量モデル) に通すとコスト過大。**Tier 1 (軽量モデル) が銘柄スクリーニング** として
本質的に機能する。

運用ポリシー:
- **MVP 初期 (Phase 5a, 〜2 週間)**: Tier 1 の `skip_flag` は **記録のみ、Tier 2 は全銘柄実行**
  - 理由: skip 判定の精度を反事実 (Tier 2 を呼んでいたらどうだったか) で検証するため
  - 現状は Tier 1/Tier 2 とも `gemini-3.1-flash-lite` (無料枠で全て賄うため一時的に同一モデル)
- **Phase 5b**: Tier 1 = `gemini-3.1-flash-lite`, Tier 2 = `gemini-2.5-flash` or `gemini-2.5-pro` (有料枠で品質差テスト)
- **適用期**: Skip 判定が信頼できると確認できたら実際にスキップし、Tier 2 通過は上位 5-10 銘柄程度に絞る

### 3.1.2 Analyst の多層化方針

完全多層化(Fundamental / Sentiment / Technical を独立コール + Synthesizer)はコストとレイテンシ
が 4 倍になり MVP では効果不明。代わりに:

- **単一 LLM コール内でセクション別に構造化思考** させる(プロンプトで明示)
- 出力 JSON で各セクションを分離 → Langfuse で各セクションを独立評価可能
- インターフェースは `Analyst[]` 型として実装し、将来「Technical だけ別コールに切り出し」が容易な設計

### 3.2 設計原則

- **執行はコード、判断は LLM**: LLM に発注機能を持たせない。Function Calling での発注も避ける
- **Analyst を分離**: 同じ市場見解を Entry / Exit 双方で参照可能にし、Langfuse で「見解の質」と「判断の質」を独立に評価
- **Entry / Exit の本質的違い**: Entry は情報のみで決まる。Exit は「いつ・いくらで・どれだけ買ったか」の自己参照が必要
- **銘柄ごとに専用 LLM 呼び出し**: 1 リクエスト = 1 銘柄の判断。プロンプト・閾値を銘柄別チューニング
- **過剰文脈の回避**: Exit 入力は基本セット(建値/保有量/含み損益/保有期間/Entry 理由/保有中最大含み益損)まで。プロンプト感度を抑える
- **Shadow Trading**: 複数モデルに同一スナップショットを投げ、モデルごとに仮想ポジション台帳を別管理
- **Tier 分離**: 軽量モデルで事前要約・ノイズ除去、重量モデルで最終判断。Tier 2 のみ shadow trading で比較対象とする(Tier 1 は共通)
- **チューニングは人手**: MVP では銘柄別プロンプト/閾値は人間が手動で調整。メタ LLM による自動チューニングは過剰適合リスクが高いためフェーズ後半
- **ALL-or-NOTHING (失敗時のサイクル中断)**: 判断パイプライン (Tier 0-3 / Critic) はいずれの段でも、リトライ後の失敗があればサイクル全体を中断する。「一部の銘柄だけ進める」「Critic 不在でも売買する」といったフェイルオープンは採用しない。これにより「審査が抜けたまま売買が走る」事故を構造的に防ぐ。詳細は §4.4.4。
  - 例外: Exit (ロット決済) における "all-or-nothing" は別概念で、「部分決済をせず全量売却する」というロット方針を指す (§4.3.4)。

## 4. 機能要件

### 4.1 データ収集

#### 4.1.1 価格データ

- 価格・OHLCV: GMO コイン API から取得
- **1 分足の Low/High** を逆指値タッチ判定にも利用 (4.4.1 参照)

#### 4.1.2 ニュース・センチメント

**2 本柱で取得**:

| ソース | 役割 | クエリ内容 |
|-------|------|---------|
| **Perplexity** (Sonar API) | ニュース・規制・マクロ動向 | "{銘柄} と暗号資産市場全体の過去 1h のニュース・規制・機関動向を要約" |
| **Grok** (xAI API) | X (Twitter) センチメント | "${銘柄} および暗号資産全体の過去 1h の X センチメント、KOL 発言、トレンドを要約" |

理由:
- Perplexity = LLM + Web 検索のハイブリッド。報道機関ソースの引用付き要約が強い
- Grok = X リアルタイムデータへのネイティブアクセス権を持つ。SNS センチメントが強い
- 互いの不得意領域を補完する組み合わせ

#### 4.1.3 取得粒度・頻度

- **PerCoin 取得**: 銘柄ごとに上記 2 ソースを呼び出し、マクロ文脈もクエリ内で含めて求める
- **頻度**: **1 日 1 回 (JST 朝 9:00)** 判定サイクルと同期
- 1 サイクル: 20+ 銘柄 × 2 ソース = 40+ req
- 20+ 銘柄 で取得すると重複コストが目立つので、将来 Macro / PerCoin 分離を再検討する余地あり

#### 4.1.4 取得失敗時 (ALL-or-NOTHING)

§3.2 の ALL-or-NOTHING 原則に従い、Tier 0 のいずれかの銘柄が retry 後も取得失敗した場合は **サイクル全体を中断する**。

- transient エラー (5xx / 429 / timeout) → exp backoff で retry
- それでも失敗 → phase throw → サイクル全体 abort + Discord 通知 + `consecutiveFailures++`
- 「情報なしマーカーで判定に進む」「直前サイクルを再利用する」といったフェイルオープンは採用しない (旧方針から変更、実装と整合)

理由: 不完全な情報での売買発生を構造的に防ぐ。Tier 0 が継続的に失敗するなら連続失敗カウンタが上がって auto-pause まで自然に至る (§4.4.4)。

#### 4.1.5 保存

- 取得結果はすべて `market_snapshots` に保存
- shadow trading の全モデルが同一スナップショットを参照(モデル間の公平比較のため)
- サイクル跨ぎでの再利用はしない(時系列性を尊重)

#### 4.1.6 コスト試算

**1 リクエスト単価の目安**:

| モデル | ¥/req | 用途 |
|-------|------|------|
| Opus 4.7 | ~¥20 | 判断品質最高 |
| Sonnet 4.6 | ~¥4 | バランス |
| Gemini 2.5 Pro | ~¥2 | コスト最安級、別系統 |
| Haiku 4.5 | ~¥1 | Tier 1 要約用 |

**Phase 5a/5b 想定: GMO 取引所形式 20+ 銘柄、Opus 1 モデル、1d サイクル**:

```
Perplexity:  20 × 30 = 600 req → ~¥500
Grok:        20 × 30 = 600 req → ~¥800
Tier 1 (Haiku):  20 × 30 = 600 req → ~¥600
Tier 2 (Opus):   20 × 30 = 600 req × ¥20 = ¥12,000  (skip 適用後は 1/3 想定)
Critic (Opus):   30 × ¥20 = ¥600
────────────────────────────────────
LLM 系合計: 月 ¥14,500 (~$100)

クラウドインフラ: ¥0 (全 Free Tier)
────────────────────────────────────
総コスト: 月 ¥14,500
```

「LLM 学習費」として、検証期 1-3 ヶ月の累計は ¥5 万程度。

**Phase 5c (モデル比較)**: Opus / Sonnet / Gemini Pro の 3 モデル並走で 2-3 倍 (~¥40,000/月)。

### 4.2 判断パイプライン

1. スケジューラが起動 (**JST 朝 9:00**)
2. 全銘柄(20+)の最新スナップショットを並列生成
3. Tier 1 (Haiku) で全銘柄スクリーニング
4. 全比較対象モデルに対して並列で Tier 2 (Analyst) → Entry/Exit を実行
   - MVP 初期: skip_flag に関わらず全銘柄 Tier 2 実行
   - 検証後: Tier 1 skip_flag に従い実行を絞る
5. Allocator → Critic → Risk Clipper
6. 仮想ポジション台帳を更新

### 4.3 Portfolio Allocator (新規層)

LLM 単体は「他の銘柄も Buy 信号が出ているか」を知らないため、サイズ決定は LLM ではなく
コードで行う。Allocator は Entry/Exit 判定の **直後**、Risk Clipper の **直前** に位置する。

#### 4.3.1 入力 / 出力

- 入力: 全銘柄の Entry/Exit 判定(Buy/No/Close + 確信度), 現在のポジション, 現金残高
- 出力: 銘柄ごとの目標投資額(JPY)

#### 4.3.2 サイズ決定方式(shadow trading で 2 方式並走)

| 方式 | 計算 |
|------|------|
| **Equal Weight** | `available_cash × max_alloc / N_buy_signals` |
| **Confidence Weighted** | `available_cash × max_alloc × (conf_i / Σ conf_j)`(同モデル内正規化) |

確信度は **モデル間で意味が違う(未校正)** ため、必ず **同モデル内での相対値** として使う。
shadow trading により「モデル × サイジング方式」の 2 軸で PnL を比較する。

#### 4.3.3 判定タイミング

全銘柄バッチ同期。1 サイクル(例: 1 時間ごと)で全銘柄を判定 → Allocator で一括正規化。
イベントドリブン方式は採用しない(予算予約ロジックが複雑化するため)。

#### 4.3.3.1 Critic LLM (承認/拒否層)

Allocator のコード計算結果を LLM が **最終承認** する層。研究目的:
「LLM のメタ判断(配分の妥当性)が PnL に貢献するか」を検証する。

```
Allocator 出力 → Critic LLM
                   入力: 配分案 + Analyst 見解 + 現ポジ + 現金
                   出力: { decision: 'approve' | 'veto' | 'modify',
                          adjustments?: 銘柄ごとの修正値,
                          reasoning: 理由 }
                   ↓
        approve  → そのまま Risk Clipper へ
        veto     → このサイクルの Exit / Entry を **両方とも実行しない**
                   (Critic は配分案 + Exit 判断全体を信用しないという判定)
                   ※ price-monitor の SL は preflight 内で実行済みなので、緊急 close は別経路で確保される
                   ※ shadow trading (Phase 5c 以降) で複数モデル並走時は「該当モデルのみスキップ、他モデルは継続」
                   system_events 記録、Discord 通知
        modify   → Risk Clipper のハードガード範囲内で adjustments を適用
```

**Shadow trading 構成**: 各モデルが自分用の Critic を持つ(Trader と同じモデル)。
将来 Phase 2 で「Trader と Critic を別モデル」も比較対象に。

**安全策**:
- 拒否率モニタリング(週次レポート、50% 超で警告)
- Critic 自体の API エラー → **サイクル中断** (ALL-or-NOTHING、§3.2 / §4.4.4)。Allocator 提案そのまま採用するフェイルオープンは採用しない (「審査抜きで売買発生」を構造的に防ぐため)。transient エラーなら次サイクルで自動リトライされる。
- 拒否理由は全件 `system_events` 保存、Langfuse トレース
- 人間が Critic を一時的に止めたい場合は `system_state.state = paused` で全停止する運用 (Critic 単独を無効化する手段は提供しない)。

#### 4.3.4 ピラミッディング(追加購入)

- 同一銘柄で Buy シグナル再発時の追加購入を **許可**
- 各購入を `trades` にロット記録、Exit LLM への表示は **平均建値**
- Exit は **全決済(all-or-nothing)** ─ ロット別決済は MVP では実装しない
- 銘柄あたりハード上限(下記)で歯止め

### 4.4 ハイブリッドリスク管理

研究目的として LLM に最大権限を与えるため、ハードガードは「実験を継続するための
最低限の安全弁」に絞る。すべてパラメータ化し UI から調整可能とする。

#### 4.4.1 Risk Clipper (Allocator 出力をクリップ、二段リスクモデル)

| ガード | 段 | base | デフォルト | 趣旨 |
|--------|----|------|----------|------|
| 総投資率上限 (`TOTAL_MAX_RATIO`) | 段 3 | cash | **100%** | 現物・レバなしなので物理上限 |
| **段 1**: per-cycle 新規 buy 上限 (`perCoinMaxRatio`) | 段 1 | cash | **25%** | 1 トランザクション粒度のガード (slippage / timing) |
| **段 2**: per-coin 総エクスポージャ上限 (`perCoinTotalMaxRatio`) | 段 2 | equity | **100%** (= 制限なし) | 集中度の最終ガード。既存 + 新規 が equity × X% を超えない |
| 1 銘柄あたり下限 (最小発注) | — | — | **5,000円** | 下回る場合はスキップ(GMO 最小注文量と手数料負け回避) |
| 1 サイクル投入上限 | — | — | なし | LLM の本来の判断力を測定するため制限しない |

**二段の使い分け**:
- 段 1 (per-cycle): "1 回の判断ミスを限定"。25% で 1 トランザクションを抑える
- 段 2 (per-coin total): "累積集中を限定"。例 40% にすれば BTC への積み増しが BTC 計 40% で頭打ち
- 既定では段 2 は 1.0 (= 旧仕様互換)。UI から有効化すれば集中度ガードが効く

**clip 順序**: per-coin total cap → per-cycle cap → portfolio total cap (proportional scale)。
より厳しい cap が優先される (per-symbol headroom = min of caps)。

#### 4.4.1.1 Kill Switch DD (HWM-base, capital-injection-adjusted)

DD 評価は **HWM (High Water Mark) からの drawdown** で行う。

```
equity      = cash + Σ positions の mtm
HWM         = max(prev_HWM, equity)            ← 単調非減少、kill-switch チェック時に更新
ddFromHwm   = (HWM - equity) / HWM             ← HWM <= 0 はガード (評価 skip)
killTrigger = ddFromHwm >= portfolioDdTrigger  ← 例 0.5 = 50%
```

**入金 / 出金の扱い**: capital-injection-adjusted HWM。
- 入金時: `cash += 入金額`, `initialCashJpy += 入金額`, `HWM += 入金額`
- 出金時: `cash -= 出金額`, `initialCashJpy -= 出金額`, `HWM -= 出金額`
- これにより HWM は "performance による peak" だけを追う (外部資金で peak が跳ね上がらない)
- 履歴は `portfolio_capital_events` に残す

**Kill 後の HWM**: 保持 (リセットしない、ファンド標準)。手動再開後も過去 peak に対する DD で評価。

実装: [kill-switch/index.ts](../src/lib/kill-switch/index.ts) / [capital/index.ts](../src/lib/capital/index.ts)

#### 4.4.2 緊急停止 — 2 階層構造

**個別緊急 SL (銘柄単位、2 段階構成)**

Entry 時にコードが自動で 3 本の pending_orders を配置:

| # | kind | trigger | limit | スリッページ | 役割 |
|---|------|--------|------|-------------|------|
| 1 | `stop_limit_primary` | 建値 × 0.75 (-25%) | 建値 × 0.73 (-27%) | なし | 通常損切り、約定品質重視 |
| 2 | `stop_market_entry` | 建値 × 0.65 (-35%) | — | 0.3% | 建値ベース最終防衛 |
| 3 | `stop_market_peak` | peak × 0.5 (-50%、trailing) | — | 0.3% | ピーク追従最終防衛 |

判定: GMO API から 1 分足取得、price-monitor (1 分ごと) が以下のルールで仮想決済:

- `stop_limit_primary`:
  - bar.low ≤ trigger (発火) **かつ** 同バー以降の bar.high ≥ limit (約定可能)
  - 約定価格 = limit、スリッページなし
- `stop_market_entry` / `stop_market_peak`:
  - bar.low ≤ trigger
  - 約定価格 = trigger × (1 - 0.003)、スリッページ 0.3% 控除

同一バー内で複数発火可能なら **Stop-Limit を優先** (より良い価格)。
1 ポジション 1 約定、他は executor 内で `active=false` に inactive 化。

通常時の損切り(-5〜-15%)は **Exit LLM の判断領域**、コード強制は -25% 以下のみ。
LUNA / FTX 級フラッシュクラッシュでも最終防衛線 (-35%, -50%) が機能する設計。

#### 4.4.1.1 約定コストモデル

すべての仮想約定で以下を控除する:

```
通常 Entry/Exit (LLM 判定の成行):
  実効金額 = 約定金額 ± (約定金額 × taker手数料率)

逆指値タッチによる強制決済:
  実効金額 = 約定金額 - (約定金額 × taker手数料率) - (約定金額 × 0.3%)
```

- 手数料率は **銘柄ごとに `coins` テーブルに GMO 公表値を保持** (Maker/Taker 別、当面は Taker のみ使用)
- **取引チャネルは取引所形式のみ**。販売所形式(実質スプレッド 2-5%)は使わない

| 層 | トリガー | 約定 |
|----|---------|-----|
| 通常損切り (Stop-Limit) | 建値比 **-25%** | 建値比 **-27%** で指値約定、スリッページなし |
| 最終防衛 entry (Stop-Market) | 建値比 **-35%** | trigger × (1 - 0.3%) で成行 |
| 最終防衛 peak (Stop-Market trailing) | ピーク比 **-50%** | trigger × (1 - 0.3%) で成行 |

(アグレッシブ設定 — LLM に思いきり判断させ、負けデータも学習材料に。検証期データを最大化する方針)

**Kill Switch (システム全体)** ─ 全停止 + 人間判断待ち

発動条件:
- ポートフォリオ累積 DD **-50%** (25万 → 12.5万 で全停止)
- LLM 判定 N=3 サイクル連続失敗
- 異常な約定失敗の連発

発動時の挙動:
1. 全保有ポジションを仮想成行で決済
2. スケジューラ停止 (新規判定を行わない)
3. UI 大バナー + Discord/Slack 緊急通知
4. 人間が原因調査 → 手動再開ボタンを押すまで停止継続

#### 4.4.3 Pending Order の更新権限

| 主体 | MVP | Phase 2+ |
|------|-----|---------|
| **コード** (Entry 時の自動配置) | ◯ | ◯ |
| **コード** (トレーリングストップ等の自動更新) | ✗ | ◯ |
| **LLM** (Exit 判定時に即時クローズ → 該当 pending order キャンセル) | ◯ | ◯ |
| **LLM** (SL/TP 値の更新提案) | ✗ | ◯ |
| **人間** (UI から任意の pending order 編集/取消) | ◯ | ◯ |

#### 4.4.4 LLM 判定失敗時のフォールバック (ALL-or-NOTHING)

§3.2 で定めた ALL-or-NOTHING 原則に従う:
**判断パイプラインのいずれかの段が、リトライ後も失敗したらサイクル全体を中断する**。
「一部銘柄だけ実行」「Critic 抜きで Allocator 採用」といったフェイルオープンは一切行わない。

```
試行 1 → エラー
       ├─ 一時的エラー(429/503/タイムアウト/overloaded) → exponential backoff で retry
       ├─ パース失敗(JSON 不正等)                      → プロンプト再送 1 回
       └─ 永続エラー(401/403/400/設定)                 → リトライせず即 throw
       ↓
全て失敗 → サイクル全体 abort + Discord 通知 + 連続失敗カウンタ++
       (個別銘柄 / Critic / その他いずれの段でも同じ扱い)

連続 N サイクル失敗 (デフォルト 3、`system_state.auto_pause_threshold` で可変)
       → 自動 pause (ポジション維持、LLM のみ停止)

ポートフォリオ DD <= -P (デフォルト -50%、`system_state.portfolio_dd_trigger` で可変)
       → Kill Switch 発動 (全 close + killed)

クォータ / billing エラー (insufficient_quota / credit balance / 402)
       → 連続失敗カウンタを通さず即 paused (`auto_pause_threshold` の対象外)
```

**カウンタ仕様**:
- `consecutiveFailures` は **同じ `lastFailureKind` (transient / permanent) が続く間だけ加算**。異種が来たらリセット。
- サイクル成功時に `consecutiveFailures: 0, lastFailureKind: null` にリセット。
- auto-pause / kill-switch 発動時もカウンタはリセットされる (再開後にゼロから再カウント)。

通知手段: Discord Webhook (MVP は 1 チャンネル垂れ流し、Embed で色分け: 緊急=赤/通常=青/レポート=緑)

### 4.5 UI (Next.js Web サービス)

スマートフォンからの閲覧・操作を想定し、**Web サービスとして公開**:

- **デプロイ**: Vercel
- **認証**: **Supabase Auth + GitHub OAuth + 事前 seed allowlist**
  - サインアップは GitHub のみ。Supabase Admin API で許可メールを事前 seed → 新規 signup を Disable
  - OAuth ログイン時、Supabase が email 一致で seed 済みユーザーに identity をリンク
  - 他人がアクセスしても「既存ユーザーなし + signup 無効」で拒否
  - middleware は `/`, `/cycles/*` を保護、未ログインなら `/login` リダイレクト
- **レスポンシブ対応**: モバイルファースト
- **機能**:
  - ダッシュボード: 損益・ポジション・取引履歴・モデル別パフォーマンス
  - LLM 思考ログ閲覧 (Langfuse 埋め込み or 独自ビュー)
  - 手動介入: 緊急停止、ポジション手動クローズ
  - パラメータ調整: プロンプト、使用モデル切替 (将来)

### 4.6 Shadow Trading スコアリング・週次レポート

複数の仮想ポートフォリオ(モデル × サイジング方式の全組み合わせ)を並走させているため、
定期的に成績を比較してチューニング判断と模型淘汰の材料にする。

#### 4.6.1 スコアリング指標

| カテゴリ | 指標 |
|---------|------|
| **絶対性能** | **絶対リターン (元手比%)**、Buy & Hold との差分 (参考) |
| **リスク調整** | シャープレシオ、ソルティノレシオ、最大 DD |
| **取引特性** | 勝率、平均 RR (リスクリワード比)、平均保有期間、取引頻度 |
| **コスト** | LLM 課金額(累計)、約定コスト合計、ネット PnL |
| **コスト効率** | リターン ÷ LLM コスト |

#### 4.6.2 レポーティング

- 週次集計 (cron で毎週日曜 00:00 等)
- 出力先: **UI ダッシュボードの「週次」タブ**
- 全組み合わせをランキング表示、銘柄別ブレークダウンも提供

#### 4.6.3 モデル淘汰

- **手動運用** (MVP)
- UI から各 (モデル × サイジング方式) 組み合わせを ON/OFF 切替
- 自動淘汰はデータ不足での誤判定リスクが大きいため不採用
- 人間がレポートを見て劣後組み合わせを停止 → コスト削減

### 4.7 起動・再開フロー

UI メイン、CLI も用意(UI 不調時のバックアップ)。

#### 4.7.1 初期起動 (1 回のみ)

1. Vercel デプロイ + 環境変数セット
2. Supabase: マイグレーション、pg_cron 設定、Vault に API キー登録
3. Langfuse: プロンプト初期登録 (label: "production")
4. UI に初期残高 ¥250,000 + 対象銘柄 (BTC, ETH) 入力
5. UI 「システム起動」ボタン → `state = 'running'`
6. pg_cron が判定サイクル開始

#### 4.7.2 通常運用

- 1h サイクル: 判定 → 仮想約定 → DB 更新 → Discord 通知
- 1min サイクル: 価格監視 → pending_orders タッチ判定

#### 4.7.3 Kill Switch 発動時

1. 全ポジション仮想成行クローズ (スリッページ込み)
2. `state = 'killed'`、スケジューラ判定 skip
3. Discord 緊急通知 (Embed 赤) + UI 大バナー
4. 人間が原因調査 (Sentry / Langfuse / DB 確認)

#### 4.7.4 再開フロー

1. 必要なら修正 (Langfuse でプロンプト編集、コード fix 等)
2. UI 「再起動」ボタン (または CLI: `npm run resume`)
3. 確認モーダル: 「失敗カウンタリセット、判定再開しますか?」
4. `state = 'running'`、連続失敗カウンタゼロクリア
5. 次サイクルから判定再開

### 4.8 プロンプト管理 (Langfuse)

- Git ではなく **Langfuse Prompt Management** で管理
- 各プロンプトに名前 + バージョン + ラベル ("production" 等)
- スマホからも UI で編集可能
- LLM コール時に最新の "production" 版を取得 → トレースに紐付け
- A/B テスト機能あり (Phase 5c で活用)

### 4.9 観測

- 全 LLM コールを Langfuse にトレース
- セッション = 1 つの判断サイクル、トレース内に Analyst/Entry/Exit のスパン
- 評価メトリクス: シグナル → 実際の値動きの相関 (フォローアップ評価)

## 5. 非機能要件

### 5.1 信頼性

- スケジューラ遅延に強い設計 (GitHub Actions cron は使わない)
- LLM 呼び出し失敗時はリトライ → それでも失敗ならサイクル全体 abort (ALL-or-NOTHING、§3.2 / §4.4.4)
- 「判断なし」も明示的に記録

### 5.2 セキュリティ

- API 鍵は Supabase Vault に保管、ワーカーのみ取得
- ペーパー期間は `.env` で十分、本番移行時に Vault に移す
- UI 認証は Supabase Auth + GitHub OAuth、Admin API での事前 seed allowlist でアクセス制限

### 5.3 コスト

- スイング × 銘柄数 × モデル数 = 週間で数百〜千コール想定
- Langfuse でモデル別コスト集計

## 6. 技術スタック

**方針: 全サービス Free Tier で構成、LLM API のみ課金**。ツールはふんだんに使う(エラー監視、ジョブ観測、LLM トレース全部入れる)。

| 層 | 技術 | プラン |
|----|------|--------|
| Frontend | Next.js (App Router), TypeScript、Vercel デプロイ | **Vercel Hobby (無料)** |
| 認証 | Supabase Auth + GitHub OAuth + Middleware (個人用、許可 GitHub ID のみ) | Free |
| DB | Supabase (Postgres) | Free (500MB) |
| ORM | Drizzle | OSS |
| 定期実行 + 判定オーケストレーション | **Inngest** (cron + ジョブ可視化、自動リトライ、並列度制御) | **Inngest Free (50k steps/月)** |
| LLM 観測 | Langfuse | Cloud Free (50k events/月) |
| エラー監視 | **Sentry** | Developer Free (5k errors/月) |
| Lint/Format | Biome | OSS |
| Dead code | Knip | OSS |
| CI | GitHub Actions | Public Free |
| 通知 | Discord / Slack Webhook | Free |
| LLM (Tier 1 / Tier 2 / Critic) | Phase 5a: `gemini-3.1-flash-lite` (無料枠で全段共用)、Phase 5b 以降: Tier 2 を Gemini Pro/Claude Sonnet/Opus に分岐、Phase 5c で並走 | Phase 5a 無料、以降課金 |
| 情報収集 | Phase 5a: 取得失敗フォールバック (キー未設定で「情報なし」)、Phase 5b 以降: Perplexity Sonar / Grok API | Phase 5a 無料、以降課金 |

### 6.1 スケジューラ・実行構成

```
[トリガー]
  Inngest cron (Free 50k steps/月):
    - cron 設定で判定サイクルを直接発火 (Phase 5a: "0 * * * *" 毎時, Phase 5b: "0 0 * * *" UTC = JST 9時)
    - 月 720 steps (1h)、Free 枠 1.4%
    - 別途 pg_cron は使わない (Inngest cron で完結)

[判定パイプライン]
  runJudgmentCycle (Vercel /api/inngest):
    - 1cycle = 1 step.run、30〜60秒で完走 (Vercel Hobby 60秒 timeout 内)
    - パイプライン構成:
        1. GMO 取引所メンテチェック
        2. Kill switch チェック (killed なら早期 return)
        3. Price-monitor (前回サイクル以降の 1m バーで逆指値タッチ判定、ペーパー専用)
        4. 銘柄並列: Tier 0 → Tier 1 → Tier 2 → Entry/Exit Decision
        5. Allocator → Critic → Risk Clipper
        6. Executor (仮想約定: Exit 優先 → Entry)
        7. system_state 更新 + Kill switch 再チェック
    - ジョブダッシュボードで可視化、自動リトライ標準

[価格監視]
  judgment cycle 内に統合 (旧設計の独立 price-monitor は廃止):
    - 前回 cycle 時刻から現在までの 1m バーを全て replay
    - 逆指値タッチ判定 → SL 発火 → executor 強制クローズ
    - 実マネー運用時 (Phase E) は GMO 取引所側で動くのでこの処理は不要

[フロント]
  Vercel Hobby (Free):
    - Next.js ダッシュボード、/api/inngest endpoint hosting
    - middleware で Supabase Auth (GitHub OAuth) ガード
```

### 6.2 採用見送りツール (Free Tier 制約で MVP には不向き)

- **GitHub Actions cron**: 遅延常態化、本番スケジューラ不適 (CI/CD のみ使用)
- **Trigger.dev Free**: 1k runs/月で MVP 規模に届かない
- **Vercel Pro**: 不要、Inngest cron + Vercel Hobby 60秒 timeout で十分
- **Supabase pg_cron**: Inngest cron で全て完結するため未使用
- **Supabase Edge Functions**: 価格監視を judgment cycle に統合したため未使用

## 7. データモデル(最低限)

| テーブル | 役割 |
|---------|------|
| `coins` | 対象銘柄マスタ、銘柄別パラメータ、Maker/Taker 手数料率 |
| `market_snapshots` | 価格 + ニュース/SNS コンテキスト (再現可能性のため永続化) |
| `pre_analyst_outputs` | Tier 1 の要約・ノイズ除去結果と skip_flag |
| `analyst_outputs` | Tier 2 の構造化見解 (モデル別、セクション分割) |
| `decisions` | Entry/Exit 判断結果 (モデル別) |
| `orders` | 仮想発注 (Risk Clipper 通過後) |
| `pending_orders` | 配置済みの逆指値・指値 (個別緊急 SL 等)、position に紐づく |
| `positions` | 現在保有 (モデル別 = shadow trading 用、ロット情報含む) |
| `trades` | 約定履歴 |
| `system_events` | Kill Switch 発動、エラー、人間介入の履歴 |

将来増加前提。MVP は最低限から開始。

## 8. 成功指標

実験期間中(初期は 1 週間、以降継続改善)の評価:

- **第一指標**: **絶対利益 (元手より増えたか)**
- **副指標**:
  - Buy & Hold リターンとの比較 (相対パフォーマンス参考)
  - シャープレシオ (リスク調整後リターン)
  - 勝率 / リスクリワード比
  - 最大ドローダウン
  - LLM 判断の説明性・一貫性 (定性レビュー)

### 8.1 モデル比較方法

同一市場スナップショットを全モデルに投げ、モデルごとに独立した仮想ポジション台帳を保持する
(shadow trading)。これにより市場差・銘柄差ではなくモデル差のみを評価できる。

## 9. フェーズ

| フェーズ | 内容 | 期間目安 |
|---------|------|---------|
| 0 | 要件定義・アーキテクチャ設計 | 〜本書 |
| 1 | 基盤構築 (Next.js / Supabase / Drizzle / Langfuse 接続) | 1 週 |
| 2 | データ収集 + Analyst 単体動作 | 1 週 |
| 3 | Entry/Exit + Risk Clipper + ペーパー台帳 | 1〜2 週 |
| 4 | UI ダッシュボード + 緊急停止 | 1 週 |
| **5a (システム検証)** | 1 モデル × 20+ 銘柄で動かし、1d サイクルの安定性を確認 | 2-4 週 |
| **5b (利益検証)** | 同一構成で継続稼働、仮想 PnL を観察 | 8-16 週 (1d サイクルなので長め) |
| **5c (モデル比較)** | Shadow trading 有効化、複数モデル並走 | 16 週+ |
| 6 | 結果分析 → 本番取引移行可否判断 | — |

1d サイクルにより 1h より検証期間が長くなる(月 30 サイクル × 20 銘柄 = 600 判断/月、これでも統計的に十分)。

### 9.1 段階分けの根拠

**モデル比較は最後** に行う。理由:
- Phase 5a/5b で要件・プロンプトの粗が露呈する。それを直してから複数モデル比較する方がシグナル/ノイズ比が良い
- いきなり多モデル走らせるとバグかモデル差か切り分け不能
- Shadow trading 機能はインターフェース実装のみ、Phase 5c から有効化

各フェーズの分岐条件:

| フェーズ | 進む条件 | 撤退/見直し条件 |
|---------|---------|---------------|
| 5a → 5b | サイクル成功率 95%+、JSON パース失敗ほぼなし | 安定しない → アーキ見直し |
| 5b → 5c | 仮想 PnL が **プラス (絶対利益あり)** | マイナス継続 → プロンプト見直し or 撤退 |
| 5c → 6 | 最良モデル/サイジングが特定でき、再現性ある | 全モデル劣後 → 戦略再考 |

## 10. 未決事項

### 10.1 MVP 開始前に必要 (確定済み)

- **対象銘柄リスト**: **GMO 取引所形式の全銘柄 (20+)**
- **判定頻度**: **1 日 1 回、JST 朝 9:00**
- **仮想ポートフォリオ初期残高**: **¥250,000**
- **shadow trading**: インターフェースは shadow 対応、**Phase 5a/5b は 1 モデル (Opus) × 1 サイジング (Confidence Weighted)** から開始、Phase 5c で複数モデル比較
- **Critic veto 時の挙動整合性**: shadow trading (Phase 5c 以降) では「該当モデルのみスキップ、他モデルは継続」。単一モデル運用 (Phase 5a/5b) では結果的にサイクル全体スキップと等価 (修正済み)

### 10.2 MVP 開始前に必要 (未決)

- **銘柄別チューニング = 具体的に何を変えるか** (Phase 5b 以降で詰める)

### 10.2 実装フェーズで詰める

- LLM の I/O JSON スキーマ (Pre-Analyst / Analyst / Entry / Exit / Critic 各出力)
- 初期プロンプトテンプレート (試行錯誤しながら作成)
- 銘柄別の具体的プロンプト調整

### 10.3 個人用なので簡素化

- UI 認証: Supabase Auth + **GitHub OAuth** + 事前 seed allowlist (Admin API でユーザー seed → signup 無効化)
- 環境分離: 単一環境 (dev/prod 分けない)
- データバックアップ: Supabase 標準機能で十分
- インフラ IaC: 不要 (手動セットアップで OK)
