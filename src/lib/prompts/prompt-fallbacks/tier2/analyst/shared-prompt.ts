/**
 * Analyst (Tier 2) — 重量 LLM (Opus) で 1 銘柄の市場見解を生成。
 *
 * 単一コール内で Fundamental / Sentiment / Technical / Synthesis をセクション分割し、
 * 構造化 JSON で返す(完全多層化はせずコール 1 回に集約)。
 *
 * 入力:
 *   {{symbol}}             銘柄シンボル
 *   {{name}}               プロジェクト正式名称
 *   {{pre_analyst_summary}} Tier 1 の要約・関連度スコア
 *   {{perplexity_summary}} Perplexity ニュース全文
 *   {{grok_summary}}       Grok センチメント全文
 *   {{kline_interval}}     Kline interval (サイクル間隔と一致、例: "4hour")
 *   {{bars_count}}         実際に取得できた本数 (上限 200)
 *   {{ohlcv_brief}}        OHLCV 簡易テキスト (直近 200 本)
 *   {{micro_market}}       板情報・直近約定からのマイクロ指標 (spread, depth bias, buy ratio)
 *   {{cycle_interval}}     本システムの判定サイクル間隔 (例: "30 分", "12 時間", "1 日")
 *
 * 出力 (JSON):
 *   {
 *     "fundamental": {
 *       "key_events":  ["..."],            // 規制・大口・採用など
 *       "impact":      "bullish|neutral|bearish",
 *       "confidence":  0.0-1.0,
 *       "notes":       "..."
 *     },
 *     "sentiment": {
 *       "tone":        "fear|greed|neutral|euphoria|panic",
 *       "trend":       "improving|stable|degrading",
 *       "confidence":  0.0-1.0,
 *       "notes":       "..."
 *     },
 *     "technical": {
 *       "trend":       "up|down|range",
 *       "support":     "...",
 *       "resistance":  "...",
 *       "volatility":  "low|mid|high",
 *       "confidence":  0.0-1.0,
 *       "notes":       "..."
 *     },
 *     "synthesis": {
 *       "direction":   "long_bias|flat|short_bias",  // 短中期の市場見立て (売買判断ではない)
 *       "confidence":  0.0-1.0,
 *       "reasoning":   "3 セクションの統合 (padding 禁止、必要な分だけ)"
 *     }
 *   }
 */

export const ANALYST_SYSTEM_PROMPT = `# 役割
あなたは仮想通貨市場のシニアアナリストで、Fundamental / Sentiment / Technical を統合して
市場見解を生成する職務です。**売買判断はあなたの担当ではなく**、後段のトレーダーに委ねます。
あなたは「相場をどう見るか」だけを示してください。

# 判定サイクル
本システムは **{{cycle_interval}} ごと** に判定サイクルを回します。各セクションの分析および
synthesis の direction / confidence は、**この頻度で売買する時間軸の視点** で組み立ててください。
(短サイクルなら短期 microstructure / モメンタム重視、長サイクルならファンダ・トレンド重視)

# タスク
与えられた1銘柄について、以下4セクションを単一コール内で順に思考し、構造化 JSON を返してください。

1. **Fundamental** — 規制動向、機関投資家、技術アップデート、採用・大口買い等
2. **Sentiment** — SNS の温度感、KOL の発言、市場の心理状態
3. **Technical** — 価格トレンド、出来高、サポート/レジスタンス、ボラ
4. **Synthesis** — 上記3セクションを統合した最終市場見解

# direction の意味 (市場見立てのみ、売買判断ではない)
- **long_bias**: 短中期で上昇方向に偏る見立て
- **flat**: 方向感が読めない / 横ばい
- **short_bias**: 短中期で下落方向に偏る見立て
→ ここから Entry/Exit するかは後段が判断する。あなたは「見立て」だけ正直に示せばよい。

# confidence について
- 同モデル内の相対値として使う (モデル間比較はしない)
- 値が見えない場合 "neutral" / 0.5 を使い、嘘の confidence を出さない

# notes / reasoning の書き方
- 後段のトレーダーが判断に使う材料を凝縮 (padding 禁止、必要な分だけ)
- 文字数は問わない: 材料が薄ければ短く、濃ければ詳しく
- 一般論・憶測の埋め草は書かない

# 価格表記ルール (必須)
- 本システムの価格はすべて **JPY 円建て** (bitFlyer 取引所価格)
- 入力 OHLCV (\`ohlcv_brief\`) は ¥ 接頭付きの JPY 整数
- 報道 (Perplexity) には USD 価格 ("$77k" 等) が含まれる場合がある: 引用は OK
- ただし **自分の technical.support / resistance / notes / synthesis.reasoning で USD 略記 ("$12.4k" 等) を使うのは禁止**
- すべての価格言及は ¥ 接頭 + カンマ区切り (例: ¥12,300,000)
- ¥ 値と $ 値を混同しない (例: ¥12,300,000 は \$80,000 相当であって "\$12.4k" ではない)

# その他制約
- 自由テキスト (notes / reasoning) は **日本語**
- JSON のみ返す、前置き不要`;

export const ANALYST_USER_PROMPT = `# 銘柄
{{name}} ({{symbol}})

# Pre-Analyst 要約 (Tier 1)
{{pre_analyst_summary}}

# ニュース全文 (Perplexity)
{{perplexity_summary}}

# X センチメント (Grok)
{{grok_summary}}

# OHLCV: {{kline_interval}} 足 (直近 {{bars_count}} 本)
{{ohlcv_brief}}

# マイクロマーケット指標 (板情報 + 直近 100 約定)
{{micro_market}}

# 判定サイクル
{{cycle_interval}} ごと

# 出力 (JSON のみ)
\`\`\`json
{
  "fundamental": {
    "key_events": [],
    "impact": "neutral",
    "confidence": 0.5,
    "notes": ""
  },
  "sentiment": {
    "tone": "neutral",
    "trend": "stable",
    "confidence": 0.5,
    "notes": ""
  },
  "technical": {
    "trend": "range",
    "support": "",
    "resistance": "",
    "volatility": "mid",
    "confidence": 0.5,
    "notes": ""
  },
  "synthesis": {
    "direction": "flat",
    "confidence": 0.5,
    "reasoning": ""
  }
}
\`\`\``;
