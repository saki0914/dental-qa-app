import assert from "node:assert/strict";
import test from "node:test";
import {
  NOTE_TEXT_REFERENCE_FONT_PX,
  createNoteTextMeasure,
  ensureTextElementHeight,
  fitTextElementToContent,
  layoutTextBox,
  layoutTextLineRanges,
  layoutTextLines,
  measureTextContentBox,
  punctuationSpacingSegments,
  setNoteTextCanvasFont,
  textCharacterColors,
  textElementColorRuns,
  textLineColorSegments,
  visibleTextLines
} from "../../js/core/note-text-layout.js";

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

import {
  NOTE_TEXT_DEFAULT_BOX,
  NOTE_TEXT_MIN_BOX_WIDTH,
  measureTextFontMetrics,
  noteTextCanvasFont,
  noteTextFontStack,
  noteTextGenericFamily,
  renderableTextLine,
  resolveTextBoxFromGesture,
  textLayoutUnits,
  textLineBaselineOffset,
  textLineBaselines
} from "../../js/core/note-text-layout.js";

const unitWidth = value => Array.from(String(value)).length;

test("英単語は単語の途中で折り返さず、空白で改行する", () => {
  assert.deepEqual(
    layoutTextLines("periodontal disease treatment", 12, unitWidth),
    ["periodontal ", "disease ", "treatment"]
  );
});

test("行幅より長い単語だけは文字単位で折り返す", () => {
  assert.deepEqual(layoutTextLines("abcdefghij", 4, unitWidth), ["abcd", "efgh", "ij"]);
});

test("句読点・閉じ括弧・繰り返し記号を行頭に置かない（CSS line-break: normal）", () => {
  assert.deepEqual(layoutTextLines("歯科衛生士。", 5, unitWidth), ["歯科衛生", "士。"]);
  assert.deepEqual(layoutTextLines("あいうえ」か", 4, unitWidth), ["あいう", "え」か"]);
  assert.deepEqual(layoutTextLines("あいう々え", 3, unitWidth), ["あい", "う々え"], "々は行頭に置かない");
  assert.deepEqual(layoutTextLines("ちょっと", 2, unitWidth), ["ちょ", "っと"], "normalでは小書き仮名の前で改行できる");
});

test("1行に収まらない単位は禁則を無視して文字単位で分割する（overflow-wrap: anywhere）", () => {
  assert.deepEqual(layoutTextLines("（SRP）を行う。", 2, unitWidth), ["（S", "RP", "）を", "行", "う。"]);
  assert.deepEqual(layoutTextLines("plaque. Scaling", 6, unitWidth), ["plaque", ". ", "Scalin", "g"]);
});

test("開き括弧を行末に残さない", () => {
  assert.deepEqual(layoutTextLines("あいう「えお」", 4, unitWidth), ["あいう", "「えお」"]);
});

test("日本語と英数字の境界で折り返せる", () => {
  assert.deepEqual(layoutTextLines("歯科CT検査", 3, unitWidth), ["歯科", "CT検", "査"]);
});

test("行末の空白は折り返しを発生させず、描画時に取り除く", () => {
  assert.deepEqual(layoutTextLines("ab   cd", 2, unitWidth), ["ab   ", "cd"]);
  assert.equal(renderableTextLine("ab   "), "ab");
  assert.equal(renderableTextLine("  indent"), "  indent", "行頭の空白は保持する");
});

test("空行・連続改行・タブを保持する", () => {
  assert.deepEqual(layoutTextLines("一\n\n二", 10, unitWidth), ["一", "", "二"]);
  assert.deepEqual(layoutTextLines("a\tb", 20, unitWidth), ["a    b"]);
  assert.deepEqual(layoutTextLines("a\r\nb", 20, unitWidth), ["a", "b"]);
});

test("合成文字は1文字として分割しない", () => {
  const family = "👨‍👩‍👧";
  assert.deepEqual(textLayoutUnits(`${family}あ`).map(unit => unit.text), [family, "あ"]);
});

test("CSSのhalf-leadingと同じ位置へベースラインを置く", () => {
  assert.equal(textLineBaselineOffset({ lineHeight: 30, ascent: 18, descent: 6 }), 21);
  assert.deepEqual(textLineBaselines(3, { top: 100, lineHeight: 30, ascent: 18, descent: 6 }), [121, 151, 181]);
});

test("Canvasのフォント指標がない環境では標準比率でベースラインを求める", () => {
  assert.deepEqual(measureTextFontMetrics({ measureText: () => ({ width: 10 }) }, 20), { ascent: 17.6, descent: 2.4 });
  assert.deepEqual(measureTextFontMetrics({
    measureText: () => ({ width: 10, fontBoundingBoxAscent: 19, fontBoundingBoxDescent: 5 })
  }, 20), { ascent: 19, descent: 5 });
});

