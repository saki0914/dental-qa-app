import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";

import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment
} from "@firebase/rules-unit-testing";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch
} from "firebase/firestore";
import {
  deleteObject,
  getBytes,
  getMetadata,
  ref,
  updateMetadata,
  uploadBytes
} from "firebase/storage";
import {
  deleteQuestionImageFiles
} from "../../js/core/question-image-delete.js";
import { splitLinkedNoteWrites } from "../../js/core/note-material-mutation.js";

const PROJECT_ID = "demo-dental-qa";
let testEnv;

before(async () => {
  const [firestoreRules, storageRules] = await Promise.all([
    readFile(new URL("../../firestore.rules", import.meta.url), "utf8"),
    readFile(new URL("../../storage.rules", import.meta.url), "utf8")
  ]);

  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: firestoreRules },
    storage: { rules: storageRules }
  });
});

beforeEach(async () => {
  await Promise.all([
    testEnv.clearFirestore(),
    testEnv.clearStorage()
  ]);
});

after(async () => {
  await testEnv?.cleanup();
});

test("Firestoreは本人のusers/{uid}/app配下だけを許可する", async () => {
  const aliceDb = testEnv.authenticatedContext("alice").firestore();
  const bobDb = testEnv.authenticatedContext("bob").firestore();
  const guestDb = testEnv.unauthenticatedContext().firestore();
  const ownRef = doc(aliceDb, "users/alice/app/questions");

  await assertSucceeds(setDoc(ownRef, { allQuestions: [{ id: "q1" }] }));
  const snapshot = await assertSucceeds(getDoc(ownRef));
  assert.equal(snapshot.data().allQuestions[0].id, "q1");
  await assertSucceeds(updateDoc(ownRef, { version: 2 }));
  const listSnapshot = await assertSucceeds(getDocs(collection(aliceDb, "users/alice/app")));
  assert.equal(listSnapshot.size, 1);

  await assertFails(getDoc(doc(bobDb, "users/alice/app/questions")));
  await assertFails(updateDoc(doc(bobDb, "users/alice/app/questions"), { denied: true }));
  await assertFails(deleteDoc(doc(bobDb, "users/alice/app/questions")));
  await assertFails(setDoc(doc(guestDb, "users/alice/app/questions"), { denied: true }));
  await assertFails(setDoc(doc(aliceDb, "public/settings"), { denied: true }));
  await assertFails(setDoc(doc(aliceDb, "users/alice/private/settings"), { denied: true }));
  await assertFails(setDoc(doc(aliceDb, "users/alice/app/questions/private/item"), { denied: true }));
  await assertSucceeds(deleteDoc(ownRef));
});

test("Firestoreは本人のノート階層だけを許可する", async () => {
  const aliceDb = testEnv.authenticatedContext("alice").firestore();
  const bobDb = testEnv.authenticatedContext("bob").firestore();
  const guestDb = testEnv.unauthenticatedContext().firestore();
  const noteRef = doc(aliceDb, "users/alice/notes/note-1");
  const pageRef = doc(aliceDb, "users/alice/notes/note-1/pages/page-1");
  const assetRef = doc(aliceDb, "users/alice/notes/note-1/assets/asset-1");

  await assertSucceeds(setDoc(noteRef, { title: "ノート", status: "ready" }));
  await assertSucceeds(setDoc(pageRef, { order: 1, contentRevision: 0 }));
  await assertSucceeds(setDoc(assetRef, { storagePath: "users/alice/notes/note-1/assets/asset-1/original.png" }));
  await assertSucceeds(getDoc(pageRef));

  await assertFails(getDoc(doc(bobDb, "users/alice/notes/note-1")));
  await assertFails(setDoc(doc(bobDb, "users/alice/notes/note-1/pages/page-1"), { denied: true }));
  await assertFails(setDoc(doc(guestDb, "users/alice/notes/note-1"), { denied: true }));
});

