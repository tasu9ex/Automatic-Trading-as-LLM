/**
 * Langfuse プロンプト管理用の型定義。
 * Langfuse 接続失敗時もコード内 fallback で動作するための共通インターフェース。
 */

/** Langfuse 上のプロンプト名(folder 名と一致させる) */
export type PromptName = "pre-analyst" | "analyst" | "entry-decision" | "exit-decision" | "critic";

/** プロンプト取得オプション */
export interface GetPromptOptions {
  /** Langfuse ラベル (default: 'production') */
  label?: string;
  /** 特定バージョン指定 */
  version?: number;
  /** Langfuse SDK のリトライ回数 */
  maxRetries?: number;
  /** Langfuse SDK のタイムアウト (ms) */
  fetchTimeoutMs?: number;
}

/** コンパイル後のプロンプト (LLM SDK に渡す形) */
export interface CompiledPrompt {
  system?: string;
  user: string;
}

/** プロンプトのメタデータ(Langfuse トレース紐付け用) */
export interface PromptMetadata {
  name: PromptName;
  /** Langfuse バージョン (fallback は 0) */
  version: number;
  /** 取得元 ('langfuse' | 'fallback') */
  source: "langfuse" | "fallback";
  /** ラベル(取得時のみ) */
  label?: string;
}

/** モデルパラメータ設定 (Langfuse Config と同じ shape) */
export interface PromptConfig {
  model: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  responseFormat?: "text" | "json";
}

/** プロンプト + メタデータ + config の結果 */
export interface PromptResolved {
  compiled: CompiledPrompt;
  config: PromptConfig;
  metadata: PromptMetadata;
}
