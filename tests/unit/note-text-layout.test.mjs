import assert from "node:assert/strict";
import test from "node:test";
import { ensureTextElementHeight, layoutTextBox, layoutTextLines, visibleTextLines } from "../../js/core/note-text-layout.js";

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

test("3行テキストの必要高さを共通レイアウトから算出する", () => {
  const layout = layoutTextBox("1行目\n2行目\n3行目", {
    maxWidth: 20,
    lineHeight: 1.4,
    measureText: value => Array.from(value).length
  });
  assert.deepEqual(layout.lines, ["1行目", "2行目", "3行目"]);
  assert.ok(Math.abs(layout.requiredHeight - 4.2) < 1e-9);
});

test("改行を含む旧テキストは表示に必要な最小高さへ補正する", () => {
  const original = {
    id: "text-1", type: "text", text: "一\n二\n三",
    bounds: { x: .1, y: .1, width: .4, height: .02 },
    style: { fontSizeRatio: .02, lineHeight: 1.25 }
  };
  const element = ensureTextElementHeight(original, { pageHeight: 1000, measureText: value => value.length * 10 });
  assert.equal(element.autoHeight, true);
  assert.ok(element.bounds.height >= .075);
  assert.equal(original.bounds.height, .02, "保存済みboundsを暗黙に変更しない");
});

test("自動高さはページ下端を越えず、既存の過大な高さもclampする", () => {
  const element = ensureTextElementHeight({
    id: "text-bottom", type: "text", text: "一\n二\n三\n四",
    bounds: { x: .1, y: .94, width: .4, height: .2 },
    style: { fontSizeRatio: .03, lineHeight: 1.25 }
  }, { pageHeight: 1000, measureText: value => value.length * 10 });
  assert.ok(Math.abs(element.bounds.height - .06) < 1e-9);
});

test("横長ページの保存済みテキストは実ページ幅で折り返し高さを算出する", () => {
  const original = {
    id: "landscape-text", type: "text", text: "123456",
    bounds: { x: .1, y: .1, width: .1, height: .01 },
    style: { fontSizeRatio: .02, lineHeight: 1 }
  };
  const narrow = ensureTextElementHeight(original, {
    pageWidth: 1000, pageHeight: 1000, measureText: value => value.length * 30
  });
  const wide = ensureTextElementHeight(original, {
    pageWidth: 2000, pageHeight: 1000, measureText: value => value.length * 30
  });
  assert.ok(narrow.bounds.height > wide.bounds.height);
});
