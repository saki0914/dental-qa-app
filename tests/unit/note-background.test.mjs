import assert from "node:assert/strict";
import test from "node:test";
import { createNoteBackgroundSignature } from "../../js/core/note-background.js";

const page = {
  pageId: "page-1",
  size: { width: 1000, height: 1400 },
  background: {
    type: "material-page",
    materialId: "material-1",
    materialPage: 2,
    paperColor: "#fff"
  }
};

test("内容revisionだけの更新では背景シグネチャを変えない", () => {
  assert.equal(
    createNoteBackgroundSignature(page),
    createNoteBackgroundSignature({ ...page, contentRevision: 9, contentHash: "updated" })
  );
});

test("ページ・寸法・背景ソースの変更を背景シグネチャへ反映する", () => {
  const signature = createNoteBackgroundSignature(page);
  assert.notEqual(signature, createNoteBackgroundSignature(page, "note-2"));
  assert.notEqual(signature, createNoteBackgroundSignature({ ...page, pageId: "page-2" }));
  assert.notEqual(signature, createNoteBackgroundSignature({ ...page, size: { width: 1400, height: 1000 } }));
  assert.notEqual(signature, createNoteBackgroundSignature({
    ...page,
    background: { ...page.background, materialPage: 3 }
  }));
  assert.notEqual(signature, createNoteBackgroundSignature({
    ...page,
    background: { ...page.background, pdfRotation: 90 }
  }));
  assert.notEqual(
    createNoteBackgroundSignature(page, "", "users/alice/material/page_1_old.png"),
    createNoteBackgroundSignature(page, "", "users/alice/material/page_1_new.png")
  );
});
