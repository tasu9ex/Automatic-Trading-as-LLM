/**
 * Drizzle マイグレーション SQL 中の BEGIN/COMMIT/ROLLBACK/SAVEPOINT 検出。
 *
 * drizzle-kit migrate は各マイグレーションを内部 transaction で包む。
 * SQL ファイル内に明示的にトランザクション制御を書くと:
 *   - BEGIN: ネスト transaction エラー
 *   - COMMIT: 早期コミット → 後続文がランニングトランザクション外
 *   - ROLLBACK: 該当ファイルの変更が全部破棄
 *
 * 検出はコメント・文字列リテラル・dollar quote を mask した上で行う(誤検知防止)。
 */

export interface TransactionControlViolation {
  line: number;
  column: number;
  keyword: string;
  snippet: string;
}

type MaskState =
  | { kind: "plain" }
  | { kind: "line_comment" }
  | { kind: "block_comment" }
  | { kind: "single_quote" }
  | { kind: "dollar_quote"; tag: string };

const FORBIDDEN_KEYWORDS = [
  "BEGIN",
  "START\\s+TRANSACTION",
  "COMMIT",
  "ROLLBACK",
  "SAVEPOINT",
] as const;

/**
 * コメント・文字列・dollar quote を空白に置換。
 * keyword 検出を素直な regex で行うため。
 *
 * SQL レキシカル状態機械なので、cognitive complexity が高くなる(構造的に分解できない)。
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: SQL state machine, structurally indivisible
function maskHiddenRegions(body: string): string {
  let state: MaskState = { kind: "plain" };
  const out: string[] = [];
  let i = 0;
  while (i < body.length) {
    const ch = body[i] ?? "";
    const next = body[i + 1] ?? "";
    switch (state.kind) {
      case "plain": {
        if (ch === "-" && next === "-") {
          state = { kind: "line_comment" };
          out.push("  ");
          i += 2;
        } else if (ch === "/" && next === "*") {
          state = { kind: "block_comment" };
          out.push("  ");
          i += 2;
        } else if (ch === "'") {
          state = { kind: "single_quote" };
          out.push("'");
          i += 1;
        } else if (ch === "$") {
          const tagMatch = body.slice(i).match(/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/);
          if (tagMatch) {
            state = { kind: "dollar_quote", tag: tagMatch[0] };
            out.push(" ".repeat(tagMatch[0].length));
            i += tagMatch[0].length;
          } else {
            out.push(ch);
            i += 1;
          }
        } else {
          out.push(ch);
          i += 1;
        }
        break;
      }
      case "line_comment": {
        if (ch === "\n") {
          state = { kind: "plain" };
          out.push("\n");
        } else {
          out.push(ch === "\t" ? "\t" : " ");
        }
        i += 1;
        break;
      }
      case "block_comment": {
        if (ch === "*" && next === "/") {
          state = { kind: "plain" };
          out.push("  ");
          i += 2;
        } else {
          out.push(ch === "\n" ? "\n" : " ");
          i += 1;
        }
        break;
      }
      case "single_quote": {
        if (ch === "'" && next === "'") {
          out.push("  ");
          i += 2;
        } else if (ch === "'") {
          state = { kind: "plain" };
          out.push("'");
          i += 1;
        } else {
          out.push(ch === "\n" ? "\n" : " ");
          i += 1;
        }
        break;
      }
      case "dollar_quote": {
        if (body.slice(i, i + state.tag.length) === state.tag) {
          out.push(" ".repeat(state.tag.length));
          i += state.tag.length;
          state = { kind: "plain" };
        } else {
          out.push(ch === "\n" ? "\n" : " ");
          i += 1;
        }
        break;
      }
    }
  }
  return out.join("");
}

export function detectTransactionControlViolations(sql: string): TransactionControlViolation[] {
  const masked = maskHiddenRegions(sql);
  const violations: TransactionControlViolation[] = [];
  const pattern = `\\b(${FORBIDDEN_KEYWORDS.join("|")})\\b`;
  const lines = masked.split("\n");
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx] ?? "";
    const regex = new RegExp(pattern, "gi");
    for (const match of line.matchAll(regex)) {
      violations.push({
        line: lineIdx + 1,
        column: (match.index ?? 0) + 1,
        keyword: match[0].toUpperCase(),
        snippet: line.trim().slice(0, 100),
      });
    }
  }
  return violations;
}

export function formatTransactionControlViolations(
  filename: string,
  violations: TransactionControlViolation[],
): string {
  return violations
    .map((v) => `  ${filename}:${v.line}:${v.column}  ${v.keyword}  "${v.snippet}"`)
    .join("\n");
}