test("Firestoreノートrulesは疎な旧documentを許容し、存在するschema fieldだけを検証する", async () => {
  const aliceDb = testEnv.authenticatedContext("alice").firestore();
  const noteRef = doc(aliceDb, "users/alice/notes/note-schema");
  const pageRef = doc(aliceDb, "users/alice/notes/note-schema/pages/page-1");
  const assetRef = doc(aliceDb, "users/alice/notes/note-schema/assets/asset-1");

  await assertSucceeds(setDoc(noteRef, { title: "旧形式の疎なノート" }));
  await assertSucceeds(updateDoc(noteRef, { status: "creating", pageCount: 0 }));
  await assertSucceeds(setDoc(pageRef, { title: "旧形式ページ" }));
  await assertSucceeds(updateDoc(pageRef, { noteId: "note-schema", contentRevision: 0 }));
  await assertSucceeds(setDoc(assetRef, { label: "旧形式asset" }));

  await assertFails(updateDoc(noteRef, { status: "unexpected" }));
  await assertFails(updateDoc(noteRef, { title: "x".repeat(201) }));
  await assertFails(updateDoc(noteRef, { schemaVersion: 2 }));
  await assertFails(updateDoc(noteRef, { pageCount: -1 }));
  await assertFails(updateDoc(noteRef, { deletedAt: 123 }));
  await assertSucceeds(updateDoc(noteRef, { status: "deleting", deletedAt: "legacy-logical-delete" }));
  await assertFails(updateDoc(pageRef, { noteId: "other-note" }));
  await assertFails(updateDoc(pageRef, { contentRevision: 1.5 }));
  await assertFails(updateDoc(pageRef, { deletedAt: 123 }));
  await assertSucceeds(updateDoc(pageRef, { deletedAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(pageRef, {
    contentPath: "users/alice/notes/note-schema/pages/page-1/revisions/save-1.json"
  }));
  await assertFails(updateDoc(pageRef, {
    contentPath: "users/alice/notes/other-note/pages/page-1/revisions/save-1.json"
  }));
  await assertFails(updateDoc(pageRef, {
    contentPath: "users/alice/notes/note-schema/pages/other-page/revisions/save-1.json"
  }));
  await assertFails(updateDoc(pageRef, {
    contentPath: "users/bob/notes/note-schema/pages/page-1/revisions/save-1.json"
  }));
  await assertFails(updateDoc(assetRef, {
    storagePath: "users/bob/notes/note-schema/assets/asset-1/original.png"
  }));
  await assertFails(updateDoc(assetRef, { mimeType: "image/svg+xml" }));
  await assertFails(updateDoc(assetRef, { mimeType: 123 }));
  await assertSucceeds(updateDoc(noteRef, {
    pendingStoragePaths: ["users/alice/notes/note-schema/pages/page-1/revisions/pending.json"],
    orphanedPaths: [],
    failedPageIds: []
  }));
  await assertFails(updateDoc(noteRef, { pendingStoragePaths: "not-a-list" }));
  await assertFails(updateDoc(noteRef, { orphanedPaths: Array.from({ length: 1001 }, (_, index) => `path-${index}`) }));
});

test("materialRefsで連携ノートを検索し、教材ロック後にbatchで論理削除できる", async () => {
  const aliceDb = testEnv.authenticatedContext("alice").firestore();
  const materialRef = doc(aliceDb, "users/alice/app/pdfMaterials");
  await Promise.all([
    setDoc(materialRef, { pdfMaterials: [{ id: "material-1", status: "ready" }] }),
    setDoc(doc(aliceDb, "users/alice/notes/note-linked-1"), {
      title: "連携ノート1", materialRefs: ["material-1"], deletedAt: null
    }),
    setDoc(doc(aliceDb, "users/alice/notes/note-linked-2"), {
      title: "連携ノート2", materialRefs: ["material-1", "material-2"], deletedAt: null
    }),
    setDoc(doc(aliceDb, "users/alice/notes/note-linked-user-deleted"), {
      title: "ユーザー削除済み連携ノート", materialRefs: ["material-1"],
      deletedAt: "earlier", deletedReason: "user"
    }),
    setDoc(doc(aliceDb, "users/alice/notes/note-other"), {
      title: "非連携ノート", materialRefs: ["material-2"], deletedAt: null
    })
  ]);

  await assertSucceeds(updateDoc(materialRef, {
    pdfMaterials: [{ id: "material-1", status: "archiving" }]
  }));
  const linked = await assertSucceeds(getDocs(query(
    collection(aliceDb, "users/alice/notes"),
    where("materialRefs", "array-contains", "material-1")
  )));
  assert.equal(linked.size, 3);

  const batch = writeBatch(aliceDb);
  linked.docs.forEach(snapshot => batch.update(snapshot.ref, {
    deletedAt: "logical-delete",
    deletedReason: "material-deleted"
  }));
  await assertSucceeds(batch.commit());
  await assertSucceeds(updateDoc(materialRef, { pdfMaterials: [] }));

  assert.deepEqual((await getDoc(materialRef)).data()?.pdfMaterials, []);
  assert.equal((await getDoc(doc(aliceDb, "users/alice/notes/note-linked-1"))).data()?.deletedReason, "material-deleted");
  assert.equal((await getDoc(doc(aliceDb, "users/alice/notes/note-linked-2"))).data()?.deletedReason, "material-deleted");
  assert.equal((await getDoc(doc(aliceDb, "users/alice/notes/note-linked-user-deleted"))).data()?.deletedReason, "material-deleted");
  assert.equal((await getDoc(doc(aliceDb, "users/alice/notes/note-other"))).data()?.deletedAt, null);
});

test("500件を超える連携ノートを複数batchへ分けて論理削除できる", async () => {
  const aliceDb = testEnv.authenticatedContext("alice").firestore();
  const references = Array.from(
    { length: 501 },
    (_, index) => doc(aliceDb, "users", "alice", "notes", `note-${String(index).padStart(3, "0")}`)
  );
  for (const referenceChunk of splitLinkedNoteWrites(references)) {
    const seedBatch = writeBatch(aliceDb);
    referenceChunk.forEach(reference => seedBatch.set(reference, {
      title: "分割batch検証",
      materialRefs: ["material-large"],
      deletedAt: null
    }));
    await assertSucceeds(seedBatch.commit());
  }

  const linked = await assertSucceeds(getDocs(query(
    collection(aliceDb, "users/alice/notes"),
    where("materialRefs", "array-contains", "material-large")
  )));
  assert.equal(linked.size, 501);
  const chunks = splitLinkedNoteWrites(linked.docs);
  assert.deepEqual(chunks.map(chunk => chunk.length), [500, 1]);
  for (const snapshotChunk of chunks) {
    const deleteBatch = writeBatch(aliceDb);
    snapshotChunk.forEach(snapshot => deleteBatch.update(snapshot.ref, {
      deletedAt: serverTimestamp(),
      deletedReason: "material-deleted",
      updatedAt: serverTimestamp()
    }));
    await assertSucceeds(deleteBatch.commit());
  }

  const deleted = await getDocs(query(
    collection(aliceDb, "users/alice/notes"),
    where("materialRefs", "array-contains", "material-large")
  ));
  assert.equal(deleted.docs.filter(snapshot => snapshot.data().deletedReason === "material-deleted").length, 501);
});

test("Storageは本人のusers/{uid}配下だけを許可する", async () => {
  const bytes = new Uint8Array([137, 80, 78, 71]);
  const aliceStorage = testEnv.authenticatedContext("alice").storage();
  const bobStorage = testEnv.authenticatedContext("bob").storage();
  const guestStorage = testEnv.unauthenticatedContext().storage();
  const ownPath = "users/alice/imageMaterials/material-1/page-1.png";

  await assertSucceeds(uploadBytes(ref(aliceStorage, ownPath), bytes, { contentType: "image/png" }));
  const stored = await assertSucceeds(getBytes(ref(aliceStorage, ownPath)));
  assert.deepEqual(new Uint8Array(stored), bytes);
  const metadata = await assertSucceeds(getMetadata(ref(aliceStorage, ownPath)));
  assert.equal(metadata.contentType, "image/png");
  await assertSucceeds(updateMetadata(ref(aliceStorage, ownPath), { cacheControl: "private,max-age=60" }));

  await assertFails(getBytes(ref(bobStorage, ownPath)));
  await assertFails(getMetadata(ref(bobStorage, ownPath)));
  await assertFails(deleteObject(ref(bobStorage, ownPath)));
  await assertFails(uploadBytes(ref(guestStorage, ownPath), bytes));
  await assertFails(uploadBytes(ref(aliceStorage, "public/page-1.png"), bytes));
  await assertSucceeds(deleteObject(ref(aliceStorage, ownPath)));
});

test("Storageのノート画像パスは画像だけを許可する", async () => {
  const bytes = new Uint8Array([137, 80, 78, 71]);
  const oversizedBytes = new Uint8Array(20 * 1024 * 1024 + 1);
  const aliceStorage = testEnv.authenticatedContext("alice").storage();
  const bobStorage = testEnv.authenticatedContext("bob").storage();
  const guestStorage = testEnv.unauthenticatedContext().storage();
  const assetPath = "users/alice/notes/note-1/assets/asset-1/original.png";
  const sourcePath = "users/alice/notes/note-1/sourcePages/page-1/background.jpg";

  await assertSucceeds(uploadBytes(ref(aliceStorage, assetPath), bytes, { contentType: "image/png" }));
  await assertSucceeds(uploadBytes(ref(aliceStorage, sourcePath), bytes, { contentType: "image/jpeg" }));
  await assertFails(uploadBytes(ref(aliceStorage, `${assetPath}.empty`), new Uint8Array(), {
    contentType: "image/png"
  }));
  await assertFails(uploadBytes(ref(aliceStorage, `${assetPath}.json`), bytes, { contentType: "application/json" }));
  await assertFails(uploadBytes(ref(aliceStorage, `${sourcePath}.json`), bytes, { contentType: "application/json" }));
  await assertFails(uploadBytes(ref(aliceStorage, `${assetPath}.large`), oversizedBytes, {
    contentType: "image/png"
  }));
  await assertFails(uploadBytes(ref(aliceStorage, `${sourcePath}.large`), oversizedBytes, {
    contentType: "image/png"
  }));
  await assertFails(uploadBytes(ref(bobStorage, assetPath), bytes, { contentType: "image/png" }));
  await assertFails(uploadBytes(ref(guestStorage, assetPath), bytes, { contentType: "image/png" }));
  await assertSucceeds(getBytes(ref(aliceStorage, assetPath)));
  await assertFails(getBytes(ref(bobStorage, assetPath)));
});

test("Storageのノートページリビジョンは小さいJSONだけを許可する", async () => {
  const aliceStorage = testEnv.authenticatedContext("alice").storage();
  const jsonPath = "users/alice/notes/note-1/pages/page-1/revisions/save-1.json";
  const jsonBytes = new TextEncoder().encode("{}");

  await assertSucceeds(uploadBytes(ref(aliceStorage, jsonPath), jsonBytes, {
    contentType: "application/json"
  }));
  await assertFails(uploadBytes(ref(aliceStorage, `${jsonPath}.empty`), new Uint8Array(), {
    contentType: "application/json"
  }));
  await assertFails(uploadBytes(ref(aliceStorage, `${jsonPath}.png`), jsonBytes, {
    contentType: "image/png"
  }));
  await assertFails(uploadBytes(ref(aliceStorage, `${jsonPath}.large`), new Uint8Array(2 * 1024 * 1024 + 1), {
    contentType: "application/json"
  }));
  await assertFails(uploadBytes(
    ref(aliceStorage, "users/alice/notes/note-1/unexpected/file.json"),
    jsonBytes,
    { contentType: "application/json" }
  ));
  await assertFails(uploadBytes(
    ref(aliceStorage, "users/alice/notes/note-1/exports/note.pdf"),
    new TextEncoder().encode("%PDF-1.7"),
    { contentType: "application/pdf" }
  ));
});

test("問題画像一括削除は本人のquestions配下をStorageから削除する", async () => {
  const bytes = new Uint8Array([137, 80, 78, 71]);
  const aliceStorage = testEnv.authenticatedContext("alice").storage();
  const imagePath = "users/alice/questions/q1/image.png";
  await assertSucceeds(uploadBytes(ref(aliceStorage, imagePath), bytes, { contentType: "image/png" }));

  const [result] = await deleteQuestionImageFiles([
    { id: "q1", imagePath }
  ], {
    userId: "alice",
    deleteByPath: path => deleteObject(ref(aliceStorage, path))
  });

  assert.equal(result.status, "deleted");
  await assert.rejects(
    getBytes(ref(aliceStorage, imagePath)),
    error => error?.code === "storage/object-not-found"
  );
});

test("問題画像一括削除はStorage拒否を対象ごとの失敗として返す", async () => {
  const bytes = new Uint8Array([137, 80, 78, 71]);
  const aliceStorage = testEnv.authenticatedContext("alice").storage();
  const bobStorage = testEnv.authenticatedContext("bob").storage();
  const imagePath = "users/alice/questions/q1/image.png";
  await assertSucceeds(uploadBytes(ref(aliceStorage, imagePath), bytes, { contentType: "image/png" }));

  const [result] = await deleteQuestionImageFiles([
    { id: "q1", imagePath }
  ], {
    userId: "alice",
    deleteByPath: path => deleteObject(ref(bobStorage, path))
  });

  assert.equal(result.status, "failed");
  assert.equal(result.reason, "delete-failed");
  await assertSucceeds(getBytes(ref(aliceStorage, imagePath)));
});

test("問題画像一括削除は不正パスをStorageへ送らず保持する", async () => {
  const bytes = new Uint8Array([137, 80, 78, 71]);
  const aliceStorage = testEnv.authenticatedContext("alice").storage();
  const imagePath = "users/alice/imageMaterials/material-1/page-1.png";
  let deleteCalls = 0;
  await assertSucceeds(uploadBytes(ref(aliceStorage, imagePath), bytes, { contentType: "image/png" }));

  const [result] = await deleteQuestionImageFiles([
    { id: "q1", imagePath }
  ], {
    userId: "alice",
    deleteByPath: async path => {
      deleteCalls += 1;
      await deleteObject(ref(aliceStorage, path));
    }
  });

  assert.equal(result.status, "failed");
  assert.equal(result.reason, "invalid-path");
  assert.equal(deleteCalls, 0);
  await assertSucceeds(getBytes(ref(aliceStorage, imagePath)));
});
