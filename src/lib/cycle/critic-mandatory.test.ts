import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 0.1 (ALL-or-NOTHING): Critic 失敗を try/catch で吸収する fail-open パスは撤廃済。
 * 再導入されると Critic 審査抜きで売買が走る非対称になるため、ソースレベルで
 * 「fail-open」リテラルと llmModel リテラルの再出現を弾く回帰防止テスト。
 *
 * finalize 全体の動作テストは外部依存 (db / LLM / GMO) が重く unit にできないので、
 * ポリシー違反コードが PR に乗らないかをファイル走査で見張る形を取る。
 */
describe("Critic mandatory (0.1)", () => {
  const phasesSrc = readFileSync(new URL("./phases.ts", import.meta.url), "utf8");

  it("phases.ts に fail-open フォールバックが残っていない", () => {
    expect(phasesSrc).not.toMatch(/llmModel:\s*["']fail-open["']/);
    expect(phasesSrc).not.toMatch(/fail-open with allocator/i);
  });

  it("Critic 失敗時のログ / event がフェイルオープン経由になっていない", () => {
    // fail-open 時に書いていた特定の文言が消えていることを確認
    expect(phasesSrc).not.toMatch(/Critic API failed/i);
    expect(phasesSrc).not.toMatch(/Critic fail-open/i);
  });
});
