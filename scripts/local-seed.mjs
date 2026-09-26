import { doc, serverTimestamp, setDoc } from "firebase/firestore";
import {
  ensureLocalUser,
  initializeLocalFirebase,
  LOCAL_EMAIL,
  LOCAL_PASSWORD
} from "./local-firebase.mjs";

const local = initializeLocalFirebase("local-seed");
try {
  const user = await ensureLocalUser(local.auth);
  const appRef = name => doc(local.db, "users", user.uid, "app", name);
  await Promise.all([
    setDoc(appRef("questions"), {
      storageMode: "chunked-v1",
      questionCount: 0,
      chunkCount: 0,
      updatedAt: serverTimestamp()
    }, { merge: true }),
    setDoc(appRef("pdfMaterials"), { pdfMaterials: [], pdfRevealStates: {}, updatedAt: serverTimestamp() }, { merge: true }),
    setDoc(appRef("progress"), { progress: {}, questionStatuses: {}, wrongQuestionIds: [], updatedAt: serverTimestamp() }, { merge: true }),
    setDoc(appRef("settings"), { schemaVersion: "split-v2", updatedAt: serverTimestamp() }, { merge: true }),
    setDoc(appRef("sync"), { revision: 0, updatedAt: serverTimestamp() }, { merge: true })
  ]);
  console.log("ローカル確認用ユーザーと初期データを準備しました。");
  console.log(`メール: ${LOCAL_EMAIL}`);
  console.log(`パスワード: ${LOCAL_PASSWORD}`);
} finally {
  await local.close();
}
