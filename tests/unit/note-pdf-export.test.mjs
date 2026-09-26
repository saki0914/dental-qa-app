import assert from "node:assert/strict";
import test from "node:test";
import { PDF_EXPORT_PRESETS, createPdfFilename, parsePdfPageRange } from "../../js/core/note-pdf-export.js";

test("PDFページ範囲を現在順のページ番号へ展開し重複を除く", () => {
  assert.deepEqual(parsePdfPageRange("1-3,3,5", 5), [1, 2, 3, 5]);
});

test("逆転・範囲外・空のPDFページ指定を拒否する", () => {
  assert.throws(() => parsePdfPageRange("3-1", 5), /逆転/);
  assert.throws(() => parsePdfPageRange("6", 5), /1〜5/);
  assert.throws(() => parsePdfPageRange("", 5), /入力/);
});

test("AI共有用PDF名へ用途と時刻を含め禁止文字を除去する", () => {
  const filename = createPdfFilename("歯科/補助:ノート", "ai", new Date(2026, 8, 26, 14, 5));
  assert.equal(filename, "歯科_補助_ノート_AI共有用_20260926_1405.pdf");
});

test("PDF画質プリセットは軽量・標準・高画質を提供する", () => {
  assert.deepEqual(Object.keys(PDF_EXPORT_PRESETS), ["compact", "standard", "high"]);
  assert.equal(PDF_EXPORT_PRESETS.standard.maxLongEdge, 2200);
  assert.equal(PDF_EXPORT_PRESETS.high.quality, .95);
});
