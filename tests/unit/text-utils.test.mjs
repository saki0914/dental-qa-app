import assert from "node:assert/strict";
import test from "node:test";

import {
  escapeDisplayText,
  escapeHtml,
  formatDisplayText,
  normalizeAnswerList,
  normalizeConditionGroups,
  normalizePdfTags,
  normalizeQuestionAnswers,
  normalizeSubcategories,
  normalizeToken,
  textToAnswerList,
  textToAnswers,
  textToTagList
} from "../../js/text-utils.js";

test("入力テキストを問題・タグの配列へ正規化する", () => {
  assert.deepEqual(textToTagList("保存, 補綴，歯周\n小児"), ["保存", "補綴", "歯周", "小児"]);
  assert.deepEqual(textToAnswers("A、B・C，D"), ["A", "B", "C", "D"]);
  assert.deepEqual(textToAnswerList("A\\nB, C\nD"), ["A", "B", "C", "D"]);
  assert.deepEqual(normalizeQuestionAnswers(["A, B", "C\\nD"]), ["A", "B", "C", "D"]);
});

test("回答比較用トークンは空白・長音・カタカナ差を吸収する", () => {
  assert.equal(normalizeToken(" カ リ エ スー "), "かりえす");
  assert.deepEqual(normalizeAnswerList([" カリエス ", "かりえす", "歯 周"]), ["かりえす", "歯周"]);
});

test("重複するカテゴリ・条件・PDFタグを除去する", () => {
  assert.deepEqual(normalizeSubcategories([" 保存 ", "保存", ""]), ["保存"]);
  assert.deepEqual(normalizeConditionGroups([["保存", " 保存 "], [], ["補綴"]]), [["保存"], ["補綴"]]);
  assert.deepEqual(normalizePdfTags([" 重要 ", "重要", "画像"]), ["重要", "画像"]);
});

test("表示文字列を改行変換してHTMLエスケープする", () => {
  assert.equal(formatDisplayText("1\\n2/n3"), "1\n2\n3");
  assert.equal(escapeHtml('<a href="x">&</a>'), "&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
  assert.equal(escapeDisplayText("<b>\\n次"), "&lt;b&gt;\n次");
});
