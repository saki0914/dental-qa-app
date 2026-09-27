import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, getDocs, setDoc, updateDoc } from "firebase/firestore";

register("../helpers/firebase-browser-import-loader.mjs", import.meta.url);
const { createNoteStore } = await import("../../js/services/note-store.js");

const projectId = "demo-dental-qa";
const firestore = { host: "127.0.0.1", port: 8080 };
const storageConfig = { host: "127.0.0.1", port: 9199 };
const page = materialId => ({
  pageId: "material-page-0001",
  order: 1,
  pageType: "material-page",
  size: { width: 100, height: 200 },
  background: { type: "material-page", materialId, materialPage: 1 }
});
const blankPage = pageId => ({
  pageId,
  order: 1,
  pageType: "blank",
  size: { width: 100, height: 200 },
  background: { type: "blank", paperColor: "#FFFFFF" }
});

async function createFixture(uid) {
  const environment = await initializeTestEnvironment({ projectId, firestore, storage: storageConfig });
  const context = environment.authenticatedContext(uid);
  const db = context.firestore();
  const storage = context.storage();
  const store = createNoteStore({ getDb: () => db, getStorage: () => storage, getUser: () => ({ uid }) });
  return { environment, db, store };
}

async function seedMaterial(db, uid, materialId, defaultNoteId) {
  await setDoc(doc(db, "users", uid, "app", "pdfMaterials"), {
    pdfMaterials: [{
      id: materialId,
      defaultNoteId,
      title: "同時作成教材",
      status: "ready",
      pages: [{ page: 1 }]
    }]
  });
}

function createDefaultNote(store, uid, materialId, noteId) {
  return store.createNote({
    noteId,
    title: "同時作成教材 ノート",
    type: "material-linked",
    sourceMaterialId: materialId,
    isDefaultMaterialNote: true,
    defaultBackground: { type: "blank", paperColor: "#FFFFFF" },
    pages: [page(materialId)],
    reuseExisting: true,
    expectedUid: uid
  });
}

test("固定IDの既定ノートを同時作成してもready 1件を再利用する", async () => {
  const uid = "note-store-concurrent-user";
  const materialId = "material-concurrent";
  const noteId = "note-default-concurrent";
  const { environment, db, store } = await createFixture(uid);
  try {
    await seedMaterial(db, uid, materialId, noteId);
    const results = await Promise.all([
      createDefaultNote(store, uid, materialId, noteId),
      createDefaultNote(store, uid, materialId, noteId)
    ]);
    assert.deepEqual(results, [noteId, noteId]);

    const root = await getDoc(doc(db, "users", uid, "notes", noteId));
    assert.equal(root.data()?.status, "ready");
    assert.equal(root.data()?.createdPageCount, 1);
    assert.equal(root.data()?.pageCount, 1);
    const pages = await getDocs(collection(db, "users", uid, "notes", noteId, "pages"));
    assert.equal(pages.size, 1);
  } finally {
    await environment.cleanup();
  }
});

test("待機中の既定ノートがfailedになったら同じ作成Sagaで再作成する", async () => {
  const uid = "note-store-failed-user";
  const materialId = "material-failed";
  const noteId = "note-default-failed";
  const { environment, db, store } = await createFixture(uid);
  try {
    await seedMaterial(db, uid, materialId, noteId);
    await setDoc(doc(db, "users", uid, "notes", noteId), {
      schemaVersion: 1,
      title: "失敗ノート",
      type: "material-linked",
      sourceMaterialId: materialId,
      materialRefs: [materialId],
      status: "creating",
      pageCount: 0,
      createdPageCount: 0,
      pendingStoragePaths: [],
      orderRevision: 0,
      deletedAt: null
    });

    const markFailed = (async () => {
      await new Promise(resolve => setTimeout(resolve, 350));
      await updateDoc(doc(db, "users", uid, "notes", noteId), { status: "failed" });
    })();
    assert.equal(await createDefaultNote(store, uid, materialId, noteId), noteId);
    await markFailed;
    const root = await getDoc(doc(db, "users", uid, "notes", noteId));
    assert.equal(root.data()?.status, "ready");
    assert.equal(root.data()?.createdPageCount, 1);
    const pages = await getDocs(collection(db, "users", uid, "notes", noteId, "pages"));
    assert.equal(pages.size, 1);
  } finally {
    await environment.cleanup();
  }
});

