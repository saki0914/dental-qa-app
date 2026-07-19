import { initializeApp } from "https://www.gstatic.com/firebasejs/11.7.3/firebase-app.js";
import {
  browserLocalPersistence,
  connectAuthEmulator,
  indexedDBLocalPersistence,
  initializeAuth
} from "https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js";
import {
  connectFirestoreEmulator,
  getFirestore
} from "https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js";
import {
  connectStorageEmulator,
  getStorage
} from "https://www.gstatic.com/firebasejs/11.7.3/firebase-storage.js";

const PRODUCTION_FIREBASE_CONFIG = {
  apiKey: "AIzaSyBdYSfjIWOT4JeNEG4ZB3j5c9I1FLoVlhM",
  authDomain: "dental-qa-hub-e7cce.firebaseapp.com",
  projectId: "dental-qa-hub-e7cce",
  storageBucket: "dental-qa-hub-e7cce.firebasestorage.app",
  messagingSenderId: "728712338347",
  appId: "1:728712338347:web:8c49928648b6cab22c10ee",
  measurementId: "G-S9QQKJ93CR"
};

const EMULATOR_PROJECT_ID = "demo-dental-qa";
const EMULATOR_FIREBASE_CONFIG = {
  apiKey: "demo-api-key",
  authDomain: `${EMULATOR_PROJECT_ID}.firebaseapp.com`,
  projectId: EMULATOR_PROJECT_ID,
  storageBucket: `${EMULATOR_PROJECT_ID}.firebasestorage.app`,
  messagingSenderId: "000000000000",
  appId: "demo-app-id"
};
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export function isFirebaseEmulatorEnabled(location = globalThis.location) {
  if (!location || !LOCAL_HOSTS.has(location.hostname)) return false;
  return new URLSearchParams(location.search).get("firebaseEmulator") === "1";
}

export function initializeFirebaseServices(location = globalThis.location) {
  const useEmulators = isFirebaseEmulatorEnabled(location);
  const config = useEmulators ? EMULATOR_FIREBASE_CONFIG : PRODUCTION_FIREBASE_CONFIG;

  const app = initializeApp(config);
  const auth = initializeAuth(app, {
    persistence: [indexedDBLocalPersistence, browserLocalPersistence]
  });
  const db = getFirestore(app);
  const storage = getStorage(app);

  if (useEmulators) {
    connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
    connectFirestoreEmulator(db, "127.0.0.1", 8080);
    connectStorageEmulator(storage, "127.0.0.1", 9199);
  }

  return { app, auth, db, storage, useEmulators };
}
