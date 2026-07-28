import assert from "node:assert/strict";
import test from "node:test";

import {
  compareAnswerLists,
  diffAnswerLists,
  isOrderSensitiveQuestion,
  normalizeAnswerForComparison
} from "../../js/core/answer-comparison.js";

test("4肢択2は正答順の入力を正解にする", () => {
  assert.equal(compareAnswerLists(["a", "d"], ["a", "d"]), true);
});

test("orderedAnswers未指定の4肢択2は逆順を正解にする", () => {
  assert.equal(compareAnswerLists(["a", "d"], ["d", "a"]), true);
  assert.equal(isOrderSensitiveQuestion({ answers: ["a", "d"] }), false);
});

test("orderedAnswers falseの4肢択2は逆順を正解にする", () => {
  assert.equal(compareAnswerLists(["a", "d"], ["d", "a"], { ordered: false }), true);
  assert.equal(isOrderSensitiveQuestion({ orderedAnswers: false }), false);
});

test("orderedAnswers trueは回答順を区別する", () => {
  assert.equal(compareAnswerLists(["a", "d"], ["d", "a"], { ordered: true }), false);
  assert.equal(isOrderSensitiveQuestion({ orderedAnswers: true }), true);
});

test("重複入力は多重度を保って不正解にする", () => {
  assert.equal(compareAnswerLists(["a", "d"], ["a", "a"]), false);
  assert.deepEqual(diffAnswerLists(["a", "d"], ["a", "a"]), {
    missing: ["d"],
    extra: ["a"]
  });
});

test("異なる選択肢を含む入力を不正解にする", () => {
  assert.equal(compareAnswerLists(["a", "d"], ["a", "c"]), false);
});

test("NFKC・前後空白・英字大小を正規化する", () => {
  assert.equal(compareAnswerLists(["a", "d"], [" A ", "ｄ"]), true);
  assert.equal(normalizeAnswerForComparison(" ８～１２ "), "8〜12");
});

test("不足回答を不正解にする", () => {
  assert.equal(compareAnswerLists(["a", "d"], ["a"]), false);
});

test("余分な回答を不正解にする", () => {
  assert.equal(compareAnswerLists(["a", "d"], ["a", "d", "c"]), false);
});

test("単一回答の完全一致判定を維持する", () => {
  assert.equal(compareAnswerLists(["ラバーダム防湿"], ["ラバーダム防湿"]), true);
  assert.equal(compareAnswerLists(["ラバーダム防湿"], ["簡易防湿"]), false);
});

test("複数穴埋めはorderedAnswers trueなら順序を維持する", () => {
  const expected = ["感染源", "感染経路", "宿主"];
  assert.equal(compareAnswerLists(expected, expected, { ordered: true }), true);
  assert.equal(
    compareAnswerLists(expected, ["感染経路", "感染源", "宿主"], { ordered: true }),
    false
  );
});

test("記述式複数回答はorderedAnswers falseなら順不同にする", () => {
  assert.equal(
    compareAnswerLists(["感染源", "感染経路"], ["感染経路", "感染源"]),
    true
  );
});
