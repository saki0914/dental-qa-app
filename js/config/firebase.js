import { initializeApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import {
  browserLocalPersistence,
  connectAuthEmulator,
  indexedDBLocalPersistence,
  initializeAuth
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";
import {
  connectFirestoreEmulator,
  getFirestore,
  initializeFirestore
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";
import {
  connectStorageEmulator,
  getStorage
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-storage.js";

export { verifyFirebaseEmulatorConnectivity } from "../core/firebase-emulator-connectivity.js";

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

function isPrivateIpv4(hostname) {
  const parts = String(hostname || "").split(".").map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  return parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168);
}

function getRequestedEmulatorHost(location) {
  const requested = new URLSearchParams(location?.search || "").get("emulatorHost") || "";
  if (!requested) {
    if (LOCAL_HOSTS.has(location?.hostname)) return "127.0.0.1";
    if (isPrivateIpv4(location?.hostname)) return location.hostname;
    return "";
  }
  if (LOCAL_HOSTS.has(requested) || isPrivateIpv4(requested)) return requested;
  return "";
}

function isFirebaseEmulatorRequested(location) {
  return new URLSearchParams(location?.search || "").get("firebaseEmulator") === "1";
}

export function isFirebaseEmulatorEnabled(location = globalThis.location) {
  if (!location) return false;
  if (!isFirebaseEmulatorRequested(location)) return false;
  const emulatorHost = getRequestedEmulatorHost(location);
  if (LOCAL_HOSTS.has(location.hostname)) return LOCAL_HOSTS.has(emulatorHost);
  return isPrivateIpv4(location.hostname) && emulatorHost === location.hostname;
}

export function initializeFirebaseServices(location = globalThis.location) {
  const emulatorRequested = isFirebaseEmulatorRequested(location);
  const useEmulators = isFirebaseEmulatorEnabled(location);
  if (emulatorRequested && !useEmulators) {
    throw new Error(
      "ローカルFirebase Emulatorの接続先が安全ではないため、初期化を停止しました。\n" +
      "本番Firebaseには接続していません。URLのemulatorHostを確認してください。"
    );
  }
  const config = useEmulators ? EMULATOR_FIREBASE_CONFIG : PRODUCTION_FIREBASE_CONFIG;

  const app = initializeApp(config);
  const auth = initializeAuth(app, {
    persistence: [indexedDBLocalPersistence, browserLocalPersistence]
  });
  const db = useEmulators
    ? initializeFirestore(app, { experimentalForceLongPolling: true })
    : getFirestore(app);
  const storage = getStorage(app);

  if (useEmulators) {
    const emulatorHost = getRequestedEmulatorHost(location);
    connectAuthEmulator(auth, `http://${emulatorHost}:9099`, { disableWarnings: true });
    connectFirestoreEmulator(db, emulatorHost, 8080);
    connectStorageEmulator(storage, emulatorHost, 9199);
    return { app, auth, db, storage, useEmulators, emulatorHost };
  }

  return { app, auth, db, storage, useEmulators, emulatorHost: "" };
}