test("status欠落の旧ノートをready相当として一覧へ返す", async () => {
  const uid = "note-store-legacy-user";
  const noteId = "note-legacy";
  const { environment, db, store } = await createFixture(uid);
  try {
    await setDoc(doc(db, "users", uid, "notes", noteId), {
      schemaVersion: 1,
      title: "statusなし旧ノート",
      type: "standalone",
      pageCount: 1,
      deletedAt: null
    });
    const notes = await store.listNotes({ expectedUid: uid });
    assert.equal(notes.some(note => note.id === noteId), true);
  } finally {
    await environment.cleanup();
  }
});

test("同じwriterSessionの直列保存だけを1回rebaseする", async () => {
  const uid = "note-store-rebase-user";
  const noteId = "note-rebase";
  const pageId = "page-rebase";
  const { environment, db, store } = await createFixture(uid);
  try {
    await store.createNote({
      noteId,
      title: "rebase test",
      type: "standalone",
      pages: [blankPage(pageId)],
      expectedUid: uid
    });
    const base = {
      noteId,
      pageId,
      expectedRevision: 0,
      expectedUid: uid,
      clientInstanceId: "client-1",
      editorTabId: "tab-1",
      writerSessionId: "writer-1"
    };
    const content = elementId => ({
      schemaVersion: 1,
      noteId,
      pageId,
      revision: 0,
      elements: [{ id: elementId, type: "stroke", points: [{ x: .1, y: .1 }, { x: .2, y: .2 }], style: {} }],
      noteMasks: []
    });

    const results = await Promise.all([
      store.savePageContent({ ...base, clientMutationId: "mutation-1" }, content("first")),
      store.savePageContent({ ...base, clientMutationId: "mutation-2" }, content("second"))
    ]);

    assert.deepEqual(results.map(result => result.revision), [1, 2]);
    const pageSnapshot = await getDoc(doc(db, "users", uid, "notes", noteId, "pages", pageId));
    assert.equal(pageSnapshot.data()?.contentRevision, 2);
    assert.equal(pageSnapshot.data()?.lastBaseRevision, 1);
    assert.equal(pageSnapshot.data()?.lastClientMutationId, "mutation-2");
    const noteSnapshot = await getDoc(doc(db, "users", uid, "notes", noteId));
    assert.deepEqual(noteSnapshot.data()?.pendingStoragePaths || [], []);
  } finally {
    await environment.cleanup();
  }
});

test("異なるwriterSessionの古いrevisionはrebaseせず競合にする", async () => {
  const uid = "note-store-rebase-conflict-user";
  const noteId = "note-rebase-conflict";
  const pageId = "page-rebase-conflict";
  const { environment, store } = await createFixture(uid);
  try {
    await store.createNote({
      noteId,
      title: "rebase conflict test",
      type: "standalone",
      pages: [blankPage(pageId)],
      expectedUid: uid
    });
    const content = { schemaVersion: 1, noteId, pageId, revision: 0, elements: [], noteMasks: [] };
    await store.savePageContent({
      noteId, pageId, expectedRevision: 0, expectedUid: uid,
      writerSessionId: "writer-1", clientMutationId: "writer-1-mutation"
    }, content);
    await assert.rejects(store.savePageContent({
      noteId, pageId, expectedRevision: 0, expectedUid: uid,
      writerSessionId: "writer-2", clientMutationId: "writer-2-mutation"
    }, content), error => error?.name === "NoteConflictError" && error.cloudRevision === 1);
  } finally {
    await environment.cleanup();
  }
});
