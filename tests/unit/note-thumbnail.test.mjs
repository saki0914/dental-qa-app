import assert from "node:assert/strict";
import test from "node:test";
import { createNoteThumbnailSignature } from "../../js/core/note-thumbnail.js";

const page = {
  pageId: "page-1",
  contentRevision: 4,
  size: { width: 1000, height: 1414 },
  background: { type: "blank", paperColor: "#fff" }
};
const content = {
  revision: 4,
  elements: [{ id: "text-1", type: "text", text: "before" }],
  noteMasks: [{ id: "mask-1", x: .1, y: .1, width: .2, height: .1 }]
};

test("サムネイル署名はクラウドrevision前のローカル編集でも変化する", () => {
  const before = createNoteThumbnailSignature({ noteId: "note-1", firstPageId: "page-1", page, content });
  const after = createNoteThumbnailSignature({
    noteId: "note-1",
    firstPageId: "page-1",
    page,
    content: { ...content, elements: [{ ...content.elements[0], text: "after" }] }
  });
  assert.notEqual(after, before);
});

test("サムネイル署名は先頭ページ・背景・マスク表示内容・競合上書きを捕捉する", () => {
  const base = createNoteThumbnailSignature({ noteId: "note-1", firstPageId: "page-1", page, content });
  assert.notEqual(
    createNoteThumbnailSignature({ noteId: "note-1", firstPageId: "page-2", page, content }),
    base
  );
  assert.notEqual(
    createNoteThumbnailSignature({ noteId: "note-1", firstPageId: "page-1", page: { ...page, background: { type: "ruled" } }, content }),
    base
  );
  assert.notEqual(
    createNoteThumbnailSignature({ noteId: "note-1", firstPageId: "page-1", page, content, maskMode: "none" }),
    base
  );
  assert.notEqual(
    createNoteThumbnailSignature({ noteId: "note-1", firstPageId: "page-1", page, content: { ...content, noteMasks: [] } }),
    base
  );
  assert.notEqual(
    createNoteThumbnailSignature({
      noteId: "note-1",
      firstPageId: "page-1",
      page,
      content,
      backgroundSource: "users/alice/material/page_1_new.png"
    }),
    base
  );
});
