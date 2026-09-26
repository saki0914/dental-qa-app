import assert from "node:assert/strict";
import test from "node:test";
import { layoutTextLines, visibleTextLines } from "../../js/core/note-text-layout.js";

test("日本語テキストを計測幅に合わせて折り返し、明示改行を保持する", () => {
  assert.deepEqual(
    layoutTextLines("歯科衛生士\nABC", 2, value => Array.from(value).length),
    ["歯科", "衛生", "士", "AB", "C"]
  );
});

test("テキストboxの高さを超える行はSVGとCanvas共通で切り詰める", () => {
  assert.deepEqual(visibleTextLines("123456", {
    maxWidth: 2,
    maxHeight: 2.5,
    lineHeight: 1,
    measureText: value => value.length
  }), ["12", "34"]);
});
