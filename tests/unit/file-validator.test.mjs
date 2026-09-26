import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_NOTE_JSON_BYTES,
  assertFiniteJson,
  assertNonEmptyBlob,
  decodeImageDimensions,
  hasPdfSignature,
  sanitizeDownloadFilename,
  serializeValidatedJson,
  validateImageBlob,
  validateNormalizedNoteContent,
  validatePdfFile
} from "../../js/core/file-validator.js";

test("0バイトBlobを拒否し、内容のあるBlobを許可する", () => {
  assert.throws(() => assertNonEmptyBlob(new Blob([]), "テスト"), /0バイト/);
  assert.equal(assertNonEmptyBlob(new Blob(["ok"])).size, 2);
});

test("画像MIMEと最大サイズを検証する", () => {
  assert.equal(validateImageBlob(new Blob(["png"], { type: "image/png" })).type, "image/png");
  assert.throws(
    () => validateImageBlob(new Blob(["svg"], { type: "image/svg+xml" })),
    /対応していません/
  );
  assert.throws(
    () => validateImageBlob(new Blob(["large"], { type: "image/png" }), { maxBytes: 2 }),
    /上限/
  );
});

test("画像の自然寸法名を保持し、寸法上限超過を検出する", async () => {
  const originalImage = globalThis.Image;
  const originalCreateObjectUrl = URL.createObjectURL;
  const originalRevokeObjectUrl = URL.revokeObjectURL;
  let revokedUrl = "";
  globalThis.Image = class {
    naturalWidth = 8193;
    naturalHeight = 1;
    async decode() {}
  };
  URL.createObjectURL = () => "blob:test-oversized";
  URL.revokeObjectURL = value => { revokedUrl = value; };
  try {
    assert.deepEqual(
      await decodeImageDimensions(new Blob(["png"], { type: "image/png" })),
      { naturalWidth: 8193, naturalHeight: 1, oversized: true }
    );
    assert.equal(revokedUrl, "blob:test-oversized");
  } finally {
    if (originalImage === undefined) delete globalThis.Image;
    else globalThis.Image = originalImage;
    URL.createObjectURL = originalCreateObjectUrl;
    URL.revokeObjectURL = originalRevokeObjectUrl;
  }
});

test("拡張子ではなくPDFシグネチャを確認する", async () => {
  const pdf = new Blob(["%PDF-1.7\n"], { type: "application/octet-stream" });
  const fake = new Blob(["not a pdf"], { type: "application/pdf" });
  assert.equal(await hasPdfSignature(pdf), true);
  assert.equal(await validatePdfFile(pdf), pdf);
  await assert.rejects(validatePdfFile(fake), /PDFとして読み込めません/);
});

test("ページJSONを再パースしID・配列・有限値を検証する", () => {
  const value = {
    schemaVersion: 1,
    noteId: "note-1",
    pageId: "page-1",
    elements: [{
      id: "stroke-1",
      type: "stroke",
      points: [{ x: .1, y: .2, pressure: .5 }, { x: .2, y: .3, pressure: .6 }],
      style: { widthRatio: .002 }
    }],
    noteMasks: []
  };
  const serialized = serializeValidatedJson(value, { noteId: "note-1", pageId: "page-1" });
  assert.equal(typeof serialized.json, "string");
  assert.deepEqual(JSON.parse(serialized.json), value);
  assert.equal(serialized.parsed.noteId, "note-1");
  assert.ok(serialized.blob.size > 0);
  assert.throws(() => assertFiniteJson({ x: Number.NaN }), /NaNまたはInfinity/);
  assert.throws(
    () => serializeValidatedJson({ ...value, pageId: "other" }, { pageId: "page-1" }),
    /pageIdが一致しません/
  );
  assert.throws(
    () => serializeValidatedJson({ ...value, elements: [{ text: "x".repeat(MAX_NOTE_JSON_BYTES) }] }),
    /上限2MB/
  );
});

test("ページJSONの正規化座標が0〜1を外れる場合は保存しない", () => {
  const base = {
    schemaVersion: 1,
    noteId: "note-1",
    pageId: "page-1",
    elements: [],
    noteMasks: []
  };
  assert.throws(() => serializeValidatedJson({
    ...base,
    elements: [{
      id: "image-1",
      type: "image",
      assetId: "asset-1",
      bounds: { x: .9, y: .1, width: .2, height: .2 },
      crop: { x: 0, y: 0, width: 1, height: 1 }
    }]
  }, { noteId: "note-1", pageId: "page-1" }), /ページ範囲/);
});

test("line/arrowはstart/end正本とゼロ幅を含む旧互換boundsを保存できる", () => {
  const value = {
    schemaVersion: 1,
    noteId: "note-1",
    pageId: "page-1",
    elements: [{
      id: "line-1",
      type: "shape",
      shapeType: "arrow",
      start: { x: .2, y: .9 },
      end: { x: .2, y: .1 },
      bounds: { x: .2, y: .1, width: 0, height: .8 },
      rotation: 0
    }],
    noteMasks: []
  };
  assert.deepEqual(serializeValidatedJson(value).parsed.elements[0].start, value.elements[0].start);
});

test("旧points形式のlineは読み込み検証で許容し、保存時はstart/end必須にする", () => {
  const value = {
    schemaVersion: 1,
    noteId: "note-1",
    pageId: "page-1",
    elements: [{
      id: "line-legacy",
      type: "shape",
      shapeType: "line",
      points: [{ x: .1, y: .2 }, { x: .8, y: .7 }]
    }],
    noteMasks: []
  };
  assert.doesNotThrow(() => validateNormalizedNoteContent(value));
  assert.doesNotThrow(() => serializeValidatedJson(value, {}, { strict: false }));
  assert.throws(() => serializeValidatedJson(value), /保存形式のstart\/end/);
});

test("PDFファイル名に使えない文字を置換する", () => {
  assert.equal(sanitizeDownloadFilename('a/b:c*?"<d>|'), "a_b_c____d__");
  assert.equal(sanitizeDownloadFilename("  ", "note"), "note");
  assert.equal(sanitizeDownloadFilename("report. "), "report");
});
