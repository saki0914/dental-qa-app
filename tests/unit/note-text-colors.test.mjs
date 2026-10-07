import assert from "node:assert/strict";
import test from "node:test";
import {
  applyTextValueChange,
  setTextColorRange,
  textColorAtCaret,
  textColorSegments,
  textColorsForStorage,
  textValueChange
} from "../../js/core/note-text-colors.js";

const RED = "#ef4444";
const BLUE = "#2563eb";

test("入力・削除・置換で変わった場所を求め、同じ文字の連続ではキャレット位置で決める", () => {
  assert.deepEqual(textValueChange("歯冠", "歯冠部"), { start: 2, removed: 0, inserted: 1 });
  assert.deepEqual(textValueChange("歯冠部", "歯部"), { start: 1, removed: 1, inserted: 0 });
  assert.deepEqual(textValueChange("あい", "愛"), { start: 0, removed: 2, inserted: 1 });
  // "aa" to "aaa" with the caret after the second "a": typed at index 1.
  assert.deepEqual(textValueChange("aa", "aaa", { caret: 2 }), { start: 1, removed: 0, inserted: 1 });
  assert.deepEqual(textValueChange("aa", "aaa", { caret: 3 }), { start: 2, removed: 0, inserted: 1 });
  // Deleting the first of "aaa" (the caret is then at 0).
  assert.deepEqual(textValueChange("aaa", "aa", { caret: 0 }), { start: 0, removed: 1, inserted: 0 });
});

test("途中で選んだ色はその場所に続けて書く文字に付き、その後の文字も同じ色を引き継ぐ", () => {
  let colors = [null, null];
  ({ colors } = applyTextValueChange(colors, "象牙", "象牙質", { caret: 3, pendingColor: RED, pendingAt: 2 }));
  assert.deepEqual(colors, [null, null, RED]);
  ({ colors } = applyTextValueChange(colors, "象牙質", "象牙質は", { caret: 4 }));
  assert.deepEqual(colors, [null, null, RED, RED], "直前の文字の色を引き継ぐ");
  // A color chosen for another place does not apply here.
  ({ colors } = applyTextValueChange(colors, "象牙質は", "象牙質は硬い", { caret: 6, pendingColor: BLUE, pendingAt: 1 }));
  assert.deepEqual(colors, [null, null, RED, RED, RED, RED]);
  // At the very start, the text takes the color of what follows it.
  ({ colors } = applyTextValueChange(colors, "象牙質は硬い", "「象牙質は硬い", { caret: 1 }));
  assert.equal(colors[0], null);
});

test("日本語入力の変換（あ→あい→愛）と選択範囲への上書きで色を保つ", () => {
  let result = applyTextValueChange([null], "歯", "歯あ", { caret: 2, pendingColor: RED, pendingAt: 1 });
  assert.equal(result.usedPending, true);
  result = applyTextValueChange(result.colors, "歯あ", "歯あい", { caret: 3 });
  result = applyTextValueChange(result.colors, "歯あい", "歯愛", { caret: 2 });
  assert.deepEqual(result.colors, [null, RED], "変換後の文字は置き換えた文字の色");
  result = applyTextValueChange([null, BLUE, BLUE, null], "歯冠部分", "歯X分", { caret: 2 });
  assert.deepEqual(result.colors, [null, BLUE, null], "上書きした文字は置き換えた先頭の文字の色");
  // The array always has one entry per code unit, even after a missed change.
  result = applyTextValueChange([null], "ab", "abc", { caret: 3 });
  assert.equal(result.colors.length, 3);
});

test("選んだ範囲だけ色を変え、キャレット位置の色を返す", () => {
  const colors = setTextColorRange([null, null, null, null], 3, 1, BLUE);
  assert.deepEqual(colors, [null, BLUE, BLUE, null]);
  assert.equal(textColorAtCaret(colors, 2, "#111111"), BLUE);
  assert.equal(textColorAtCaret(colors, 1, "#111111"), "#111111");
  assert.equal(textColorAtCaret(colors, 0, "#111111"), "#111111");
  assert.deepEqual(textColorSegments("歯冠部分", colors, "#111111"), [
    { text: "歯", color: "#111111" },
    { text: "冠部", color: BLUE },
    { text: "分", color: "#111111" }
  ]);
});

test("保存形式: 1色なら本体の色だけ、混在なら本体の色と違う部分だけを範囲で持つ", () => {
  assert.deepEqual(textColorsForStorage("歯冠", [null, null], "#111111"), { color: "#111111", textColors: null });
  assert.deepEqual(textColorsForStorage("歯冠", [RED, RED], "#111111"), { color: RED, textColors: null }, "全体が1色ならその色を本体の色にする");
  assert.deepEqual(textColorsForStorage("象牙質は硬い", [null, null, RED, RED, "#111111", BLUE], "#111111"), {
    color: "#111111",
    textColors: { length: 6, runs: [{ start: 2, end: 4, color: RED }, { start: 5, end: 6, color: BLUE }] }
  });
  assert.deepEqual(textColorsForStorage("AB", ["#EF4444", "bad"], "#111111"), {
    color: "#111111",
    textColors: { length: 2, runs: [{ start: 0, end: 1, color: RED }] }
  }, "大文字は小文字へ、不正な色は本体の色へ");
  assert.deepEqual(textColorsForStorage("", [], "#111111"), { color: "#111111", textColors: null });
});
