import assert from "node:assert/strict";
import { deleteDoc, doc, getDoc, serverTimestamp, setDoc } from "firebase/firestore";
import { deleteObject, getBytes, ref, uploadBytes } from "firebase/storage";
import { ensureLocalUser, getLocalHost, initializeLocalFirebase } from "./local-firebase.mjs";

const host = getLocalHost();
const appResponse = await fetch(`http://${host}:3000/index.html`);
assert.equal(appResponse.ok, true, "ローカルHTTPサーバーへ接続できません。");

const local = initializeLocalFirebase("local-smoke");
const smokeRunId = `local-smoke-${crypto.randomUUID()}`;
let smokeNoteRef;
let smokeImageRef;
try {
  const user = await ensureLocalUser(local.auth);
  const legacyNote = await getDoc(doc(local.db, "users", user.uid, "notes", "local-smoke-note"));
  if (legacyNote.exists()) {
    console.warn("旧local:smokeの固定IDデータ local-smoke-note が残っています。共有データとして扱い、このスクリプトでは削除しません。");
  }
  smokeNoteRef = doc(local.db, "users", user.uid, "notes", smokeRunId);
  await setDoc(smokeNoteRef, {
    schemaVersion: 1,
    title: "local smoke",
    type: "standalone",
    status: "ready",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
  assert.equal((await getDoc(smokeNoteRef)).data()?.title, "local smoke");

  const imagePath = `users/${user.uid}/notes/${smokeRunId}/assets/smoke/original.png`;
  smokeImageRef = ref(local.storage, imagePath);
  const bytes = new Uint8Array([137, 80, 78, 71]);
  await uploadBytes(smokeImageRef, bytes, { contentType: "image/png" });
  assert.deepEqual(new Uint8Array(await getBytes(smokeImageRef)), bytes);

  console.log("local:smoke OK");
  console.log("Auth / Firestore / Storage EmulatorとローカルHTTPサーバーを確認しました。");
  console.log("接続先はdemo-dental-qaのみで、本番Firebaseは使用していません。");
} finally {
  if (smokeImageRef) await deleteObject(smokeImageRef).catch(error => {
    if (error?.code !== "storage/object-not-found") console.warn("smoke画像の後片付けに失敗しました。", error);
  });
  if (smokeNoteRef) await deleteDoc(smokeNoteRef).catch(error => console.warn("smokeノートの後片付けに失敗しました。", error));
  await local.close();
}
