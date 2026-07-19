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
  setDoc,
  updateDoc
} from "firebase/firestore";
import {
  deleteObject,
  getBytes,
  getMetadata,
  ref,
  updateMetadata,
  uploadBytes
} from "firebase/storage";

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
