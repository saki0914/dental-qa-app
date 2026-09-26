import assert from "node:assert/strict";
import { deleteDoc, doc, getDoc, serverTimestamp, setDoc } from "firebase/firestore";
import { deleteObject, getBytes, ref, uploadBytes } from "firebase/storage";
import { ensureLocalUser, getLocalHost, initializeLocalFirebase } from "./local-firebase.mjs";

const host = getLocalHost();
const appResponse = await fetch(`http://${host}:3000/index.html`);
assert.equal(appResponse.ok, true, "ローカルHTTPサーバーへ接続できません。");

const local = initializeLocalFirebase("local-smoke");
try {
  const user = await ensureLocalUser(local.auth);
  const noteRef = doc(local.db, "users", user.uid, "notes", "local-smoke-note");
  await setDoc(noteRef, {
    schemaVersion: 1,
    title: "local smoke",
    type: "standalone",
    status: "ready",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
  assert.equal((await getDoc(noteRef)).data()?.title, "local smoke");

  const imagePath = `users/${user.uid}/notes/local-smoke-note/assets/smoke/original.png`;
  const imageRef = ref(local.storage, imagePath);
  const bytes = new Uint8Array([137, 80, 78, 71]);
  await uploadBytes(imageRef, bytes, { contentType: "image/png" });
  assert.deepEqual(new Uint8Array(await getBytes(imageRef)), bytes);
  await deleteObject(imageRef);
  await deleteDoc(noteRef);

  console.log("local:smoke OK");
  console.log("Auth / Firestore / Storage EmulatorとローカルHTTPサーバーを確認しました。");
  console.log("接続先はdemo-dental-qaのみで、本番Firebaseは使用していません。");
} finally {
  await local.close();
}
