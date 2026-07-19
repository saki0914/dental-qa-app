import assert from "node:assert/strict";
import test from "node:test";

import {
  estimateQuestionDocumentBytes,
  normalizeImportAssetPath,
  resolveImportImageFile
} from "../../js/core/question-import.js";

test("画像参照パスを一括登録用に正規化する", () => {
  assert.equal(normalizeImportAssetPath(" ./Images\\Chapter1.PNG "), "images/chapter1.png");
});

test("相対パスを優先しファイル名でも画像を照合する", () => {
  const files = [
    { name: "figure.png", webkitRelativePath: "保存/images/figure.png" },
    { name: "other.png", webkitRelativePath: "保存/images/other.png" }
  ];

  assert.equal(resolveImportImageFile("images/figure.png", files).file, files[0]);
  assert.equal(resolveImportImageFile("other.png", files).file, files[1]);
  assert.equal(resolveImportImageFile("missing.png", files).error, "missing");
});

test("同名画像が複数ある場合は曖昧として停止する", () => {
  const files = [
    { name: "figure.png", webkitRelativePath: "保存/images/figure.png" },
    { name: "figure.png", webkitRelativePath: "補綴/images/figure.png" }
  ];
  assert.equal(resolveImportImageFile("figure.png", files).error, "ambiguous");
});

test("Firestore保存前の概算サイズをUTF-8バイトで返す", () => {
  assert.ok(estimateQuestionDocumentBytes([{ question: "歯" }]) > 20);
});
