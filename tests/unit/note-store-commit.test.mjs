import assert from "node:assert/strict";
import { register } from "node:module";
import { afterEach, beforeEach, test } from "node:test";

register("../helpers/note-store-commit-loader.mjs", import.meta.url);
const { resetFirebaseStubs } = await import("../helpers/note-store-firebase-stubs.mjs");
const { createNoteStore } = await import("../../js/services/note-store.js?commit-semantics");

const originalImage = globalThis.Image;
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

beforeEach(() => {
  globalThis.Image = class {
    naturalWidth = 32;
    naturalHeight = 24;
    async decode() {}
  };
  URL.createObjectURL = () => "blob:test-image";
  URL.revokeObjectURL = () => {};
});

afterEach(() => {
  globalThis.Image = originalImage;
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
});

function storeSwitchingUserAfterFinalTransaction() {
  let uid = "alice";
  resetFirebaseStubs({
    afterTransactionCommit: transactionCount => {
      if (transactionCount === 2) uid = "bob";
    }
  });
  return createNoteStore({
    getDb: () => ({ name: "db" }),
    getStorage: () => ({ name: "storage" }),
    getUser: () => ({ uid })
  });
}

function storeWithPageData(pageDataForTransaction) {
  resetFirebaseStubs({ pageDataForTransaction });
  return createNoteStore({
    getDb: () => ({ name: "db" }),
    getStorage: () => ({ name: "storage" }),
    getUser: () => ({ uid: "alice" })
  });
}

test("savePageContentはFirestore commit直後のユーザー切替を保存成功として返す", async () => {
  const store = storeSwitchingUserAfterFinalTransaction();
  const result = await store.savePageContent({
    noteId: "note-1",
    pageId: "page-1",
    expectedRevision: 0,
    expectedUid: "alice"
  }, {
    elements: [],
    noteMasks: []
  });

  assert.equal(result.revision, 1);
  assert.match(result.contentPath, /^users\/alice\/notes\/note-1\/pages\/page-1\/revisions\/.+[.]json$/);
});

test("uploadAssetはFirestore commit直後のユーザー切替を保存成功として返す", async () => {
  const store = storeSwitchingUserAfterFinalTransaction();
  const blob = new Blob(["image"], { type: "image/png" });
  const result = await store.uploadAsset("note-1", blob, {
    assetId: "asset-1",
    expectedUid: "alice"
  });

  assert.equal(result.assetId, "asset-1");
  assert.equal(result.storagePath, "users/alice/notes/note-1/assets/asset-1/original.png");
});

test("savePageContentは同じwriterSessionの先行revisionへ1回だけ追従する", async () => {
  const store = storeWithPageData(transactionCall => transactionCall >= 2
    ? { contentRevision: 1, lastWriterSessionId: "writer-1" }
    : {});
  const result = await store.savePageContent({
    noteId: "note-1",
    pageId: "page-1",
    expectedRevision: 0,
    expectedUid: "alice",
    writerSessionId: "writer-1",
    clientMutationId: "mutation-1"
  }, { elements: [], noteMasks: [] });

  assert.equal(result.revision, 2);
});

test("savePageContentは別writerSessionの先行revisionへ追従しない", async () => {
  const store = storeWithPageData(transactionCall => transactionCall >= 2
    ? { contentRevision: 1, lastWriterSessionId: "writer-other" }
    : {});
  await assert.rejects(store.savePageContent({
    noteId: "note-1",
    pageId: "page-1",
    expectedRevision: 0,
    expectedUid: "alice",
    writerSessionId: "writer-1",
    clientMutationId: "mutation-1"
  }, { elements: [], noteMasks: [] }), error => (
    error?.name === "NoteConflictError" && error.cloudRevision === 1
  ));
});

test("savePageContentは同じwriterSessionでも2回目のrebaseを競合にする", async () => {
  const store = storeWithPageData(transactionCall => {
    if (transactionCall >= 4) return { contentRevision: 2, lastWriterSessionId: "writer-1" };
    if (transactionCall >= 2) return { contentRevision: 1, lastWriterSessionId: "writer-1" };
    return {};
  });
  await assert.rejects(store.savePageContent({
    noteId: "note-1",
    pageId: "page-1",
    expectedRevision: 0,
    expectedUid: "alice",
    writerSessionId: "writer-1",
    clientMutationId: "mutation-1"
  }, { elements: [], noteMasks: [] }), error => (
    error?.name === "NoteConflictError" && error.cloudRevision === 2
  ));
});
