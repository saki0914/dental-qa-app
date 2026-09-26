import { initializeApp, deleteApp } from "firebase/app";
import {
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  getAuth,
  signInWithEmailAndPassword
} from "firebase/auth";
import { connectFirestoreEmulator, getFirestore } from "firebase/firestore";
import { connectStorageEmulator, getStorage } from "firebase/storage";

export const LOCAL_PROJECT_ID = "demo-dental-qa";
export const LOCAL_EMAIL = "local-note-test@example.com";
export const LOCAL_PASSWORD = "LocalNoteTest123!";

export function getLocalHost() {
  return process.env.DENTAL_LOCAL_HOST || "127.0.0.1";
}

export function initializeLocalFirebase(name = `local-${Date.now()}-${Math.random()}`) {
  const host = getLocalHost();
  const app = initializeApp({
    apiKey: "demo-api-key",
    authDomain: `${LOCAL_PROJECT_ID}.firebaseapp.com`,
    projectId: LOCAL_PROJECT_ID,
    storageBucket: `${LOCAL_PROJECT_ID}.firebasestorage.app`,
    appId: "demo-app-id"
  }, name);
  const auth = getAuth(app);
  const db = getFirestore(app);
  const storage = getStorage(app);
  connectAuthEmulator(auth, `http://${host}:9099`, { disableWarnings: true });
  connectFirestoreEmulator(db, host, 8080);
  connectStorageEmulator(storage, host, 9199);
  return { app, auth, db, storage, close: () => deleteApp(app) };
}

export async function ensureLocalUser(auth) {
  try {
    return (await createUserWithEmailAndPassword(auth, LOCAL_EMAIL, LOCAL_PASSWORD)).user;
  } catch (error) {
    if (error?.code !== "auth/email-already-in-use") throw error;
    return (await signInWithEmailAndPassword(auth, LOCAL_EMAIL, LOCAL_PASSWORD)).user;
  }
}
