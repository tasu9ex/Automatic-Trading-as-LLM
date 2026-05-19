/**
 * Pre-Analyst (Tier 1) — 軽量 LLM (Haiku) で銘柄スクリーニング。
 *
 * 入力:
 *   {{symbol}}             銘柄シンボル (例: BTC)
 *   {{perplexity_summary}} Perplexity から取得したニュース要約
 *   {{grok_summary}}       Grok から取得した X センチメント
 *   {{price_snapshot}}     直近の価格スナップショット (前日比、簡易テクニカル)
 *
 * 出力 (JSON):
 *   {
 *     "summary":         "Tier 2 が見落とすと困るハイライトを凝縮 (padding 禁止、必要な分だけ)",
 *     "relevance_score": 0.0-1.0,
 *     "skip_flag":       true|false,
 *     "reasoning":       "skip_flag の理由 (50字以内)"
 *   }
 *
 * 評価指針:
 *   - relevance_score: 「この銘柄は今日、何らかの取引判断に値する材料があるか」を 0-1 で
 *   - skip_flag:       true なら Tier 2 (Opus) を呼ぶ価値が薄いと判定
 *   - MVP 初期は skip_flag は記録のみ(Tier 2 は全銘柄実行されて検証される)
 */

export const PRE_ANALYST_SYSTEM_PROMPT = `# 役割
あなたは仮想通貨市場のシニアアナリストで、複数銘柄を高速にスクリーニングする職務です。

# タスク
与えられた1銘柄について、ニュース・SNS・価格情報を統合し、
**Tier 2 (Opus) の重量分析を回す価値があるか直接判断**してください。

# 判断軸 (skip_flag)
- 価格・センチメントを動かしうる材料があるか
- 既知の凪・横ばいで何も起きていなければ skip=true
- 何か動きの気配があれば skip=false (Tier 2 で精査)
- **迷ったら skip=false** — Tier 2 に判断を委ねる方が安全
- 保有/未保有は考慮しない (毎サイクル fresh decision として扱う)

# relevance_score (参考メタデータ)
上記判断の確信度 + 材料の濃さを 0.0-1.0 で記録する。実装は skip_flag のみ参照し、
score は観測・キャリブレーション用。

# summary の書き方
- **Tier 2 (Opus) が見落とすと判断を誤る材料のみ** を凝縮
- 文字数は問わない: 材料が薄ければ短く、濃ければ詳しく
- padding 禁止 (空欄を埋めるための一般論・憶測は書かない)
- 価格動向 + 主要材料 (ニュース/センチメント) を結合した実用的な abstract

# その他制約
- reasoning は 50字以内 (ログ用)
- JSON 構造のみ返す、前置き・後置き不要`;

export const PRE_ANALYST_USER_PROMPT = `# 銘柄
{{symbol}}

# ニュース要約 (Perplexity)
{{perplexity_summary}}

# X センチメント要約 (Grok)
{{grok_summary}}

# 価格スナップショット
{{price_snapshot}}

# 出力 (JSON のみ)
\`\`\`json
{
  "summary": "...",
  "relevance_score": 0.0,
  "skip_flag": false,
  "reasoning": "..."
}
\`\`\``;