test("エディタ・SVG・PDFで同じフォントスタックを使う", () => {
  assert.match(noteTextFontStack("system-sans"), /Hiragino Sans.*sans-serif$/);
  assert.match(noteTextFontStack("system-serif"), /serif$/);
  assert.equal(noteTextFontStack("unknown"), noteTextFontStack("system-sans"));
  assert.equal(noteTextGenericFamily("system-serif"), "serif");
  assert.equal(noteTextGenericFamily("monospace"), "monospace");
  assert.equal(noteTextGenericFamily("system-sans"), "sans-serif");
  assert.equal(
    noteTextCanvasFont({ fontFamily: "monospace", fontWeight: "bold", fontStyle: "italic" }, 24),
    `italic bold 24px ${noteTextFontStack("monospace")}`
  );
});

test("Pencilのタップ揺れで作られる極細のテキスト枠を既定幅にする", () => {
  const tapped = resolveTextBoxFromGesture({ x: .2, y: .3 }, { x: .205, y: .33 });
  assert.equal(tapped.dragged, false);
  assert.equal(tapped.width, NOTE_TEXT_DEFAULT_BOX.width);
  assert.ok(tapped.height >= NOTE_TEXT_DEFAULT_BOX.height);
  assert.equal(tapped.x, .2);

  const narrow = resolveTextBoxFromGesture({ x: .1, y: .1 }, { x: .16, y: .3 });
  assert.equal(narrow.dragged, true);
  assert.equal(narrow.width, NOTE_TEXT_MIN_BOX_WIDTH);

  const reversed = resolveTextBoxFromGesture({ x: .8, y: .6 }, { x: .4, y: .5 });
  assert.deepEqual(
    { x: reversed.x, y: reversed.y, width: +reversed.width.toFixed(3), height: +reversed.height.toFixed(3) },
    { x: .4, y: .5, width: .4, height: .1 }
  );

  const nearEdge = resolveTextBoxFromGesture({ x: .95, y: .97 }, { x: .95, y: .97 });
  assert.ok(nearEdge.x + nearEdge.width <= 1);
  assert.ok(nearEdge.y + nearEdge.height <= 1);
});

test("隣接する全角約物の間だけで計測区間を分け、約物の詰めを計測へ持ち込まない", () => {
  assert.deepEqual(punctuationSpacingSegments("「う蝕」、は"), ["「う蝕」", "、は"]);
  assert.deepEqual(punctuationSpacingSegments("（「メモ」）"), ["（", "「メモ」", "）"]);
  assert.deepEqual(punctuationSpacingSegments("歯科衛生士。"), ["歯科衛生士。"]);
  assert.deepEqual(punctuationSpacingSegments(""), [""]);
});

function createMeasureContext() {
  const calls = [];
  return {
    calls,
    font: "",
    fontKerning: "auto",
    measureText(value) {
      calls.push({ value, font: this.font, kerning: this.fontKerning });
      // Canvas-like: each character is 1em at the current font size, but
      // adjacent punctuation would be kerned to 0.5em if measured together.
      const size = Number(/([\d.]+)px/.exec(this.font)?.[1] || 10);
      let width = 0;
      const chars = Array.from(String(value));
      chars.forEach((char, index) => {
        const kerned = index > 0 && "」、".includes(char) && "」、".includes(chars[index - 1]);
        width += kerned ? size / 2 : size;
      });
      return { width };
    }
  };
}

test("折返し幅は基準サイズで計測して比例換算し、描画サイズごとの丸め差を持ち込まない", () => {
  const context = createMeasureContext();
  const measure = createNoteTextMeasure(context, { fontFamily: "system-sans" }, 25);
  assert.equal(measure("歯科"), 50, "基準100pxの計測値を25pxへ換算する");
  assert.equal(measure("」、"), 50, "隣接約物は別々に計測する");
  assert.ok(context.calls.every(call => call.font.includes(`${NOTE_TEXT_REFERENCE_FONT_PX}px`)));
  assert.ok(context.calls.every(call => call.kerning === "none"), "カーニングを無効化して計測する");
  context.font = "normal normal 12px serif";
  assert.equal(measure("歯"), 25, "描画側がfontを変えても基準フォントへ戻して計測する");
  const callCount = context.calls.length;
  assert.equal(measure("歯"), 25);
  assert.equal(context.calls.length, callCount, "同じ文字列の計測はキャッシュする");
});

test("Canvasへノート文字のフォントを設定するときはカーニングを無効化する", () => {
  const context = { font: "", fontKerning: "normal" };
  setNoteTextCanvasFont(context, { fontFamily: "system-serif", fontWeight: "bold", fontStyle: "italic" }, 20);
  assert.equal(context.fontKerning, "none");
  assert.match(context.font, /^italic bold 20px "Hiragino Mincho ProN"/);
  const legacyContext = { font: "" };
  setNoteTextCanvasFont(legacyContext, {}, 16);
  assert.equal("fontKerning" in legacyContext, false, "未対応のCanvasへは設定しない");
});

// One unit per grapheme, as a 1em-per-character CJK font of size 1.
const unitMeasure = value => Array.from(String(value)).length;

