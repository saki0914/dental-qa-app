import assert from "node:assert/strict";
import test from "node:test";

import {
  createQuestionChunkStorage,
  estimateQuestionDocumentBytes,
  normalizeImportAssetPath,
  restoreQuestionsFromChunks,
  resolveImportImageFile,
  splitQuestionsIntoChunks
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

test("上限に近い問題データを複数文書へ分割して順序を保つ", () => {
  const questions = Array.from({ length: 6 }, (_, index) => ({
    id: `q${index + 1}`,
    question: "歯".repeat(40)
  }));
  const chunks = splitQuestionsIntoChunks(questions, {
    targetBytes: 450,
    maxBytes: 900
  });

  assert.ok(chunks.length > 1);
  assert.deepEqual(chunks.flat(), questions);
  assert.ok(chunks.every(chunk => estimateQuestionDocumentBytes(chunk) <= 450));
});

test("1問題だけで文書上限を超えるデータは停止する", () => {
  assert.throws(
    () => splitQuestionsIntoChunks([{ question: "歯".repeat(100) }], {
      targetBytes: 200,
      maxBytes: 250
    }),
    /1件あたりの安全上限/
  );
});

test("分割保存の管理情報から元の問題一覧を復元する", () => {
  const questions = Array.from({ length: 800 }, (_, index) => ({
    id: `q${index + 1}`,
    question: "歯科問題".repeat(80)
  }));
  const storage = createQuestionChunkStorage(questions, { updatedAt: "test-time" });

  assert.ok(storage.manifest.chunkCount > 1);
  assert.equal(storage.manifest.questionCount, questions.length);
  assert.ok(storage.chunks.every(chunk => chunk.updatedAt === "test-time"));
  assert.deepEqual(restoreQuestionsFromChunks(storage.manifest, storage.chunks), questions);
});

test("分割ファイルが欠けている場合は不完全な問題一覧を返さない", () => {
  const storage = createQuestionChunkStorage([{ id: "q1" }]);
  assert.throws(
    () => restoreQuestionsFromChunks(storage.manifest, []),
    /分割ファイル数/
  );
});
