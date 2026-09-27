import assert from "node:assert/strict";
import test from "node:test";
import {
  PDF_EXPORT_PRESETS,
  createPdfFilename,
  getPdfPageLayout,
  pdfMaskMode,
  pdfScreenHiddenMaskIds,
  parsePdfPageRange,
  sanitizePdfFilename,
  sharePdfBlob
} from "../../js/core/note-pdf-export.js";

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

test("ユーザー編集後のPDF名も重複拡張子・末尾dot・禁止文字を除去する", () => {
  assert.equal(sanitizePdfFilename("  症例/共有.pdf.pdf.  "), "症例_共有.pdf");
  assert.equal(sanitizePdfFilename("   "), "学習ノート.pdf");
});

test("共有直前にもユーザー編集後のPDF名を再サニタイズする", async () => {
  let sharedFile;
  const navigatorObject = {
    canShare: ({ files }) => files[0].name === "症例_共有.pdf",
    share: async ({ files }) => { [sharedFile] = files; }
  };
  await sharePdfBlob(new Blob(["%PDF"], { type: "application/pdf" }), "症例/共有.pdf.pdf", "症例", navigatorObject);
  assert.equal(sharedFile.name, "症例_共有.pdf");
});

test("PDF画質プリセットは軽量・標準・高画質を提供する", () => {
  assert.deepEqual(Object.keys(PDF_EXPORT_PRESETS), ["compact", "standard", "high"]);
  assert.equal(PDF_EXPORT_PRESETS.standard.maxLongEdge, 2200);
  assert.equal(PDF_EXPORT_PRESETS.high.quality, .95);
});

test("ページ番号は本文を縮小せず独立フッターへ配置し横向き比率も維持する", () => {
  const withoutFooter = getPdfPageLayout(1600, 900, false);
  const withFooter = getPdfPageLayout(1600, 900, true);
  assert.equal(withFooter.bodyWidth, withoutFooter.bodyWidth);
  assert.equal(withFooter.bodyHeight, withoutFooter.bodyHeight);
  assert.equal(withFooter.pageWidth / withFooter.bodyHeight, 1600 / 900);
  assert.equal(withFooter.pageHeight, withoutFooter.pageHeight + 22);
  assert.equal(withoutFooter.footerHeight, 0);
});

test("PDFのマスク描画は用途と画面どおりの現在表示状態を分離する", () => {
  assert.equal(pdfMaskMode("ai"), "none");
  assert.equal(pdfMaskMode("study"), "all");
  assert.equal(pdfMaskMode("screen"), "screen");
  const revealed = new Set(["note:study-hidden"]);
  const editingHidden = new Set(["note:edit-hidden"]);
  assert.deepEqual([...pdfScreenHiddenMaskIds("ai", { revealedMaskIds: revealed, editingHiddenMaskIds: editingHidden })], []);
  assert.deepEqual([...pdfScreenHiddenMaskIds("study", { revealedMaskIds: revealed, editingHiddenMaskIds: editingHidden })], []);
  assert.deepEqual([...pdfScreenHiddenMaskIds("screen", { studyMode: false, revealedMaskIds: revealed, editingHiddenMaskIds: editingHidden })], ["note:edit-hidden"]);
  assert.deepEqual([...pdfScreenHiddenMaskIds("screen", { studyMode: true, revealedMaskIds: revealed, editingHiddenMaskIds: editingHidden })], ["note:study-hidden"]);
});