test("行ごとに元の文字の位置を持つ折り返しは、通常の折り返しと同じ行を返す（タブ・CRLFを含む）", () => {
  const text = "歯科衛生士\r\nA\tB\n";
  const ranges = layoutTextLineRanges(text, 2, unitMeasure);
  assert.deepEqual(ranges.map(line => line.text), layoutTextLines(text, 2, unitMeasure));
  assert.deepEqual(ranges[0].sourceIndices, [0, 1]);
  assert.deepEqual(ranges[2].sourceIndices, [4], "「士」は改行の前");
  // "A" then the tab expanded to four spaces (all from index 8), then "B".
  const tabLine = ranges.find(line => line.text.startsWith("A"));
  assert.equal(tabLine.sourceIndices[0], 7);
  assert.ok(tabLine.sourceIndices.slice(1, 5).every(index => index === 8));
});

test("色の範囲は文字数が一致するときだけ使い、不正な範囲と色は無視する", () => {
  const element = { text: "象牙質は硬い", textColors: { length: 6, runs: [
    { start: 2, end: 4, color: "#EF4444" },
    { start: 3, end: 5, color: "#2563eb" },
    { start: 5, end: 9, color: "#2563eb" },
    { start: 5, end: 6, color: "red" }
  ] } };
  assert.deepEqual(textElementColorRuns(element), [{ start: 2, end: 4, color: "#ef4444" }]);
  assert.deepEqual(textElementColorRuns({ ...element, text: "象牙質は硬いです" }), [], "旧版が文字を変えた場合は1色に戻す");
  assert.deepEqual(textElementColorRuns({ text: "abc" }), []);
  assert.deepEqual(textCharacterColors(4, [{ start: 1, end: 3, color: "#ef4444" }]), [null, "#ef4444", "#ef4444", null]);
});

test("行の見える部分を色の変わり目で分け、合成文字は分けない", () => {
  const text = "歯👩‍⚕️冠 ";
  const colors = textCharacterColors(text.length, [{ start: 1, end: 3, color: "#ef4444" }]);
  const [line] = layoutTextLineRanges(text, 10, unitMeasure);
  assert.deepEqual(textLineColorSegments(line, colors, "#111111"), [
    { text: "歯", color: "#111111" },
    { text: "👩‍⚕️", color: "#ef4444" },
    { text: "冠", color: "#111111" }
  ], "絵文字の途中で色が変わっても1文字として描き、行末の空白は描かない");
});

test("テキストの枠は一番長い行の幅（少しの余白込み）と行数の高さにする", () => {
  const element = {
    type: "text", text: "歯冠\n象牙質", rotation: 0,
    bounds: { x: .1, y: .2, width: .35, height: .12 },
    style: { fontSizeRatio: .02, lineHeight: 1.25, textAlign: "left" }
  };
  const options = { pageWidth: 1000, pageHeight: 1000, measureText: value => Array.from(String(value)).length * 20 };
  const box = measureTextContentBox(element, options);
  assert.ok(Math.abs(box.x - .1) < 1e-9);
  assert.ok(Math.abs(box.width - (60 + 2) / 1000) < 1e-9, "3文字×20px＋余白2px");
  assert.ok(Math.abs(box.height - 2 * 25 / 1000) < 1e-9, "2行×行の高さ25px");
  assert.equal(box.softWrapped, false);
  const centered = measureTextContentBox({ ...element, style: { ...element.style, textAlign: "center" } }, options);
  assert.ok(Math.abs(centered.x - (.1 + (.35 - .062) / 2)) < 1e-9, "中央揃えは枠の中央に置く");
  const right = measureTextContentBox({ ...element, style: { ...element.style, textAlign: "right" } }, options);
  assert.ok(Math.abs(right.x + right.width - .45) < 1e-9, "右揃えは右端をそろえる");
  const wrapped = measureTextContentBox({ ...element, text: "歯科衛生士国家試験の過去問題", bounds: { ...element.bounds, width: .1 } }, options);
  assert.equal(wrapped.softWrapped, true, "枠の幅で折り返した");
});

test("テキストを書いた文字に合わせて縮め、折り返しの位置は変えない。回転したテキストはそのまま", () => {
  const options = { pageWidth: 1000, pageHeight: 1000, measureText: value => Array.from(String(value)).length * 20 };
  const element = {
    type: "text", text: "歯科衛生士国家試験の過去問題を解く", rotation: 0, autoHeight: true,
    bounds: { x: .1, y: .2, width: .35, height: .12 },
    style: { fontSizeRatio: .02, lineHeight: 1.25, textAlign: "left" }
  };
  const before = layoutTextLines(element.text, 350, options.measureText);
  const fitted = fitTextElementToContent(element, options);
  assert.ok(fitted.bounds.width < element.bounds.width);
  assert.deepEqual(layoutTextLines(fitted.text, fitted.bounds.width * 1000, options.measureText), before);
  assert.ok(Math.abs(fitted.bounds.height - before.length * 25 / 1000) < 1e-9);
  assert.equal(fitTextElementToContent(fitted, options), fitted, "合わせ済みなら同じ要素を返す");
  const rotated = { ...element, rotation: 30 };
  assert.equal(fitTextElementToContent(rotated, options), rotated);
  assert.equal(fitTextElementToContent({ ...element, text: "" }, options).bounds, element.bounds);
});
