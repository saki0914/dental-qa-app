import assert from "node:assert/strict";
import { register } from "node:module";
import { afterEach, beforeEach, test } from "node:test";

register("../helpers/note-store-commit-loader.mjs", import.meta.url);
const { firebaseStubCalls, resetFirebaseStubs } = await import("../helpers/note-store-firebase-stubs.mjs");
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
      // The Storage journal is a read plus an arrayUnion update, so the page
      // or asset commit is the first (and final) transaction of each save.
      if (transactionCount === 1) uid = "bob";
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
  const store = storeWithPageData(transactionCall => transactionCall >= 1
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
  const store = storeWithPageData(transactionCall => transactionCall >= 1
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
    if (transactionCall >= 2) return { contentRevision: 2, lastWriterSessionId: "writer-1" };
    if (transactionCall >= 1) return { contentRevision: 1, lastWriterSessionId: "writer-1" };
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

test("Storageジャーナルは削除済み・作成失敗・上限到達のノートへアップロード前に拒否する", async () => {
  const cases = [
    [{ deletedAt: "2026-09-01T00:00:00.000Z" }, /Storage書込み先のノートを確認できません/],
    [{ status: "failed" }, /Storage書込み先のノートを確認できません/],
    [{ pendingStoragePaths: Array.from({ length: 1000 }, (_, index) => `users/alice/notes/note-1/x/${index}`) }, /上限に達した/]
  ];
  for (const [noteData, message] of cases) {
    resetFirebaseStubs({ noteData });
    const store = createNoteStore({
      getDb: () => ({ name: "db" }),
      getStorage: () => ({ name: "storage" }),
      getUser: () => ({ uid: "alice" })
    });
    await assert.rejects(store.savePageContent({
      noteId: "note-1",
      pageId: "page-1",
      expectedRevision: 0,
      expectedUid: "alice"
    }, { elements: [], noteMasks: [] }), message);
    assert.deepEqual(firebaseStubCalls().uploads, [], "Storageへは何も書き込まない");
    assert.deepEqual(firebaseStubCalls().updates, [], "ノート文書も更新しない");
  }
});

test("Storageジャーナルは1回のarrayUnion更新で書込み先を記録してからアップロードする", async () => {
  resetFirebaseStubs();
  const store = createNoteStore({
    getDb: () => ({ name: "db" }),
    getStorage: () => ({ name: "storage" }),
    getUser: () => ({ uid: "alice" })
  });
  const result = await store.savePageContent({
    noteId: "note-1",
    pageId: "page-1",
    expectedRevision: 0,
    expectedUid: "alice"
  }, { elements: [], noteMasks: [] });
  const { uploads, updates } = firebaseStubCalls();
  assert.deepEqual(uploads, [result.contentPath]);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].path, "users/alice/notes/note-1");
  assert.deepEqual(updates[0].fields.pendingStoragePaths, { union: [result.contentPath] });
});
