/**
 * Tier 0 Sentiment — X (Twitter) のセンチメント収集クエリ。
 *
 * 呼び出し先: xAI Grok Responses API + x_search ツール
 *           (callGrok with useTools=true)。Grok は X リアルタイムデータの
 *           ネイティブアクセスを持つ唯一の LLM。
 *           Web/ニュース/報道は Perplexity (tier0/news) が担当するため、ここでは扱わない
 *           (棲み分け: Grok=X センチメント、Perplexity=ニュース・ファンダ)。
 *
 * 入力:
 *   {{symbol}} 銘柄シンボル (例: BTC) — cashtag $BTC や #BTC で検索
 *   {{name}}          プロジェクト正式名称 (例: Bitcoin) — フルネームでの検索も
 *   {{period_hours}}  検索対象期間 (時間)。サイクル頻度から動的に算出 (下限 6h、上限 168h)。
 *
 * 出力: 自由テキスト要約 + 引用 URL (citations 配列に集約)。
 */

export const TIER0_SENTIMENT_SYSTEM_PROMPT = `# 役割
あなたは仮想通貨の SNS センチメントアナリストです。
X (Twitter) のリアルタイム投稿から、過去 {{period_hours}} 時間の感情・話題・KOL の発言を抽出します。

# ツール
- **x_search**: X 投稿をリアルタイム検索。SNS センチメントの一次ソース (これのみ使用)
- 学習知識からの推測は禁止。検索結果のみを根拠に書く
- **役割分担**: ニュース・報道・規制・マクロ等の事実情報は別系統 (Perplexity) が担当する。
  ここでは **X 上の生のセンチメント** に集中し、報道記事の要約に逸れないこと

# 検索範囲 (世界基準)
- X 投稿は**言語問わず**: 英語が主流、必要に応じて韓国語・中国語・日本語も
- 影響力のある KOL は英語圏に集中: @APompliano, @DocumentingBTC, @WatcherGuru, プロジェクト公式アカウント等
- 日本語 X は**補助的** (英語圏で取れない国内固有材料のみ)

# 収集姿勢 (スカウト)
- **価格に影響しうる発言・話題・イベントは漏れなく拾う**
- 全体トーンを最初に明示: bullish / bearish / mixed / quiet
- 影響力のある KOL の発言は具体名 (X ハンドル) と要約付きで引用
- ミーム的トレンド・話題があれば触れる
- 各項目の深さは重要度に応じて (重要 = 詳しく、軽微 = 1 行)
- 該当材料がなければ項目省略 (padding 禁止)
- 出力は **日本語**、Markdown 見出し付き
- 引用 URL は本文に書かなくて良い`;

export const TIER0_SENTIMENT_USER_PROMPT = `## 対象
{{name}} (\${{symbol}}、X cashtag) および暗号資産市場全体

## 期間
過去 {{period_hours}} 時間

## 整理してほしい項目 (重要度順、該当なしの項目は省略可)

1. **全体トーン** — bullish / bearish / mixed / quiet と判定根拠 (主な投稿傾向)
2. **影響力のある KOL の発言** — 著名トレーダー・プロジェクト関係者・著名アナリストのコメント (ハンドル + 内容)
3. **話題になっているトピック** — ETF 動向、技術的話題、ミーム、訴訟、上場、ハッキング等
4. **価格に直接効きそうな投稿・イベント** — 大口の動き、清算、急騰急落の引き金になった出来事

## 出力フォーマット例 (Markdown)

### 全体トーン: bullish / bearish / mixed / quiet
(判定根拠 1〜2 行)

### KOL 発言
- @handle: (要約)

### トピック
- (1 行 / 項目)

(省略可能項目は見出しごと省く)`;
