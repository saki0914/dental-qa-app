import { expect, test } from "@playwright/test";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, getDocs, setDoc, updateDoc } from "firebase/firestore";
import { deleteObject, ref, uploadBytes } from "firebase/storage";
import {
  PDFDocument,
  StandardFonts,
  TextRenderingMode,
  beginText,
  concatTransformationMatrix,
  degrees,
  drawObject,
  endText,
  moveText,
  popGraphicsState,
  pushGraphicsState,
  setFontAndSize,
  setTextRenderingMode,
  showText
} from "pdf-lib";
import { deflateSync } from "node:zlib";
import { guardProductionFirebase } from "../helpers/readOnlyApp.mjs";
import { createPdfFixture, PDF_PAGE_GEOMETRY_FIXTURES } from "../helpers/pdf-fixture.mjs";

const TEST_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

function recordUnexpectedPageError(errors, error) {
  const message = error?.message || String(error);
  const emulatorChannelClosed = message.includes("127.0.0.1:8080/google.firestore.v1.Firestore/") &&
    message.includes("/channel?") &&
    message.includes("due to access control checks.");
  if (!emulatorChannelClosed) errors.push(message);
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([typeBytes, data])) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function createRgbPng(width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const scanlines = Buffer.alloc((width * 3 + 1) * height);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

async function createUser() {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const email = `note-${suffix}@example.test`;
  const password = "DentalNote!123";
  const response = await fetch("http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-api-key", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password, returnSecureToken: true })
  });
  const data = await response.json();
  expect(response.ok, JSON.stringify(data)).toBeTruthy();
  return { email, password, uid: data.localId };
}

async function openNoteList(page) {
  const noteList = page.locator("#noteListView");
  const newNoteButton = page.locator("#newNoteBtn");
  const noteTab = page.locator("#tabBtnPdf");
  await expect.poll(async () => await newNoteButton.isVisible() || await noteTab.isVisible(), { timeout: 20_000 }).toBe(true);
  if (!await newNoteButton.isVisible()) {
    await noteTab.click();
    if (!await newNoteButton.isVisible()) {
      await page.locator("#noteModeBtn").click();
    }
  }
  await expect(newNoteButton).toBeVisible();
  await expect(noteList).not.toHaveClass(/hidden/);
}

async function login(page, user) {
  await page.goto("/?firebaseEmulator=1", { waitUntil: "domcontentloaded" });
  await page.locator("#tabBtnAuth").click();
  await page.locator("#emailInput").fill(user.email);
  await page.locator("#passwordInput").fill(user.password);
  await page.locator("#signInBtn").click();
  await expect(page.locator("#authStatus")).toContainText(user.email, { timeout: 20_000 });
  await expect(page.locator("#localEnvironmentBanner")).toBeVisible();
  // A sibling tab can persist the note surface as the active view while this
  // tab is signing in. Avoid clicking controls that are intentionally hidden
  // when the desired note list is already visible.
  await openNoteList(page);
}

async function openEditorPopup(opener, trigger, {
  blockedRequests = null,
  onDialog = null,
  onPageError = null,
  onRequest = null,
  timeout = 90_000
} = {}) {
  const popupPromise = opener.waitForEvent("popup", { timeout });
  const triggerPromise = Promise.resolve().then(trigger);
  const editor = await popupPromise;
  await guardProductionFirebase(editor, blockedRequests);
  if (onDialog) editor.on("dialog", onDialog);
  if (onPageError) editor.on("pageerror", onPageError);
  if (onRequest) editor.on("request", onRequest);
  await triggerPromise;
  await editor.waitForURL(url => url.searchParams.get("noteEditor") === "1" && Boolean(url.searchParams.get("noteId")), { timeout });
  await expect(editor.locator("#noteEditorView")).toBeVisible({ timeout });
  await expect(editor.locator("#noteEditorStartup")).toBeHidden({ timeout });
  return editor;
}

async function readNotes(uid) {
  const environment = await initializeTestEnvironment({ projectId: "demo-dental-qa", firestore: { host: "127.0.0.1", port: 8080 } });
  try {
    const db = environment.authenticatedContext(uid).firestore();
    const snapshots = await getDocs(collection(db, "users", uid, "notes"));
    const notes = snapshots.docs.map(item => ({ id: item.id, ...item.data() }));
    for (const note of notes) {
      const pages = await getDocs(collection(db, "users", uid, "notes", note.id, "pages"));
      note.pages = pages.docs.map(item => ({ pageId: item.id, ...item.data() }));
    }
    const materials = await getDoc(doc(db, "users", uid, "app", "pdfMaterials"));
    return { notes, pdfMaterials: materials.exists() ? materials.data()?.pdfMaterials || [] : [] };
  } finally {
    await environment.cleanup();
  }
}

async function readNoteAssets(uid, noteId) {
  const environment = await initializeTestEnvironment({ projectId: "demo-dental-qa", firestore: { host: "127.0.0.1", port: 8080 } });
  try {
    const db = environment.authenticatedContext(uid).firestore();
    const snapshots = await getDocs(collection(db, "users", uid, "notes", noteId, "assets"));
    return snapshots.docs.map(item => ({ assetId: item.id, ...item.data() }));
  } finally {
    await environment.cleanup();
  }
}

async function seedNotePageBackground(uid, noteId, pageId, { image = TEST_PNG, size = null } = {}) {
  const environment = await initializeTestEnvironment({
    projectId: "demo-dental-qa",
    firestore: { host: "127.0.0.1", port: 8080 },
    storage: { host: "127.0.0.1", port: 9199 }
  });
  const imagePath = `users/${uid}/notes/${noteId}/sourcePages/${pageId}/background.png`;
  try {
    const context = environment.authenticatedContext(uid);
    await uploadBytes(ref(context.storage("gs://demo-dental-qa.firebasestorage.app"), imagePath), image, { contentType: "image/png" });
    await updateDoc(doc(context.firestore(), "users", uid, "notes", noteId, "pages", pageId), {
      pageType: "pdf-source-page",
      background: { type: "pdf-source-page", imagePath, sourcePageNumber: 1 },
      ...(size ? { size } : {})
    });
    return imagePath;
  } finally {
    await environment.cleanup();
  }
}

async function deleteTestStorageObject(uid, path) {
  const environment = await initializeTestEnvironment({
    projectId: "demo-dental-qa",
    storage: { host: "127.0.0.1", port: 9199 }
  });
  try {
    await deleteObject(ref(environment.authenticatedContext(uid).storage("gs://demo-dental-qa.firebasestorage.app"), path));
  } finally {
    await environment.cleanup();
  }
}

async function seedLinkedMaterial(uid) {
  const environment = await initializeTestEnvironment({ projectId: "demo-dental-qa", firestore: { host: "127.0.0.1", port: 8080 } });
  const materialId = `material-${crypto.randomUUID()}`;
  const noteId = `note-${crypto.randomUUID()}`;
  try {
    const db = environment.authenticatedContext(uid).firestore();
    await Promise.all([
      setDoc(doc(db, "users", uid, "app", "pdfMaterials"), {
        pdfMaterials: [{
          id: materialId,
          title: "連携削除E2E教材",
          subject: "E2E",
          categories: [],
          tags: [],
          pages: [],
          masks: [],
          sourceType: "images",
          sourceName: ""
        }],
        pdfRevealStates: {},
        selectedPdfId: materialId,
        selectedMaskId: null,
        pdfSearchQuery: ""
      }),
      setDoc(doc(db, "users", uid, "notes", noteId), {
        schemaVersion: 1,
        title: "連携削除E2Eノート",
        type: "material-linked",
        sourceMaterialId: materialId,
        materialRefs: [materialId],
        status: "ready",
        pageCount: 1,
        orderRevision: 1,
        deletedAt: null
      }),
      setDoc(doc(db, "users", uid, "notes", noteId, "pages", "page-1"), {
        schemaVersion: 1,
        noteId,
        order: 1,
        pageType: "material-page",
        contentRevision: 0,
        contentPath: "",
        deletedAt: null,
        size: { width: 1240, height: 1754 },
        background: { type: "material-page", materialId, materialPage: 1 }
      })
    ]);
    return { materialId, noteId };
  } finally {
    await environment.cleanup();
  }
}

async function seedLegacyLinkedMaterial(uid, { legacyPayloadBytes = 400 * 1024 } = {}) {
  const environment = await initializeTestEnvironment({ projectId: "demo-dental-qa", firestore: { host: "127.0.0.1", port: 8080 } });
  const materialId = `legacy-material-${crypto.randomUUID()}`;
  const noteId = `legacy-note-${crypto.randomUUID()}`;
  const pageId = `legacy-page-${crypto.randomUUID()}`;
  try {
    await environment.withSecurityRulesDisabled(async context => {
      const db = context.firestore();
      await Promise.all([
        setDoc(doc(db, "users", uid, "app", "main"), {
          pdfMaterials: [{
            id: materialId,
            title: "旧形式E2E教材",
            subject: "E2E",
            categories: [],
            tags: [],
            pages: [],
            masks: [],
            sourceType: "images",
            sourceName: ""
          }],
          pdfRevealStates: {},
          selectedPdfId: materialId,
          selectedMaskId: null,
          pdfSearchQuery: "",
          // Reproduce the transfer cost of a pre-split document containing
          // unrelated app-wide state while staying clear of Firestore's 1 MiB
          // per-document limit.
          legacyPerformancePayload: "x".repeat(legacyPayloadBytes)
        }),
        setDoc(doc(db, "users", uid, "notes", noteId), {
          schemaVersion: 1,
          title: "旧形式fallback E2Eノート",
          type: "material-linked",
          sourceMaterialId: materialId,
          materialRefs: [materialId],
          status: "ready",
          pageCount: 1,
          orderRevision: 1,
          deletedAt: null
        }),
        setDoc(doc(db, "users", uid, "notes", noteId, "pages", pageId), {
          schemaVersion: 1,
          noteId,
          order: 1,
          pageType: "blank",
          contentRevision: 0,
          contentPath: "",
          contentHash: "",
          noteMaskCount: 0,
          deletedAt: null,
          size: { width: 1240, height: 1754 },
          background: { type: "blank", paperColor: "#FFFFFF" }
        })
      ]);
    });
    return { materialId, noteId, pageId, legacyPayloadBytes };
  } finally {
    await environment.cleanup();
  }
}

async function seedOpenableMaterial(uid) {
  const environment = await initializeTestEnvironment({
    projectId: "demo-dental-qa",
    firestore: { host: "127.0.0.1", port: 8080 },
    storage: { host: "127.0.0.1", port: 9199 }
  });
  const materialId = `material-open-${crypto.randomUUID()}`;
  const defaultNoteId = `note-default-${crypto.randomUUID()}`;
  const imagePath = `users/${uid}/imageMaterials/${materialId}/page-1.png`;
  try {
    const db = environment.authenticatedContext(uid).firestore();
    const storage = environment.authenticatedContext(uid).storage("gs://demo-dental-qa.firebasestorage.app");
    await uploadBytes(ref(storage, imagePath), TEST_PNG, { contentType: "image/png" });
    await setDoc(doc(db, "users", uid, "app", "pdfMaterials"), {
      pdfMaterials: [{
        id: materialId,
        defaultNoteId,
        title: "既定ノート更新E2E教材",
        subject: "E2E",
        categories: ["連携ノート"],
        tags: ["連携ノート"],
        pages: [{ page: 1, imagePath, width: 1, height: 1 }],
        masks: [],
        sourceType: "images",
        sourceName: ""
      }],
      pdfRevealStates: {},
      selectedPdfId: materialId,
      selectedMaskId: null,
      pdfSearchQuery: ""
    });
    return { materialId, defaultNoteId, imagePath };
  } finally {
    await environment.cleanup();
  }
}

async function seedReadyNote(uid, title, { legacyWithoutStatus = false, pageCount = 1 } = {}) {
  const environment = await initializeTestEnvironment({ projectId: "demo-dental-qa", firestore: { host: "127.0.0.1", port: 8080 } });
  const noteId = `note-session-${crypto.randomUUID()}`;
  const pageIds = Array.from({ length: pageCount }, () => `page-session-${crypto.randomUUID()}`);
  try {
    const db = environment.authenticatedContext(uid).firestore();
    await Promise.all([
      setDoc(doc(db, "users", uid, "notes", noteId), {
        schemaVersion: 1,
        title,
        type: "standalone",
        ...(legacyWithoutStatus ? {} : { status: "ready" }),
        pageCount,
        noteMaskCount: 0,
        orderRevision: 1,
        materialRefs: [],
        deletedAt: null
      }),
      ...pageIds.map((pageId, index) => setDoc(doc(db, "users", uid, "notes", noteId, "pages", pageId), {
          schemaVersion: 1,
          noteId,
          order: index + 1,
          pageType: "blank",
          contentRevision: 0,
          contentPath: "",
          contentHash: "",
          noteMaskCount: 0,
          deletedAt: null,
          size: { width: 1240, height: 1754 },
          background: { type: "blank", paperColor: "#FFFFFF" }
        }))
    ]);
    return { noteId, pageId: pageIds[0], pageIds };
  } finally {
    await environment.cleanup();
  }
}

async function seedBrokenQuestionManifest(uid) {
  const environment = await initializeTestEnvironment({
    projectId: "demo-dental-qa",
    firestore: { host: "127.0.0.1", port: 8080 }
  });
  try {
    await environment.withSecurityRulesDisabled(async context => {
      await setDoc(doc(context.firestore(), "users", uid, "app", "questions"), {
        storageMode: "chunked-v1",
        questionCount: 1,
        chunkCount: 1
      });
    });
  } finally {
    await environment.cleanup();
  }
}

async function seedNoteRoot(uid, noteId, data) {
  const environment = await initializeTestEnvironment({ projectId: "demo-dental-qa", firestore: { host: "127.0.0.1", port: 8080 } });
  try {
    const db = environment.authenticatedContext(uid).firestore();
    await setDoc(doc(db, "users", uid, "notes", noteId), data);
  } finally {
    await environment.cleanup();
  }
}

async function updateNoteRoot(uid, noteId, fields) {
  const environment = await initializeTestEnvironment({ projectId: "demo-dental-qa", firestore: { host: "127.0.0.1", port: 8080 } });
  try {
    const db = environment.authenticatedContext(uid).firestore();
    await updateDoc(doc(db, "users", uid, "notes", noteId), fields);
  } finally {
    await environment.cleanup();
  }
}

async function updateNotePage(uid, noteId, pageId, fields) {
  const environment = await initializeTestEnvironment({ projectId: "demo-dental-qa", firestore: { host: "127.0.0.1", port: 8080 } });
  try {
    const db = environment.authenticatedContext(uid).firestore();
    await updateDoc(doc(db, "users", uid, "notes", noteId, "pages", pageId), fields);
  } finally {
    await environment.cleanup();
  }
}

async function localNoteStoreCounts(page) {
  return page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("dentalQaNoteLocal");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const count = storeName => new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, "readonly");
      const request = transaction.objectStore(storeName).count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const result = {
      pendingAssets: await count("pendingAssets"),
      pageDrafts: await count("pageDrafts"),
      pendingSaves: await count("pendingSaves"),
      conflicts: await count("conflicts")
    };
    database.close();
    return result;
  });
}

async function localPendingSaveCountForUser(page, uid) {
  return page.evaluate(async userId => {
    const { createNoteLocalStore } = await import("/js/core/note-local-store.js");
    const store = createNoteLocalStore();
    const values = await store.listForUser("pendingSaves", userId);
    await store.close();
    return values.length;
  }, uid);
}

async function seedPendingPageDraft(page, { uid, noteId, pageId, content, expectedRevision }) {
  await page.evaluate(async value => {
    const { createNoteLocalStore } = await import("/js/core/note-local-store.js");
    const localStore = createNoteLocalStore();
    const key = `${value.uid}|${value.noteId}|${value.pageId}`;
    const updatedAt = new Date().toISOString();
    const revisionFields = Number.isInteger(value.expectedRevision)
      ? { expectedRevision: value.expectedRevision }
      : {};
    await localStore.put("pageDrafts", {
      key,
      uid: value.uid,
      noteId: value.noteId,
      pageId: value.pageId,
      content: value.content,
      ...revisionFields,
      updatedAt
    });
    await localStore.put("pendingSaves", {
      key,
      uid: value.uid,
      noteId: value.noteId,
      pageId: value.pageId,
      ...revisionFields,
      updatedAt
    });
    await localStore.close();
  }, { uid, noteId, pageId, content, expectedRevision });
}

async function seedPendingAsset(page, { uid, noteId, pageId, assetId, bytes, mimeType = "image/png" }) {
  await page.evaluate(async value => {
    const { createNoteLocalStore, noteLocalKey } = await import("/js/core/note-local-store.js");
    const localStore = createNoteLocalStore();
    const updatedAt = new Date().toISOString();
    const binary = atob(value.base64);
    const buffer = Uint8Array.from(binary, character => character.charCodeAt(0));
    await localStore.put("pendingAssets", {
      key: noteLocalKey(value.uid, value.noteId, value.pageId, value.assetId),
      uid: value.uid,
      noteId: value.noteId,
      pageId: value.pageId,
      assetId: value.assetId,
      blob: new Blob([buffer], { type: value.mimeType }),
      createdAt: updatedAt,
      updatedAt
    });
    await localStore.close();
  }, { uid, noteId, pageId, assetId, base64: bytes.toString("base64"), mimeType });
}

async function openPageSidebar(page) {
  await expect(page.locator("#noteEditorView")).toBeVisible();
  const sidebar = page.locator("#notePageSidebar");
  const pagesButton = page.locator("#notePagesBtn");
  if (await pagesButton.isVisible() && await pagesButton.getAttribute("aria-expanded") !== "true") {
    await page.locator("#notePagesBtn").click();
  }
  await expect(sidebar).toBeVisible();
}

test("IndexedDB v2の全6ストアを主キーprefix範囲でユーザー・ノート別に取得する", async ({ page }) => {
  await page.goto("/js/core/note-local-store.js");
  const result = await page.evaluate(async () => {
    const databaseName = "dentalQaNoteLocal";
    const stores = ["pageDrafts", "pendingAssets", "pendingSaves", "conflicts", "pendingCleanups", "thumbnails"];
    const getAllCalls = [];
    const originalGetAll = IDBObjectStore.prototype.getAll;
    IDBObjectStore.prototype.getAll = function getAll(...args) {
      const query = args[0];
      getAllCalls.push({
        store: this.name,
        lower: query?.lower,
        upper: query?.upper
      });
      return originalGetAll.apply(this, args);
    };
    const deleteDatabase = () => new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(databaseName);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    await deleteDatabase();
    await new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 2);
      request.onupgradeneeded = () => {
        stores.forEach(name => request.result.createObjectStore(name, { keyPath: "key" }));
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction(stores, "readwrite");
        stores.forEach(name => {
          transaction.objectStore(name).put({
            key: `alice|note-1|page-1|${name}`,
            uid: "alice",
            noteId: "note-1",
            pageId: "page-1",
            marker: `${name}-target`
          });
          transaction.objectStore(name).put({
            key: `alice|note-10|page-2|${name}`,
            uid: "alice",
            noteId: "note-10",
            pageId: "page-2",
            marker: `${name}-same-user-other-note`
          });
          transaction.objectStore(name).put({
            key: `bob|note-1|page-3|${name}`,
            uid: "bob",
            noteId: "note-1",
            pageId: "page-3",
            marker: `${name}-other-user`
          });
        });
        transaction.oncomplete = () => {
          database.close();
          resolve();
        };
        transaction.onerror = () => reject(transaction.error);
      };
    });

    const { createNoteLocalStore } = await import("/js/core/note-local-store.js");
    const localStore = createNoteLocalStore();
    const records = {};
    for (const name of stores) {
      records[name] = {
        note: (await localStore.listForNote(name, "alice", "note-1")).map(value => value.marker),
        user: (await localStore.listForUser(name, "alice")).map(value => value.marker).sort()
      };
    }
    await localStore.close();

    const schema = await new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const indexes = Object.fromEntries(stores.map(name => {
          const transaction = database.transaction(name, "readonly");
          const store = transaction.objectStore(name);
          return [name, { names: [...store.indexNames] }];
        }));
        const value = { version: database.version, indexes };
        database.close();
        resolve(value);
      };
    });
    await deleteDatabase();
    IDBObjectStore.prototype.getAll = originalGetAll;
    return { records, schema, getAllCalls };
  });

  expect(result.schema.version).toBe(2);
  for (const storeName of ["pageDrafts", "pendingAssets", "pendingSaves", "conflicts", "pendingCleanups", "thumbnails"]) {
    expect(result.records[storeName]).toEqual({
      note: [`${storeName}-target`],
      user: [`${storeName}-same-user-other-note`, `${storeName}-target`]
    });
    expect(result.schema.indexes[storeName]).toEqual({ names: [] });
    expect(result.getAllCalls.filter(call => call.store === storeName)).toEqual([
      { store: storeName, lower: "alice|note-1|", upper: "alice|note-1|\uffff" },
      { store: storeName, lower: "alice|", upper: "alice|\uffff" }
    ]);
  }
});

test("@authenticated 白紙ノートへ描画・画像・マスクを保存し2ページPDFを書き出す", async ({ page }) => {
  test.setTimeout(120_000);
  const blockedRequests = await guardProductionFirebase(page);
  const pdfCdnRequests = [];
  const pageErrors = [];
  const dialogs = [];
  const onDialog = async dialog => {
    dialogs.push(dialog.message());
    await dialog.accept();
  };
  const onRequest = request => {
    const hostname = new URL(request.url()).hostname;
    if (["cdn.jsdelivr.net", "cdnjs.cloudflare.com"].includes(hostname)) {
      pdfCdnRequests.push(request.url());
    }
  };
  const onPageError = error => recordUnexpectedPageError(pageErrors, error);
  page.on("dialog", onDialog);
  page.on("request", onRequest);
  page.on("pageerror", onPageError);
  const user = await createUser();
  await login(page, user);
  await expect(page.locator("#localEnvironmentStatus")).toContainText("Auth: 接続済み / Firestore: 接続済み / Storage: 接続済み");

  await page.locator("#newNoteBtn").click();
  await page.locator("#newNoteTitle").fill("E2E 学習ノート");
  page = await openEditorPopup(page, () => page.locator('[data-create-note="blank"]').click(), {
    blockedRequests, onDialog, onRequest, onPageError
  });
  await expect(page.locator("#noteTitleInput")).toHaveValue("E2E 学習ノート");

  const stage = page.locator("#notePageStage");
  await stage.scrollIntoViewIfNeeded();
  await expect(stage).toHaveAttribute("data-tool", "pen");
  const box = await stage.boundingBox();
  expect(box).toBeTruthy();
  await stage.dispatchEvent("pointerdown", { pointerId: 1, pointerType: "mouse", button: 0, clientX: box.x + box.width * .2, clientY: box.y + box.height * .08 });
  await stage.dispatchEvent("pointermove", { pointerId: 1, pointerType: "mouse", button: 0, pressure: .5, clientX: box.x + box.width * .55, clientY: box.y + box.height * .15 });
  await stage.dispatchEvent("pointerup", { pointerId: 1, pointerType: "mouse", button: 0, clientX: box.x + box.width * .55, clientY: box.y + box.height * .15 });
  await expect(stage.locator('[data-element-id]')).toHaveCount(1);

  await page.locator('[data-note-tool="mask"]').click();
  await stage.dispatchEvent("pointerdown", { pointerId: 2, pointerType: "mouse", button: 0, clientX: box.x + box.width * .25, clientY: box.y + box.height * .18 });
  await stage.dispatchEvent("pointermove", { pointerId: 2, pointerType: "mouse", button: 0, clientX: box.x + box.width * .58, clientY: box.y + box.height * .25 });
  await stage.dispatchEvent("pointerup", { pointerId: 2, pointerType: "mouse", button: 0, clientX: box.x + box.width * .58, clientY: box.y + box.height * .25 });
  await expect(stage.locator(".note-mask")).toHaveCount(1);
  await expect(stage.locator('[data-transform-handle="resize-se"]')).toBeVisible();
  await expect(stage.locator('[data-transform-handle="rotate"]')).toHaveCount(0);
  await expect(page.locator('#noteSelectionActions [data-selection-action="rotate-left"]')).toBeDisabled();
  await stage.locator(".note-paper-layer").evaluate(node => { node.dataset.renderProbe = "persistent-background"; });
  const maskBeforeResize = await stage.locator(".note-mask").boundingBox();
  const maskResizeHandle = await stage.locator('[data-transform-handle="resize-se"]').boundingBox();
  await page.mouse.move(maskResizeHandle.x + maskResizeHandle.width / 2, maskResizeHandle.y + maskResizeHandle.height / 2);
  await page.mouse.down();
  await page.mouse.move(maskResizeHandle.x + maskResizeHandle.width / 2 + 35, maskResizeHandle.y + maskResizeHandle.height / 2 + 18, { steps: 5 });
  await page.mouse.up();
  const maskAfterResize = await stage.locator(".note-mask").boundingBox();
  expect(maskAfterResize.width).toBeGreaterThan(maskBeforeResize.width);
  await expect(stage.locator('.note-paper-layer[data-render-probe="persistent-background"]')).toHaveCount(1);

  await openPageSidebar(page);
  await page.locator('[data-page-action="add-ruled"]').click();
  await expect(page.locator("#notePageCounter")).toHaveText("2 / 2");
  await page.locator("#noteImageFileInput").setInputFiles({ name: "paste.png", mimeType: "image/png", buffer: TEST_PNG });
  await expect.poll(async () => ({
    imageCount: await stage.locator(".note-image-element").count(),
    dialogs
  }), { timeout: 20_000 }).toEqual({ imageCount: 1, dialogs: [] });
  await page.locator('[data-note-tool="select"]').click();
  await expect(stage.locator(".note-image-element.note-selected")).toBeVisible();
  await expect(page.locator('#noteSelectionActions [data-selection-action="crop"]')).toBeVisible();
  await page.locator('#noteSelectionActions [data-selection-action="crop"]').click();
  await expect(stage.locator(".note-crop-overlay")).toBeVisible();
  await expect(stage.locator('[data-transform-handle^="crop-"]')).toHaveCount(8);
  const imageBeforeCrop = await stage.locator(".note-image-element").boundingBox();
  const cropHandle = await stage.locator('[data-transform-handle="crop-w"]').boundingBox();
  await page.mouse.move(cropHandle.x + cropHandle.width / 2, cropHandle.y + cropHandle.height / 2);
  await page.mouse.down();
  await page.mouse.move(cropHandle.x + cropHandle.width / 2 + 20, cropHandle.y + cropHandle.height / 2, { steps: 5 });
  await page.mouse.up();
  const imageAfterCrop = await stage.locator(".note-image-element").boundingBox();
  expect(imageAfterCrop.width).toBeLessThan(imageBeforeCrop.width);
  await page.locator("#noteInputSettingsBtn").click();
  await expect(page.locator("#noteToolSettings")).toBeHidden();
  await expect(stage.locator(".note-crop-overlay"), "crop中は設定パネル要求を無視する").toBeVisible();
  await expect(page.locator("#noteEditorNotice")).toContainText("トリミング編集中");
  await page.locator('[data-note-tool="pen"]').click();
  await expect(stage).toHaveAttribute("data-tool", "select");
  await expect(stage.locator(".note-crop-overlay"), "crop中はツール切替要求を無視する").toBeVisible();
  await page.locator("#noteMoreMenu summary").click();
  await expect(page.locator("#noteMoreMenu")).not.toHaveAttribute("open", "");
  await expect(stage.locator(".note-crop-overlay"), "crop中は他のメニューを開かない").toBeVisible();
  const blockedCropDialogCount = dialogs.length;
  await page.locator("#noteBackgroundBtn").evaluate(button => button.click());
  await expect.poll(() => dialogs.length, "crop中は背景変更プロンプトを開かない").toBe(blockedCropDialogCount);
  await page.locator('[data-note-action="export"]').evaluate(button => button.click());
  await expect(page.locator("#noteExportDialog"), "crop中はPDF書き出しを開かない").toBeHidden();
  await expect(page.locator("#noteEditorNotice")).toContainText("適用またはキャンセル");
  await page.keyboard.press("Escape");
  await expect(stage.locator(".note-crop-overlay"), "crop中はEscapeでも調整を破棄しない").toBeVisible();
  const imageAfterBlockedUi = await stage.locator(".note-image-element").boundingBox();
  expect(imageAfterBlockedUi.width).toBeCloseTo(imageAfterCrop.width, 0);
  await page.locator('[data-crop-action="reset"]').click();
  await expect(stage.locator(".note-crop-overlay"), "全体表示後もcrop編集を継続する").toBeVisible();
  const imageAfterReset = await stage.locator(".note-image-element").boundingBox();
  expect(imageAfterReset.width).toBeCloseTo(imageBeforeCrop.width, 0);
  await page.locator('[data-crop-action="apply"]').click();
  await expect(stage.locator(".note-crop-overlay")).toHaveCount(0);
  await expect(page.locator("#noteSaveStatus")).toContainText("保存済み", { timeout: 20_000 });

  const backgroundPromptCount = dialogs.length;
  const penButton = page.locator('[data-note-tool="pen"]');
  await penButton.click();
  if (!await page.locator("#noteToolSettings").isVisible()) await penButton.click();
  await expect(page.locator("#noteToolSettings")).toBeVisible();
  await page.locator("#noteBackgroundBtn").click();
  await expect(page.locator("#noteToolSettings"), "背景変更開始時に設定パネルを閉じる").toBeHidden();
  await expect.poll(() => dialogs.length).toBeGreaterThan(backgroundPromptCount);

  await page.locator("#noteStudyModeBtn").click();
  await expect(page.locator("#noteStudyControls")).toBeVisible();
  await page.locator("#noteEditModeBtn").click();
  expect(await page.evaluate(() => Boolean(globalThis.PDFLib)), "PDF生成前はpdf-libを評価しない").toBe(false);

  await page.locator(".note-more-menu summary").click();
  await page.locator('[data-note-action="export"]').click();
  await expect(page.locator("#noteMoreMenu"), "export開始時に背後の一時メニューを閉じる").not.toHaveAttribute("open", "");
  await expect(page.locator("#noteExportDialog")).toBeVisible();
  await expect(page.locator("#noteExportPageNumbers")).toBeChecked();
  await page.locator("#createNotePdfBtn").click();
  await expect(page.locator("#noteExportStatus")).toContainText("作成したPDF", { timeout: 60_000 });
  expect(await page.evaluate(() => Boolean(globalThis.PDFLib?.PDFDocument)), "PDF生成時にローカルpdf-libを遅延読込する").toBe(true);
  await expect(page.locator("#noteExportFilename")).toHaveValue(/AI共有用.*\.pdf$/);
  await page.locator("#noteExportFilename").fill(" 症例/共有.pdf.pdf. ");
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#downloadNotePdfBtn").click();
  await expect(page.locator("#noteExportFilename")).toHaveValue("症例_共有.pdf");
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^(download|症例_共有\.pdf)$/);
  await download.saveAs("test-results/study-note-export.pdf");
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const pdfBytes = Buffer.concat(chunks);
  expect(pdfBytes.byteLength).toBeGreaterThan(0);
  expect((await PDFDocument.load(pdfBytes)).getPageCount()).toBe(2);
  await page.locator('#noteExportDialog button[value="close"]').click();

  const editorTabIdBeforeReload = new URL(page.url()).searchParams.get("editorTabId");
  expect(editorTabIdBeforeReload).toBeTruthy();
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#authStatus")).toContainText(user.email, { timeout: 20_000 });
  expect(new URL(page.url()).searchParams.get("editorTabId")).toBe(editorTabIdBeforeReload);
  await expect(page.locator("#notePageCounter")).toHaveText("1 / 2");
  await expect(page.locator("#notePageStage [data-element-id]")).toHaveCount(1);

  const stored = await readNotes(user.uid);
  expect(stored.notes).toHaveLength(1);
  expect(stored.notes[0].pages).toHaveLength(2);
  expect(stored.notes[0].pendingStoragePaths || []).toEqual([]);
  expect(stored.pdfMaterials).toHaveLength(0);
  expect(blockedRequests).toEqual([]);
  expect(pdfCdnRequests, "PDF出力はjsDelivr/cdnjsへ接続しない").toEqual([]);
  expect(pageErrors).toEqual([]);
});

test("@authenticated @ipad-v-next 単一タブで100ストロークと即時ページ切替を行っても自己競合しない", async ({ page }) => {
  test.setTimeout(120_000);
  const blockedRequests = await guardProductionFirebase(page);
  const pageErrors = [];
  page.on("pageerror", error => recordUnexpectedPageError(pageErrors, error));
  const user = await createUser();
  await login(page, user);
  await page.locator("#newNoteBtn").click();
  await page.locator("#newNoteTitle").fill("100ストローク競合E2Eノート");
  page = await openEditorPopup(page, () => page.locator('[data-create-note="blank"]').click(), {
    blockedRequests,
    onPageError: error => recordUnexpectedPageError(pageErrors, error)
  });

  const stage = page.locator("#notePageStage");
  const box = await stage.boundingBox();
  expect(box).toBeTruthy();
  for (let index = 0; index < 100; index += 1) {
    const row = index % 20;
    const column = Math.floor(index / 20);
    const startX = box.x + box.width * (.08 + column * .14);
    const startY = box.y + box.height * (.06 + row * .042);
    const pointerId = 1000 + index;
    await stage.dispatchEvent("pointerdown", {
      pointerId, pointerType: "pen", button: 0, pressure: .1,
      clientX: startX, clientY: startY
    });
    await stage.dispatchEvent("pointermove", {
      pointerId, pointerType: "pen", button: 0, pressure: index % 2 ? 1 : .2,
      clientX: startX + box.width * .055, clientY: startY + box.height * .008
    });
    await stage.dispatchEvent("pointerup", {
      pointerId, pointerType: "pen", button: 0,
      clientX: startX + box.width * .055, clientY: startY + box.height * .008
    });
  }

  await expect(stage.locator('[data-element-id]')).toHaveCount(100);
  await expect(page.locator("#notePageConflictBanner")).toBeHidden();
  await expect(page.locator("#noteSaveStatus")).toContainText("保存済み", { timeout: 30_000 });
  await expect.poll(() => localNoteStoreCounts(page)).toMatchObject({ conflicts: 0, pendingSaves: 0 });

  await openPageSidebar(page);
  await page.locator('[data-page-action="add-blank"]').click();
  await expect(page.locator("#notePageCounter")).toHaveText("2 / 2");
  const secondBox = await stage.boundingBox();
  await stage.dispatchEvent("pointerdown", {
    pointerId: 1200, pointerType: "pen", button: 0, pressure: .5,
    clientX: secondBox.x + secondBox.width * .2, clientY: secondBox.y + secondBox.height * .2
  });
  await stage.dispatchEvent("pointermove", {
    pointerId: 1200, pointerType: "pen", button: 0, pressure: .5,
    clientX: secondBox.x + secondBox.width * .55, clientY: secondBox.y + secondBox.height * .24
  });
  await stage.dispatchEvent("pointerup", {
    pointerId: 1200, pointerType: "pen", button: 0,
    clientX: secondBox.x + secondBox.width * .55, clientY: secondBox.y + secondBox.height * .24
  });
  await page.locator('#notePageList [aria-label="1ページを開く"]').click();
  await expect(page.locator("#notePageCounter")).toHaveText("1 / 2");
  await expect(stage.locator('[data-element-id]')).toHaveCount(100);
  await expect(page.locator("#notePageConflictBanner")).toBeHidden();
  await expect(page.locator("#noteSaveStatus")).toContainText("保存済み", { timeout: 30_000 });

  const viewport = page.locator("#noteViewport");
  const swipeBox = await stage.boundingBox();
  const swipe = async (pointerId, fromRatio, toRatio) => {
    const y = swipeBox.y + swipeBox.height * .55;
    await viewport.dispatchEvent("pointerdown", {
      pointerId, pointerType: "touch", button: 0,
      clientX: swipeBox.x + swipeBox.width * fromRatio, clientY: y,
      width: 8, height: 8
    });
    await viewport.dispatchEvent("pointermove", {
      pointerId, pointerType: "touch", button: 0,
      clientX: swipeBox.x + swipeBox.width * toRatio, clientY: y + 2,
      width: 8, height: 8
    });
    await viewport.dispatchEvent("pointerup", {
      pointerId, pointerType: "touch", button: 0,
      clientX: swipeBox.x + swipeBox.width * toRatio, clientY: y + 2,
      width: 8, height: 8
    });
  };
  await swipe(1250, .78, .2);
  await expect(page.locator("#notePageCounter")).toHaveText("2 / 2");
  await swipe(1251, .2, .78);
  await expect(page.locator("#notePageCounter")).toHaveText("1 / 2");

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#noteEditorView")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#notePageCounter")).toHaveText("1 / 2");
  await expect(page.locator("#notePageStage [data-element-id]")).toHaveCount(100);
  await expect(page.locator("#notePageConflictBanner")).toBeHidden();
  const stored = await readNotes(user.uid);
  expect(stored.notes).toHaveLength(1);
  expect(stored.notes[0].pages).toHaveLength(2);
  expect(stored.notes[0].pages.every(item => Number(item.contentRevision) >= 1)).toBeTruthy();
  expect(stored.notes[0].pages.every(item => Boolean(item.lastClientMutationId))).toBeTruthy();
  expect(pageErrors).toEqual([]);
  expect(blockedRequests).toEqual([]);
});

test("@authenticated 固定線幅・ツール再タップ設定・長押し直線化・パレット保持を操作で確認する", async ({ page }) => {
  test.setTimeout(120_000);
  const user = await createUser();
  await login(page, user);
  await page.locator("#newNoteBtn").click();
  await page.locator("#newNoteTitle").fill("マークアップ設定E2Eノート");
  page = await openEditorPopup(page, () => page.locator('[data-create-note="blank"]').click());

  const toolbarButtons = page.locator(".note-toolbar button");
  expect(await toolbarButtons.count()).toBeGreaterThanOrEqual(10);
  for (const button of await toolbarButtons.all()) {
    expect(await button.getAttribute("aria-label")).toBeTruthy();
    expect(await button.getAttribute("title")).toBeTruthy();
    const dimensions = await button.boundingBox();
    if (dimensions) {
      expect(dimensions.width).toBeGreaterThanOrEqual(44);
      expect(dimensions.height).toBeGreaterThanOrEqual(44);
    }
  }
  await expect(page.locator(".note-pencil-doubletap-notice")).toContainText("Apple Pencil本体のダブルタップを取得できません");

  const penButton = page.locator('[data-note-tool="pen"]');
  await penButton.click();
  await expect(page.locator("#noteToolSettings")).toBeVisible();
  await expect(page.locator("#noteToolSettingsTitle")).toHaveText("ペン設定");
  await page.locator('#noteWidthPresets [data-width="72"]').click();
  await page.locator('#noteColorPresets [data-color="#ef4444"]').click();
  await page.locator("#noteOpacityInput").fill("77");
  await expect(page.locator("#noteWidthInput")).toHaveValue("72");
  await expect(page.locator("#noteColorInput")).toHaveValue("#ef4444");

  const stage = page.locator("#notePageStage");
  const box = await stage.boundingBox();
  expect(box).toBeTruthy();
  await stage.dispatchEvent("pointerdown", {
    pointerId: 1301, pointerType: "pen", button: 0, pressure: .05,
    clientX: box.x + box.width * .15, clientY: box.y + box.height * .15
  });
  await stage.dispatchEvent("pointermove", {
    pointerId: 1301, pointerType: "pen", button: 0, pressure: 1,
    clientX: box.x + box.width * .3, clientY: box.y + box.height * .18
  });
  await stage.dispatchEvent("pointermove", {
    pointerId: 1301, pointerType: "pen", button: 0, pressure: .1,
    clientX: box.x + box.width * .45, clientY: box.y + box.height * .16
  });
  await stage.dispatchEvent("pointerup", {
    pointerId: 1301, pointerType: "pen", button: 0,
    clientX: box.x + box.width * .45, clientY: box.y + box.height * .16
  });
  const penPath = stage.locator('path.note-element[data-element-id]').first();
  const pageCoordinateWidth = await stage.locator("svg.note-layer").first().evaluate(node => (
    node.viewBox.baseVal.width
  ));
  await expect(penPath).toHaveAttribute("stroke", "#ef4444");
  expect(Number(await penPath.getAttribute("stroke-width"))).toBeCloseTo(pageCoordinateWidth * 72 / 10_000, 6);
  await expect(penPath).toHaveAttribute("stroke-opacity", "0.77");

  const highlighterButton = page.locator('[data-note-tool="highlighter"]');
  await highlighterButton.click();
  await highlighterButton.click();
  await expect(page.locator("#noteToolSettingsTitle")).toHaveText("蛍光ペン設定");
  await page.locator('#noteWidthPresets [data-width="82"]').click();
  await page.locator('#noteColorPresets [data-color="#6ce5ff"]').click();
  await page.locator("#noteOpacityInput").fill("35");
  await expect(penPath).toHaveAttribute("stroke", "#ef4444");
  await stage.dispatchEvent("pointerdown", {
    pointerId: 1302, pointerType: "pen", button: 0, pressure: .05,
    clientX: box.x + box.width * .15, clientY: box.y + box.height * .3
  });
  await stage.dispatchEvent("pointermove", {
    pointerId: 1302, pointerType: "pen", button: 0, pressure: 1,
    clientX: box.x + box.width * .45, clientY: box.y + box.height * .34
  });
  await stage.dispatchEvent("pointerup", {
    pointerId: 1302, pointerType: "pen", button: 0,
    clientX: box.x + box.width * .45, clientY: box.y + box.height * .34
  });
  const highlighterPath = stage.locator('path.note-element[data-element-id]').nth(1);
  await expect(highlighterPath).toHaveAttribute("stroke", "#6ce5ff");
  expect(Number(await highlighterPath.getAttribute("stroke-width"))).toBeCloseTo(pageCoordinateWidth * 82 / 1_000, 6);
  await expect(highlighterPath).toHaveAttribute("stroke-opacity", "0.35");

  const eraserButton = page.locator('[data-note-tool="eraser-object"]');
  await eraserButton.click();
  await eraserButton.click();
  await expect(page.locator("#noteToolSettingsTitle")).toHaveText("消しゴム設定");
  await page.locator("#noteEraserMode").selectOption("pixel");
  await page.locator("#noteEraserSize").fill("60");
  await expect(page.locator("#noteEraserBadge")).toHaveText("P");

  await page.locator("#noteInputSettingsBtn").click();
  await expect(page.locator("#noteToolSettingsTitle")).toHaveText("入力設定");
  await page.locator("#noteToolbarDock").selectOption("top");
  await expect(page.locator(".note-toolbar")).toHaveAttribute("data-dock", "top");
  await page.locator("#noteToolbarDock").selectOption("right");
  await expect(page.locator(".note-toolbar")).toHaveAttribute("data-dock", "right");
  await page.locator("#noteToolbarDock").selectOption("bottom");
  await expect(page.locator(".note-toolbar")).toHaveAttribute("data-dock", "bottom");
  await page.locator("#noteToolbarDock").selectOption("left");
  await expect(page.locator(".note-toolbar")).toHaveAttribute("data-dock", "left");
  await page.locator("#notePagesBtn").click();
  await expect(page.locator("#notePageSidebar")).toBeHidden();

  await penButton.click();
  await expect(page.locator("#noteStraightenEnabled")).toBeChecked();
  await stage.dispatchEvent("pointerdown", {
    pointerId: 1303, pointerType: "pen", button: 0, pressure: .5,
    clientX: box.x + box.width * .2, clientY: box.y + box.height * .48
  });
  await stage.dispatchEvent("pointermove", {
    pointerId: 1303, pointerType: "pen", button: 0, pressure: .5,
    clientX: box.x + box.width * .36, clientY: box.y + box.height * .52
  });
  await stage.dispatchEvent("pointermove", {
    pointerId: 1303, pointerType: "pen", button: 0, pressure: .5,
    clientX: box.x + box.width * .56, clientY: box.y + box.height * .47
  });
  await page.waitForTimeout(750);
  await stage.dispatchEvent("pointermove", {
    pointerId: 1303, pointerType: "pen", button: 0, pressure: .5,
    clientX: box.x + box.width * .62, clientY: box.y + box.height * .5
  });
  await stage.dispatchEvent("pointerup", {
    pointerId: 1303, pointerType: "pen", button: 0,
    clientX: box.x + box.width * .62, clientY: box.y + box.height * .5
  });
  await expect(stage.locator('path.note-element[data-element-id]')).toHaveCount(3);
  const straightPath = stage.locator('path.note-element[data-element-id]').last();
  await expect(straightPath).toBeVisible();
  expect((await straightPath.getAttribute("d")).match(/L/g) || []).toHaveLength(1);

  await expect(page.locator("#noteSaveStatus")).toContainText("保存済み", { timeout: 30_000 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#noteEditorView")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".note-toolbar")).toHaveAttribute("data-dock", "left");
  await expect(page.locator("#notePageSidebar")).toBeHidden();
  await page.locator('[data-note-tool="pen"]').click();
  await expect(page.locator("#noteToolSettingsTitle")).toHaveText("ペン設定");
  await expect(page.locator("#noteWidthInput")).toHaveValue("72");
  await expect(page.locator("#noteColorInput")).toHaveValue("#ef4444");
  await page.locator('[data-note-tool="highlighter"]').click();
  await page.locator('[data-note-tool="highlighter"]').click();
  await expect(page.locator("#noteWidthInput")).toHaveValue("82");
  await expect(page.locator("#noteColorInput")).toHaveValue("#6ce5ff");
});

test("@authenticated lineは移動・保存再読込でき、後続panのpointercancelで巻き戻らない", async ({ page }) => {
  test.setTimeout(90_000);
  const user = await createUser();
  await login(page, user);
  await page.locator("#newNoteBtn").click();
  await page.locator("#newNoteTitle").fill("line変形E2Eノート");
  page = await openEditorPopup(page, () => page.locator('[data-create-note="blank"]').click());

  const stage = page.locator("#notePageStage");
  const box = await stage.boundingBox();
  expect(box).toBeTruthy();
  await page.locator('[data-note-tool="shape"]').click();
  await page.locator("#noteStyleBtn").click();
  await page.locator("#noteShapeType").selectOption("line");
  await stage.dispatchEvent("pointerdown", {
    pointerId: 61, pointerType: "mouse", button: 0,
    clientX: box.x + box.width * .2, clientY: box.y + box.height * .2
  });
  await stage.dispatchEvent("pointermove", {
    pointerId: 61, pointerType: "mouse", button: 0,
    clientX: box.x + box.width * .4, clientY: box.y + box.height * .3
  });
  await stage.dispatchEvent("pointerup", {
    pointerId: 61, pointerType: "mouse", button: 0,
    clientX: box.x + box.width * .4, clientY: box.y + box.height * .3
  });
  const line = stage.locator("line:not(.note-element-hit)");
  await expect(line).toHaveCount(1);

  await page.locator('[data-note-tool="select"]').click();
  await line.dispatchEvent("pointerdown", {
    pointerId: 62, pointerType: "mouse", button: 0,
    clientX: box.x + box.width * .3, clientY: box.y + box.height * .25
  });
  await stage.dispatchEvent("pointermove", {
    pointerId: 62, pointerType: "mouse", button: 0,
    clientX: box.x + box.width * .4, clientY: box.y + box.height * .35
  });
  await stage.dispatchEvent("pointerup", {
    pointerId: 62, pointerType: "mouse", button: 0,
    clientX: box.x + box.width * .4, clientY: box.y + box.height * .35
  });
  await expect.poll(async () => Number(await line.getAttribute("x1"))).toBeGreaterThan(250);
  const movedX = Number(await line.getAttribute("x1"));

  await page.locator('[data-note-tool="pan"]').click();
  await stage.dispatchEvent("pointerdown", {
    pointerId: 63, pointerType: "mouse", button: 0,
    clientX: box.x + box.width * .5, clientY: box.y + box.height * .5
  });
  await stage.dispatchEvent("pointercancel", {
    pointerId: 63, pointerType: "mouse", button: 0,
    clientX: box.x + box.width * .5, clientY: box.y + box.height * .5
  });
  await expect(line).toHaveCount(1);
  expect(Number(await line.getAttribute("x1"))).toBeCloseTo(movedX, 6);
  await expect(page.locator("#noteSaveStatus")).toContainText("保存済み", { timeout: 20_000 });

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#authStatus")).toContainText(user.email, { timeout: 20_000 });
  const reloadedLine = page.locator("#notePageStage line:not(.note-element-hit)");
  await expect(reloadedLine).toHaveCount(1);
  expect(Number(await reloadedLine.getAttribute("x1"))).toBeCloseTo(movedX, 6);
});

test("@authenticated 読み取り専用タブではUndo・Redo・コピー貼り付け・削除・画像貼り付けを無効にする", async ({ page }) => {
  test.setTimeout(90_000);
  const blockedRequests = await guardProductionFirebase(page);
  const user = await createUser();
  await login(page, user);
  await page.locator("#newNoteBtn").click();
  await page.locator("#newNoteTitle").fill("読み取り専用ガードE2Eノート");
  page = await openEditorPopup(page, () => page.locator('[data-create-note="blank"]').click(), { blockedRequests });

  const stage = page.locator("#notePageStage");
  const box = await stage.boundingBox();
  expect(box).toBeTruthy();
  await openPageSidebar(page);
  await page.locator('[data-page-action="add-blank"]').click();
  await expect(page.locator("#notePageCounter")).toHaveText("2 / 2");
  await page.locator("#notePageList .note-page-thumbnail").first().click();
  const drawStroke = async (pointerId, yOffset) => {
    await stage.dispatchEvent("pointerdown", {
      pointerId, pointerType: "mouse", button: 0,
      clientX: box.x + box.width * .2, clientY: box.y + box.height * yOffset
    });
    await stage.dispatchEvent("pointermove", {
      pointerId, pointerType: "mouse", button: 0, pressure: .5,
      clientX: box.x + box.width * .6, clientY: box.y + box.height * (yOffset + .04)
    });
    await stage.dispatchEvent("pointerup", {
      pointerId, pointerType: "mouse", button: 0,
      clientX: box.x + box.width * .6, clientY: box.y + box.height * (yOffset + .04)
    });
  };

  await drawStroke(41, .2);
  await drawStroke(42, .35);
  await expect(stage.locator("[data-element-id]")).toHaveCount(2);
  await page.locator("#noteUndoBtn").click();
  await expect(stage.locator("[data-element-id]")).toHaveCount(1);
  await page.locator('[data-note-tool="select"]').click();
  await stage.locator("[data-element-id]").click();
  await expect(stage.locator(".note-selected")).toHaveCount(1);
  await expect(page.locator("#noteSaveStatus")).toContainText("保存済み", { timeout: 20_000 });

  const takeover = await page.context().newPage();
  await guardProductionFirebase(takeover, blockedRequests);
  try {
    const takeoverUrl = new URL(page.url());
    takeoverUrl.searchParams.set("editorTabId", crypto.randomUUID());
    await takeover.goto(takeoverUrl.toString(), { waitUntil: "domcontentloaded" });
    await expect(takeover.locator("#noteEditorView")).toBeVisible({ timeout: 20_000 });
    await expect(takeover.locator("#noteEditorLockBanner")).toContainText("別のタブで編集中");
    await expect(takeover.locator("#noteEditorStartup")).toBeHidden({ timeout: 20_000 });
    const blockedLockMetric = await takeover.evaluate(() => globalThis.__noteEditorStartupMetrics.spans
      .find(span => span.name === "editor-lock"));
    expect(blockedLockMetric?.details).toMatchObject({
      acquired: false,
      readOnly: true,
      claimConfirmationWaitMs: 0,
      retryCount: 0
    });
    await takeover.locator("#noteEditorTakeoverBtn").click();
    await expect(takeover.locator("#noteEditorView")).not.toHaveClass(/is-readonly/);
    await expect(page.locator("#noteEditorView")).toHaveClass(/is-readonly/);
    await expect(page.locator("#noteTitleInput")).toHaveAttribute("readonly", "");
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await expect(page.locator("#noteEditorStartup")).toBeHidden({ timeout: 20_000 });
    await expect(page.locator("#noteEditorView")).toHaveClass(/is-readonly/);
    await expect(page.locator("#noteTitleInput")).toHaveAttribute("readonly", "");
    await expect(page.locator('[data-note-action="rename"]')).toBeDisabled();
    await expect(page.locator('[data-note-action="duplicate"]')).toBeDisabled();
    await expect(page.locator('[data-note-action="delete"]')).toBeDisabled();
    await expect(page.locator("#noteBackgroundBtn")).toBeDisabled();
    await openPageSidebar(page);
    await expect(page.locator('[data-page-action="add-blank"]')).toBeDisabled();
    const beforeState = await readNotes(user.uid);
    const protectedBefore = beforeState.notes.find(note => note.title === "読み取り専用ガードE2Eノート");
    const leakedDialogs = [];
    page.on("dialog", async dialog => {
      leakedDialogs.push(dialog.message());
      await dialog.accept();
    });
    await page.evaluate(() => {
      const title = document.querySelector("#noteTitleInput");
      title.readOnly = false;
      title.value = "不正な名前変更";
      title.dispatchEvent(new Event("change", { bubbles: true }));
      [
        '[data-note-action="rename"]',
        '[data-note-action="duplicate"]',
        '[data-note-action="delete"]',
        "#noteBackgroundBtn",
        '[data-page-action="add-blank"]',
        "#notePageList .note-page-row-actions button:last-child"
      ].forEach(selector => {
        const button = document.querySelector(selector);
        if (!button) return;
        button.disabled = false;
        button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
    });
    await page.waitForTimeout(1000);
    const afterState = await readNotes(user.uid);
    const protectedAfter = afterState.notes.find(note => note.id === protectedBefore.id);
    expect(leakedDialogs).toEqual([]);
    expect(afterState.notes).toHaveLength(beforeState.notes.length);
    expect(protectedAfter.title).toBe(protectedBefore.title);
    expect(protectedAfter.deletedAt || null).toBe(protectedBefore.deletedAt || null);
    expect(protectedAfter.pages).toHaveLength(protectedBefore.pages.length);
    expect(protectedAfter.pages.map(item => ({ pageId: item.pageId, order: item.order, background: item.background })))
      .toEqual(protectedBefore.pages.map(item => ({ pageId: item.pageId, order: item.order, background: item.background })));

    await page.locator("#noteUndoBtn").click();
    await page.locator("#noteRedoBtn").click();
    await page.keyboard.press("Delete");
    await expect(stage.locator("[data-element-id]")).toHaveCount(1);

    await page.evaluate(base64 => {
      const bytes = Uint8Array.from(atob(base64), value => value.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], "blocked-paste.png", { type: "image/png" }));
      document.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
    }, TEST_PNG.toString("base64"));
    await expect.poll(() => localNoteStoreCounts(page)).toMatchObject({ pendingAssets: 0 });
    await expect(stage.locator("[data-element-id]")).toHaveCount(1);

    await page.keyboard.press("Control+c");
    await takeover.close();
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await expect(page.locator("#noteEditorStartup")).toBeHidden({ timeout: 20_000 });
    await expect(page.locator("#noteEditorView")).not.toHaveClass(/is-readonly/);
    await page.keyboard.press("Control+v");
    await expect(stage.locator("[data-element-id]")).toHaveCount(1);
    expect(blockedRequests).toEqual([]);
  } finally {
    if (!takeover.isClosed()) await takeover.close();
  }
});

test("@authenticated ハンドルで図形変形・回転・arrow端点移動し自由形投げ縄で複数選択する", async ({ page }) => {
  test.setTimeout(90_000);
  const user = await createUser();
  await login(page, user);
  await page.locator("#newNoteBtn").click();
  await page.locator("#newNoteTitle").fill("直接変形E2Eノート");
  page = await openEditorPopup(page, () => page.locator('[data-create-note="blank"]').click());
  const stage = page.locator("#notePageStage");
  await stage.scrollIntoViewIfNeeded();
  const box = await stage.boundingBox();
  expect(box).toBeTruthy();
  const point = (x, y) => ({ x: box.x + box.width * x, y: box.y + box.height * y });
  const drag = async (from, to) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 7 });
    await page.mouse.up();
  };

  await page.locator('[data-note-tool="shape"]').click();
  await page.locator("#noteStyleBtn").click();
  await page.locator("#noteShapeType").selectOption("rectangle");
  await drag(point(.16, .12), point(.36, .25));
  await expect(stage.locator("g.note-element:has(rect:not(.note-element-hit))")).toHaveCount(1);
  await page.locator("#noteStyleBtn").click();

  await page.locator('[data-note-tool="select"]').click();
  const rectangle = stage.locator("g.note-element:has(rect:not(.note-element-hit))");
  await stage.locator(".note-paper-layer").evaluate(node => { node.dataset.renderProbe = "persistent-background"; });
  await rectangle.locator(".note-element-hit").click({ position: { x: 4, y: 4 } });
  await expect(stage.locator('[data-selection-overlay="true"]')).toBeVisible();
  await expect(stage.locator('[data-transform-handle^="resize-"]')).toHaveCount(8);
  await expect(stage.locator('[data-transform-handle="rotate"]')).toBeVisible();
  const widthBefore = Number(await rectangle.locator("rect:not(.note-element-hit)").getAttribute("width"));
  const resizeHandle = await stage.locator('[data-transform-handle="resize-se"]').boundingBox();
  await drag(
    { x: resizeHandle.x + resizeHandle.width / 2, y: resizeHandle.y + resizeHandle.height / 2 },
    { x: resizeHandle.x + resizeHandle.width / 2 + 45, y: resizeHandle.y + resizeHandle.height / 2 + 25 }
  );
  expect(Number(await stage.locator("g.note-element:has(rect:not(.note-element-hit)) rect:not(.note-element-hit)").getAttribute("width"))).toBeGreaterThan(widthBefore);

  const overlayBox = await stage.locator('[data-selection-overlay="true"]').boundingBox();
  const rotateHandle = await stage.locator('[data-transform-handle="rotate"]').boundingBox();
  await drag(
    { x: rotateHandle.x + rotateHandle.width / 2, y: rotateHandle.y + rotateHandle.height / 2 },
    { x: overlayBox.x + overlayBox.width + 28, y: overlayBox.y + overlayBox.height / 2 }
  );
  const rotatedTransform = await stage.locator("g.note-element:has(rect:not(.note-element-hit))").getAttribute("transform");
  expect(rotatedTransform).toMatch(/rotate\((?!0(?:\.0+)?\b)-?\d/);

  await page.locator('[data-note-tool="shape"]').click();
  await page.locator("#noteStyleBtn").click();
  await page.locator("#noteShapeType").selectOption("arrow");
  await page.locator("#noteStyleBtn").click();
  await drag(point(.22, .36), point(.58, .46));
  await expect(stage.locator("line[marker-end]")).toHaveCount(1);
  await page.locator('[data-note-tool="select"]').click();
  const arrow = stage.locator("line[marker-end]");
  await arrow.click({ force: true });
  await expect(stage.locator('[data-transform-handle="line-start"]')).toBeVisible();
  await expect(stage.locator('[data-transform-handle="line-end"]')).toBeVisible();
  const arrowEndBefore = Number(await arrow.getAttribute("x2"));
  const arrowEndHandle = await stage.locator('[data-transform-handle="line-end"]').boundingBox();
  await drag(
    { x: arrowEndHandle.x + arrowEndHandle.width / 2, y: arrowEndHandle.y + arrowEndHandle.height / 2 },
    { x: arrowEndHandle.x + arrowEndHandle.width / 2 + 35, y: arrowEndHandle.y + arrowEndHandle.height / 2 + 20 }
  );
  expect(Number(await stage.locator("line[marker-end]").getAttribute("x2"))).toBeGreaterThan(arrowEndBefore);

  // A lasso is one continuous pointer gesture around both shapes.
  const lassoBox = await stage.boundingBox();
  const lassoPoint = (x, y) => ({ x: lassoBox.x + lassoBox.width * x, y: lassoBox.y + lassoBox.height * y });
  await page.mouse.move(lassoPoint(.04, .1).x, lassoPoint(.04, .1).y);
  await page.mouse.down();
  const lassoVertices = [lassoPoint(.75, .1), lassoPoint(.75, .52), lassoPoint(.04, .52), lassoPoint(.04, .1)];
  for (const [index, vertex] of lassoVertices.entries()) {
    await page.mouse.move(vertex.x, vertex.y, { steps: 5 });
    if (index === 0) await expect(stage.locator(".note-lasso-path")).toHaveCount(1);
  }
  await page.mouse.up();
  await expect(stage.locator(".note-element.note-selected")).toHaveCount(2);
  await expect(stage.locator('[data-selection-overlay="true"]')).toBeVisible();

  const selectionBeforeCancel = await stage.locator('[data-selection-overlay="true"]').boundingBox();
  const multiResizeHandle = stage.locator('[data-transform-handle="resize-se"]');
  const multiResizeBox = await multiResizeHandle.boundingBox();
  await multiResizeHandle.dispatchEvent("pointerdown", {
    pointerId: 71, pointerType: "mouse", button: 0,
    clientX: multiResizeBox.x + multiResizeBox.width / 2,
    clientY: multiResizeBox.y + multiResizeBox.height / 2
  });
  await stage.dispatchEvent("pointermove", {
    pointerId: 71, pointerType: "mouse", button: 0,
    clientX: multiResizeBox.x + multiResizeBox.width / 2 + 45,
    clientY: multiResizeBox.y + multiResizeBox.height / 2 + 25
  });
  await expect.poll(async () => (await stage.locator('[data-selection-overlay="true"]').boundingBox()).width)
    .toBeGreaterThan(selectionBeforeCancel.width);
  await expect(stage.locator('.note-paper-layer[data-render-probe="persistent-background"]')).toHaveCount(1);
  await stage.dispatchEvent("pointercancel", {
    pointerId: 71, pointerType: "mouse", button: 0,
    clientX: multiResizeBox.x + multiResizeBox.width / 2 + 45,
    clientY: multiResizeBox.y + multiResizeBox.height / 2 + 25
  });
  await expect.poll(async () => (await stage.locator('[data-selection-overlay="true"]').boundingBox()).width)
    .toBeCloseTo(selectionBeforeCancel.width, 0);

  const rectangleTransformBeforeCancel = await stage.locator("g.note-element:has(rect:not(.note-element-hit))").getAttribute("transform");
  const multiRotateHandle = stage.locator('[data-transform-handle="rotate"]');
  const multiRotateBox = await multiRotateHandle.boundingBox();
  await multiRotateHandle.dispatchEvent("pointerdown", {
    pointerId: 72, pointerType: "mouse", button: 0,
    clientX: multiRotateBox.x + multiRotateBox.width / 2,
    clientY: multiRotateBox.y + multiRotateBox.height / 2
  });
  await stage.dispatchEvent("pointermove", {
    pointerId: 72, pointerType: "mouse", button: 0,
    clientX: selectionBeforeCancel.x + selectionBeforeCancel.width,
    clientY: selectionBeforeCancel.y + selectionBeforeCancel.height / 2
  });
  await expect.poll(() => stage.locator("g.note-element:has(rect:not(.note-element-hit))").getAttribute("transform"))
    .not.toBe(rectangleTransformBeforeCancel);
  await stage.dispatchEvent("pointercancel", {
    pointerId: 72, pointerType: "mouse", button: 0,
    clientX: selectionBeforeCancel.x + selectionBeforeCancel.width,
    clientY: selectionBeforeCancel.y + selectionBeforeCancel.height / 2
  });
  await expect(stage.locator("g.note-element:has(rect:not(.note-element-hit))"))
    .toHaveAttribute("transform", rectangleTransformBeforeCancel);
});

test("@authenticated @ipad-v-next 日本語複数行テキストを再編集し書式・配置・ボックス幅を直接変更する", async ({ page }) => {
  test.setTimeout(90_000);
  const user = await createUser();
  await login(page, user);
  await page.locator("#newNoteBtn").click();
  await page.locator("#newNoteTitle").fill("日本語テキストE2Eノート");
  page = await openEditorPopup(page, () => page.locator('[data-create-note="blank"]').click());
  const stage = page.locator("#notePageStage");
  await stage.scrollIntoViewIfNeeded();
  const box = await stage.boundingBox();
  const from = { x: box.x + box.width * .15, y: box.y + box.height * .16 };
  const to = { x: box.x + box.width * .48, y: box.y + box.height * .32 };
  await page.locator('[data-note-tool="text"]').click();
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
  const editor = stage.locator(".note-text-editor");
  await expect(editor).toBeVisible();
  await editor.fill("日本語の長い文章を折り返します\n二行目も表示します");
  await editor.press("Tab");
  const text = stage.locator("text.note-element");
  await expect(text).toHaveCount(1);
  await expect(text.locator("tspan")).toHaveCount(3);

  await page.locator('[data-note-tool="select"]').click();
  await expect(text).toBeVisible();
  // WebKit reports the enclosing SVG viewport for getBoundingClientRect() on
  // SVG <text>. Click a normalized point inside the persisted text bounds.
  const currentStageBox = await stage.boundingBox();
  await page.mouse.click(
    currentStageBox.x + currentStageBox.width * .25,
    currentStageBox.y + currentStageBox.height * .22
  );
  await expect(stage.locator('[data-selection-overlay="true"]')).toBeVisible();
  await page.locator("#noteStyleBtn").click();
  await page.locator("#noteFontFamily").selectOption("system-serif");
  await page.locator("#noteFontSize").fill("34");
  await page.locator("#noteFontBold").check();
  await page.locator("#noteFontItalic").check();
  await page.locator("#noteTextAlign").selectOption("center");
  await expect(stage.locator("text.note-element")).toHaveAttribute("text-anchor", "middle");
  await expect(stage.locator("text.note-element")).toHaveAttribute("font-family", "serif");
  await expect(stage.locator("text.note-element")).toHaveAttribute("font-weight", "bold");

  await page.locator("#noteStyleBtn").click();
  const overlayBefore = await stage.locator('[data-selection-overlay="true"]').boundingBox();
  const eastHandle = await stage.locator('[data-transform-handle="resize-e"]').boundingBox();
  await page.mouse.move(eastHandle.x + eastHandle.width / 2, eastHandle.y + eastHandle.height / 2);
  await page.mouse.down();
  await page.mouse.move(eastHandle.x + eastHandle.width / 2 + 50, eastHandle.y + eastHandle.height / 2, { steps: 6 });
  await page.mouse.up();
  const overlayAfter = await stage.locator('[data-selection-overlay="true"]').boundingBox();
  expect(overlayAfter.width).toBeGreaterThan(overlayBefore.width);

  await page.locator("#noteStyleBtn").click();
  await page.locator("#noteTextAlign").selectOption("right");
  await expect(stage.locator("text.note-element")).toHaveAttribute("text-anchor", "end");
  await expect(page.locator("#noteSaveStatus")).toContainText("保存済み", { timeout: 20_000 });
});

test("@authenticated @ipad-v-next ハイライト・オブジェクト消しゴム・ピクセル消しゴムを実操作してUndoできる", async ({ page }) => {
  test.setTimeout(90_000);
  const user = await createUser();
  await login(page, user);
  await page.locator("#newNoteBtn").click();
  await page.locator("#newNoteTitle").fill("消しゴムE2Eノート");
  page = await openEditorPopup(page, () => page.locator('[data-create-note="blank"]').click());
  const stage = page.locator("#notePageStage");
  await stage.scrollIntoViewIfNeeded();
  const box = await stage.boundingBox();
  const point = (x, y) => ({ x: box.x + box.width * x, y: box.y + box.height * y });
  const drag = async (from, to, steps = 10) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps });
    await page.mouse.up();
  };
  const elementCount = () => stage.locator("[data-element-id]").evaluateAll(nodes =>
    new Set(nodes.map(node => node.dataset.elementId)).size
  );

  await drag(point(.16, .14), point(.62, .14));
  await page.locator('[data-note-tool="highlighter"]').click();
  await drag(point(.16, .28), point(.62, .28));
  await expect.poll(elementCount).toBe(2);

  await page.locator('[data-note-tool="eraser-object"]').click();
  await page.mouse.click(point(.35, .14).x, point(.35, .14).y);
  await expect.poll(elementCount).toBe(1);
  await page.locator("#noteUndoBtn").click();
  await expect.poll(elementCount).toBe(2);

  await page.locator("#noteStyleBtn").click();
  await page.locator("#noteEraserMode").selectOption("pixel");
  await page.locator("#noteStyleBtn").click();
  await page.mouse.move(point(.39, .23).x, point(.39, .23).y);
  await page.mouse.down();
  await page.mouse.move(point(.39, .28).x, point(.39, .28).y, { steps: 3 });
  const eraserCursor = page.locator("#notePixelEraserCursor");
  await expect(eraserCursor).toBeVisible();
  await expect(eraserCursor).toHaveCSS("pointer-events", "none");
  const eraserCursorBox = await eraserCursor.boundingBox();
  expect(Math.abs(eraserCursorBox.width - eraserCursorBox.height)).toBeLessThanOrEqual(1);
  await page.mouse.move(point(.39, .33).x, point(.39, .33).y, { steps: 4 });
  await page.mouse.up();
  await expect(eraserCursor).toBeHidden();
  await expect.poll(elementCount).toBeGreaterThan(2);
  await page.locator("#noteUndoBtn").click();
  await expect.poll(elementCount).toBe(2);
  await expect(page.locator("#noteSaveStatus")).toContainText("保存済み", { timeout: 20_000 });
});

test("@authenticated 全NoteStore APIはexpectedUidなしでSDKへ到達しない", async ({ page }) => {
  await page.goto("/?firebaseEmulator=1", { waitUntil: "domcontentloaded" });
  const result = await page.evaluate(async () => {
    const { createNoteStore } = await import("/js/services/note-store.js");
    let contextCalls = 0;
    const store = createNoteStore({
      getDb: () => { contextCalls += 1; return null; },
      getStorage: () => { contextCalls += 1; return null; },
      getUser: () => { contextCalls += 1; return null; }
    });
    const blob = new Blob(["x"], { type: "image/png" });
    const calls = {
      listNotes: () => store.listNotes(),
      getNote: () => store.getNote("note"),
      listNotesByMaterial: () => store.listNotesByMaterial("material"),
      listPages: () => store.listPages("note"),
      createNote: () => store.createNote({ pages: [] }),
      createCreatingNote: () => store.createCreatingNote("note", {}),
      finalizeCreatingNote: () => store.finalizeCreatingNote("note", []),
      finalizeNoteCreation: () => store.finalizeNoteCreation("note", 0),
      abortCreatingNote: () => store.abortCreatingNote("note"),
      cleanupStuckCreatingNotes: () => store.cleanupStuckCreatingNotes(),
      markCreationFailed: () => store.markCreationFailed("note"),
      uploadSourcePage: () => store.uploadSourcePage("note", "page", blob),
      deleteStoragePaths: () => store.deleteStoragePaths([]),
      loadPageContent: () => store.loadPageContent("note", { pageId: "page", contentPath: "" }),
      savePageContent: () => store.savePageContent({ noteId: "note", pageId: "page", expectedRevision: 0 }, {}),
      uploadAsset: () => store.uploadAsset("note", blob),
      getAsset: () => store.getAsset("note", "asset"),
      getStorageBlob: () => store.getStorageBlob("users/u/notes/n/file.json"),
      cleanupStoragePath: () => store.cleanupStoragePath("users/u/notes/n/file.json"),
      updatePageOrder: () => store.updatePageOrder("note", [], 0),
      createPage: () => store.createPage("note", { pageId: "page" }, 1, 0),
      deletePage: () => store.deletePage("note", "page", [{ pageId: "remaining" }], 0),
      updatePage: () => store.updatePage("note", "page", {}),
      updateNote: () => store.updateNote("note", {}),
      deleteMaterialLinkedNotes: () => store.deleteMaterialLinkedNotes([], "material-deleted"),
      restoreNote: () => store.restoreNote("note"),
      deleteNote: () => store.deleteNote("note")
    };
    const errors = [];
    for (const [name, call] of Object.entries(calls)) {
      try {
        await call();
        errors.push({ name, message: "" });
      } catch (error) {
        errors.push({ name, message: error?.message || String(error) });
      }
    }
    return { contextCalls, errors };
  });

  expect(result.errors).toHaveLength(27);
  expect(result.errors.filter(({ message }) => !message.includes("expectedUid"))).toEqual([]);
  expect(result.contextCalls, "Firebaseコンテキスト取得前に拒否する").toBe(0);
});

test("@authenticated status欠落の旧ノートも一覧に表示する", async ({ page }) => {
  const blockedRequests = await guardProductionFirebase(page);
  const user = await createUser();
  await seedReadyNote(user.uid, "statusなし旧ノート", { legacyWithoutStatus: true });
  await login(page, user);

  await expect(page.locator(".note-card h4", { hasText: "statusなし旧ノート" })).toBeVisible();
  expect(blockedRequests).toEqual([]);
});

test("@authenticated 寸法上限を超える画像はStorageへ保存する前に拒否する", async ({ page }) => {
  const blockedRequests = await guardProductionFirebase(page);
  await page.goto("/?firebaseEmulator=1", { waitUntil: "domcontentloaded" });
  const oversizedPng = createRgbPng(8193, 1);
  const result = await page.evaluate(async encoded => {
    const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
    const blob = new Blob([bytes], { type: "image/png" });
    const { createNoteStore } = await import("/js/services/note-store.js");
    let contextCalled = false;
    const store = createNoteStore({
      getDb: () => { contextCalled = true; return null; },
      getStorage: () => { contextCalled = true; return null; },
      getUser: () => { contextCalled = true; return null; }
    });
    let missingUidError = "";
    try {
      await store.uploadAsset("note-oversized", blob);
    } catch (error) {
      missingUidError = error?.message || String(error);
    }
    try {
      await store.uploadAsset("note-oversized", blob, { expectedUid: "test-user" });
      return { error: "", missingUidError, contextCalled };
    } catch (error) {
      return { error: error?.message || String(error), missingUidError, contextCalled };
    }
  }, oversizedPng.toString("base64"));

  expect(result.missingUidError).toContain("expectedUid");
  expect(result.error).toContain("縦横サイズまたは総画素数が上限");
  expect(result.contextCalled, "Storage/Firestoreの処理前に拒否する").toBe(false);
  expect(blockedRequests).toEqual([]);
});

test("@authenticated 画像Storage失敗時はIndexedDBへ保持し再読込後に再送する", async ({ page }) => {
  test.setTimeout(90_000);
  const blockedRequests = await guardProductionFirebase(page);
  const dialogs = [];
  const onDialog = async dialog => {
    dialogs.push(dialog.message());
    await dialog.accept();
  };
  page.on("dialog", onDialog);
  const user = await createUser();
  await login(page, user);
  let journalSeenBeforeUpload = false;

  await page.locator("#newNoteBtn").click();
  await page.locator("#newNoteTitle").fill("画像復旧E2Eノート");
  page = await openEditorPopup(page, () => page.locator('[data-create-note="blank"]').click(), {
    blockedRequests, onDialog
  });

  await page.route("**/v0/b/demo-dental-qa.firebasestorage.app/o**", async route => {
    const request = route.request();
    const objectName = new URL(request.url()).searchParams.get("name") || "";
    if (["POST", "PUT"].includes(request.method()) && objectName.includes("/notes/") && objectName.includes("/assets/")) {
      const stored = await readNotes(user.uid);
      journalSeenBeforeUpload = stored.notes.some(note =>
        (note.pendingStoragePaths || []).some(path => path.includes("/assets/"))
      );
      await route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: 403, message: "forced note asset failure" } })
      });
      return;
    }
    await route.continue();
  });
  await page.locator("#noteImageFileInput").setInputFiles({ name: "offline.png", mimeType: "image/png", buffer: TEST_PNG });
  await expect(page.locator("#noteSaveStatus")).toHaveAttribute("data-state", "recoverable-error", { timeout: 20_000 });
  await expect.poll(() => localNoteStoreCounts(page)).toMatchObject({ pendingAssets: 1, pageDrafts: 1, pendingSaves: 1 });
  await expect.poll(() => dialogs.length).toBeGreaterThan(0);
  expect(journalSeenBeforeUpload, "Storage開始前にFirestore journalへ記録する").toBe(true);
  const failedUploadState = await readNotes(user.uid);
  expect(failedUploadState.notes[0].pendingStoragePaths || []).toEqual([]);

  await page.addInitScript(() => {
    window.__noteOfflineForExport = true;
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      get: () => !window.__noteOfflineForExport
    });
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#authStatus")).toContainText(user.email, { timeout: 20_000 });
  await expect(page.locator("#notePageStage .note-image-element img")).toHaveAttribute("src", /blob:/, { timeout: 20_000 });
  const recoveryStartupMetrics = await page.evaluate(() => globalThis.__noteEditorStartupMetrics);
  expect(recoveryStartupMetrics.context).toMatchObject({
    pendingSaveCount: 1,
    pendingAssetCount: 1,
    conflictCount: 0
  });
  expect(recoveryStartupMetrics.spans.find(span => span.name === "pending-asset-recovery")?.details).toMatchObject({
    before: 1,
    remaining: 1
  });
  expect(recoveryStartupMetrics.spans.find(span => span.name === "current-page-assets")?.details).toMatchObject({
    assetCount: 1,
    failedAssetCount: 0
  });
  await page.locator("#noteSaveStatus").click();
  await expect(page.locator("#noteRetrySaveBtn")).toBeVisible();
  await page.locator("#noteSaveStatus").click();
  await page.locator(".note-more-menu summary").click();
  await page.locator('[data-note-action="export"]').click();
  await page.locator("#createNotePdfBtn").click();
  await expect(page.locator("#noteExportStatus")).toContainText("作成したPDF", { timeout: 60_000 });
  await page.locator('#noteExportDialog button[value="close"]').click();

  await page.unroute("**/v0/b/demo-dental-qa.firebasestorage.app/o**");
  await page.evaluate(() => {
    window.__noteOfflineForExport = false;
    window.dispatchEvent(new Event("online"));
  });
  await expect.poll(() => page.locator("#noteSaveStatus").getAttribute("data-state"), { timeout: 20_000 })
    .toMatch(/^(recoverable-error|saved)$/);
  if (await page.locator("#noteSaveStatus").getAttribute("data-state") !== "saved") {
    await page.locator("#noteSaveStatus").click();
    await page.locator("#noteRetrySaveBtn").click();
  }
  await expect(page.locator("#noteSaveStatus")).toContainText("保存済み", { timeout: 20_000 });
  await expect.poll(() => localNoteStoreCounts(page)).toEqual({ pendingAssets: 0, pageDrafts: 0, pendingSaves: 0, conflicts: 0 });

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#authStatus")).toContainText(user.email, { timeout: 20_000 });
  await expect(page.locator("#notePageStage .note-image-element")).toHaveCount(1, { timeout: 20_000 });
  const stored = await readNotes(user.uid);
  expect(stored.notes[0].pages[0].contentRevision).toBeGreaterThan(0);
  expect(blockedRequests).toEqual([]);
});

test("@authenticated 画像追加後のIndexedDB下書き失敗を端末保存済みと誤表示しない", async ({ page }) => {
  test.setTimeout(60_000);
  const blockedRequests = await guardProductionFirebase(page);
  page.on("dialog", dialog => dialog.accept());
  const user = await createUser();
  await login(page, user);
  await page.locator("#newNoteBtn").click();
  await page.locator("#newNoteTitle").fill("画像ローカル保存失敗E2Eノート");
  page = await openEditorPopup(page, () => page.locator('[data-create-note="blank"]').click(), { blockedRequests });

  await page.evaluate(() => {
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function put(value, ...args) {
      if (this.name === "pendingSaves") throw new DOMException("forced pending save failure", "QuotaExceededError");
      return originalPut.call(this, value, ...args);
    };
  });
  await page.locator("#noteImageFileInput").setInputFiles({
    name: "local-save-failure.png",
    mimeType: "image/png",
    buffer: TEST_PNG
  });
  await expect(page.locator("#noteSaveStatus")).toHaveAttribute("data-state", "local-storage-error", { timeout: 20_000 });
  await expect(page.locator("#notePageStage .note-image-element")).toHaveCount(1);
  await page.locator("#noteSaveStatus").click();
  await expect(page.locator("#noteSaveStatusDetail")).toContainText("画面内にだけ残っています");
  expect(blockedRequests).toEqual([]);
});

test("@authenticated 一般ページ下書きも再読込後に自動再送する", async ({ page }) => {
  test.setTimeout(90_000);
  const blockedRequests = await guardProductionFirebase(page);
  const user = await createUser();
  await login(page, user);

  await page.locator("#newNoteBtn").click();
  await page.locator("#newNoteTitle").fill("下書き再送E2Eノート");
  page = await openEditorPopup(page, () => page.locator('[data-create-note="blank"]').click(), { blockedRequests });

  const storedBefore = await readNotes(user.uid);
  const note = storedBefore.notes.find(item => item.title === "下書き再送E2Eノート");
  expect(note).toBeTruthy();
  const notePage = note.pages[0];
  const content = {
    schemaVersion: 1,
    noteId: note.id,
    pageId: notePage.pageId,
    revision: 0,
    elements: [{
      id: crypto.randomUUID(),
      type: "stroke",
      points: [{ x: .1, y: .1, pressure: .5 }, { x: .4, y: .2, pressure: .5 }],
      style: { color: "#111111", widthRatio: .0025, opacity: 1 },
      zIndex: 20
    }],
    noteMasks: [],
    savedAt: ""
  };
  await seedPendingPageDraft(page, {
    uid: user.uid,
    noteId: note.id,
    pageId: notePage.pageId,
    content
  });
  await expect.poll(() => localNoteStoreCounts(page)).toMatchObject({ pageDrafts: 1, pendingSaves: 1 });

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#authStatus")).toContainText(user.email, { timeout: 20_000 });
  await expect(page.locator("#notePageStage path[data-element-id]")).toHaveCount(1, { timeout: 20_000 });
  await expect.poll(async () => {
    const stored = await readNotes(user.uid);
    return stored.notes.find(item => item.id === note.id)?.pages[0]?.contentRevision || 0;
  }, { timeout: 20_000 }).toBeGreaterThan(0);
  await expect.poll(() => localNoteStoreCounts(page)).toEqual({ pendingAssets: 0, pageDrafts: 0, pendingSaves: 0, conflicts: 0 });
  expect(blockedRequests).toEqual([]);
});

test("@authenticated オンライン状態が反復しても未送信下書きを多重再送しない", async ({ page }) => {
  test.setTimeout(90_000);
  const blockedRequests = await guardProductionFirebase(page);
  const user = await createUser();
  await login(page, user);
  await page.locator("#newNoteBtn").click();
  await page.locator("#newNoteTitle").fill("再送排他E2Eノート");
  page = await openEditorPopup(page, () => page.locator('[data-create-note="blank"]').click(), { blockedRequests });

  const storedBefore = await readNotes(user.uid);
  const note = storedBefore.notes.find(item => item.title === "再送排他E2Eノート");
  const notePage = note.pages[0];
  await page.evaluate(() => {
    window.__noteRecoveryOnline = false;
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      get: () => window.__noteRecoveryOnline
    });
  });
  await seedPendingPageDraft(page, {
    uid: user.uid,
    noteId: note.id,
    pageId: notePage.pageId,
    expectedRevision: 0,
    content: {
      schemaVersion: 1,
      noteId: note.id,
      pageId: notePage.pageId,
      revision: 0,
      elements: [],
      noteMasks: [],
      savedAt: ""
    }
  });
  await expect.poll(() => localNoteStoreCounts(page)).toMatchObject({ pageDrafts: 1, pendingSaves: 1 });

  let uploadCount = 0;
  let releaseUpload;
  let notifyUploadStarted;
  const uploadGate = new Promise(resolve => { releaseUpload = resolve; });
  const uploadStarted = new Promise(resolve => { notifyUploadStarted = resolve; });
  await page.route("**/v0/b/demo-dental-qa.firebasestorage.app/o**", async route => {
    const request = route.request();
    const objectName = new URL(request.url()).searchParams.get("name") || "";
    if (["POST", "PUT"].includes(request.method()) && objectName.includes("/revisions/")) {
      uploadCount += 1;
      if (uploadCount === 1) {
        notifyUploadStarted();
        await uploadGate;
      }
    }
    await route.continue();
  });

  await page.evaluate(() => {
    window.__noteRecoveryOnline = true;
    window.dispatchEvent(new Event("online"));
  });
  await uploadStarted;
  await page.evaluate(() => {
    for (let index = 0; index < 3; index += 1) {
      window.__noteRecoveryOnline = false;
      window.dispatchEvent(new Event("offline"));
      window.__noteRecoveryOnline = true;
      window.dispatchEvent(new Event("online"));
    }
  });
  await page.waitForTimeout(250);
  expect(uploadCount).toBe(1);

  releaseUpload();
  await expect.poll(() => localNoteStoreCounts(page), { timeout: 20_000 }).toEqual({
    pendingAssets: 0,
    pageDrafts: 0,
    pendingSaves: 0,
    conflicts: 0
  });
  await page.evaluate(() => {
    window.__noteRecoveryOnline = false;
    window.dispatchEvent(new Event("offline"));
    window.__noteRecoveryOnline = true;
    window.dispatchEvent(new Event("online"));
  });
  await page.waitForTimeout(250);
  expect(uploadCount).toBe(1);
  await page.unroute("**/v0/b/demo-dental-qa.firebasestorage.app/o**");
  expect(blockedRequests).toEqual([]);
});

test("@authenticated 復旧中にユーザーを切り替えても新ユーザーの復旧を独立実行する", async ({ page }) => {
  test.setTimeout(120_000);
  const blockedRequests = await guardProductionFirebase(page);
  const alice = await createUser();
  const bob = await createUser();
  const aliceNote = await seedReadyNote(alice.uid, "Alice復旧ノート");
  const bobNote = await seedReadyNote(bob.uid, "Bob復旧ノート");
  await login(page, alice);
  const contentFor = (noteId, pageId, id) => ({
    schemaVersion: 1,
    noteId,
    pageId,
    revision: 0,
    elements: [{
      id,
      type: "stroke",
      points: [{ x: .1, y: .1, pressure: .5 }, { x: .4, y: .4, pressure: .5 }],
      style: { color: "#111111", widthRatio: .0025, opacity: 1 },
      zIndex: 10
    }],
    noteMasks: [],
    savedAt: ""
  });
  await seedPendingPageDraft(page, {
    uid: alice.uid,
    noteId: aliceNote.noteId,
    pageId: aliceNote.pageId,
    content: contentFor(aliceNote.noteId, aliceNote.pageId, "alice-stroke"),
    expectedRevision: 0
  });
  await seedPendingPageDraft(page, {
    uid: bob.uid,
    noteId: bobNote.noteId,
    pageId: bobNote.pageId,
    content: contentFor(bobNote.noteId, bobNote.pageId, "bob-stroke"),
    expectedRevision: 0
  });

  let releaseAliceUpload;
  let notifyAliceUpload;
  const aliceUploadStarted = new Promise(resolve => { notifyAliceUpload = resolve; });
  const aliceUploadGate = new Promise(resolve => { releaseAliceUpload = resolve; });
  await page.route("**/v0/b/demo-dental-qa.firebasestorage.app/o**", async route => {
    const request = route.request();
    const objectName = new URL(request.url()).searchParams.get("name") || "";
    if (["POST", "PUT"].includes(request.method()) && objectName.includes(`users/${alice.uid}/notes/`)) {
      notifyAliceUpload();
      await aliceUploadGate;
    }
    await route.continue();
  });
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await aliceUploadStarted;

  await page.locator("#tabBtnAuth").click();
  await page.locator("#signOutBtn").click();
  await expect(page.locator("#authStatus")).toContainText("未ログイン", { timeout: 20_000 });
  await page.locator("#emailInput").fill(bob.email);
  await page.locator("#passwordInput").fill(bob.password);
  await page.locator("#signInBtn").click();
  await expect(page.locator("#authStatus")).toContainText(bob.email, { timeout: 20_000 });
  await page.locator("#tabBtnPdf").click();
  await page.locator("#noteModeBtn").click();

  await expect.poll(async () => {
    const stored = await readNotes(bob.uid);
    return stored.notes.find(note => note.id === bobNote.noteId)?.pages[0]?.contentRevision || 0;
  }, { timeout: 30_000 }).toBe(1);
  await expect.poll(() => localPendingSaveCountForUser(page, bob.uid)).toBe(0);
  expect(await localPendingSaveCountForUser(page, alice.uid)).toBe(1);
  releaseAliceUpload();
  await expect.poll(() => localPendingSaveCountForUser(page, alice.uid)).toBe(1);
  const aliceStored = await readNotes(alice.uid);
  expect(aliceStored.notes.find(note => note.id === aliceNote.noteId)?.pages[0]?.contentRevision).toBe(0);
  await page.unroute("**/v0/b/demo-dental-qa.firebasestorage.app/o**");
  expect(blockedRequests).toEqual([]);
});

test("@authenticated 基準revisionのない旧下書きは推測保存せず競合として保持する", async ({ page }) => {
  test.setTimeout(90_000);
  const blockedRequests = await guardProductionFirebase(page);
  const user = await createUser();
  await login(page, user);
  await page.locator("#newNoteBtn").click();
  await page.locator("#newNoteTitle").fill("基準不明E2Eノート");
  page = await openEditorPopup(page, () => page.locator('[data-create-note="blank"]').click(), { blockedRequests });

  const storedBefore = await readNotes(user.uid);
  const note = storedBefore.notes.find(item => item.title === "基準不明E2Eノート");
  const notePage = note.pages[0];
  await page.evaluate(() => {
    window.__noteRecoveryOnline = false;
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      get: () => window.__noteRecoveryOnline
    });
  });
  await seedPendingPageDraft(page, {
    uid: user.uid,
    noteId: note.id,
    pageId: notePage.pageId,
    content: {
      schemaVersion: 1,
      noteId: note.id,
      pageId: notePage.pageId,
      elements: [],
      noteMasks: [],
      savedAt: ""
    }
  });
  await page.evaluate(() => {
    window.__noteRecoveryOnline = true;
    window.dispatchEvent(new Event("online"));
  });

  await expect.poll(() => localNoteStoreCounts(page)).toEqual({
    pendingAssets: 0,
    pageDrafts: 1,
    pendingSaves: 1,
    conflicts: 1
  });
  const storedAfter = await readNotes(user.uid);
  expect(storedAfter.notes.find(item => item.id === note.id)?.pages[0]?.contentRevision).toBe(0);
  expect(blockedRequests).toEqual([]);
});

test("@authenticated 復旧中に更新されたIndexedDB下書きをcompare-and-deleteで保持する", async ({ page }) => {
  test.setTimeout(90_000);
  const blockedRequests = await guardProductionFirebase(page);
  const user = await createUser();
  await login(page, user);
  await page.locator("#newNoteBtn").click();
  await page.locator("#newNoteTitle").fill("復旧競合E2Eノート");
  page = await openEditorPopup(page, () => page.locator('[data-create-note="blank"]').click(), { blockedRequests });

  const storedBefore = await readNotes(user.uid);
  const note = storedBefore.notes.find(item => item.title === "復旧競合E2Eノート");
  const notePage = note.pages[0];
  await page.evaluate(() => {
    window.__noteRecoveryOnline = false;
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      get: () => window.__noteRecoveryOnline
    });
  });
  const originalContent = {
    schemaVersion: 1,
    noteId: note.id,
    pageId: notePage.pageId,
    revision: 0,
    elements: [],
    noteMasks: [],
    savedAt: ""
  };
  await seedPendingPageDraft(page, {
    uid: user.uid,
    noteId: note.id,
    pageId: notePage.pageId,
    expectedRevision: 0,
    content: originalContent
  });
  let releaseUpload;
  let notifyUploadStarted;
  const uploadGate = new Promise(resolve => { releaseUpload = resolve; });
  const uploadStarted = new Promise(resolve => { notifyUploadStarted = resolve; });
  await page.route("**/v0/b/demo-dental-qa.firebasestorage.app/o**", async route => {
    const request = route.request();
    const objectName = new URL(request.url()).searchParams.get("name") || "";
    if (["POST", "PUT"].includes(request.method()) && objectName.includes("/revisions/")) {
      notifyUploadStarted();
      await uploadGate;
    }
    await route.continue();
  });

  await page.evaluate(() => {
    window.__noteRecoveryOnline = true;
    window.dispatchEvent(new Event("online"));
  });
  await uploadStarted;
  const newerElementId = `newer-${crypto.randomUUID()}`;
  await seedPendingPageDraft(page, {
    uid: user.uid,
    noteId: note.id,
    pageId: notePage.pageId,
    expectedRevision: 0,
    content: {
      ...originalContent,
      elements: [{
        id: newerElementId,
        type: "stroke",
        points: [{ x: .2, y: .2, pressure: .5 }, { x: .5, y: .3, pressure: .5 }],
        style: { color: "#111111", widthRatio: .0025, opacity: 1 },
        zIndex: 20
      }]
    }
  });
  releaseUpload();

  await expect.poll(async () => {
    const stored = await readNotes(user.uid);
    return stored.notes.find(item => item.id === note.id)?.pages[0]?.contentRevision || 0;
  }, { timeout: 20_000 }).toBe(1);
  await expect.poll(() => localNoteStoreCounts(page)).toEqual({
    pendingAssets: 0,
    pageDrafts: 1,
    pendingSaves: 1,
    conflicts: 0
  });
  const preservedElementId = await page.evaluate(async value => {
    const { createNoteLocalStore, noteLocalKey } = await import("/js/core/note-local-store.js");
    const localStore = createNoteLocalStore();
    const key = noteLocalKey(value.uid, value.noteId, value.pageId);
    const preserved = await localStore.get("pageDrafts", key);
    await localStore.close();
    return preserved?.content?.elements?.[0]?.id || null;
  }, { uid: user.uid, noteId: note.id, pageId: notePage.pageId });
  expect(preservedElementId).toBe(newerElementId);
  await page.unroute("**/v0/b/demo-dental-qa.firebasestorage.app/o**");
  expect(blockedRequests).toEqual([]);
});

test("@authenticated 再送前にクラウドが更新済みなら下書きを競合保持して上書きしない", async ({ page }) => {
  test.setTimeout(90_000);
  const blockedRequests = await guardProductionFirebase(page);
  const user = await createUser();
  await login(page, user);
  await page.locator("#newNoteBtn").click();
  await page.locator("#newNoteTitle").fill("下書き競合E2Eノート");
  page = await openEditorPopup(page, () => page.locator('[data-create-note="blank"]').click(), { blockedRequests });

  const storedBefore = await readNotes(user.uid);
  const note = storedBefore.notes.find(item => item.title === "下書き競合E2Eノート");
  const notePage = note.pages[0];
  const content = {
    schemaVersion: 1,
    noteId: note.id,
    pageId: notePage.pageId,
    revision: 0,
    elements: [{
      id: crypto.randomUUID(),
      type: "stroke",
      points: [{ x: .15, y: .15, pressure: .5 }, { x: .45, y: .25, pressure: .5 }],
      style: { color: "#111111", widthRatio: .0025, opacity: 1 },
      zIndex: 20
    }],
    noteMasks: [],
    savedAt: ""
  };
  await seedPendingPageDraft(page, {
    uid: user.uid,
    noteId: note.id,
    pageId: notePage.pageId,
    content
  });
  await updateNotePage(user.uid, note.id, notePage.pageId, { contentRevision: 1 });

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#authStatus")).toContainText(user.email, { timeout: 20_000 });
  await expect(page.locator("#noteSaveStatus")).toHaveAttribute("data-state", "conflict", { timeout: 20_000 });
  await expect.poll(() => localNoteStoreCounts(page)).toEqual({ pendingAssets: 0, pageDrafts: 1, pendingSaves: 1, conflicts: 1 });
  const storedAfter = await readNotes(user.uid);
  expect(storedAfter.notes.find(item => item.id === note.id)?.pages[0]?.contentRevision).toBe(1);

  await expect(page.locator("#notePageStage [data-element-id]")).toHaveCount(1);
  expect(blockedRequests).toEqual([]);
});

test("@authenticated 保存状態と設定popoverの変化で編集面を動かさず全経路で閉じられる", async ({ page }) => {
  test.setTimeout(90_000);
  const blockedRequests = await guardProductionFirebase(page);
  const user = await createUser();
  await login(page, user);
  await page.locator("#newNoteBtn").click();
  await page.locator("#newNoteTitle").fill("固定ヘッダーE2Eノート");
  page = await openEditorPopup(page, () => page.locator('[data-create-note="blank"]').click(), { blockedRequests });

  const before = await page.evaluate(() => {
    const stage = document.querySelector("#notePageStage").getBoundingClientRect();
    const viewer = document.querySelector("#noteViewport");
    return { stage: { left: stage.left, top: stage.top, width: stage.width, height: stage.height }, scrollLeft: viewer.scrollLeft, scrollTop: viewer.scrollTop };
  });
  await page.evaluate(() => {
    const states = ["editing", "saving", "saved", "recoverable-error", "offline-local", "conflict"];
    for (let index = 0; index < 100; index += 1) {
      const state = states[index % states.length];
      const status = document.querySelector("#noteSaveStatus");
      status.dataset.state = state;
      status.setAttribute("aria-label", `${state}-${"非常に長い保存状態説明".repeat(index % 3)}`);
      document.querySelector("#noteSaveStatusButtonText").textContent = status.getAttribute("aria-label");
      document.querySelector("#noteSaveStatusIcon").textContent = index % 2 ? "✓" : "!";
    }
  });
  const after = await page.evaluate(() => {
    const stage = document.querySelector("#notePageStage").getBoundingClientRect();
    const viewer = document.querySelector("#noteViewport");
    return { stage: { left: stage.left, top: stage.top, width: stage.width, height: stage.height }, scrollLeft: viewer.scrollLeft, scrollTop: viewer.scrollTop };
  });
  for (const key of ["left", "top", "width", "height"]) expect(Math.abs(after.stage[key] - before.stage[key])).toBeLessThanOrEqual(1);
  expect(after.scrollLeft).toBe(before.scrollLeft);
  expect(after.scrollTop).toBe(before.scrollTop);

  await page.locator("#noteSaveStatus").click();
  await expect(page.locator("#noteSavePopover")).toBeVisible();
  await expect(page.locator("#noteSaveDiagnosticsBtn")).toBeFocused();
  expect(await page.evaluate(() => {
    const shell = document.querySelector(".note-save-status-shell");
    const popover = document.querySelector("#noteSavePopover");
    const rect = popover.getBoundingClientRect();
    const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + Math.min(20, rect.height / 2));
    return {
      containment: getComputedStyle(shell).contain,
      parentIsBody: popover.parentElement === document.body,
      position: getComputedStyle(popover).position,
      insideViewport: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
      receivesPointer: Boolean(target?.closest("#noteSavePopover"))
    };
  })).toEqual({ containment: "layout paint", parentIsBody: true, position: "fixed", insideViewport: true, receivesPointer: true });
  await page.evaluate(() => {
    visualViewport?.dispatchEvent(new Event("resize"));
    visualViewport?.dispatchEvent(new Event("scroll"));
  });
  await expect(page.locator("#noteSavePopover"), "visualViewportの変化では閉じずに再配置する").toBeVisible();
  await expect.poll(() => page.locator("#noteSavePopover").evaluate(popover => {
    const rect = popover.getBoundingClientRect();
    const viewport = visualViewport;
    const left = viewport?.offsetLeft || 0;
    const top = viewport?.offsetTop || 0;
    const right = left + (viewport?.width || innerWidth);
    const bottom = top + (viewport?.height || innerHeight);
    return rect.left >= left && rect.top >= top && rect.right <= right && rect.bottom <= bottom;
  })).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.locator("#noteSavePopover")).toBeHidden();
  await expect(page.locator("#noteSaveStatus")).toBeFocused();

  const pen = page.locator('[data-note-tool="pen"]');
  await pen.click();
  await expect(page.locator("#noteToolSettings")).toBeVisible();
  await pen.click();
  await expect(page.locator("#noteToolSettings")).toBeHidden();
  await pen.click();
  await page.locator("#noteToolSettingsDoneBtn").click();
  await expect(page.locator("#noteToolSettings")).toBeHidden();
  await pen.click();
  await page.locator('[data-note-tool="highlighter"]').click();
  await expect(page.locator("#noteToolSettings")).toBeHidden();
  await page.locator('[data-note-tool="highlighter"]').click();
  await expect(page.locator("#noteToolSettings")).toBeVisible();
  await page.locator("#notePageStage").click({ position: { x: 40, y: 40 } });
  await expect(page.locator("#noteToolSettings")).toBeHidden();
  await expect(page.locator("#notePageStage")).toBeVisible();

  await pen.click();
  await pen.click();
  await expect(page.locator("#noteToolSettings")).toBeVisible();
  const tabId = new URL(page.url()).searchParams.get("editorTabId");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#noteEditorStartup")).toBeHidden({ timeout: 20_000 });
  expect(new URL(page.url()).searchParams.get("editorTabId")).toBe(tabId);
  await expect(page.locator("#noteToolSettings")).toBeHidden();
  await page.locator("#notePageStage").click({ position: { x: 60, y: 60 } });
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await expect(page.locator("#noteEditorStartup")).toBeHidden({ timeout: 20_000 });
  await expect.poll(async () => page.evaluate(expectedTabId => {
    const uid = Object.keys(localStorage).find(key => key.startsWith("dentalQaNoteClientInstance:"))?.split(":").at(-1);
    const noteId = new URL(location.href).searchParams.get("noteId");
    const lease = JSON.parse(localStorage.getItem(`dentalQaNoteEditorLease:${uid}:${noteId}`) || "null");
    return lease?.editorTabId === expectedTabId;
  }, tabId)).toBe(true);
  expect(blockedRequests).toEqual([]);
});

test("@authenticated ログイン状態の反映中に画面要素が欠けても読み込み中のまま止めず再読み込みを案内する", async ({ page }) => {
  test.setTimeout(60_000);
  const blockedRequests = await guardProductionFirebase(page);
  const pageErrors = [];
  page.on("pageerror", error => recordUnexpectedPageError(pageErrors, error));
  const user = await createUser();
  const note = await seedReadyNote(user.uid, "要素欠落E2Eノート");
  await login(page, user);
  // Stands in for an HTML/JS version mismatch after a deploy: an element that
  // app.js updates on every sign-in state is missing when the module runs.
  await page.addInitScript(() => {
    document.addEventListener("readystatechange", () => {
      if (document.readyState === "interactive") document.getElementById("studyLockBanner")?.remove();
    });
  });
  await page.goto(`/?firebaseEmulator=1&noteEditor=1&noteId=${note.noteId}&editorTabId=${crypto.randomUUID()}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#noteEditorStartupTitle")).toHaveText("ノートを開けませんでした", { timeout: 20_000 });
  await expect(page.locator("#noteEditorStartupDetail")).toContainText("ログイン状態を画面へ反映できませんでした。ページを再読み込みしてください。");
  const actions = page.locator("#noteEditorStartupActions");
  await expect(actions.getByRole("button", { name: "ページを再読み込み" })).toBeVisible();
  await expect(actions.getByRole("button", { name: "ノート一覧へ戻る" })).toBeVisible();
  await expect(actions.getByRole("button", { name: "端末内の下書きから復元" })).toBeHidden();
  expect(await page.evaluate(() => document.getElementById("studyLockBanner"))).toBeNull();
  expect(pageErrors, "例外は画面の復旧案内として扱い、未処理のまま残さない").toEqual([]);
  expect(blockedRequests).toEqual([]);
});

test("@authenticated 起動処理が進まないときは競合しない操作だけを示し再読み込みで開ける", async ({ page }) => {
  test.setTimeout(90_000);
  const blockedRequests = await guardProductionFirebase(page);
  const user = await createUser();
  const note = await seedReadyNote(user.uid, "起動停滞E2Eノート");
  await login(page, user);
  // Firebase Auth confirms a restored sign-in with accounts:lookup before it
  // reports the state; leaving that request unanswered keeps startup waiting.
  const lookupPattern = /127\.0\.0\.1:9099\/identitytoolkit\.googleapis\.com\/v1\/accounts:lookup/;
  const heldLookups = [];
  await page.route(lookupPattern, route => { heldLookups.push(route); });
  await page.goto(`/?firebaseEmulator=1&noteEditor=1&noteId=${note.noteId}&editorTabId=${crypto.randomUUID()}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#noteEditorStartupSlow")).toBeVisible({ timeout: 15_000 });
  const actions = page.locator("#noteEditorStartupActions");
  await expect(actions).toBeVisible();
  await expect(actions.locator("button:not(.hidden)")).toHaveText(["ページを再読み込み", "ノート一覧へ戻る", "診断情報をコピー"]);
  await expect(page.locator("#noteEditorStartupTitle")).toHaveText("ノートを読み込んでいます");
  expect(heldLookups.length).toBeGreaterThan(0);

  await page.unroute(lookupPattern);
  await Promise.all([
    page.waitForEvent("load"),
    actions.getByRole("button", { name: "ページを再読み込み" }).click()
  ]);
  await expect(page.locator("#noteEditorStartup")).toBeHidden({ timeout: 20_000 });
  await expect(page.locator("#noteTitleInput")).toHaveValue("起動停滞E2Eノート");
  await expect(actions).toBeHidden();
  expect(blockedRequests).toEqual([]);
});

test("@authenticated 不正なノートURLでも灰色画面だけにならず復旧操作を表示する", async ({ page }) => {
  test.setTimeout(60_000);
  const blockedRequests = await guardProductionFirebase(page);
  const user = await createUser();
  await login(page, user);
  await page.goto(`/?firebaseEmulator=1&noteEditor=1&noteId=missing-${crypto.randomUUID()}&editorTabId=${crypto.randomUUID()}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#noteEditorStartup")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#noteEditorStartupTitle")).toHaveText("ノートを開けませんでした");
  await expect(page.locator("#noteEditorStartupActions")).toBeVisible();
  await expect(page.getByRole("button", { name: "再試行" })).toBeVisible();
  await expect(page.locator("#noteEditorStartupActions").getByRole("button", { name: "ページを再読み込み" })).toBeVisible();
  await expect(page.locator("#noteEditorStartupActions").getByRole("button", { name: "ノート一覧へ戻る" })).toBeVisible();
  await expect(page.getByRole("button", { name: "診断情報をコピー" })).toBeVisible();
  await expect(page.locator("#noteViewport")).toBeVisible();
  expect(blockedRequests).toEqual([]);
});

test("@authenticated ページ内容の初期読込失敗後は取得済み編集leaseを解放する", async ({ page }) => {
  test.setTimeout(60_000);
  const blockedRequests = await guardProductionFirebase(page);
  const user = await createUser();
  const note = await seedReadyNote(user.uid, "初期読込失敗lease解放E2Eノート");
  await updateNotePage(user.uid, note.noteId, note.pageId, {
    contentRevision: 1,
    contentPath: `users/${user.uid}/notes/${note.noteId}/pages/${note.pageId}/revisions/missing.json`,
    contentHash: "missing-content"
  });
  await login(page, user);

  const editorTabId = crypto.randomUUID();
  await page.goto(`/?firebaseEmulator=1&noteEditor=1&noteId=${note.noteId}&editorTabId=${editorTabId}`, {
    waitUntil: "domcontentloaded"
  });
  await expect(page.locator("#noteEditorStartupTitle")).toHaveText("ノートを開けませんでした", { timeout: 20_000 });
  await expect.poll(() => page.evaluate(({ uid, noteId }) => (
    localStorage.getItem(`dentalQaNoteEditorLease:${uid}:${noteId}`)
  ), { uid: user.uid, noteId: note.noteId })).toBeNull();
  expect(blockedRequests).toEqual([]);
});

test("@authenticated 専用エディタは対象外ノート一覧を構築せずローカル4ストアを各1回だけ走査する", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const blockedRequests = await guardProductionFirebase(page);
  await page.addInitScript(() => {
    globalThis.__noteLocalObjectStoreGetAllCalls = [];
    const originalObjectStoreGetAll = IDBObjectStore.prototype.getAll;
    IDBObjectStore.prototype.getAll = function getAll(...args) {
      const query = args[0];
      globalThis.__noteLocalObjectStoreGetAllCalls.push({
        database: this.transaction.db.name,
        store: this.name,
        lower: query?.lower,
        upper: query?.upper
      });
      return originalObjectStoreGetAll.apply(this, args);
    };
  });
  const user = await createUser();
  const target = await seedReadyNote(user.uid, "直行読込E2Eノート");
  await Promise.all([
    seedReadyNote(user.uid, "対象外E2Eノート1"),
    seedReadyNote(user.uid, "対象外E2Eノート2"),
    seedReadyNote(user.uid, "対象外E2Eノート3")
  ]);
  await login(page, user);

  await page.goto(`/?firebaseEmulator=1&noteEditor=1&noteId=${target.noteId}&editorTabId=${crypto.randomUUID()}`, {
    waitUntil: "domcontentloaded"
  });
  await expect(page.locator("#noteEditorStartup")).toBeHidden({ timeout: 20_000 });
  await expect(page.locator("#noteTitleInput")).toHaveValue("直行読込E2Eノート");
  await expect(page.locator("#noteList").locator(":scope > *")).toHaveCount(0);
  const dedicatedEditorResources = await page.evaluate(() => performance.getEntriesByType("resource")
    .map(entry => new URL(entry.name).pathname));
  expect(dedicatedEditorResources).not.toContain("/js/features/question-manager.js");
  expect(dedicatedEditorResources).not.toContain("/js/features/image-memory.js");
  expect(dedicatedEditorResources).not.toContain("/vendor/pdf-lib/pdf-lib.min.js");
  await expect.poll(() => page.evaluate(() => globalThis.__noteLocalObjectStoreGetAllCalls
    .filter(call => call.database === "dentalQaNoteLocal")
    .sort((left, right) => left.store.localeCompare(right.store)))).toEqual(
    ["conflicts", "pendingSaves", "pendingAssets", "pageDrafts"].sort().map(store => ({
      database: "dentalQaNoteLocal",
      store,
      lower: `${user.uid}|${target.noteId}|`,
      upper: `${user.uid}|${target.noteId}|\uffff`
    }))
  );
  const startupMetrics = await page.evaluate(() => globalThis.__noteEditorStartupMetrics);
  const startupSpanNames = startupMetrics.spans.map(span => span.name);
  const startupMarkNames = startupMetrics.marks.map(mark => mark.name);
  expect(startupSpanNames).toEqual(expect.arrayContaining([
    "firebase-initialization",
    "auth-state-wait",
    "note-metadata",
    "page-metadata",
    "editor-lock",
    "local-record-scan",
    "pending-asset-recovery",
    "pending-save-recovery",
    "page-content-json",
    "page-list-dom",
    "current-page-background",
    "current-page-assets",
    "first-page-render",
    "open-note"
  ]));
  expect(startupMarkNames).toEqual(expect.arrayContaining([
    "app-module-evaluated",
    "auth-state-ready",
    "note-open-requested",
    "first-page-rendered",
    "first-visible-page",
    "interactive-ready",
    "can-edit"
  ]));
  expect(startupMetrics.spans.find(span => span.name === "editor-lock")?.details).toMatchObject({
    acquired: true,
    claimConfirmationWaitMs: 180,
    retryCount: 0
  });
  const startupSpan = name => startupMetrics.spans.find(span => span.name === name);
  const parallelStartupSpans = [
    "note-metadata",
    "page-metadata",
    "editor-lock",
    "local-record-scan"
  ].map(startupSpan);
  expect(parallelStartupSpans.every(Boolean)).toBe(true);
  expect(
    Math.max(...parallelStartupSpans.map(span => span.startMs)),
    "ノート本体・ページ一覧・編集権・端末記録の読込は互いを待たずに同時に始める"
  ).toBeLessThanOrEqual(Math.min(...parallelStartupSpans.map(span => span.endMs)));
  const resourcePreparation = startupSpan("note-resource-preparation");
  expect(resourcePreparation, "教材リソース準備を計測する").toBeTruthy();
  expect(resourcePreparation.startMs, "教材リソース準備はノート本体に依存するため取得後に始める")
    .toBeGreaterThanOrEqual(startupSpan("note-metadata").endMs);
  expect(resourcePreparation.startMs, "教材リソース準備はページ本文の読込より前に始める")
    .toBeLessThanOrEqual(startupSpan("page-content-json").startMs);
  await testInfo.attach("note-startup-metrics.json", {
    body: JSON.stringify(startupMetrics, null, 2),
    contentType: "application/json"
  });
  expect(blockedRequests).toEqual([]);
});

test("@authenticated PDF背景は再表示時に端末キャッシュを使いStorage再取得を待たない", async ({ page }) => {
  test.setTimeout(90_000);
  const blockedRequests = await guardProductionFirebase(page);
  const user = await createUser();
  const note = await seedReadyNote(user.uid, "背景キャッシュE2Eノート");
  await seedNotePageBackground(user.uid, note.noteId, note.pageId, {
    image: createRgbPng(1240, 1754),
    size: { width: 1240, height: 1754 }
  });
  await login(page, user);
  await page.goto(`/?firebaseEmulator=1&noteEditor=1&noteId=${note.noteId}&editorTabId=${crypto.randomUUID()}`, {
    waitUntil: "domcontentloaded"
  });
  await expect(page.locator("#noteEditorStartup")).toBeHidden({ timeout: 30_000 });
  await expect(page.locator("#notePageStage .note-background-image")).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const counters = globalThis.__noteEditorStartupMetrics?.counters || {};
    return Number(counters["resource-cache-writes"] || 0) +
      Number(counters["resource-idb-cache-hits"] || 0) +
      Number(counters["resource-cache-api-hits"] || 0);
  })).toBeGreaterThan(0);
  expect(await page.evaluate(() => globalThis.__noteEditorStartupMetrics.counters["resource-cache-write-failures"] || 0)).toBe(0);
  // The cache keeps a manifest of its images (key, size, time), so that
  // making room never reads every cached image.
  await expect.poll(() => page.evaluate(uid => new Promise(resolve => {
    const request = indexedDB.open("dentalQaNoteLocal", 2);
    request.onsuccess = () => {
      const database = request.result;
      const read = database.transaction("thumbnails", "readonly").objectStore("thumbnails").get(`${uid}|~note-resource-manifest`);
      read.onsuccess = () => {
        database.close();
        const manifest = read.result;
        resolve(manifest?.kind === "note-resource-manifest"
          ? manifest.entries.filter(entry => /\|resource-/.test(entry.key) && entry.blobSize > 0).length
          : 0);
      };
      read.onerror = () => { database.close(); resolve(-1); };
    };
    request.onerror = () => resolve(-1);
  }), user.uid), { timeout: 20_000 }).toBeGreaterThan(0);

  let storageRequests = 0;
  await page.route("**/v0/b/demo-dental-qa.firebasestorage.app/o**", route => {
    storageRequests += 1;
    return route.abort("failed");
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#noteEditorStartup")).toBeHidden({ timeout: 30_000 });
  await expect(page.locator("#notePageStage .note-background-image")).toBeVisible();
  expect(await page.evaluate(() => globalThis.__noteEditorStartupMetrics.counters["resource-cache-hits"] || 0)).toBeGreaterThan(0);
  expect(storageRequests, "再表示時はStorageへ背景を取りに行かない").toBe(0);
  expect(blockedRequests).toEqual([]);
});

test("@authenticated 教材画像のStorageパス差し替え後は永続背景キャッシュを更新する", async ({ page }) => {
  test.setTimeout(120_000);
  const blockedRequests = await guardProductionFirebase(page);
  const user = await createUser();
  const material = await seedOpenableMaterial(user.uid);
  await login(page, user);
  await page.locator("#newNoteBtn").click();
  await page.locator('[data-create-note="material"]').click();
  const editor = await openEditorPopup(page, () => page.locator("#noteMaterialPicker button", {
    hasText: "既定ノート更新E2E教材"
  }).click(), { blockedRequests });
  const background = editor.locator("#notePageStage .note-background-image");
  await expect(background).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => background.evaluate(image => image.naturalWidth)).toBe(1);
  await expect.poll(() => editor.evaluate(() => {
    const counters = globalThis.__noteEditorStartupMetrics?.counters || {};
    return Number(counters["resource-cache-writes"] || 0) +
      Number(counters["resource-idb-cache-hits"] || 0) +
      Number(counters["resource-cache-api-hits"] || 0);
  })).toBeGreaterThan(0);

  const replacementPath = `users/${user.uid}/imageMaterials/${material.materialId}/page-1-replacement.png`;
  const environment = await initializeTestEnvironment({
    projectId: "demo-dental-qa",
    firestore: { host: "127.0.0.1", port: 8080 },
    storage: { host: "127.0.0.1", port: 9199 }
  });
  try {
    const context = environment.authenticatedContext(user.uid);
    await uploadBytes(
      ref(context.storage("gs://demo-dental-qa.firebasestorage.app"), replacementPath),
      createRgbPng(2, 1),
      { contentType: "image/png" }
    );
    const materialsRef = doc(context.firestore(), "users", user.uid, "app", "pdfMaterials");
    const snapshot = await getDoc(materialsRef);
    await setDoc(materialsRef, {
      ...snapshot.data(),
      pdfMaterials: snapshot.data().pdfMaterials.map(item => item.id === material.materialId ? {
        ...item,
        pages: item.pages.map(source => Number(source.page) === 1 ? { ...source, imagePath: replacementPath } : source)
      } : item)
    });
  } finally {
    await environment.cleanup();
  }

  await editor.reload({ waitUntil: "domcontentloaded" });
  await expect(editor.locator("#noteEditorStartup")).toBeHidden({ timeout: 30_000 });
  await expect(background).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => background.evaluate(image => image.naturalWidth)).toBe(2);
  expect(await editor.evaluate(() => globalThis.__noteEditorStartupMetrics.counters["resource-cache-misses"] || 0)).toBeGreaterThan(0);
  expect(blockedRequests).toEqual([]);
});

test("@authenticated split未整備では大きい旧mainへfallbackしても許容時間内に専用エディタを開く", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const blockedRequests = await guardProductionFirebase(page);
  const user = await createUser();
  await login(page, user);
  // Seed after the normal login so this navigation cannot reuse material data
  // already applied by the full-app loader.
  const seeded = await seedLegacyLinkedMaterial(user.uid);

  const startedAt = Date.now();
  await page.goto(`/?firebaseEmulator=1&noteEditor=1&noteId=${seeded.noteId}&editorTabId=${crypto.randomUUID()}`, {
    waitUntil: "domcontentloaded"
  });
  await expect(page.locator("#noteEditorStartup")).toBeHidden({ timeout: 20_000 });
  const elapsedMs = Date.now() - startedAt;

  await testInfo.attach("legacy-main-fallback-timing.json", {
    body: JSON.stringify({
      elapsedMs,
      legacyPayloadBytes: seeded.legacyPayloadBytes,
      startupMetrics: await page.evaluate(() => globalThis.__noteEditorStartupMetrics)
    }, null, 2),
    contentType: "application/json"
  });
  await expect(page.locator("#noteTitleInput")).toHaveValue("旧形式fallback E2Eノート");
  await expect(page.locator("#cloudStatus")).toContainText("旧形式の教材データを読み込みました");
  expect(elapsedMs, "400 KiBのlegacy main fallbackを含む専用エディタ起動時間").toBeLessThan(10_000);
  expect(blockedRequests).toEqual([]);
});

test("@authenticated ページサムネイルはエディタready後に画面内のページだけ最大2件ずつ生成し、編集後は休止後に1回だけ作り直す", async ({ page }) => {
  test.setTimeout(90_000);
  const blockedRequests = await guardProductionFirebase(page);
  await page.addInitScript(() => {
    globalThis.__noteThumbnailMetrics = { active: 0, maxActive: 0, started: 0, completed: 0, startedBeforeReady: 0 };
    const originalToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function toBlob(callback, ...args) {
      const params = new URL(location.href).searchParams;
      if (params.get("noteEditor") !== "1") return originalToBlob.call(this, callback, ...args);
      const metrics = globalThis.__noteThumbnailMetrics;
      metrics.active += 1;
      metrics.started += 1;
      metrics.maxActive = Math.max(metrics.maxActive, metrics.active);
      if (document.getElementById("noteEditorStartup")?.dataset.state !== "ready") {
        metrics.startedBeforeReady += 1;
      }
      setTimeout(() => {
        originalToBlob.call(this, blob => {
          metrics.active -= 1;
          metrics.completed += 1;
          callback(blob);
        }, ...args);
      }, 80);
    };
  });
  const user = await createUser();
  const note = await seedReadyNote(user.uid, "サムネイルキューE2Eノート", { pageCount: 6 });
  await login(page, user);

  await page.goto(`/?firebaseEmulator=1&noteEditor=1&noteId=${note.noteId}&editorTabId=${crypto.randomUUID()}`, {
    waitUntil: "domcontentloaded"
  });
  await expect(page.locator("#noteEditorStartup")).toBeHidden({ timeout: 20_000 });
  await expect(page.locator("#notePageList > li")).toHaveCount(6);
  // Only the page list items on screen get thumbnails at first.
  await expect.poll(() => page.evaluate(() => globalThis.__noteEditorStartupMetrics.spans
    .some(span => span.name === "thumbnail-queue-drain")), { timeout: 20_000 }).toBe(true);
  const thumbnailDrain = await page.evaluate(() => globalThis.__noteEditorStartupMetrics.spans
    .find(span => span.name === "thumbnail-queue-drain"));
  expect(thumbnailDrain).toMatchObject({ status: "ok", details: { concurrency: 2, lazy: true, failed: 0 } });
  const firstShown = thumbnailDrain.details.expected;
  expect(firstShown).toBeGreaterThan(0);
  expect(firstShown).toBeLessThan(6);
  expect(thumbnailDrain.details.completed).toBe(firstShown);
  expect(await page.evaluate(() => globalThis.__noteThumbnailMetrics)).toMatchObject({
    started: firstShown,
    completed: firstShown,
    startedBeforeReady: 0
  });
  await expect(page.locator("#notePageList .note-page-thumbnail img")).toHaveCount(firstShown);

  // Scrolling the list makes the rest, still at most two at a time.
  await page.locator("#notePageList .note-page-thumbnail").last().scrollIntoViewIfNeeded();
  await expect.poll(() => page.evaluate(() => globalThis.__noteThumbnailMetrics.completed), { timeout: 20_000 }).toBe(6);
  await expect(page.locator("#notePageList .note-page-thumbnail img")).toHaveCount(6);
  expect(await page.evaluate(() => globalThis.__noteThumbnailMetrics)).toMatchObject({ maxActive: 2, started: 6 });

  // Three quick strokes redraw the edited page's thumbnail once, after the
  // pause (its list item is on screen again).
  await page.locator("#notePageList .note-page-thumbnail").first().scrollIntoViewIfNeeded();
  const stage = page.locator("#notePageStage");
  const box = await stage.boundingBox();
  for (let index = 0; index < 3; index += 1) {
    const y = box.y + box.height * (.2 + index * .05);
    await stage.dispatchEvent("pointerdown", { pointerId: 40 + index, pointerType: "mouse", button: 0, clientX: box.x + box.width * .2, clientY: y });
    await stage.dispatchEvent("pointermove", { pointerId: 40 + index, pointerType: "mouse", button: 0, pressure: .5, clientX: box.x + box.width * .5, clientY: y + 4 });
    await stage.dispatchEvent("pointerup", { pointerId: 40 + index, pointerType: "mouse", button: 0, clientX: box.x + box.width * .5, clientY: y + 4 });
  }
  await expect(stage.locator("[data-element-id]")).toHaveCount(3);
  await expect.poll(() => page.evaluate(() => globalThis.__noteThumbnailMetrics.completed), { timeout: 20_000 }).toBe(7);
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => globalThis.__noteThumbnailMetrics)).toMatchObject({ started: 7, completed: 7 });
  expect(blockedRequests).toEqual([]);
});

test("@authenticated 質問データの初期読込失敗に専用エディタは巻き込まれず通常画面では全状態を再読込する", async ({ page }) => {
  test.setTimeout(90_000);
  const blockedRequests = await guardProductionFirebase(page);
  const user = await createUser();
  const note = await seedReadyNote(user.uid, "初期読込失敗復旧E2Eノート");
  await seedBrokenQuestionManifest(user.uid);

  await page.goto("/?firebaseEmulator=1", { waitUntil: "domcontentloaded" });
  await page.locator("#tabBtnAuth").click();
  await page.locator("#emailInput").fill(user.email);
  await page.locator("#passwordInput").fill(user.password);
  await page.locator("#signInBtn").click();
  await expect(page.locator("#cloudStatus")).toContainText("クラウドデータの初期読込に失敗", { timeout: 20_000 });

  const editorTabId = crypto.randomUUID();
  await page.goto(`/?firebaseEmulator=1&noteEditor=1&noteId=${note.noteId}&editorTabId=${editorTabId}`, {
    waitUntil: "domcontentloaded"
  });
  await expect(page.locator("#noteEditorStartup")).toBeHidden({ timeout: 20_000 });
  await expect(page.locator("#noteTitleInput")).toHaveValue("初期読込失敗復旧E2Eノート");
  await expect(page.locator("#noteEditorView")).not.toHaveClass(/is-readonly/);
  await page.locator("#closeNoteBtn").click();
  await page.waitForURL(url => url.searchParams.get("noteEditor") !== "1", { timeout: 20_000 });
  await expect(page.locator("#cloudStatus")).toContainText("クラウドデータの初期読込に失敗", { timeout: 20_000 });
  expect(blockedRequests).toEqual([]);
});

test("@authenticated ノート一覧へ戻るは保存してから編集タブを閉じ、一覧タブに変更を反映する", async ({ page }) => {
  test.setTimeout(120_000);
  const blockedRequests = await guardProductionFirebase(page);
  const pageErrors = [];
  const onPageError = error => recordUnexpectedPageError(pageErrors, error);
  page.on("pageerror", onPageError);
  const user = await createUser();
  await login(page, user);
  const list = page;
  await list.locator("#newNoteBtn").click();
  await list.locator("#newNoteTitle").fill("タブを閉じるE2Eノート");
  let editor = await openEditorPopup(list, () => list.locator('[data-create-note="blank"]').click(), { blockedRequests, onPageError });
  const noteId = new URL(editor.url()).searchParams.get("noteId");

  // A stroke and a new title just before leaving: the tab closes only after
  // both are in the cloud.
  const stage = editor.locator("#notePageStage");
  await expect(stage).toHaveAttribute("data-tool", "pen");
  const box = await stage.boundingBox();
  await stage.dispatchEvent("pointerdown", { pointerId: 1, pointerType: "mouse", button: 0, clientX: box.x + box.width * .2, clientY: box.y + box.height * .1 });
  await stage.dispatchEvent("pointermove", { pointerId: 1, pointerType: "mouse", button: 0, pressure: .5, clientX: box.x + box.width * .5, clientY: box.y + box.height * .15 });
  await stage.dispatchEvent("pointerup", { pointerId: 1, pointerType: "mouse", button: 0, clientX: box.x + box.width * .5, clientY: box.y + box.height * .15 });
  await expect(stage.locator("[data-element-id]")).toHaveCount(1);
  await editor.locator("#noteTitleInput").fill("タブを閉じたE2Eノート");
  const editorClosed = editor.waitForEvent("close", { timeout: 20_000 });
  await editor.locator("#closeNoteBtn").click();
  await editorClosed;
  const saved = (await readNotes(user.uid)).notes.find(item => item.id === noteId);
  expect(saved.title).toBe("タブを閉じたE2Eノート");
  expect(saved.pages[0].contentRevision).toBeGreaterThan(0);
  // The browser shows the list tab again: it shows the note list (not the
  // creation screen the note was made from) with the change, without a reload.
  await list.bringToFront();
  await expect(list.locator("#noteListView")).toBeVisible();
  await expect(list.locator("#noteCreateView")).toBeHidden();
  await expect(list.locator("#noteList .note-card h4")).toHaveText(["タブを閉じたE2Eノート"], { timeout: 20_000 });
  expect(new URL(list.url()).searchParams.get("noteEditor")).toBeNull();

  // The save popover's "ノート一覧へ戻る" closes the tab the same way.
  editor = await openEditorPopup(list, () => list.locator(".note-card", { hasText: "タブを閉じたE2Eノート" })
    .getByRole("button", { name: "編集", exact: true }).click(), { blockedRequests, onPageError });
  await editor.locator("#noteSaveStatus").click();
  await expect(editor.locator("#noteSaveListBtn")).toBeVisible();
  const reopenedEditorClosed = editor.waitForEvent("close", { timeout: 20_000 });
  await editor.locator("#noteSaveListBtn").click();
  await reopenedEditorClosed;
  expect(list.isClosed()).toBe(false);
  expect(pageErrors).toEqual([]);
  expect(blockedRequests).toEqual([]);
});

test("@authenticated クラウド版を開いても端末下書きを送信せず後から復元コピーにできる", async ({ page }) => {
  test.setTimeout(90_000);
  const blockedRequests = await guardProductionFirebase(page);
  const user = await createUser();
  await login(page, user);
  await page.locator("#newNoteBtn").click();
  await page.locator("#newNoteTitle").fill("クラウド優先E2Eノート");
  page = await openEditorPopup(page, () => page.locator('[data-create-note="blank"]').click(), { blockedRequests });
  await page.waitForTimeout(750);

  const before = await readNotes(user.uid);
  const sourceNote = before.notes.find(item => item.title === "クラウド優先E2Eノート");
  const sourcePage = sourceNote.pages[0];
  const sourceAssetId = `asset-${crypto.randomUUID()}`;
  const localContent = {
    schemaVersion: 1,
    noteId: sourceNote.id,
    pageId: sourcePage.pageId,
    revision: 0,
    elements: [{
      id: crypto.randomUUID(),
      type: "stroke",
      points: [{ x: .15, y: .2, pressure: .5 }, { x: .75, y: .7, pressure: .5 }],
      style: { color: "#654321", widthRatio: .003, opacity: 1 },
      zIndex: 10
    }, {
      id: crypto.randomUUID(),
      type: "image",
      assetId: sourceAssetId,
      bounds: { x: .2, y: .25, width: .3, height: .3 },
      crop: { x: 0, y: 0, width: 1, height: 1 },
      rotation: 0,
      opacity: 1,
      locked: false,
      zIndex: 11
    }],
    noteMasks: [],
    savedAt: ""
  };
  await seedPendingPageDraft(page, {
    uid: user.uid,
    noteId: sourceNote.id,
    pageId: sourcePage.pageId,
    content: localContent,
    expectedRevision: 0
  });
  await seedPendingAsset(page, {
    uid: user.uid,
    noteId: sourceNote.id,
    pageId: sourcePage.pageId,
    assetId: sourceAssetId,
    bytes: TEST_PNG
  });
  await expect.poll(() => localNoteStoreCounts(page)).toMatchObject({ pendingAssets: 1, pageDrafts: 1, pendingSaves: 1 });

  await page.evaluate(() => document.querySelector('[data-startup-action="cloud"]').click());
  await expect(page.locator("#noteEditorStartup")).toBeHidden({ timeout: 20_000 });
  await expect(page.locator("#notePageStage path[data-element-id]")).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForTimeout(750);
  await expect.poll(() => localNoteStoreCounts(page)).toEqual({
    pendingAssets: 1,
    pageDrafts: 1,
    pendingSaves: 1,
    conflicts: 0
  });
  const cloudOnly = await readNotes(user.uid);
  expect(cloudOnly.notes.find(item => item.id === sourceNote.id).pages[0].contentRevision).toBe(0);
  expect(await readNoteAssets(user.uid, sourceNote.id)).toHaveLength(0);

  await page.locator("#noteSaveStatus").click();
  const restore = page.locator("#noteRestoreLocalDraftBtn");
  await expect(restore).toBeVisible();
  await restore.click();
  await page.waitForURL(url => url.searchParams.get("noteId") !== sourceNote.id, { timeout: 30_000 });
  await expect(page.locator("#noteEditorStartup")).toBeHidden({ timeout: 30_000 });
  await expect(page.locator("#notePageStage path[data-element-id]")).toHaveCount(1);
  await expect(page.locator("#notePageStage .note-image-element img")).toHaveCount(1);
  await expect.poll(() => localNoteStoreCounts(page)).toEqual({
    pendingAssets: 0,
    pageDrafts: 0,
    pendingSaves: 0,
    conflicts: 0
  });
  const recovered = await readNotes(user.uid);
  expect(recovered.notes.some(note => note.status === "ready" && note.title === "クラウド優先E2Eノート（復元コピー）")).toBe(true);
  expect(blockedRequests).toEqual([]);
});

test("@authenticated 削除済みノートの端末下書きを一覧から新規ノートへ復元する", async ({ page }) => {
  test.setTimeout(90_000);
  const blockedRequests = await guardProductionFirebase(page);
  const dialogs = [];
  const onDialog = dialog => { dialogs.push(`${dialog.type()}: ${dialog.message()}`); return dialog.accept(); };
  page.on("dialog", onDialog);
  const user = await createUser();
  await login(page, user);
  await page.locator("#newNoteBtn").click();
  await page.locator("#newNoteTitle").fill("孤立下書きE2Eノート");
  page = await openEditorPopup(page, () => page.locator('[data-create-note="blank"]').click(), { blockedRequests, onDialog });

  const before = await readNotes(user.uid);
  const sourceNote = before.notes.find(item => item.title === "孤立下書きE2Eノート");
  const sourcePage = sourceNote.pages[0];
  const sourceBackgroundPath = await seedNotePageBackground(user.uid, sourceNote.id, sourcePage.pageId);
  const sourceAssetId = `asset-${crypto.randomUUID()}`;
  const content = {
    schemaVersion: 1,
    noteId: sourceNote.id,
    pageId: sourcePage.pageId,
    revision: 0,
    elements: [{
      id: crypto.randomUUID(),
      type: "stroke",
      points: [{ x: .1, y: .2, pressure: .5 }, { x: .8, y: .7, pressure: .5 }],
      style: { color: "#123456", widthRatio: .003, opacity: 1 },
      zIndex: 10
    }, {
      id: crypto.randomUUID(),
      type: "image",
      assetId: sourceAssetId,
      bounds: { x: .2, y: .25, width: .3, height: .3 },
      crop: { x: 0, y: 0, width: 1, height: 1 },
      rotation: 0,
      opacity: 1,
      locked: false,
      zIndex: 11
    }],
    noteMasks: [],
    savedAt: ""
  };
  await seedPendingPageDraft(page, {
    uid: user.uid,
    noteId: sourceNote.id,
    pageId: sourcePage.pageId,
    content,
    expectedRevision: 0
  });
  await seedPendingAsset(page, {
    uid: user.uid,
    noteId: sourceNote.id,
    pageId: sourcePage.pageId,
    assetId: sourceAssetId,
    bytes: TEST_PNG
  });
  await updateNoteRoot(user.uid, sourceNote.id, {
    deletedAt: new Date().toISOString(),
    deletedReason: "user"
  });

  await page.goto("/?firebaseEmulator=1", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#authStatus")).toContainText(user.email, { timeout: 20_000 });
  await page.locator("#tabBtnPdf").click();
  await page.locator("#noteModeBtn").click();
  const recoveryCard = page.locator(".note-recovery-card");
  await expect(recoveryCard).toContainText("一覧にないノートの未保存下書き", { timeout: 20_000 });
  try {
    page = await openEditorPopup(page, () => recoveryCard.getByRole("button", { name: "新規ノートとして復元" }).click(), {
      blockedRequests, onDialog
    });
  } catch (error) {
    throw new Error(`${error.message}\nDialogs: ${dialogs.join(" | ")}`);
  }
  await expect(page.locator("#notePageStage path[data-element-id]")).toHaveCount(1);
  await expect.poll(() => localNoteStoreCounts(page)).toEqual({
    pendingAssets: 0,
    pageDrafts: 0,
    pendingSaves: 0,
    conflicts: 0
  });
  const after = await readNotes(user.uid);
  const recovered = after.notes.find(note => note.status === "ready" && note.title === "孤立下書きE2Eノート（復元コピー）");
  expect(recovered).toBeTruthy();
  expect(recovered.id).not.toBe(sourceNote.id);
  expect(recovered.recoveredFromNoteId).toBe(sourceNote.id);
  expect(recovered.pages[0].pageId).not.toBe(sourcePage.pageId);
  expect(recovered.pages[0].contentRevision).toBe(1);
  expect(recovered.pages[0].contentPath).toContain(`/notes/${recovered.id}/pages/${recovered.pages[0].pageId}/`);
  expect(recovered.pages[0].background.type).toBe("pdf-source-page");
  expect(recovered.pages[0].background.imagePath).not.toBe(sourceBackgroundPath);
  expect(recovered.pages[0].background.imagePath).toContain(`/notes/${recovered.id}/sourcePages/${recovered.pages[0].pageId}/`);
  const recoveredAssets = await readNoteAssets(user.uid, recovered.id);
  expect(recoveredAssets).toHaveLength(1);
  expect(recoveredAssets[0].assetId).not.toBe(sourceAssetId);
  expect(recoveredAssets[0].storagePath).toContain(`/notes/${recovered.id}/assets/${recoveredAssets[0].assetId}/`);
  await deleteTestStorageObject(user.uid, sourceBackgroundPath);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#noteEditorStartup")).toBeHidden({ timeout: 20_000 });
  await expect(page.locator("#notePageStage .note-background-image")).toBeVisible();
  await expect(page.locator("#notePageStage path[data-element-id]")).toHaveCount(1);
  await expect(page.locator("#notePageStage .note-image-element img")).toHaveCount(1);
  const copiedImage = await page.locator("#notePageStage .note-image-element").getAttribute("data-element-id");
  expect(copiedImage).toBeTruthy();
  expect(blockedRequests).toEqual([]);
});

test("@authenticated 教材背景の復元コピーは教材削除後も独立して再読込できる", async ({ page }) => {
  test.setTimeout(120_000);
  const blockedRequests = await guardProductionFirebase(page);
  const dialogs = [];
  const onDialog = dialog => { dialogs.push(`${dialog.type()}: ${dialog.message()}`); return dialog.accept(); };
  page.on("dialog", onDialog);
  const user = await createUser();
  const material = await seedOpenableMaterial(user.uid);
  await login(page, user);

  await page.locator("#newNoteBtn").click();
  await page.locator('[data-create-note="material"]').click();
  const sourceEditor = await openEditorPopup(page, () => page.locator("#noteMaterialPicker button", {
    hasText: "既定ノート更新E2E教材"
  }).click(), { blockedRequests });
  page = sourceEditor;
  page.on("dialog", onDialog);

  const before = await readNotes(user.uid);
  const sourceNote = before.notes.find(item => item.sourceMaterialId === material.materialId && !item.deletedAt);
  expect(sourceNote).toBeTruthy();
  const sourcePage = sourceNote.pages[0];
  const content = {
    schemaVersion: 1,
    noteId: sourceNote.id,
    pageId: sourcePage.pageId,
    revision: 0,
    elements: [{
      id: crypto.randomUUID(),
      type: "stroke",
      points: [{ x: .15, y: .2, pressure: .5 }, { x: .7, y: .65, pressure: .5 }],
      style: { color: "#234567", widthRatio: .003, opacity: 1 },
      zIndex: 10
    }],
    noteMasks: [],
    savedAt: ""
  };
  await seedPendingPageDraft(page, {
    uid: user.uid,
    noteId: sourceNote.id,
    pageId: sourcePage.pageId,
    content,
    expectedRevision: 0
  });
  await updateNoteRoot(user.uid, sourceNote.id, {
    deletedAt: new Date().toISOString(),
    deletedReason: "user"
  });

  await page.goto("/?firebaseEmulator=1", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#authStatus")).toContainText(user.email, { timeout: 20_000 });
  await page.locator("#tabBtnPdf").click();
  await page.locator("#noteModeBtn").click();
  const recoveryCard = page.locator(".note-recovery-card");
  await expect(recoveryCard).toBeVisible({ timeout: 20_000 });
  try {
    page = await openEditorPopup(page, () => recoveryCard.getByRole("button", { name: "新規ノートとして復元" }).click(), {
      blockedRequests,
      onDialog
    });
  } catch (error) {
    throw new Error(`${error.message}\nDialogs: ${dialogs.join(" | ")}`);
  }
  await expect(page.locator("#notePageStage .note-background-image")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#notePageStage path[data-element-id]")).toHaveCount(1);

  const recoveredState = await readNotes(user.uid);
  const recovered = recoveredState.notes.find(item => item.status === "ready" && item.recoveredFromNoteId === sourceNote.id);
  expect(recovered).toBeTruthy();
  expect(recovered.type).toBe("standalone");
  expect(recovered.defaultBackground?.type).toBe("blank");
  expect(recovered.pages[0].background.type).toBe("pdf-source-page");
  expect(recovered.pages[0].background.imagePath).toContain(`/notes/${recovered.id}/sourcePages/${recovered.pages[0].pageId}/`);
  expect(recovered.pages[0].background.imagePath).not.toBe(material.imagePath);

  const environment = await initializeTestEnvironment({
    projectId: "demo-dental-qa",
    firestore: { host: "127.0.0.1", port: 8080 }
  });
  try {
    const db = environment.authenticatedContext(user.uid).firestore();
    const reference = doc(db, "users", user.uid, "app", "pdfMaterials");
    const snapshot = await getDoc(reference);
    await setDoc(reference, { ...snapshot.data(), pdfMaterials: [] });
  } finally {
    await environment.cleanup();
  }
  await deleteTestStorageObject(user.uid, material.imagePath);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#noteEditorStartup")).toBeHidden({ timeout: 20_000 });
  await expect(page.locator("#notePageStage .note-background-image")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#notePageStage path[data-element-id]")).toHaveCount(1);
  expect(blockedRequests).toEqual([]);
});

test("@authenticated 画像アップロード中にページを切り替えても元ページへ保存する", async ({ page }) => {
  test.setTimeout(90_000);
  const blockedRequests = await guardProductionFirebase(page);
  const user = await createUser();
  await login(page, user);
  await page.locator("#newNoteBtn").click();
  await page.locator("#newNoteTitle").fill("画像ページ固定E2Eノート");
  page = await openEditorPopup(page, () => page.locator('[data-create-note="blank"]').click(), { blockedRequests });

  let releaseUpload;
  let uploadStarted;
  const uploadGate = new Promise(resolve => { releaseUpload = resolve; });
  const uploadStartedPromise = new Promise(resolve => { uploadStarted = resolve; });
  await page.route("**/v0/b/demo-dental-qa.firebasestorage.app/o**", async route => {
    const request = route.request();
    const objectName = new URL(request.url()).searchParams.get("name") || "";
    if (["POST", "PUT"].includes(request.method()) && objectName.includes("/notes/") && objectName.includes("/assets/")) {
      uploadStarted();
      await uploadGate;
    }
    await route.continue();
  });

  await page.locator("#noteImageFileInput").setInputFiles({
    name: "delayed.png",
    mimeType: "image/png",
    buffer: TEST_PNG
  });
  await uploadStartedPromise;
  await expect.poll(() => localNoteStoreCounts(page)).toMatchObject({ pendingAssets: 1, pageDrafts: 1, pendingSaves: 1 });
  await openPageSidebar(page);
  await page.locator('[data-page-action="add-ruled"]').click();
  await expect(page.locator("#notePageCounter")).toHaveText("2 / 2");

  releaseUpload();
  await expect.poll(() => localNoteStoreCounts(page), { timeout: 20_000 }).toEqual({ pendingAssets: 0, pageDrafts: 0, pendingSaves: 0, conflicts: 0 });
  await page.unroute("**/v0/b/demo-dental-qa.firebasestorage.app/o**");
  const stored = await readNotes(user.uid);
  const note = stored.notes.find(item => item.title === "画像ページ固定E2Eノート");
  const firstPage = note.pages.find(item => item.order === 1);
  const secondPage = note.pages.find(item => item.order === 2);
  expect(firstPage.contentRevision).toBeGreaterThan(0);
  expect(secondPage.contentRevision).toBe(0);

  await openPageSidebar(page);
  await page.locator("#notePageList li").first().locator("button").first().click();
  await expect(page.locator("#notePageCounter")).toHaveText("1 / 2");
  await expect(page.locator("#notePageStage .note-image-element")).toHaveCount(1);
  expect(blockedRequests).toEqual([]);
});

test("@authenticated 同じ教材を2画面で同時に開いても既定ノートは1件だけ作る", async ({ page }) => {
  test.setTimeout(120_000);
  const blockedRequests = await guardProductionFirebase(page);
  const secondPage = await page.context().newPage();
  const secondBlockedRequests = await guardProductionFirebase(secondPage);
  let firstEditor = null;
  let secondEditor = null;
  const user = await createUser();
  const material = await seedOpenableMaterial(user.uid);

  try {
    // The assertion below targets concurrent material-note creation.  Let the
    // first tab finish the legacy app-wide initial sync before the second tab
    // signs in, otherwise two fresh-user bootstrap writes can trip the
    // unrelated app-wide revision guard before either material action starts.
    await login(page, user);
    // Both pages share one browser context, so Firebase Auth already persists
    // the first page's session. Loading the second page and signing in again
    // can restart its initial cloud sync while the persisted session is still
    // settling, leaving the non-auth tabs intentionally locked.
    await secondPage.goto("/?firebaseEmulator=1", { waitUntil: "domcontentloaded" });
    await expect(secondPage.locator("#authStatus")).toContainText(user.email, { timeout: 20_000 });
    await expect(secondPage.locator("#localEnvironmentBanner")).toBeVisible();
    await openNoteList(secondPage);
    await Promise.all([
      page.locator("#newNoteBtn").click(),
      secondPage.locator("#newNoteBtn").click()
    ]);
    await Promise.all([
      page.locator('[data-create-note="material"]').click(),
      secondPage.locator('[data-create-note="material"]').click()
    ]);

    const firstMaterialButton = page.locator("#noteMaterialPicker button", { hasText: "既定ノート更新E2E教材" });
    const secondMaterialButton = secondPage.locator("#noteMaterialPicker button", { hasText: "既定ノート更新E2E教材" });
    [firstEditor, secondEditor] = await Promise.all([
      openEditorPopup(page, () => firstMaterialButton.click(), { blockedRequests }),
      openEditorPopup(secondPage, () => secondMaterialButton.click(), { blockedRequests: secondBlockedRequests })
    ]);
    await Promise.all([
      expect(firstEditor.locator("#noteEditorView")).toBeVisible(),
      expect(secondEditor.locator("#noteEditorView")).toBeVisible()
    ]);

    const stored = await readNotes(user.uid);
    const linkedNotes = stored.notes.filter(note => note.sourceMaterialId === material.materialId);
    expect(linkedNotes).toHaveLength(1);
    expect(linkedNotes[0]).toMatchObject({
      id: material.defaultNoteId,
      status: "ready",
      createdPageCount: 1,
      pageCount: 1
    });
    expect(linkedNotes[0].pages).toHaveLength(1);
    expect(blockedRequests).toEqual([]);
    expect(secondBlockedRequests).toEqual([]);
  } finally {
    await firstEditor?.close().catch(() => {});
    await secondEditor?.close().catch(() => {});
    await secondPage.close();
  }
});

test("@authenticated 既定ノートの作成失敗記録がある場合は同じSagaで再作成する", async ({ page }) => {
  test.setTimeout(120_000);
  const blockedRequests = await guardProductionFirebase(page);
  const user = await createUser();
  const material = await seedOpenableMaterial(user.uid);
  await seedNoteRoot(user.uid, material.defaultNoteId, {
    schemaVersion: 1,
    title: "作成失敗した既定ノート",
    type: "material-linked",
    sourceMaterialId: material.materialId,
    materialRefs: [material.materialId],
    status: "failed",
    pageCount: 0,
    createdPageCount: 0,
    pendingStoragePaths: [],
    orderRevision: 0,
    deletedAt: null
  });
  await login(page, user);

  await page.locator("#newNoteBtn").click();
  await page.locator('[data-create-note="material"]').click();
  page = await openEditorPopup(page, () => page.locator("#noteMaterialPicker button", { hasText: "既定ノート更新E2E教材" }).click(), {
    blockedRequests
  });
  await expect(page.locator("#notePageCounter")).toHaveText("1 / 1");

  const stored = await readNotes(user.uid);
  const recreated = stored.notes.find(note => note.id === material.defaultNoteId);
  expect(recreated).toMatchObject({ status: "ready", createdPageCount: 1, pageCount: 1 });
  expect(recreated.pages).toHaveLength(1);
  expect(blockedRequests).toEqual([]);
});

test("@authenticated ユーザー削除済みノートがあってもページ数変更後は新しい教材既定ノートを作る", async ({ page }) => {
  test.setTimeout(120_000);
  const blockedRequests = await guardProductionFirebase(page);
  const onDialog = async dialog => { await dialog.accept(); };
  page.on("dialog", onDialog);
  const user = await createUser();
  const material = await seedOpenableMaterial(user.uid);
  await login(page, user);

  await page.locator("#newNoteBtn").click();
  await page.locator('[data-create-note="material"]').click();
  const firstEditor = await openEditorPopup(page, () => page.locator("#noteMaterialPicker button", { hasText: "既定ノート更新E2E教材" }).click(), {
    blockedRequests, onDialog
  });
  await expect(firstEditor.locator("#notePageCounter")).toHaveText("1 / 1");
  const firstState = await readNotes(user.uid);
  const firstNote = firstState.notes.find(item => item.sourceMaterialId === material.materialId && !item.deletedAt);
  expect(firstNote).toBeTruthy();
  expect(firstNote.id).toBe(material.defaultNoteId);

  await firstEditor.close();
  await updateNoteRoot(user.uid, firstNote.id, {
    deletedAt: new Date().toISOString(),
    deletedReason: "user",
    deletedMaterialRefs: []
  });

  // The dedicated editor and the list tab each load the app-wide split state.
  // Reload the remaining tab after closing the editor so a late, already
  // queued settings save from the closed tab cannot make this replacement
  // fixture look like a genuine second-device revision conflict.
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#authStatus")).toContainText(user.email, { timeout: 20_000 });
  await openNoteList(page);

  await page.locator("#pdfEditModeBtn").click();
  const materialRow = page.locator('#pdfEditTableBody tr:has-text("既定ノート更新E2E教材")');
  await materialRow.locator("[data-edit-pdf]").click();
  await page.locator("#pdfFileInput").setInputFiles([
    { name: "replacement-1.png", mimeType: "image/png", buffer: TEST_PNG },
    { name: "replacement-2.png", mimeType: "image/png", buffer: TEST_PNG }
  ]);
  await page.locator("#updatePdfBtn").click();
  await expect(page.locator("#pdfEditStatus")).toContainText("教材情報と画像を更新しました", { timeout: 30_000 });

  const replacedMaterialState = await readNotes(user.uid);
  const replacedMaterial = replacedMaterialState.pdfMaterials.find(item => item.id === material.materialId);
  expect(replacedMaterial.defaultNoteId).not.toBe(firstNote.id);
  expect(replacedMaterial.pages).toHaveLength(2);
  const archivedNote = replacedMaterialState.notes.find(item => item.id === firstNote.id);
  expect(archivedNote.deletedReason).toBe("material-replaced");

  const replacementEditor = await openEditorPopup(page, () => materialRow.locator("[data-open-note]").click(), {
    blockedRequests, onDialog
  });
  await expect(replacementEditor.locator("#notePageCounter")).toHaveText("1 / 2");

  const replacedState = await readNotes(user.uid);
  const linkedNotes = replacedState.notes.filter(item => item.sourceMaterialId === material.materialId);
  expect(linkedNotes).toHaveLength(2);
  const newNote = linkedNotes.find(item => !item.deletedAt);
  expect(newNote.id).toBe(replacedMaterial.defaultNoteId);
  expect(newNote.pages).toHaveLength(2);
  expect(linkedNotes.find(item => item.id === firstNote.id)?.deletedReason).toBe("material-replaced");
  expect(blockedRequests).toEqual([]);
});

test("@authenticated 競合直後にクラウド版または競合コピーを選べ、古い競合キューを再送しない", async ({ page }) => {
  test.setTimeout(90_000);
  const blockedRequests = await guardProductionFirebase(page);
  const onDialog = async dialog => {
    if (dialog.message().includes("ローカル版を競合コピー")) await dialog.dismiss();
    else if (dialog.type() === "prompt" && dialog.message().includes("ノートを閉じる操作")) await dialog.accept("continue");
    else await dialog.accept();
  };
  page.on("dialog", onDialog);
  const user = await createUser();
  await login(page, user);
  await page.locator("#newNoteBtn").click();
  await page.locator("#newNoteTitle").fill("競合破棄E2Eノート");
  page = await openEditorPopup(page, () => page.locator('[data-create-note="blank"]').click(), {
    blockedRequests, onDialog
  });
  const stage = page.locator("#notePageStage");
  const box = await stage.boundingBox();
  expect(box).toBeTruthy();

  const drawStroke = async (pointerId, yOffset) => {
    await stage.dispatchEvent("pointerdown", { pointerId, pointerType: "mouse", button: 0, clientX: box.x + box.width * .2, clientY: box.y + box.height * yOffset });
    await stage.dispatchEvent("pointermove", { pointerId, pointerType: "mouse", button: 0, pressure: .5, clientX: box.x + box.width * .5, clientY: box.y + box.height * (yOffset + .05) });
    await stage.dispatchEvent("pointerup", { pointerId, pointerType: "mouse", button: 0, clientX: box.x + box.width * .5, clientY: box.y + box.height * (yOffset + .05) });
  };
  await drawStroke(31, .1);
  await expect(page.locator("#notePageStage [data-element-id]")).toHaveCount(1);
  await expect.poll(async () => {
    const stored = await readNotes(user.uid);
    return stored.notes.find(item => item.title === "競合破棄E2Eノート")?.pages[0]?.contentRevision || 0;
  }, { timeout: 20_000 }).toBe(1);
  const initial = await readNotes(user.uid);
  const note = initial.notes.find(item => item.title === "競合破棄E2Eノート");
  const notePage = note.pages[0];
  expect(notePage.contentRevision).toBe(1);

  await updateNotePage(user.uid, note.id, notePage.pageId, {
    contentRevision: 2,
    lastWriterSessionId: "external-writer-session",
    lastClientInstanceId: "external-client",
    lastClientMutationId: "external-mutation"
  });
  await drawStroke(32, .25);
  await expect(page.locator("#noteSaveStatus")).toHaveAttribute("data-state", "conflict", { timeout: 20_000 });
  await expect.poll(() => localNoteStoreCounts(page)).toMatchObject({ pageDrafts: 1, pendingSaves: 1, conflicts: 1 });
  await expect(stage.locator("[data-element-id]")).toHaveCount(2);
  await expect(page.locator("#noteBackgroundBtn")).toBeDisabled();
  await openPageSidebar(page);
  await expect(page.locator("#notePageList .note-page-row-actions button").first()).toBeDisabled();
  await page.locator("#noteUndoBtn").click();
  await expect(stage.locator("[data-element-id]")).toHaveCount(2);
  await page.locator('#notePageConflictBanner [data-conflict-action="cloud"]').click();
  await expect.poll(() => localNoteStoreCounts(page)).toEqual({ pendingAssets: 0, pageDrafts: 0, pendingSaves: 0, conflicts: 0 });
  await expect(stage.locator("[data-element-id]")).toHaveCount(1);

  await updateNotePage(user.uid, note.id, notePage.pageId, {
    contentRevision: 3,
    lastWriterSessionId: "second-external-writer-session",
    lastClientInstanceId: "second-external-client",
    lastClientMutationId: "second-external-mutation"
  });
  await drawStroke(33, .4);
  await expect(page.locator("#noteSaveStatus")).toHaveAttribute("data-state", "conflict", { timeout: 20_000 });
  await expect.poll(() => localNoteStoreCounts(page)).toMatchObject({ pageDrafts: 1, pendingSaves: 1, conflicts: 1 });
  await page.locator('#notePageConflictBanner [data-conflict-action="copy"]').click();
  await expect.poll(() => localNoteStoreCounts(page)).toEqual({ pendingAssets: 0, pageDrafts: 0, pendingSaves: 0, conflicts: 0 });
  await expect.poll(async () => {
    const stored = await readNotes(user.uid);
    return stored.notes.some(item => item.title.includes("競合コピー") && item.status === "ready");
  }, { timeout: 20_000 }).toBe(true);

  await page.close();
  await new Promise(resolve => setTimeout(resolve, 1200));
  const after = await readNotes(user.uid);
  expect(after.notes.find(item => item.id === note.id)?.pages[0]?.contentRevision).toBe(3);
  expect(blockedRequests).toEqual([]);
});

test("@authenticated 2本指ピンチ中は描画や1本指パンを開始しない", async ({ page }) => {
  test.setTimeout(90_000);
  const user = await createUser();
  await login(page, user);
  await page.locator("#newNoteBtn").click();
  await page.locator("#newNoteTitle").fill("ピンチ排他E2Eノート");
  page = await openEditorPopup(page, () => page.locator('[data-create-note="blank"]').click());
  const stage = page.locator("#notePageStage");
  const viewport = page.locator("#noteViewport");
  const box = await stage.boundingBox();
  expect(box).toBeTruthy();
  const point = (x, y) => ({ clientX: box.x + box.width * x, clientY: box.y + box.height * y });
  await page.locator('[data-note-tool="pan"]').click();
  const initialScrollTop = await viewport.evaluate(node => {
    node.scrollTop = Math.min(240, node.scrollHeight - node.clientHeight);
    return node.scrollTop;
  });
  await stage.dispatchEvent("pointerdown", { pointerId: 81, pointerType: "touch", button: 0, ...point(.3, .3), width: 8, height: 8 });
  await stage.dispatchEvent("pointermove", { pointerId: 81, pointerType: "touch", button: 0, ...point(.3, .2), width: 8, height: 8 });
  await expect.poll(() => viewport.evaluate(node => node.scrollTop)).not.toBe(initialScrollTop);
  await stage.dispatchEvent("pointerdown", { pointerId: 82, pointerType: "touch", button: 0, ...point(.7, .65), width: 8, height: 8 });
  await expect.poll(() => viewport.evaluate(node => node.scrollTop)).toBe(initialScrollTop);
  await stage.dispatchEvent("pointermove", { pointerId: 82, pointerType: "touch", button: 0, ...point(.86, .78), width: 8, height: 8 });
  await stage.dispatchEvent("pointerup", { pointerId: 82, pointerType: "touch", button: 0, ...point(.86, .78), width: 8, height: 8 });
  await stage.dispatchEvent("pointerup", { pointerId: 81, pointerType: "touch", button: 0, ...point(.3, .3), width: 8, height: 8 });
  await expect(stage.locator("[data-element-id]")).toHaveCount(0);
  await expect.poll(() => stage.evaluate(node => node.style.transform)).toContain("scale(");
  expect(Number(await stage.evaluate(node => getComputedStyle(node).getPropertyValue("--page-zoom")))).toBeGreaterThan(1);
});

test("@authenticated ページ追加・並び替え・削除はorderRevision競合を検出し、再読込後に再試行できる", async ({ page }) => {
  test.setTimeout(90_000);
  const dialogs = [];
  const onDialog = async dialog => {
    dialogs.push(dialog.message());
    await dialog.accept();
  };
  page.on("dialog", onDialog);
  const user = await createUser();
  await login(page, user);
  await page.locator("#newNoteBtn").click();
  await page.locator("#newNoteTitle").fill("ページ競合E2Eノート");
  page = await openEditorPopup(page, () => page.locator('[data-create-note="blank"]').click(), { onDialog });
  const [{ id: noteId }] = (await readNotes(user.uid)).notes;

  await updateNoteRoot(user.uid, noteId, { orderRevision: 2 });
  await openPageSidebar(page);
  await page.locator('[data-page-action="add-ruled"]').click();
  await expect.poll(() => dialogs.some(message => message.includes("別の端末でページ順が変更"))).toBe(true);
  await expect(page.locator("#notePageCounter")).toHaveText("1 / 1");

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#authStatus")).toContainText(user.email, { timeout: 20_000 });
  await openPageSidebar(page);
  await page.locator('[data-page-action="add-ruled"]').click();
  await expect(page.locator("#notePageCounter")).toHaveText("2 / 2");

  const pagesBeforeReorder = (await readNotes(user.uid)).notes[0].pages.sort((a, b) => a.order - b.order);
  await updateNoteRoot(user.uid, noteId, { orderRevision: 4 });
  await openPageSidebar(page);
  await page.locator("#notePageList .note-page-row-actions").nth(1).getByRole("button", { name: "↑" }).click();
  await expect.poll(() => dialogs.filter(message => message.includes("別の端末でページ順が変更")).length).toBe(2);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#authStatus")).toContainText(user.email, { timeout: 20_000 });
  await openPageSidebar(page);
  await page.locator("#notePageList .note-page-row-actions").nth(1).getByRole("button", { name: "↑" }).click();
  await expect.poll(async () => {
    const note = (await readNotes(user.uid)).notes.find(item => item.id === noteId);
    return note.pages.sort((a, b) => a.order - b.order)[0].pageId;
  }).toBe(pagesBeforeReorder[1].pageId);

  await updateNoteRoot(user.uid, noteId, { orderRevision: 6 });
  await openPageSidebar(page);
  await page.locator("#notePageList .note-page-row-actions").nth(1).getByRole("button", { name: "削除" }).click();
  await expect.poll(() => dialogs.filter(message => message.includes("別の端末でページ順が変更")).length).toBe(3);
  await expect(page.locator("#notePageCounter")).toHaveText("2 / 2");

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#authStatus")).toContainText(user.email, { timeout: 20_000 });
  await openPageSidebar(page);
  await page.locator("#notePageList .note-page-row-actions").nth(1).getByRole("button", { name: "削除" }).click();
  await expect(page.locator("#notePageCounter")).toHaveText("1 / 1");
});

test("@authenticated @ipad-v-next PDFを教材へ追加せずノート専用Storage背景として順番どおり作成する", async ({ page }) => {
  test.setTimeout(120_000);
  const blockedRequests = await guardProductionFirebase(page);
  const pageErrors = [];
  const dialogs = [];
  const onPageError = error => recordUnexpectedPageError(pageErrors, error);
  const onDialog = async dialog => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  };
  page.on("pageerror", onPageError);
  page.on("dialog", onDialog);
  const user = await createUser();
  await login(page, user);
  const fixture = await createPdfFixture({ pageCount: 2 });

  await page.locator("#newNoteBtn").click();
  const createPopupPromise = page.waitForEvent("popup", { timeout: 120_000 });
  await page.locator('[data-create-note="pdf"]').click();
  page = await createPopupPromise;
  await guardProductionFirebase(page, blockedRequests);
  page.on("pageerror", onPageError);
  page.on("dialog", onDialog);
  await page.waitForURL(url => url.searchParams.get("noteEditor") === "1" && url.searchParams.get("create") === "pdf", { timeout: 120_000 });
  await expect(page.locator("#noteCreateView")).toBeVisible();
  await expect(page.locator("#authStatus")).toContainText(user.email, { timeout: 20_000 });
  await page.locator("#newNoteTitle").fill("E2E PDFノート");
  const fileChooserPromise = page.waitForEvent("filechooser");
  await page.locator('[data-create-note="pdf"]').click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles({ name: "two-pages.pdf", mimeType: "application/pdf", buffer: fixture });
  await expect.poll(() => dialogs.length > 0 || new URL(page.url()).searchParams.has("noteId"), {
    timeout: 30_000,
    message: "PDF変換は編集URLへ遷移するか、具体的な作成エラーを返す"
  }).toBe(true);
  expect(dialogs).toEqual([]);
  await page.waitForURL(url => url.searchParams.get("noteEditor") === "1" && Boolean(url.searchParams.get("noteId")), { timeout: 120_000 });
  await expect(page.locator("#noteEditorView")).toBeVisible({ timeout: 120_000 });
  await expect(page.locator("#notePageCounter")).toHaveText("1 / 2");
  await expect(page.locator("#notePageStage .note-background-image")).toBeVisible({ timeout: 20_000 });

  const stored = await readNotes(user.uid);
  expect(stored.notes).toHaveLength(1);
  expect(stored.notes[0]).toMatchObject({ type: "pdf-imported", status: "ready", pageCount: 2 });
  expect(stored.notes[0].pendingStoragePaths || []).toEqual([]);
  expect(stored.notes[0].pages.sort((a, b) => a.order - b.order).map(item => item.background.sourcePageNumber)).toEqual([1, 2]);
  for (const storedPage of stored.notes[0].pages) {
    expect(storedPage.background.imagePath).toContain(`users/${user.uid}/notes/${stored.notes[0].id}/sourcePages/`);
  }
  expect(stored.pdfMaterials).toHaveLength(0);
  expect(blockedRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test("@authenticated PDFノート作成中にページ画像の保存が失敗したら開始済みの画像を全て消して失敗を記録する", async ({ page }) => {
  test.setTimeout(120_000);
  const blockedRequests = await guardProductionFirebase(page);
  const pageErrors = [];
  const onPageError = error => recordUnexpectedPageError(pageErrors, error);
  page.on("pageerror", onPageError);
  const user = await createUser();
  await login(page, user);
  const fixture = await createPdfFixture({ pageCount: 5 });

  await page.locator("#newNoteBtn").click();
  const createPopupPromise = page.waitForEvent("popup", { timeout: 120_000 });
  await page.locator('[data-create-note="pdf"]').click();
  page = await createPopupPromise;
  await guardProductionFirebase(page, blockedRequests);
  page.on("pageerror", onPageError);
  const dialogs = [];
  page.on("dialog", async dialog => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await expect(page.locator("#authStatus")).toContainText(user.email, { timeout: 20_000 });
  const uploadPaths = [];
  const deletedPaths = [];
  await page.route(/127\.0\.0\.1:9199\/v0\/b\/[^/]+\/o/, async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "POST" && url.searchParams.get("name")?.includes("/sourcePages/")) {
      uploadPaths.push(url.searchParams.get("name"));
      if (uploadPaths.length === 2) {
        await route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: 403, message: "forced second-page failure" } })
        });
        return;
      }
    } else if (request.method() === "DELETE") {
      deletedPaths.push(decodeURIComponent(url.pathname.split("/o/")[1] || ""));
    }
    await route.fallback();
  });
  await page.locator("#newNoteTitle").fill("保存失敗E2E PDFノート");
  const fileChooserPromise = page.waitForEvent("filechooser");
  await page.locator('[data-create-note="pdf"]').click();
  await (await fileChooserPromise).setFiles({ name: "five-pages.pdf", mimeType: "application/pdf", buffer: fixture });

  await expect.poll(() => dialogs.length, { timeout: 90_000 }).toBe(1);
  expect(dialogs[0]).toContain("PDFノートは作成されていません。");
  const stored = await readNotes(user.uid);
  expect(stored.notes).toHaveLength(1);
  const [note] = stored.notes;
  expect(note).toMatchObject({ title: "保存失敗E2E PDFノート", status: "failed", errorPhase: "pdf-import" });
  expect(note.pendingStoragePaths || [], "消し残しがないので記録も残らない").toEqual([]);
  expect(note.pages).toEqual([]);
  expect(uploadPaths.length).toBeGreaterThanOrEqual(2);
  expect(new Set(uploadPaths).size).toBe(uploadPaths.length);
  for (const path of uploadPaths) {
    expect(path).toContain(`users/${user.uid}/notes/${note.id}/sourcePages/`);
    expect(deletedPaths, "失敗した要求の画像も含め、開始した画像はすべて削除する").toContain(path);
  }
  const token = await (await fetch("http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-api-key", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: user.email, password: user.password, returnSecureToken: true })
  }).then(response => response.json())).idToken;
  for (const path of uploadPaths) {
    const response = await fetch(`http://127.0.0.1:9199/v0/b/demo-dental-qa.firebasestorage.app/o/${encodeURIComponent(path)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    expect(response.status, path).toBe(404);
  }
  expect(blockedRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});

// Four-color scan image made by the browser: red top-left, green top-right,
// blue bottom-left, amber bottom-right.
async function createScanJpeg(page) {
  return Buffer.from(await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 800;
    canvas.height = 1100;
    const context = canvas.getContext("2d");
    [["#dc2626", 0, 0], ["#16a34a", 400, 0], ["#2563eb", 0, 550], ["#f59e0b", 400, 550]].forEach(([color, x, y]) => {
      context.fillStyle = color;
      context.fillRect(x, y, 400, 550);
    });
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", .95));
    return [...new Uint8Array(await blob.arrayBuffer())];
  }));
}

async function backgroundQuadrantColors(page) {
  const image = page.locator("#notePageStage .note-background-image");
  await expect(image).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => image.evaluate(node => node.complete && node.naturalWidth > 0), { timeout: 20_000 }).toBe(true);
  return image.evaluate(node => {
    const canvas = document.createElement("canvas");
    canvas.width = node.naturalWidth;
    canvas.height = node.naturalHeight;
    const context = canvas.getContext("2d");
    context.drawImage(node, 0, 0);
    const name = ([r, g, b]) => {
      const palette = {
        red: [220, 38, 38], green: [22, 163, 74], blue: [37, 99, 235], amber: [245, 158, 11],
        black: [0, 0, 0], white: [255, 255, 255]
      };
      return Object.entries(palette)
        .map(([label, color]) => [label, Math.hypot(r - color[0], g - color[1], b - color[2])])
        .sort((left, right) => left[1] - right[1])[0][0];
    };
    const at = (x, y) => name(context.getImageData(Math.floor(canvas.width * x), Math.floor(canvas.height * y), 1, 1).data);
    return { size: [canvas.width, canvas.height], topLeft: at(.25, .25), topRight: at(.75, .25), bottomLeft: at(.25, .75), bottomRight: at(.75, .75) };
  });
}

test("@authenticated @ipad-v-next スキャンPDF（全面JPEG・白黒1ビット画像・不可視OCR文字・回転ページ）は埋込み画像を直接描画して向きどおりにノート化する", async ({ page }) => {
  test.setTimeout(120_000);
  const blockedRequests = await guardProductionFirebase(page);
  const pageErrors = [];
  const onPageError = error => recordUnexpectedPageError(pageErrors, error);
  page.on("pageerror", onPageError);
  const fallbackWarnings = [];
  const onConsole = message => {
    if (/pdf\.jsで変換します|pdf-libで展開します/.test(message.text())) fallbackWarnings.push(message.text());
  };
  page.on("console", onConsole);
  await page.context().addInitScript(() => {
    // 1-bit pages are inflated on the page by DecompressionStream; pdf.js
    // would inflate them in its worker instead.
    const OriginalDecompressionStream = window.DecompressionStream;
    if (OriginalDecompressionStream) {
      window.DecompressionStream = class extends OriginalDecompressionStream {
        constructor(...args) {
          super(...args);
          sessionStorage.setItem("bilevelInflates", String(Number(sessionStorage.getItem("bilevelInflates") || 0) + 1));
        }
      };
    }
    const original = window.createImageBitmap?.bind(window);
    if (!original) return;
    let decoding = 0;
    window.createImageBitmap = async (source, ...rest) => {
      if (!(source instanceof Blob && source.type === "image/jpeg")) return original(source, ...rest);
      sessionStorage.setItem("scanJpegDecodes", String(Number(sessionStorage.getItem("scanJpegDecodes") || 0) + 1));
      decoding += 1;
      sessionStorage.setItem("scanJpegPeak", String(Math.max(decoding, Number(sessionStorage.getItem("scanJpegPeak") || 0))));
      try {
        const bitmap = await original(source, ...rest);
        const close = bitmap.close.bind(bitmap);
        bitmap.close = () => {
          decoding -= 1;
          close();
        };
        return bitmap;
      } catch (error) {
        decoding -= 1;
        throw error;
      }
    };
  });
  const user = await createUser();
  await login(page, user);
  const jpeg = await createScanJpeg(page);
  const scan = await PDFDocument.create();
  const image = await scan.embedJpg(jpeg);
  const font = await scan.embedFont(StandardFonts.Helvetica);
  const upright = scan.addPage([400, 550]);
  upright.drawImage(image, { x: 0, y: 0, width: 400, height: 550 });
  const fontKey = upright.node.newFontDictionary("F1", font.ref);
  upright.pushOperators(
    setTextRenderingMode(TextRenderingMode.Invisible), beginText(), setFontAndSize(fontKey, 18),
    moveText(40, 300), showText(font.encodeText("OCR TEXT")), endText()
  );
  const rotated = scan.addPage([400, 550]);
  rotated.setRotation(degrees(90));
  rotated.drawImage(image, { x: 0, y: 0, width: 400, height: 550 });
  const rotatedBack = scan.addPage([400, 550]);
  rotatedBack.setRotation(degrees(270));
  rotatedBack.drawImage(image, { x: 0, y: 0, width: 400, height: 550 });
  // A black-and-white page as a scanner stores it: a 1-bit gray image with
  // FlateDecode, 800 x 1100 px, black only in the top-left quarter.
  const bilevelRowBytes = 800 / 8;
  const bilevelBits = new Uint8Array(bilevelRowBytes * 1100).fill(0xff);
  for (let y = 0; y < 550; y += 1) bilevelBits.fill(0, y * bilevelRowBytes, y * bilevelRowBytes + bilevelRowBytes / 2);
  const bilevelImage = scan.context.register(scan.context.flateStream(bilevelBits, {
    Type: "XObject", Subtype: "Image", Width: 800, Height: 1100, ColorSpace: "DeviceGray", BitsPerComponent: 1
  }));
  const bilevel = scan.addPage([400, 550]);
  const bilevelName = bilevel.node.newXObject("Im", bilevelImage);
  bilevel.pushOperators(pushGraphicsState(), concatTransformationMatrix(400, 0, 0, 550, 0, 0), drawObject(bilevelName), popGraphicsState());
  const fixture = Buffer.from(await scan.save());

  await page.locator("#newNoteBtn").click();
  const popupPromise = page.waitForEvent("popup", { timeout: 120_000 });
  await page.locator('[data-create-note="pdf"]').click();
  page = await popupPromise;
  await guardProductionFirebase(page, blockedRequests);
  page.on("pageerror", onPageError);
  page.on("console", onConsole);
  await expect(page.locator("#noteCreateView")).toBeVisible();
  await expect(page.locator("#authStatus")).toContainText(user.email, { timeout: 20_000 });
  const fileChooserPromise = page.waitForEvent("filechooser");
  await page.locator('[data-create-note="pdf"]').click();
  await (await fileChooserPromise).setFiles({ name: "scan.pdf", mimeType: "application/pdf", buffer: fixture });
  await page.waitForURL(url => url.searchParams.get("noteEditor") === "1" && Boolean(url.searchParams.get("noteId")), { timeout: 120_000 });
  const decodes = await page.evaluate(() => ({
    pages: Number(sessionStorage.getItem("scanJpegDecodes") || 0),
    atOnce: Number(sessionStorage.getItem("scanJpegPeak") || 0),
    bilevelInflates: Number(sessionStorage.getItem("bilevelInflates") || 0),
    progressRecords: Object.keys(localStorage).filter(key => key.startsWith("dentalQaPdfCreationProgress:"))
  }));
  expect(decodes, "カラーの3ページを埋込みJPEGから1ページずつ、白黒ページを1ビット画像から描画し、作成後は途中経過の記録を残さない")
    .toEqual({ pages: 3, atOnce: 1, bilevelInflates: 1, progressRecords: [] });
  expect(fallbackWarnings, "どのページもpdf.jsやpdf-libの代替処理へ回さない").toEqual([]);

  await expect(page.locator("#notePageCounter")).toHaveText("1 / 4", { timeout: 60_000 });
  const first = await backgroundQuadrantColors(page);
  expect(first).toMatchObject({ topLeft: "red", topRight: "green", bottomLeft: "blue", bottomRight: "amber" });
  expect(first.size[0] / first.size[1]).toBeCloseTo(400 / 550, 2);
  await openPageSidebar(page);
  await page.locator('#notePageList [aria-label="2ページを開く"]').click();
  await expect(page.locator("#notePageCounter")).toHaveText("2 / 4");
  const second = await backgroundQuadrantColors(page);
  expect(second, "90度回転ページは時計回りに回した向き").toMatchObject({ topLeft: "blue", topRight: "red", bottomLeft: "amber", bottomRight: "green" });
  expect(second.size[0] / second.size[1]).toBeCloseTo(550 / 400, 2);
  await page.locator('#notePageList [aria-label="3ページを開く"]').click();
  await expect(page.locator("#notePageCounter")).toHaveText("3 / 4");
  const third = await backgroundQuadrantColors(page);
  expect(third, "270度回転ページは反時計回りに回した向き").toMatchObject({ topLeft: "green", topRight: "amber", bottomLeft: "red", bottomRight: "blue" });
  expect(third.size[0] / third.size[1]).toBeCloseTo(550 / 400, 2);
  await page.locator('#notePageList [aria-label="4ページを開く"]').click();
  await expect(page.locator("#notePageCounter")).toHaveText("4 / 4");
  const fourth = await backgroundQuadrantColors(page);
  expect(fourth, "白黒ページは左上だけ黒い向きのまま").toMatchObject({ topLeft: "black", topRight: "white", bottomLeft: "white", bottomRight: "white" });
  expect(fourth.size[0] / fourth.size[1]).toBeCloseTo(400 / 550, 2);
  expect(blockedRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test("@authenticated @ipad-page-coordinates 縦横・16:9・回転混在PDFは全レイヤーと9地点を同じページ座標へ投影する", async ({ page }) => {
  test.setTimeout(180_000);
  const user = await createUser();
  await login(page, user);
  const fixture = await createPdfFixture({ pageDefinitions: [
    PDF_PAGE_GEOMETRY_FIXTURES.a4Portrait,
    PDF_PAGE_GEOMETRY_FIXTURES.a4Landscape,
    PDF_PAGE_GEOMETRY_FIXTURES.widescreen,
    PDF_PAGE_GEOMETRY_FIXTURES.rotated90,
    PDF_PAGE_GEOMETRY_FIXTURES.rotated270
  ] });

  await page.locator("#newNoteBtn").click();
  const popupPromise = page.waitForEvent("popup", { timeout: 120_000 });
  await page.locator('[data-create-note="pdf"]').click();
  page = await popupPromise;
  await guardProductionFirebase(page);
  await page.waitForURL(url => url.searchParams.get("create") === "pdf", { timeout: 120_000 });
  await expect(page.locator("#authStatus")).toContainText(user.email, { timeout: 20_000 });
  await page.locator("#newNoteTitle").fill("混在PDF座標E2Eノート");
  const chooserPromise = page.waitForEvent("filechooser");
  await page.locator('[data-create-note="pdf"]').click();
  const chooser = await chooserPromise;
  await chooser.setFiles({ name: "mixed-orientation.pdf", mimeType: "application/pdf", buffer: fixture });
  await page.waitForURL(url => Boolean(url.searchParams.get("noteId")), { timeout: 120_000 });
  await expect(page.locator("#noteEditorStartup")).toBeHidden({ timeout: 120_000 });

  const noteId = new URL(page.url()).searchParams.get("noteId");
  await expect.poll(async () => {
    const note = (await readNotes(user.uid)).notes.find(item => item.id === noteId);
    return note?.pages?.length || 0;
  }, { timeout: 20_000 }).toBe(5);
  const stored = await readNotes(user.uid);
  const note = stored.notes.find(item => item.id === noteId);
  const storedPages = [...note.pages].sort((a, b) => a.order - b.order);
  expect(storedPages).toHaveLength(5);
  expect(storedPages.map(storedPage => storedPage.background.pdfRotation))
    .toEqual([0, 0, 0, 90, 270]);
  await openPageSidebar(page);
  const normalizedPoints = [0, .5, 1].flatMap(y => [0, .5, 1].map(x => ({ x, y })));

  for (const [pageIndex, storedPage] of storedPages.entries()) {
    await page.locator(`#notePageList [aria-label="${pageIndex + 1}ページを開く"]`).click();
    await expect(page.locator("#notePageCounter")).toHaveText(`${pageIndex + 1} / ${storedPages.length}`);
    await expect(page.locator("#notePageStage .note-background-image")).toBeVisible({ timeout: 20_000 });
    const stage = page.locator("#notePageStage");
    const capture = stage.locator('[data-layer="drawing-input"]');
    const box = await stage.boundingBox();
    expect(box).toBeTruthy();

    for (const [pointIndex, point] of normalizedPoints.entries()) {
      const insetX = Math.min(.995, Math.max(.005, point.x));
      const insetY = Math.min(.995, Math.max(.005, point.y));
      const pointerId = 5000 + pageIndex * 20 + pointIndex;
      const event = {
        pointerId, pointerType: "pen", button: 0,
        clientX: box.x + box.width * insetX,
        clientY: box.y + box.height * insetY,
        width: 2, height: 2
      };
      await capture.dispatchEvent("pointerdown", { ...event, pressure: .5 });
      await capture.dispatchEvent("pointerup", { ...event, pressure: 0 });
    }
    await expect(stage.locator("circle[data-element-id]")).toHaveCount(9);

    const geometry = await stage.evaluate(node => {
      const snapshot = element => {
        const rect = element?.getBoundingClientRect();
        return rect && { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
      };
      const root = snapshot(node);
      const layers = [
        node.querySelector(".note-paper-layer"),
        node.querySelector(".note-background-image"),
        node.querySelector('[data-layer="elements"]'),
        node.querySelector("svg.note-layer"),
        node.querySelector('[data-layer="drawing-input"]'),
        node.querySelector('[data-layer="masks"]')
      ].map(snapshot).filter(Boolean);
      const maximumLayerDeltaPx = Math.max(...layers.flatMap(rect => [
        Math.abs(rect.left - root.left), Math.abs(rect.top - root.top),
        Math.abs(rect.width - root.width), Math.abs(rect.height - root.height)
      ]));
      return {
        root,
        maximumLayerDeltaPx,
        viewBox: node.querySelector("svg.note-layer")?.getAttribute("viewBox"),
        circles: [...node.querySelectorAll("circle[data-element-id]")].map(circle => ({
          x: Number(circle.getAttribute("cx")), y: Number(circle.getAttribute("cy"))
        }))
      };
    });
    expect(geometry.maximumLayerDeltaPx).toBeLessThanOrEqual(1);
    expect(geometry.viewBox).toBe(`0 0 ${storedPage.size.width} ${storedPage.size.height}`);
    geometry.circles.forEach((circle, pointIndex) => {
      const expected = normalizedPoints[pointIndex];
      const clientX = geometry.root.left + circle.x / storedPage.size.width * geometry.root.width;
      const clientY = geometry.root.top + circle.y / storedPage.size.height * geometry.root.height;
      const targetX = geometry.root.left + Math.min(.995, Math.max(.005, expected.x)) * geometry.root.width;
      const targetY = geometry.root.top + Math.min(.995, Math.max(.005, expected.y)) * geometry.root.height;
      expect(Math.abs(clientX - targetX), `page ${pageIndex + 1} point ${pointIndex + 1} x`).toBeLessThanOrEqual(2);
      expect(Math.abs(clientY - targetY), `page ${pageIndex + 1} point ${pointIndex + 1} y`).toBeLessThanOrEqual(2);
    });
  }

  const debugUrl = new URL(page.url());
  debugUrl.searchParams.set("inputDebug", "1");
  await page.goto(debugUrl.toString(), { waitUntil: "domcontentloaded" });
  await expect(page.locator("#noteEditorStartup")).toBeHidden({ timeout: 30_000 });
  await openPageSidebar(page);
  await page.locator('#notePageList [aria-label="5ページを開く"]').click();
  await expect(page.locator("#notePageCounter")).toHaveText("5 / 5");
  const diagnosticStage = page.locator("#notePageStage");
  const diagnosticCapture = diagnosticStage.locator('[data-layer="drawing-input"]');
  const diagnosticBox = await diagnosticStage.boundingBox();
  expect(diagnosticBox).toBeTruthy();
  const diagnosticEvent = {
    pointerId: 5999, pointerType: "pen", button: 0, buttons: 1,
    clientX: diagnosticBox.x + diagnosticBox.width * .37,
    clientY: diagnosticBox.y + diagnosticBox.height * .61,
    width: 2, height: 2, pressure: .5
  };
  await diagnosticCapture.dispatchEvent("pointerdown", diagnosticEvent);
  await diagnosticCapture.dispatchEvent("pointerup", { ...diagnosticEvent, buttons: 0, pressure: 0 });
  await expect(page.locator("#noteInputDebugValues")).toContainText("pen pointerdown");
  await page.locator("#noteInputDebugPanel summary").click();
  const diagnosticDownloadPromise = page.waitForEvent("download");
  await page.locator("#noteInputDebugDownload").click();
  const diagnosticDownload = await diagnosticDownloadPromise;
  const diagnosticStream = await diagnosticDownload.createReadStream();
  const diagnosticChunks = [];
  for await (const chunk of diagnosticStream) diagnosticChunks.push(chunk);
  const diagnostic = JSON.parse(Buffer.concat(diagnosticChunks).toString("utf8"));
  expect(diagnostic.pageSpace).toMatchObject({
    sourceWidth: storedPages[4].size.width,
    sourceHeight: storedPages[4].size.height,
    pdfRotation: 270,
    rotationApplied: true
  });
  for (const key of ["backgroundRect", "svgRect", "inputSurfaceRect", "maskLayerRect", "pageRootRect"]) {
    expect(diagnostic.pageSpace[key], `${key}を診断JSONへ含める`).toBeTruthy();
  }
  expect(diagnostic.pageSpace.maximumLayerDeltaPx).toBeLessThanOrEqual(1);
  expect(diagnostic.drawing.events.some(event => event.distance !== null && event.distance <= .01),
    "入力座標の再投影deltaを診断JSONへ含める").toBe(true);
});

test("@authenticated @ipad-v-next PDF作成タブが拒否されても同じタブで作成画面を継続する", async ({ page }) => {
  const blockedRequests = await guardProductionFirebase(page);
  const user = await createUser();
  await login(page, user);
  await page.locator("#newNoteBtn").click();
  for (const type of ["blank", "ruled", "pdf", "material"]) {
    await expect(page.locator(`[data-create-note="${type}"]`), "一覧画面では全ての作成方法を選べる").toBeVisible();
  }
  await page.evaluate(() => { window.open = () => null; });
  await page.locator('[data-create-note="pdf"]').click();
  await page.waitForURL(url => url.searchParams.get("noteEditor") === "1" && url.searchParams.get("create") === "pdf");
  await expect(page.locator("#noteCreateView")).toBeVisible();
  await expect(page.locator("#noteCreateTitle")).toHaveText("PDFからノートを作成");
  await expect(page.locator('[data-create-note="pdf"]')).toBeVisible();
  await expect(page.locator('[data-create-note="pdf"]')).toContainText("PDFファイルを選択");
  for (const type of ["blank", "ruled", "material"]) {
    await expect(page.locator(`[data-create-note="${type}"]`), "PDF作成画面には選んだ作成方法だけを出す").toBeHidden();
  }
  await expect(page.locator("#authStatus")).toContainText(user.email, { timeout: 20_000 });
  await expect(page.getByText("クラウド読込の完了後に画像暗記が使えます。")).toHaveCount(0);
  await expect(page.locator("#notePdfInput")).toBeAttached();
  await expect(page.locator(".note-create-notice")).toHaveCount(0);

  // A tab that ended during a creation (iPad Safari reloads a tab that ran
  // out of memory) tells where the previous attempt stopped, once.
  const progressKey = `dentalQaPdfCreationProgress:${new URL(page.url()).searchParams.get("creationSessionId")}`;
  await page.evaluate(({ key, uid }) => localStorage.setItem(key, JSON.stringify({
    uid, fileName: "20260801_Z章微生物学.pdf", fileSize: 56_300_000, phase: "converting",
    pageNumber: 18, pageCount: 41, startedAt: Date.now() - 60_000, updatedAt: Date.now()
  })), { key: progressKey, uid: user.uid });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator(".note-create-notice")).toContainText(
    "「20260801_Z章微生物学.pdf」の41ページ中18ページ目の変換中に終了しました",
    { timeout: 20_000 }
  );
  await expect(page.locator('[data-create-note="pdf"]')).toBeVisible();
  expect(await page.evaluate(key => localStorage.getItem(key), progressKey)).toBeNull();
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#newNoteTitle")).toHaveValue("新しいPDFノート", { timeout: 20_000 });
  await expect(page.locator(".note-create-notice"), "案内は一度だけ出す").toHaveCount(0);
  expect(blockedRequests).toEqual([]);
});

test("@authenticated @ipad-v-next ノートのマスクは暗記学習と同じ見た目で、ピンチは指の位置を中心に拡大し、弧を描く指スワイプでページを送る", async ({ page }) => {
  test.setTimeout(120_000);
  const blockedRequests = await guardProductionFirebase(page);
  const pageErrors = [];
  page.on("pageerror", error => recordUnexpectedPageError(pageErrors, error));
  const user = await createUser();
  const note = await seedReadyNote(user.uid, "ジェスチャーE2Eノート", { pageCount: 2 });
  await seedNotePageBackground(user.uid, note.noteId, note.pageId, {
    image: createRgbPng(1240, 1754),
    size: { width: 1240, height: 1754 }
  });
  await login(page, user);
  // An Apple Pencil user: fingers pan, zoom and turn pages instead of drawing.
  await page.evaluate(uid => localStorage.setItem(`dentalQaNoteToolSettings:${uid}`, JSON.stringify({ pencilMode: true, fingerDraw: false })), user.uid);
  await page.addInitScript(() => {
    globalThis.__noteNotices = [];
    document.addEventListener("DOMContentLoaded", () => {
      const notice = document.querySelector("#noteEditorNotice");
      new MutationObserver(() => {
        if (notice.textContent) globalThis.__noteNotices.push(notice.textContent);
      }).observe(notice, { childList: true, characterData: true, subtree: true });
    });
  });
  // A slow network: the page background arrives well after the page is drawn.
  await page.route(url => url.port === "9199" && url.searchParams.get("alt") === "media", async route => {
    await new Promise(resolve => setTimeout(resolve, 1200));
    await route.fallback();
  });
  const editorUrl = `/?firebaseEmulator=1&noteEditor=1&noteId=${note.noteId}&editorTabId=${crypto.randomUUID()}`;
  await page.goto(editorUrl, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#noteEditorStartup")).toBeHidden({ timeout: 30_000 });
  const stage = page.locator("#notePageStage");
  await expect(stage.locator(".note-background-image")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(700);
  expect(await page.evaluate(() => globalThis.__noteNotices), "背景の読込みが遅くても、レイヤーのずれを通知しない").toEqual([]);
  await expect(stage.locator('[data-layer="drawing-input"]'), "Pencilの入力面は有効のまま").toHaveClass(/active/);

  // A note mask, drawn with the mask tool.
  await page.locator('[data-note-tool="mask"]').click();
  const pageBox = await stage.boundingBox();
  await page.mouse.move(pageBox.x + pageBox.width * .3, pageBox.y + 120);
  await page.mouse.down();
  await page.mouse.move(pageBox.x + pageBox.width * .55, pageBox.y + 190, { steps: 5 });
  await page.mouse.up();
  const mask = stage.locator(".note-mask").first();
  await expect(stage.locator(".note-mask")).toHaveCount(1);
  await expect(mask, "編集中は暗記学習でめくったマスクと同じ細い破線").toHaveCSS("border-top-style", "dashed");
  await expect(mask).toHaveCSS("border-top-width", "1px");
  await expect(mask).toHaveCSS("border-top-color", "rgba(37, 99, 235, 0.55)");
  await expect(mask, "選択中は暗記学習と同じオレンジの枠").toHaveCSS("outline-color", "rgb(245, 158, 11)");
  await page.locator('[data-note-tool="pen"]').click();

  // Study mode: masks look like the image memory screen's, and only a tap
  // opens or closes one.
  await page.locator("#noteStudyModeBtn").click();
  await expect(stage).toHaveClass(/study-mode/);
  await expect(mask).toHaveCSS("background-color", "rgb(17, 24, 39)");
  await expect(mask).toHaveCSS("border-top-style", "solid");
  await expect(mask).toHaveCSS("border-top-width", "2px");
  await expect(mask).toHaveCSS("border-top-left-radius", "6px");
  const maskBox = await mask.boundingBox();
  const maskCenter = { x: maskBox.x + maskBox.width / 2, y: maskBox.y + maskBox.height / 2 };
  const touchOn = (locator, type, pointerId, x, y) => locator.dispatchEvent(type, {
    pointerId, pointerType: "touch", button: 0, clientX: x, clientY: y, width: 8, height: 8, pressure: type === "pointerup" ? 0 : .5
  });
  await touchOn(mask, "pointerdown", 501, maskCenter.x, maskCenter.y);
  await touchOn(mask, "pointermove", 501, maskCenter.x + 40, maskCenter.y + 6);
  await touchOn(mask, "pointerup", 501, maskCenter.x + 40, maskCenter.y + 6);
  await expect(stage.locator(".note-mask.revealed"), "マスクの上から動かした指ではめくらない").toHaveCount(0);
  await touchOn(mask, "pointerdown", 502, maskCenter.x, maskCenter.y);
  await touchOn(mask, "pointerup", 502, maskCenter.x, maskCenter.y);
  await expect(stage.locator(".note-mask.revealed"), "タップでめくる").toHaveCount(1);
  await expect(stage.locator(".note-mask.revealed")).toHaveCSS("border-top-style", "dashed");
  await expect(stage.locator(".note-mask.revealed")).toHaveCSS("border-top-color", "rgba(37, 99, 235, 0.55)");
  await page.locator("#noteEditModeBtn").click();

  // Pinch: the page point between the fingers stays between them.
  const capture = stage.locator('[data-layer="drawing-input"]');
  const pageState = () => stage.evaluate(node => {
    const rect = node.getBoundingClientRect();
    return { left: rect.left, top: rect.top, zoom: Number(getComputedStyle(node).getPropertyValue("--page-zoom") || 1) };
  });
  const before = await pageState();
  const focus = { x: pageBox.x + pageBox.width * .62, y: pageBox.y + 260 };
  const pagePoint = { x: (focus.x - before.left) / before.zoom, y: (focus.y - before.top) / before.zoom };
  await touchOn(capture, "pointerdown", 301, focus.x - 30, focus.y);
  await touchOn(capture, "pointerdown", 302, focus.x + 30, focus.y);
  for (const spread of [45, 60, 75, 90]) {
    await touchOn(capture, "pointermove", 301, focus.x - spread, focus.y);
    await touchOn(capture, "pointermove", 302, focus.x + spread, focus.y);
  }
  await touchOn(capture, "pointerup", 301, focus.x - 90, focus.y);
  await touchOn(capture, "pointerup", 302, focus.x + 90, focus.y);
  await expect.poll(async () => (await pageState()).zoom).toBeGreaterThan(2.5);
  const after = await pageState();
  expect(Math.abs(after.left + pagePoint.x * after.zoom - focus.x), "横方向に指の位置からずれない").toBeLessThan(2);
  expect(Math.abs(after.top + pagePoint.y * after.zoom - focus.y), "縦方向に指の位置からずれない").toBeLessThan(2);

  // Page swipes at the normal zoom: a finger arcs, so drift is allowed.
  await page.goto(editorUrl, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#noteEditorStartup")).toBeHidden({ timeout: 30_000 });
  await expect(page.locator("#notePageCounter")).toHaveText("1 / 2");
  const swipe = async (dx, dy) => {
    const box = await stage.boundingBox();
    const start = { x: box.x + box.width * .7, y: box.y + Math.min(box.height, 600) * .5 };
    await touchOn(capture, "pointerdown", 401, start.x, start.y);
    for (let step = 1; step <= 10; step += 1) {
      await page.waitForTimeout(16);
      await touchOn(capture, "pointermove", 401, start.x + dx * step / 10, start.y + dy * step / 10);
    }
    await touchOn(capture, "pointerup", 401, start.x + dx, start.y + dy);
  };
  await swipe(-260, 60);
  await expect(page.locator("#notePageCounter"), "60 px斜めにずれても次のページへ").toHaveText("2 / 2");
  await expect.poll(() => stage.evaluate(node => `${node.style.visibility}|${node.style.translate}`)).toBe("|");
  await expect(page.locator("#noteAdjacentPagePreview")).toBeHidden();
  await swipe(260, -40);
  await expect(page.locator("#notePageCounter"), "前のページへ戻る").toHaveText("1 / 2");
  await expect.poll(() => stage.evaluate(node => `${node.style.visibility}|${node.style.translate}`)).toBe("|");
  await swipe(-60, -260);
  await page.waitForTimeout(600);
  await expect(page.locator("#notePageCounter"), "縦の動きではページを送らない").toHaveText("1 / 2");
  expect(await page.evaluate(() => globalThis.__noteNotices)).toEqual([]);
  expect(blockedRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test("@authenticated @ipad-v-next 指の移動は離した後も慣性で流れ、暗記モードとページの外側でも動かせ、2本指タップでペンと消しゴムを切り替える", async ({ page }) => {
  test.setTimeout(120_000);
  const blockedRequests = await guardProductionFirebase(page);
  const pageErrors = [];
  page.on("pageerror", error => recordUnexpectedPageError(pageErrors, error));
  const user = await createUser();
  const note = await seedReadyNote(user.uid, "指の操作E2Eノート", { pageCount: 2 });
  await login(page, user);
  // An Apple Pencil user: fingers move the page instead of drawing.
  await page.evaluate(uid => localStorage.setItem(`dentalQaNoteToolSettings:${uid}`, JSON.stringify({ pencilMode: true, fingerDraw: false })), user.uid);
  await page.setViewportSize({ width: 1180, height: 760 });
  await page.goto(`/?firebaseEmulator=1&noteEditor=1&noteId=${note.noteId}&editorTabId=${crypto.randomUUID()}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#noteEditorStartup")).toBeHidden({ timeout: 30_000 });
  const stage = page.locator("#notePageStage");
  const viewport = page.locator("#noteViewport");
  const capture = stage.locator('[data-layer="drawing-input"]');
  await expect(stage).toHaveAttribute("data-tool", "pen");
  const scrollTop = () => viewport.evaluate(node => node.scrollTop);
  const setScrollTop = value => viewport.evaluate((node, top) => { node.scrollTop = top; }, value);
  const zoom = () => stage.evaluate(node => Number(getComputedStyle(node).getPropertyValue("--page-zoom") || 1));
  expect(await viewport.evaluate(node => node.scrollHeight - node.clientHeight), "縦に動かせる長さがある").toBeGreaterThan(400);
  const touch = (locator, type, pointerId, x, y) => locator.dispatchEvent(type, {
    pointerId, pointerType: "touch", button: 0, clientX: x, clientY: y, width: 8, height: 8, pressure: type === "pointerup" ? 0 : .5
  });
  // A finger drags `distance` px upward in 10 steps, 16 ms apart, and lifts
  // while it still moves (dispatched in the page, so that the timing holds
  // however busy the test machine is).
  const flick = (locator, x, y, distance, pointerId) => locator.evaluate(async (target, { x, y, distance, pointerId }) => {
    const fire = (type, clientY) => target.dispatchEvent(new PointerEvent(type, {
      pointerId, pointerType: "touch", button: 0, buttons: type === "pointerup" ? 0 : 1, isPrimary: true,
      clientX: x, clientY, width: 8, height: 8, pressure: type === "pointerup" ? 0 : .5,
      bubbles: true, cancelable: true, composed: true
    }));
    fire("pointerdown", y);
    for (let step = 1; step <= 10; step += 1) {
      await new Promise(resolve => setTimeout(resolve, 16));
      fire("pointermove", y - distance * step / 10);
    }
    fire("pointerup", y - distance);
  }, { x, y, distance, pointerId });
  const box = await stage.boundingBox();
  const onPage = { x: box.x + box.width * .5, y: Math.min(box.y + box.height, 700) - 40 };

  // Edit mode: the page glides on after a quick drag, then slows to a stop.
  await setScrollTop(0);
  await flick(capture, onPage.x, onPage.y, 200, 601);
  const released = await scrollTop();
  expect(released, "指に合わせて動く").toBeGreaterThan(150);
  await page.waitForTimeout(700);
  const glided = await scrollTop();
  expect(glided, "指を離した後も慣性で流れる").toBeGreaterThan(released + 60);
  await page.waitForTimeout(2600);
  const settled = await scrollTop();
  await page.waitForTimeout(300);
  expect(Math.abs(await scrollTop() - settled), "減速して止まる").toBeLessThanOrEqual(1);

  // A new touch stops the glide at once.
  await setScrollTop(0);
  await flick(capture, onPage.x, onPage.y, 200, 602);
  await page.waitForTimeout(60);
  await touch(capture, "pointerdown", 603, onPage.x, onPage.y);
  const stoppedAt = await scrollTop();
  await page.waitForTimeout(400);
  expect(await scrollTop(), "触れると止まる").toBe(stoppedAt);
  await touch(capture, "pointerup", 603, onPage.x, onPage.y);

  // The area around the page moves the page too.
  await setScrollTop(0);
  const around = await viewport.evaluate(node => {
    const rect = node.getBoundingClientRect();
    const page = node.querySelector("#notePageStage").getBoundingClientRect();
    return { x: rect.left + Math.max(8, (page.left - rect.left) / 2), y: rect.top + 300 };
  });
  await flick(viewport, around.x, around.y, 150, 604);
  expect(await scrollTop(), "ページの外側の指でも動く").toBeGreaterThan(100);

  // Study mode: a finger moves the page as on the image memory screen.
  await page.locator("#noteStudyModeBtn").click();
  await expect(stage).toHaveClass(/study-mode/);
  await page.waitForTimeout(2500);
  await setScrollTop(0);
  await touch(stage, "pointerdown", 605, onPage.x, onPage.y);
  for (let step = 1; step <= 6; step += 1) {
    await page.waitForTimeout(40);
    await touch(stage, "pointermove", 605, onPage.x, onPage.y - step * 30);
  }
  await page.waitForTimeout(200);
  await touch(stage, "pointerup", 605, onPage.x, onPage.y - 180);
  expect(await scrollTop(), "暗記モードでも指でページを動かせる").toBeGreaterThan(150);
  // A two-finger tap does not change tools in study mode.
  const twoFingerTap = async (base = 900) => {
    const center = { x: box.x + box.width * .5, y: box.y + 200 };
    await touch(capture, "pointerdown", base + 1, center.x - 60, center.y);
    await touch(capture, "pointerdown", base + 2, center.x + 60, center.y);
    await page.waitForTimeout(60);
    await touch(capture, "pointerup", base + 1, center.x - 60, center.y);
    await touch(capture, "pointerup", base + 2, center.x + 60, center.y);
  };
  await twoFingerTap(910);
  await page.waitForTimeout(300);
  await page.locator("#noteEditModeBtn").click();
  await expect(stage).toHaveAttribute("data-tool", "pen");

  // Edit mode: a two-finger tap switches pen ⇄ eraser and keeps the zoom.
  // (Taps less than 0.45 s apart are one double tap: wait between them.)
  const zoomBefore = await zoom();
  await page.waitForTimeout(500);
  await twoFingerTap(920);
  await expect(stage, "2本指タップで消しゴムへ").toHaveAttribute("data-tool", "eraser-object");
  await expect(page.locator('[data-note-tool="eraser-object"]')).toHaveClass(/active/);
  await expect(page.locator("#noteEditorNotice")).toContainText("消しゴムに切り替えました");
  expect(await zoom(), "タップでは拡大率を変えない").toBeCloseTo(zoomBefore, 5);
  await page.waitForTimeout(500);
  await twoFingerTap(930);
  await expect(stage, "もう一度でペンへ戻る").toHaveAttribute("data-tool", "pen");
  // A pinch is not a tap.
  const pinchCenter = { x: box.x + box.width * .5, y: box.y + 220 };
  await touch(capture, "pointerdown", 941, pinchCenter.x - 40, pinchCenter.y);
  await touch(capture, "pointerdown", 942, pinchCenter.x + 40, pinchCenter.y);
  for (const spread of [60, 80, 100]) {
    await touch(capture, "pointermove", 941, pinchCenter.x - spread, pinchCenter.y);
    await touch(capture, "pointermove", 942, pinchCenter.x + spread, pinchCenter.y);
  }
  await touch(capture, "pointerup", 942, pinchCenter.x + 100, pinchCenter.y);
  await expect.poll(zoom).toBeGreaterThan(zoomBefore * 1.5);
  // The finger left down after the pinch moves the page on.
  const beforeResume = await scrollTop();
  for (let step = 1; step <= 5; step += 1) {
    await page.waitForTimeout(16);
    await touch(capture, "pointermove", 941, pinchCenter.x - 100, pinchCenter.y - step * 20);
  }
  expect(await scrollTop(), "ピンチ後に残した指でもページを動かせる").toBeGreaterThan(beforeResume + 50);
  await touch(capture, "pointerup", 941, pinchCenter.x - 100, pinchCenter.y - 100);
  await page.waitForTimeout(200);
  await expect(stage, "ピンチではツールを変えない").toHaveAttribute("data-tool", "pen");

  // The input settings can turn the two-finger tap off.
  await page.locator("#noteInputSettingsBtn").click();
  await expect(page.locator("#noteTwoFingerTap")).toBeChecked();
  await page.locator("#noteTwoFingerTap").uncheck();
  await page.locator("#noteToolSettingsDoneBtn").click();
  await twoFingerTap(950);
  await page.waitForTimeout(300);
  await expect(stage, "設定をオフにすると切り替えない").toHaveAttribute("data-tool", "pen");
  expect(await page.evaluate(uid => JSON.parse(localStorage.getItem(`dentalQaNoteToolSettings:${uid}`)).twoFingerTapQuickSwitch, user.uid)).toBe(false);
  expect(blockedRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test("@authenticated @ipad-v-next iPadの大きさの指（幅42〜84px）でも2本指タップ・2本指ダブルタップ・指の移動・ピンチ・マスクのタップが働き、手のひらとPencil直後の手は無視する", async ({ page }) => {
  test.setTimeout(120_000);
  const blockedRequests = await guardProductionFirebase(page);
  const pageErrors = [];
  page.on("pageerror", error => recordUnexpectedPageError(pageErrors, error));
  const user = await createUser();
  const note = await seedReadyNote(user.uid, "iPadの指E2Eノート", { pageCount: 2 });
  await login(page, user);
  // An Apple Pencil user: fingers move the page instead of drawing.
  await page.evaluate(uid => localStorage.setItem(`dentalQaNoteToolSettings:${uid}`, JSON.stringify({ pencilMode: true, fingerDraw: false })), user.uid);
  await page.setViewportSize({ width: 1180, height: 760 });
  await page.goto(`/?firebaseEmulator=1&noteEditor=1&noteId=${note.noteId}&editorTabId=${crypto.randomUUID()}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#noteEditorStartup")).toBeHidden({ timeout: 30_000 });
  const stage = page.locator("#notePageStage");
  const viewport = page.locator("#noteViewport");
  const capture = stage.locator('[data-layer="drawing-input"]');
  await expect(stage).toHaveAttribute("data-tool", "pen");
  const scrollTop = () => viewport.evaluate(node => node.scrollTop);
  const setScrollTop = value => viewport.evaluate((node, top) => { node.scrollTop = top; }, value);
  const zoom = () => stage.evaluate(node => Number(getComputedStyle(node).getPropertyValue("--page-zoom") || 1));
  // Safari on iPad reports a contact's width and height as twice its radius:
  // a fingertip is about 40 px or more, a thumb pressed flat about 80 px.
  const touch = (locator, type, pointerId, x, y, size = 52) => locator.dispatchEvent(type, {
    pointerId, pointerType: "touch", button: 0, clientX: x, clientY: y, width: size, height: size, pressure: type === "pointerup" ? 0 : .5
  });
  // Contacts dispatched in the page, so that their timing holds however busy
  // the test machine is. Each step: [type, pointerId, pointerType, x, y, size, waitAfterMs].
  const sequence = (locator, steps) => locator.evaluate(async (target, steps) => {
    for (const [type, pointerId, pointerType, clientX, clientY, size, waitMs] of steps) {
      target.dispatchEvent(new PointerEvent(type, {
        pointerId, pointerType, button: 0, buttons: type === "pointerup" ? 0 : 1, isPrimary: pointerId % 2 === 1,
        clientX, clientY, width: size, height: size, pressure: type === "pointerup" ? 0 : .5,
        bubbles: true, cancelable: true, composed: true
      }));
      if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
    }
  }, steps);
  const box = await stage.boundingBox();
  const tapAt = { x: box.x + box.width * .5, y: box.y + 300 };
  const twoFingerTapSteps = (base, sizes = [46, 60], waitAfterMs = 0) => [
    ["pointerdown", base + 1, "touch", tapAt.x - 60, tapAt.y, sizes[0], 20],
    ["pointerdown", base + 2, "touch", tapAt.x + 60, tapAt.y + 4, sizes[1], 90],
    ["pointerup", base + 1, "touch", tapAt.x - 58, tapAt.y + 2, sizes[0], 0],
    ["pointerup", base + 2, "touch", tapAt.x + 61, tapAt.y + 5, sizes[1], waitAfterMs]
  ];
  const flickSteps = (pointerId, x, y, distance, size) => [
    ["pointerdown", pointerId, "touch", x, y, size, 16],
    ...Array.from({ length: 10 }, (_, index) => ["pointermove", pointerId, "touch", x, y - distance * (index + 1) / 10, size, 16]),
    ["pointerup", pointerId, "touch", x, y - distance, size, 0]
  ];

  // A note mask (drawn with the mouse) for the study mode tap later.
  await page.locator('[data-note-tool="mask"]').click();
  await page.mouse.move(box.x + box.width * .3, box.y + 80);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * .55, box.y + 150, { steps: 5 });
  await page.mouse.up();
  await expect(stage.locator(".note-mask")).toHaveCount(1);
  await page.locator('[data-note-tool="pen"]').click();
  await expect(stage).toHaveAttribute("data-tool", "pen");

  // A two-finger tap with iPad-sized fingers switches to the eraser.
  await page.waitForTimeout(500);
  await sequence(capture, twoFingerTapSteps(700));
  await expect(stage, "幅46px・60pxの指の2本指タップで消しゴムへ").toHaveAttribute("data-tool", "eraser-object");
  await expect(page.locator("#noteEditorNotice")).toContainText("消しゴムに切り替えました");
  // A two-finger double tap switches once (back to the pen), not twice.
  await page.waitForTimeout(600);
  await sequence(capture, [...twoFingerTapSteps(710, [52, 84], 150), ...twoFingerTapSteps(720, [52, 84])]);
  await page.waitForTimeout(300);
  await expect(stage, "2本指のダブルタップは1回分だけ切り替える").toHaveAttribute("data-tool", "pen");
  await expect(page.locator("#noteEditorNotice")).toContainText("ペンに切り替えました");
  // Later, a tap switches again.
  await page.waitForTimeout(600);
  await sequence(capture, twoFingerTapSteps(730));
  await expect(stage, "間を空けた次のタップでは再び切り替える").toHaveAttribute("data-tool", "eraser-object");
  await page.waitForTimeout(600);
  await sequence(capture, twoFingerTapSteps(740));
  await expect(stage).toHaveAttribute("data-tool", "pen");

  // The hand just after the Pencil lifts is not a tap.
  await page.waitForTimeout(600);
  const strokes = await stage.locator("path[data-element-id]").count();
  await sequence(capture, [
    ["pointerdown", 750, "pen", box.x + box.width * .2, box.y + 420, 1, 16],
    ["pointermove", 750, "pen", box.x + box.width * .35, box.y + 440, 1, 16],
    ["pointerup", 750, "pen", box.x + box.width * .35, box.y + 440, 1, 30],
    ...twoFingerTapSteps(760)
  ]);
  await expect(stage.locator("path[data-element-id]")).toHaveCount(strokes + 1);
  await page.waitForTimeout(300);
  await expect(stage, "Pencilを離した直後の2本の指では切り替えない").toHaveAttribute("data-tool", "pen");

  // A finger (52 px) moves the page and lets it glide; a palm (140 px) does not.
  await setScrollTop(0);
  await sequence(capture, flickSteps(770, box.x + box.width * .5, 660, 200, 52));
  expect(await scrollTop(), "iPadの大きさの指でページを動かせる").toBeGreaterThan(150);
  await page.waitForTimeout(3500);
  await setScrollTop(0);
  await sequence(capture, flickSteps(771, box.x + box.width * .5, 660, 200, 140));
  await page.waitForTimeout(300);
  expect(await scrollTop(), "手のひらほどの接触ではページを動かさない").toBe(0);
  await expect(stage.locator("path[data-element-id]"), "指・手のひらでは描かない").toHaveCount(strokes + 1);
  // A small wobble of a resting finger does not move the page.
  await sequence(capture, [
    ["pointerdown", 772, "touch", box.x + box.width * .5, 600, 60, 16],
    ["pointermove", 772, "touch", box.x + box.width * .5 + 3, 605, 60, 16],
    ["pointerup", 772, "touch", box.x + box.width * .5 + 3, 605, 60, 0]
  ]);
  expect(await scrollTop(), "8px未満のずれではページを動かさない").toBe(0);

  // The area around the page.
  const around = await viewport.evaluate(node => {
    const rect = node.getBoundingClientRect();
    const page = node.querySelector("#notePageStage").getBoundingClientRect();
    return { x: rect.left + Math.max(8, (page.left - rect.left) / 2), y: rect.top + 300 };
  });
  await sequence(viewport, flickSteps(773, around.x, around.y, 150, 48));
  expect(await scrollTop(), "ページの外側でもiPadの大きさの指で動く").toBeGreaterThan(100);
  await page.waitForTimeout(3500);

  // Study mode: a fingertip taps a mask open.
  await page.locator("#noteStudyModeBtn").click();
  await expect(stage).toHaveClass(/study-mode/);
  await setScrollTop(0);
  await page.waitForTimeout(500);
  const maskBox = await stage.locator(".note-mask").first().boundingBox();
  const maskCenter = { x: maskBox.x + maskBox.width / 2, y: maskBox.y + maskBox.height / 2 };
  await touch(stage.locator(".note-mask").first(), "pointerdown", 780, maskCenter.x, maskCenter.y, 56);
  await touch(stage.locator(".note-mask").first(), "pointerup", 780, maskCenter.x + 2, maskCenter.y + 1, 56);
  await expect(stage.locator(".note-mask.revealed"), "幅56pxの指のタップでマスクをめくる").toHaveCount(1);
  await page.locator("#noteEditModeBtn").click();
  await expect(stage).toHaveAttribute("data-tool", "pen");

  // A pinch with iPad-sized fingers zooms.
  const zoomBefore = await zoom();
  const pinchAt = { x: box.x + box.width * .5, y: box.y + 260 };
  await touch(capture, "pointerdown", 791, pinchAt.x - 40, pinchAt.y, 50);
  await touch(capture, "pointerdown", 792, pinchAt.x + 40, pinchAt.y, 58);
  for (const spread of [60, 80, 100]) {
    await touch(capture, "pointermove", 791, pinchAt.x - spread, pinchAt.y, 50);
    await touch(capture, "pointermove", 792, pinchAt.x + spread, pinchAt.y, 58);
  }
  await touch(capture, "pointerup", 791, pinchAt.x - 100, pinchAt.y, 50);
  await touch(capture, "pointerup", 792, pinchAt.x + 100, pinchAt.y, 58);
  await expect.poll(zoom, { message: "iPadの大きさの指でピンチすると拡大する" }).toBeGreaterThan(zoomBefore * 1.5);
  await page.waitForTimeout(300);
  await expect(stage, "ピンチではツールを変えない").toHaveAttribute("data-tool", "pen");
  expect(blockedRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test("@authenticated 教材をノートで繰り返し開いても既定ノートを重複作成しない", async ({ page }) => {
  test.setTimeout(90_000);
  const blockedRequests = await guardProductionFirebase(page);
  const user = await createUser();
  await login(page, user);

  await page.locator("#pdfEditModeBtn").click();
  await page.locator("#pdfTitleInput").fill("既定ノートE2E教材");
  await page.locator("#pdfSubjectInput").fill("E2E");
  await page.locator("#pdfCategoryInput").fill("連携ノート");
  await page.locator("#pdfFileInput").setInputFiles({ name: "material.png", mimeType: "image/png", buffer: TEST_PNG });
  await page.locator("#addPdfBtn").click();
  await expect(page.locator("#pdfEditStatus")).toContainText("教材を追加しました", { timeout: 30_000 });
  let row = page.locator('#pdfEditTableBody tr:has-text("既定ノートE2E教材")');
  let editor = await openEditorPopup(page, () => row.locator("[data-open-note]").click(), { blockedRequests });
  await expect(editor.locator("#notePageStage .note-background-image")).toBeVisible({ timeout: 20_000 });
  // The tab knows the note is linked to a material and loads the material
  // together with the note.
  expect(new URL(editor.url()).searchParams.get("material")).toBe("1");
  expect(await editor.evaluate(() => globalThis.__noteEditorStartupMetrics.context)).toMatchObject({
    noteType: "material-linked",
    materialHinted: true
  });
  await editor.close();

  await page.locator("#pdfEditModeBtn").click();
  row = page.locator('#pdfEditTableBody tr:has-text("既定ノートE2E教材")');
  editor = await openEditorPopup(page, () => row.locator("[data-open-note]").click(), { blockedRequests });
  await expect(editor.locator("#noteEditorView")).toBeVisible();
  await expect(editor.locator("#notePageStage .note-background-image")).toBeVisible({ timeout: 20_000 });
  expect(new URL(editor.url()).searchParams.get("material")).toBe("1");

  const stored = await readNotes(user.uid);
  const linked = stored.notes.filter(note => note.type === "material-linked");
  expect(linked).toHaveLength(1);
  expect(linked[0].materialRefs).toEqual([linked[0].sourceMaterialId]);
  expect(blockedRequests).toEqual([]);
});

test("@authenticated 教材をarchivingでロックしてから連携ノートを論理削除する", async ({ page }) => {
  test.setTimeout(90_000);
  const blockedRequests = await guardProductionFirebase(page);
  const pageErrors = [];
  const dialogs = [];
  page.on("pageerror", error => recordUnexpectedPageError(pageErrors, error));
  page.on("dialog", async dialog => {
    dialogs.push(dialog.message());
    await dialog.accept();
  });

  const user = await createUser();
  const seeded = await seedLinkedMaterial(user.uid);
  await login(page, user);
  await expect(page.locator("#noteList")).toContainText("連携削除E2Eノート");

  await page.locator("#pdfEditModeBtn").click();
  const row = page.locator('#pdfEditTableBody tr:has-text("連携削除E2E教材")');
  await expect(row).toBeVisible();
  await row.locator("[data-delete-pdf]").check();
  await page.locator("#pdfDeleteCheckedBtn").click();
  await expect(page.locator("#pdfEditStatus")).toContainText("1件の画像教材を削除しました", { timeout: 20_000 });
  await expect(row).toHaveCount(0);

  expect(dialogs).toHaveLength(2);
  expect(dialogs[1]).toContain("連携ノート");
  const stored = await readNotes(user.uid);
  expect(stored.pdfMaterials).toHaveLength(0);
  const linkedNote = stored.notes.find(note => note.id === seeded.noteId);
  expect(linkedNote?.deletedAt).toBeTruthy();
  expect(linkedNote?.deletedReason).toBe("material-deleted");
  expect(linkedNote?.deletedMaterialRefs).toEqual([seeded.materialId]);
  expect(blockedRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test("@authenticated archiving中の教材では新しい連携ノートを開始できない", async ({ page }) => {
  test.setTimeout(90_000);
  const user = await createUser();
  const seeded = await seedLinkedMaterial(user.uid);
  const environment = await initializeTestEnvironment({ projectId: "demo-dental-qa", firestore: { host: "127.0.0.1", port: 8080 } });
  try {
    const db = environment.authenticatedContext(user.uid).firestore();
    const materialRef = doc(db, "users", user.uid, "app", "pdfMaterials");
    const snapshot = await getDoc(materialRef);
    await setDoc(materialRef, {
      ...snapshot.data(),
      pdfMaterials: snapshot.data().pdfMaterials.map(material => ({
        ...material,
        status: "archiving",
        archivingOperation: "deletion",
        archivingStartedAt: "2026-09-27T00:00:00.000Z"
      }))
    });
  } finally {
    await environment.cleanup();
  }

  await login(page, user);
  await page.locator("#newNoteBtn").click();
  await page.locator('[data-create-note="material"]').click();
  const materialButton = page.locator("#noteMaterialPicker button", { hasText: "連携削除E2E教材" });
  await expect(materialButton).toBeDisabled();
  await expect(materialButton).toContainText("差し替え・削除処理中");
  await page.locator("#pdfEditModeBtn").click();
  await expect(page.locator(`[data-open-note="${seeded.materialId}"]`)).toBeDisabled();
});

test("@authenticated @ipad-transient-ui ツール別設定・画像メニュー・手書き・内部ズームをiPad向け境界内に保つ", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const blockedRequests = await guardProductionFirebase(page);
  const pageErrors = [];
  page.on("pageerror", error => recordUnexpectedPageError(pageErrors, error));
  const user = await createUser();
  await login(page, user);
  await page.locator("#newNoteBtn").click();
  await page.locator("#newNoteTitle").fill("一時UI回帰E2Eノート");
  page = await openEditorPopup(page, () => page.locator('[data-create-note="blank"]').click(), {
    blockedRequests,
    onPageError: error => recordUnexpectedPageError(pageErrors, error)
  });

  const settings = page.locator("#noteToolSettings");
  const openToolSettings = async (tool, title, sectionTool = tool) => {
    const button = page.locator(`[data-note-tool="${tool}"]`);
    await button.click();
    if (!await settings.isVisible()) await button.click();
    await expect(settings).toBeVisible();
    await expect(page.locator("#noteToolSettingsTitle")).toHaveText(title);
    await expect(settings.locator("[data-setting-tools]:not(.hidden)")).toHaveCount(1);
    await expect(settings.locator(`[data-setting-tools~="${sectionTool}"]`)).toBeVisible();
    const geometry = await settings.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const done = element.querySelector("#noteToolSettingsDoneBtn")?.getBoundingClientRect();
      const scroll = element.querySelector(".note-tool-settings-scroll");
      return {
        left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
        width: rect.width, height: rect.height,
        viewportWidth: visualViewport?.width || innerWidth,
        viewportHeight: visualViewport?.height || innerHeight,
        compactLayout: matchMedia("(orientation: portrait), (max-width: 760px)").matches,
        maxHeight: parseFloat(getComputedStyle(element).maxHeight),
        verticalLabels: [...element.querySelectorAll(".tool-setting-label")].some(label => getComputedStyle(label).writingMode !== "horizontal-tb"),
        done: done ? { left: done.left, top: done.top, right: done.right, bottom: done.bottom } : null,
        scrollClientWidth: scroll?.clientWidth || 0,
        scrollWidth: scroll?.scrollWidth || 0
      };
    });
    expect(geometry.left).toBeGreaterThanOrEqual(-1);
    expect(geometry.top).toBeGreaterThanOrEqual(-1);
    expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth + 1);
    expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight + 1);
    expect(geometry.width).toBeLessThanOrEqual(422);
    const expectedMaxHeight = geometry.compactLayout
      ? Math.min(562, geometry.viewportHeight * .52)
      : Math.min(562, geometry.viewportHeight - 94);
    expect(geometry.maxHeight).toBeLessThanOrEqual(expectedMaxHeight + 1);
    expect(geometry.height).toBeLessThanOrEqual(expectedMaxHeight + 1);
    expect(geometry.verticalLabels).toBe(false);
    expect(geometry.done).not.toBeNull();
    expect(geometry.done.left).toBeGreaterThanOrEqual(geometry.left - 1);
    expect(geometry.done.right).toBeLessThanOrEqual(geometry.right + 1);
    expect(geometry.done.top).toBeGreaterThanOrEqual(geometry.top - 1);
    expect(geometry.done.bottom).toBeLessThanOrEqual(geometry.bottom + 1);
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.scrollClientWidth + 1);
    await testInfo.attach(`${testInfo.project.name}-${sectionTool}-settings`, {
      body: await settings.screenshot(),
      contentType: "image/png"
    });
    await page.locator("#noteToolSettingsDoneBtn").click();
    await expect(settings).toBeHidden();
  };

  await openToolSettings("pen", "ペン設定");
  await openToolSettings("highlighter", "蛍光ペン設定");
  await openToolSettings("eraser-object", "消しゴム設定", "eraser-object");
  await openToolSettings("shape", "図形設定");
  await openToolSettings("text", "テキスト設定");
  await page.locator("#noteInputSettingsBtn").click();
  await expect(settings).toBeVisible();
  await expect(page.locator("#noteToolSettingsTitle")).toHaveText("入力設定");
  await expect(settings.locator("[data-setting-tools]:not(.hidden)")).toHaveCount(1);
  await expect(settings.locator('[data-setting-tools="input"]')).toBeVisible();
  for (const dock of ["top", "right", "bottom", "left"]) {
    await page.locator("#noteToolbarDock").selectOption(dock);
    await expect(settings).toHaveClass(new RegExp(`\\bdock-${dock}\\b`));
    const dockGeometry = await settings.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const viewportHeight = visualViewport?.height || innerHeight;
      return {
        compactLayout: matchMedia("(orientation: portrait), (max-width: 760px)").matches,
        height: rect.height,
        maxHeight: parseFloat(getComputedStyle(element).maxHeight),
        viewportHeight
      };
    });
    if (dockGeometry.compactLayout) {
      expect(dockGeometry.maxHeight).toBeLessThanOrEqual(dockGeometry.viewportHeight * .52 + 1);
      expect(dockGeometry.height).toBeLessThanOrEqual(dockGeometry.viewportHeight * .52 + 1);
    }
  }
  await testInfo.attach(`${testInfo.project.name}-input-settings`, {
    body: await settings.screenshot(), contentType: "image/png"
  });
  await page.locator("#noteToolSettingsDoneBtn").click();

  await page.locator('[data-note-tool="image"]').click();
  await expect(page.locator("#noteImageSourceMenu")).toBeVisible();
  await page.locator('[data-note-tool="pen"]').click();
  await expect(page.locator("#noteImageSourceMenu")).toBeHidden();
  await page.locator('[data-note-tool="image"]').click();
  const chooserPromise = page.waitForEvent("filechooser");
  await page.locator('[data-image-source="file"]').click();
  const chooser = await chooserPromise;
  await chooser.setFiles({ name: "menu.png", mimeType: "image/png", buffer: TEST_PNG });
  await expect(page.locator("#noteImageSourceMenu")).toBeHidden();
  await expect(page.locator("#notePageStage .note-image-element")).toHaveCount(1, { timeout: 20_000 });

  await page.locator('[data-note-tool="select"]').click();
  await page.locator("#notePageStage .note-image-element").click({ force: true });
  await expect(page.locator("#noteSelectionActions")).toBeVisible();
  await expect(page.locator("#noteSelectionActionsTitle")).toHaveText("画像を編集");
  await page.locator('[data-note-tool="image"]').click();
  await expect(page.locator("#noteImageSourceMenu")).toBeVisible();
  await expect(page.locator("#noteSelectionActions")).toBeHidden();
  await expect(page.locator("#notePageStage .note-transform-overlay")).toHaveCount(0);
  await page.locator('[data-note-tool="pen"]').click();
  await expect(page.locator("#noteImageSourceMenu")).toBeHidden();

  await page.locator('[data-note-tool="select"]').click();
  const imageBeforeViewportDismiss = await page.locator("#notePageStage .note-image-element").boundingBox();
  await page.locator("#notePageStage .note-image-element").click({ force: true });
  await page.locator('#noteSelectionActions [data-selection-action="crop"]').click();
  await expect(page.locator("#notePageStage .note-crop-overlay")).toBeVisible();
  const cropActions = page.locator("body > .note-crop-actions");
  await expect(cropActions).toBeVisible();
  await expect.poll(() => cropActions.evaluate(actions => {
    const rect = actions.getBoundingClientRect();
    const viewport = visualViewport;
    const left = viewport?.offsetLeft || 0;
    const top = viewport?.offsetTop || 0;
    const right = left + (viewport?.width || innerWidth);
    const bottom = top + (viewport?.height || innerHeight);
    return getComputedStyle(actions).position === "fixed" &&
      rect.left >= left && rect.top >= top && rect.right <= right && rect.bottom <= bottom;
  }), "crop操作をVisualViewport内へ固定する").toBe(true);
  await page.evaluate(() => {
    visualViewport?.dispatchEvent(new Event("resize"));
    visualViewport?.dispatchEvent(new Event("scroll"));
  });
  await expect.poll(() => cropActions.evaluate(actions => {
    const rect = actions.getBoundingClientRect();
    const viewport = visualViewport;
    const left = viewport?.offsetLeft || 0;
    const top = viewport?.offsetTop || 0;
    return rect.left >= left && rect.top >= top &&
      rect.right <= left + (viewport?.width || innerWidth) &&
      rect.bottom <= top + (viewport?.height || innerHeight);
  })).toBe(true);

  const cropHandle = await page.locator('[data-transform-handle="crop-w"]').boundingBox();
  await page.mouse.move(cropHandle.x + cropHandle.width / 2, cropHandle.y + cropHandle.height / 2);
  await page.mouse.down();
  await page.mouse.move(cropHandle.x + cropHandle.width / 2 + 24, cropHandle.y + cropHandle.height / 2, { steps: 4 });
  await page.mouse.up();
  const croppedBeforeGesture = await page.locator("#notePageStage .note-image-element").boundingBox();
  expect(croppedBeforeGesture.width).toBeLessThan(imageBeforeViewportDismiss.width);
  await page.locator("#notePageStage").dispatchEvent("gesturestart", { clientX: cropHandle.x, clientY: cropHandle.y, scale: 1 });
  await expect(page.locator("#notePageStage .note-crop-overlay"), "gesture開始時はcropをキャンセルする").toHaveCount(0);
  await expect(cropActions).toHaveCount(0);
  const imageAfterGesture = await page.locator("#notePageStage .note-image-element").boundingBox();
  expect(imageAfterGesture.width).toBeCloseTo(imageBeforeViewportDismiss.width, 0);
  await page.locator("#notePageStage").dispatchEvent("gestureend", { clientX: cropHandle.x, clientY: cropHandle.y, scale: 1 });

  await page.locator("#notePageStage .note-image-element").click({ force: true });
  await page.locator('#noteSelectionActions [data-selection-action="crop"]').click();
  await expect(page.locator("#notePageStage .note-crop-overlay")).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("orientationchange")));
  await expect(page.locator("#notePageStage .note-crop-overlay"), "画面回転時はcropをキャンセルする").toHaveCount(0);
  await expect(page.locator("body > .note-crop-actions")).toHaveCount(0);
  await page.locator('[data-note-tool="pen"]').click();

  const selectionBoundary = await page.evaluate(() => {
    const stage = document.querySelector("#notePageStage");
    const title = document.querySelector("#noteTitleInput");
    const stageEvent = new Event("selectstart", { bubbles: true, cancelable: true });
    const titleEvent = new Event("selectstart", { bubbles: true, cancelable: true });
    stage.dispatchEvent(stageEvent);
    title.dispatchEvent(titleEvent);
    const dragEvent = new Event("dragstart", { bubbles: true, cancelable: true });
    stage.dispatchEvent(dragEvent);
    return {
      stageSelectionPrevented: stageEvent.defaultPrevented,
      titleSelectionPrevented: titleEvent.defaultPrevented,
      stageDragPrevented: dragEvent.defaultPrevented
    };
  });
  expect(selectionBoundary).toEqual({
    stageSelectionPrevented: true,
    titleSelectionPrevented: false,
    stageDragPrevented: true
  });

  const beforeStrokeCount = await page.locator('#notePageStage path[data-element-id]').count();
  const stageBox = await page.locator("#notePageStage").boundingBox();
  expect(stageBox).toBeTruthy();
  for (let character = 0; character < 10; character += 1) {
    const column = character % 5;
    const row = Math.floor(character / 5);
    const originX = .13 + column * .15;
    const originY = .16 + row * .23;
    const strokes = [
      [[originX, originY], [originX + .035, originY + .035], [originX + .015, originY + .075]],
      [[originX + .06, originY], [originX + .085, originY + .04], [originX + .06, originY + .08]],
      [[originX + .02, originY + .1], [originX + .06, originY + .11], [originX + .095, originY + .1]]
    ];
    for (const [start, middle, end] of strokes) {
      await page.mouse.move(stageBox.x + stageBox.width * start[0], stageBox.y + stageBox.height * start[1]);
      await page.mouse.down();
      await page.mouse.move(stageBox.x + stageBox.width * middle[0], stageBox.y + stageBox.height * middle[1], { steps: 2 });
      await page.mouse.move(stageBox.x + stageBox.width * end[0], stageBox.y + stageBox.height * end[1], { steps: 2 });
      await page.mouse.up();
    }
  }
  await expect(page.locator('#notePageStage path[data-element-id]')).toHaveCount(beforeStrokeCount + 30);
  const cancelStart = { x: stageBox.x + stageBox.width * .2, y: stageBox.y + stageBox.height * .65 };
  await page.locator("#notePageStage").dispatchEvent("pointerdown", { pointerId: 91, pointerType: "pen", button: 0, clientX: cancelStart.x, clientY: cancelStart.y, pressure: .5 });
  await page.locator("#notePageStage").dispatchEvent("pointermove", { pointerId: 91, pointerType: "pen", button: 0, clientX: cancelStart.x + 40, clientY: cancelStart.y + 30, pressure: .5 });
  await page.locator("#notePageStage").dispatchEvent("pointercancel", { pointerId: 91, pointerType: "pen", button: 0, clientX: cancelStart.x + 40, clientY: cancelStart.y + 30, pressure: 0 });
  await expect(page.locator('#notePageStage path[data-element-id]')).toHaveCount(beforeStrokeCount + 31);
  await page.locator("#notePageStage").dispatchEvent("lostpointercapture", { pointerId: 91, pointerType: "pen" });
  await expect(page.locator('#notePageStage path[data-element-id]')).toHaveCount(beforeStrokeCount + 31);
  await page.locator("#notePageStage").dispatchEvent("pointerdown", { pointerId: 92, pointerType: "pen", button: 0, clientX: cancelStart.x, clientY: cancelStart.y + 50, pressure: .5 });
  await page.locator("#notePageStage").dispatchEvent("pointermove", { pointerId: 92, pointerType: "pen", button: 0, clientX: cancelStart.x + 40, clientY: cancelStart.y + 80, pressure: .5 });
  await expect(page.locator('#notePageStage [data-note-draft]:not([data-note-draft="settled"])')).toHaveCount(1);
  await page.locator("#notePageStage").dispatchEvent("gesturestart", { clientX: cancelStart.x + 20, clientY: cancelStart.y + 65, scale: 1 });
  await expect(page.locator('#notePageStage [data-note-draft]:not([data-note-draft="settled"])'), "Pencil接触中のnative gestureはstroke所有権を奪わない").toHaveCount(1);
  await expect(page.locator('#notePageStage path[data-element-id]')).toHaveCount(beforeStrokeCount + 31);
  await page.locator("#notePageStage").dispatchEvent("gestureend", { clientX: cancelStart.x + 20, clientY: cancelStart.y + 65, scale: 1 });
  await page.locator("#notePageStage").dispatchEvent("pointerup", { pointerId: 92, pointerType: "pen", button: 0, clientX: cancelStart.x + 45, clientY: cancelStart.y + 82, pressure: 0 });
  await expect(page.locator('#notePageStage path[data-element-id]')).toHaveCount(beforeStrokeCount + 32);
  await expect(page.locator("#noteEditorView")).not.toHaveCSS("user-select", "text");
  await expect(page.locator("#noteSaveStatus")).not.toHaveAttribute("data-state", "conflict");

  const viewportContract = await page.evaluate(() => ({
    meta: document.querySelector('meta[name="viewport"]')?.content || "",
    htmlPosition: getComputedStyle(document.documentElement).position,
    bodyPosition: getComputedStyle(document.body).position,
    titleFontSize: parseFloat(getComputedStyle(document.querySelector("#noteTitleInput")).fontSize),
    headerTouchAction: getComputedStyle(document.querySelector(".note-editor-header")).touchAction,
    toolbarTouchAction: getComputedStyle(document.querySelector(".note-toolbar")).touchAction
  }));
  expect(viewportContract.meta).toContain("maximum-scale=1");
  expect(viewportContract.meta).toContain("user-scalable=no");
  expect(viewportContract.htmlPosition).toBe("fixed");
  expect(viewportContract.bodyPosition).toBe("fixed");
  expect(viewportContract.titleFontSize).toBeGreaterThanOrEqual(16);
  expect(viewportContract.headerTouchAction).toBe("manipulation");
  expect(viewportContract.toolbarTouchAction).toBe("manipulation");

  await page.locator("#noteTitleInput").focus();
  await expect.poll(() => page.evaluate(() => visualViewport?.scale || 1)).toBe(1);
  await page.locator("#noteViewport").dispatchEvent("wheel", {
    ctrlKey: true, deltaY: -180, clientX: stageBox.x + 100, clientY: stageBox.y + 100
  });
  await expect.poll(() => page.locator("#notePageStage").evaluate(element => element.style.transform)).not.toBe("scale(1)");

  await page.locator("#noteMoreMenu summary").click();
  await page.locator('[data-note-action="reset-view"]').click();
  await expect.poll(() => page.evaluate(() => ({
    transform: document.querySelector("#notePageStage").style.transform,
    left: document.querySelector("#noteViewport").scrollLeft,
    top: document.querySelector("#noteViewport").scrollTop
  }))).toEqual({ transform: "scale(1)", left: 0, top: 0 });
  await expect(page.locator("#noteSaveStatus")).toHaveAttribute("data-state", "saved", { timeout: 20_000 });

  await expect(page.locator("#localEnvironmentToggle")).toBeVisible();
  await expect(page.locator("#localEnvironmentDetails")).toBeHidden();
  const localChip = await page.locator("#localEnvironmentToggle").boundingBox();
  expect(localChip.width).toBeLessThanOrEqual(80);
  expect(localChip.height).toBeLessThanOrEqual(44);
  expect(blockedRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test("@authenticated @ipad-transient-ui ペンcapture layer上の2本指pinchはtouchを伝播し、進行中の指ストロークだけを破棄する", async ({ page }) => {
  test.setTimeout(90_000);
  const user = await createUser();
  await login(page, user);
  await page.locator("#newNoteBtn").click();
  await page.locator("#newNoteTitle").fill("指描画ピンチ取消E2Eノート");
  page = await openEditorPopup(page, () => page.locator('[data-create-note="blank"]').click());

  await page.locator("#noteInputSettingsBtn").click();
  await expect(page.locator("#noteFingerDraw")).toBeChecked();
  await page.locator("#noteToolSettingsDoneBtn").click();

  const stage = page.locator("#notePageStage");
  const capture = stage.locator('[data-layer="drawing-input"]');
  await expect(capture).toHaveClass(/active/);
  const box = await stage.boundingBox();
  expect(box).toBeTruthy();
  const point = (x, y) => ({ clientX: box.x + box.width * x, clientY: box.y + box.height * y });
  const before = await stage.locator("path[data-element-id]").count();

  await capture.dispatchEvent("pointerdown", {
    pointerId: 201, pointerType: "touch", button: 0, ...point(.2, .25), width: 8, height: 8, pressure: .5
  });
  await capture.dispatchEvent("pointermove", {
    pointerId: 201, pointerType: "touch", button: 0, ...point(.32, .36), width: 8, height: 8, pressure: .5
  });
  await expect(stage.locator('[data-note-draft]:not([data-note-draft="settled"])')).toHaveCount(1);
  await capture.dispatchEvent("pointerdown", {
    pointerId: 202, pointerType: "touch", button: 0, ...point(.72, .68), width: 8, height: 8, pressure: .5
  });
  await expect(stage.locator("[data-note-draft]")).toHaveCount(0);
  await capture.dispatchEvent("pointermove", {
    pointerId: 202, pointerType: "touch", button: 0, ...point(.9, .82), width: 8, height: 8, pressure: .5
  });
  await expect.poll(() => stage.evaluate(node => Number(getComputedStyle(node).getPropertyValue("--page-zoom")))).toBeGreaterThan(1);
  await capture.dispatchEvent("pointercancel", {
    pointerId: 201, pointerType: "touch", button: 0, ...point(.32, .36), width: 8, height: 8, pressure: 0
  });
  await capture.dispatchEvent("pointercancel", {
    pointerId: 202, pointerType: "touch", button: 0, ...point(.72, .68), width: 8, height: 8, pressure: 0
  });
  await expect(stage.locator("path[data-element-id]")).toHaveCount(before);
});

test("@authenticated @ipad-transient-ui 単独touch cancelは破棄し、pen cancelと次のpen開始は有効ストロークだけを一度確定する", async ({ page }) => {
  test.setTimeout(90_000);
  const user = await createUser();
  await login(page, user);
  await page.locator("#newNoteBtn").click();
  await page.locator("#newNoteTitle").fill("単独cancel確定E2Eノート");
  page = await openEditorPopup(page, () => page.locator('[data-create-note="blank"]').click());

  const stage = page.locator("#notePageStage");
  const box = await stage.boundingBox();
  expect(box).toBeTruthy();
  const point = (x, y) => ({ clientX: box.x + box.width * x, clientY: box.y + box.height * y });
  const before = await stage.locator("path[data-element-id]").count();
  const cancelStroke = async (pointerId, pointerType, start, end) => {
    await stage.dispatchEvent("pointerdown", {
      pointerId, pointerType, button: 0, ...start, width: 2, height: 2, pressure: .5
    });
    await stage.dispatchEvent("pointermove", {
      pointerId, pointerType, button: 0, ...end, width: 2, height: 2, pressure: .5
    });
    await stage.dispatchEvent("pointercancel", {
      pointerId, pointerType, button: 0, ...end, width: 2, height: 2, pressure: 0
    });
  };

  await cancelStroke(210, "touch", point(.14, .12), point(.3, .2));
  await expect(stage.locator("path[data-element-id]"), "単独touchのcancelは描画を確定しない").toHaveCount(before);
  await cancelStroke(211, "pen", point(.2, .28), point(.36, .36));
  await expect(stage.locator("path[data-element-id]")).toHaveCount(before + 1);
  await page.locator('[data-note-tool="highlighter"]').click();
  await cancelStroke(212, "pen", point(.2, .48), point(.42, .56));
  await expect(stage.locator("path[data-element-id]")).toHaveCount(before + 2);

  await stage.dispatchEvent("pointerdown", {
    pointerId: 213, pointerType: "pen", button: 0, ...point(.18, .62), width: 2, height: 2, pressure: .5
  });
  await stage.dispatchEvent("pointermove", {
    pointerId: 213, pointerType: "pen", button: 0, ...point(.38, .68), width: 2, height: 2, pressure: .5
  });
  await expect(stage.locator('[data-note-draft]:not([data-note-draft="settled"])')).toHaveCount(1);
  await stage.dispatchEvent("pointerdown", {
    pointerId: 214, pointerType: "pen", button: 0, ...point(.2, .76), width: 2, height: 2, pressure: .5
  });
  await expect(stage.locator("path[data-element-id]"), "pointerupが欠落した旧pen strokeを次のpen開始時に確定する").toHaveCount(before + 3);
  await stage.dispatchEvent("pointerup", {
    pointerId: 213, pointerType: "pen", button: 0, ...point(.38, .68), width: 2, height: 2, pressure: 0
  });
  await stage.dispatchEvent("lostpointercapture", { pointerId: 213, pointerType: "pen" });
  await expect(stage.locator("path[data-element-id]"), "遅延した旧pointer終了イベントでは二重確定しない").toHaveCount(before + 3);
  await stage.dispatchEvent("pointermove", {
    pointerId: 214, pointerType: "pen", button: 0, ...point(.4, .82), width: 2, height: 2, pressure: .5
  });
  await stage.dispatchEvent("pointerup", {
    pointerId: 214, pointerType: "pen", button: 0, ...point(.4, .82), width: 2, height: 2, pressure: 0
  });
  await expect(stage.locator("path[data-element-id]")).toHaveCount(before + 4);

  await page.locator('[data-note-tool="pen"]').click();
  await stage.dispatchEvent("pointerdown", {
    pointerId: 215, pointerType: "pen", button: 0, ...point(.52, .68), width: 2, height: 2, pressure: .5
  });
  await stage.dispatchEvent("pointerup", {
    pointerId: 215, pointerType: "pen", button: 0, ...point(.58, .72), width: 2, height: 2, pressure: 0
  });
  await expect(stage.locator("path[data-element-id]"), "pointermoveなしでもpointerup終端を含む短い1画を確定する").toHaveCount(before + 5);
  await expect(page.locator("#noteSaveStatus")).toHaveAttribute("data-state", "saved", { timeout: 20_000 });
});

test("@authenticated @ipad-input-core moveなしの1点strokeはドラフトと確定表示の位置・大きさが一致する", async ({ page }) => {
  test.setTimeout(90_000);
  const user = await createUser();
  await login(page, user);
  await page.locator("#newNoteBtn").click();
  await page.locator("#newNoteTitle").fill("単一点プレビュー一致E2Eノート");
  page = await openEditorPopup(page, () => page.locator('[data-create-note="blank"]').click());

  const stage = page.locator("#notePageStage");
  const capture = stage.locator('[data-layer="drawing-input"]');
  const box = await stage.boundingBox();
  expect(box).toBeTruthy();
  const point = { clientX: box.x + box.width * .42, clientY: box.y + box.height * .36 };

  await capture.dispatchEvent("pointerdown", {
    pointerId: 216, pointerType: "pen", button: 0, buttons: 1, ...point, width: 2, height: 2, pressure: .5
  });
  const draftDot = stage.locator('[data-note-draft]:not([data-note-draft="settled"]) circle.note-draft-dot');
  await expect(draftDot).toHaveCount(1);
  const draftBox = await draftDot.boundingBox();
  expect(draftBox).toBeTruthy();

  await capture.dispatchEvent("pointerup", {
    pointerId: 216, pointerType: "pen", button: 0, buttons: 0, ...point, width: 2, height: 2, pressure: 0
  });
  const settledDot = stage.locator('[data-layer="elements"] circle[data-element-id]');
  await expect(settledDot).toHaveCount(1, { timeout: 20_000 });
  const settledBox = await settledDot.boundingBox();
  expect(settledBox).toBeTruthy();
  for (const key of ["x", "y", "width", "height"]) {
    expect(Math.abs(draftBox[key] - settledBox[key]), `${key}の差を2px以内に保つ`).toBeLessThanOrEqual(2);
  }
});

test("@authenticated @ipad-input-core 連続筆記中はページ全体の保存処理を保留し、確定形状のdraftを休止後にまとめて確定する", async ({ page }) => {
  test.setTimeout(90_000);
  const user = await createUser();
  await login(page, user);
  await page.locator("#newNoteBtn").click();
  await page.locator("#newNoteTitle").fill("連続筆記保留E2Eノート");
  page = await openEditorPopup(page, () => page.locator('[data-create-note="blank"]').click());
  await expect(page.locator("#noteSaveStatus")).toHaveAttribute("data-state", "saved", { timeout: 20_000 });
  await page.evaluate(() => {
    window.__notePageDraftPuts = [];
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function recordPageDraftPut(...args) {
      if (this.name === "pageDrafts") window.__notePageDraftPuts.push(performance.now());
      return put.apply(this, args);
    };
  });

  const stage = page.locator("#notePageStage");
  const capture = stage.locator('[data-layer="drawing-input"]');
  const box = await stage.boundingBox();
  expect(box).toBeTruthy();
  const point = (x, y) => ({ clientX: box.x + box.width * x, clientY: box.y + box.height * y });
  const writeStroke = async (pointerId, row) => {
    const y = .2 + row * .08;
    await capture.dispatchEvent("pointerdown", {
      pointerId, pointerType: "pen", button: 0, buttons: 1, ...point(.2, y), width: 2, height: 2, pressure: .5
    });
    for (let step = 1; step <= 6; step += 1) {
      await capture.dispatchEvent("pointermove", {
        pointerId, pointerType: "pen", button: 0, buttons: 1,
        ...point(.2 + step * .05, y + (step % 2 ? .012 : -.012)), width: 2, height: 2, pressure: .5
      });
    }
    await capture.dispatchEvent("pointerup", {
      pointerId, pointerType: "pen", button: 0, buttons: 0, ...point(.5, y), width: 2, height: 2, pressure: 0
    });
  };

  // 画の間隔（0.4秒）は、改訂2までの保存予約（220ms）を超え、休止判定（1秒）には届かない。
  for (let index = 0; index < 5; index += 1) {
    await writeStroke(3100 + index, index);
    await page.waitForTimeout(400);
  }
  const settled = stage.locator('[data-note-draft="settled"] path[data-element-id]');
  await expect(settled, "書込み中の画は確定形状のdraftで表示する").toHaveCount(5);
  expect(
    await page.evaluate(() => window.__notePageDraftPuts.length),
    "書込み中はページ全体の端末内下書き保存を行わない"
  ).toBe(0);
  const settledPath = await settled.first().getAttribute("d");
  expect(settledPath, "筆跡は中点を結ぶ曲線で描く").toMatch(/ Q /);

  await expect.poll(() => page.evaluate(() => window.__notePageDraftPuts.length), { timeout: 10_000 }).toBeGreaterThan(0);
  const committed = stage.locator('[data-layer="elements"] path[data-element-id]');
  await expect(committed, "休止後に5画を1回でまとめて確定する").toHaveCount(5);
  await expect(stage.locator('[data-note-draft="settled"]')).toHaveCount(0);
  expect(await committed.first().getAttribute("d"), "確定前後で線の形を変えない").toBe(settledPath);
  await expect(page.locator("#noteSaveStatus")).toHaveAttribute("data-state", "saved", { timeout: 20_000 });
});

test("@authenticated @ipad-input-core Apple Pencilのtouchはページで確保し、指とテキスト入力は妨げない", async ({ page }) => {
  test.setTimeout(90_000);
  const user = await createUser();
  await login(page, user);
  await page.locator("#newNoteBtn").click();
  await page.locator("#newNoteTitle").fill("Scribble抑止E2Eノート");
  page = await openEditorPopup(page, () => page.locator('[data-create-note="blank"]').click());
  const stage = page.locator("#notePageStage");
  await expect(stage.locator('[data-layer="drawing-input"]')).toHaveClass(/active/);
  // Chromium has no Touch.touchType; emulate WebKit's property so the same
  // listener path that iPad Safari runs can be checked here.
  await page.evaluate(() => {
    const stylusTouches = new WeakSet();
    globalThis.__noteStylusTouches = stylusTouches;
    Object.defineProperty(Touch.prototype, "touchType", {
      configurable: true,
      get() { return stylusTouches.has(this) ? "stylus" : "direct"; }
    });
  });
  const dispatchTouches = () => page.evaluate(() => {
    const layer = document.querySelector('#notePageStage [data-layer="drawing-input"]');
    const rect = layer.getBoundingClientRect();
    let identifier = 1;
    const fire = (type, stylus) => {
      const touch = new Touch({
        identifier: identifier++,
        target: layer,
        clientX: rect.left + rect.width * .4,
        clientY: rect.top + rect.height * .4
      });
      if (stylus) globalThis.__noteStylusTouches.add(touch);
      const event = new TouchEvent(type, {
        touches: [touch], targetTouches: [touch], changedTouches: [touch], bubbles: true, cancelable: true
      });
      layer.dispatchEvent(event);
      return event.defaultPrevented;
    };
    return {
      stylusStart: fire("touchstart", true),
      stylusMove: fire("touchmove", true),
      fingerStart: fire("touchstart", false),
      fingerMove: fire("touchmove", false)
    };
  });

  expect(await dispatchTouches(), "Pencilだけを確保して指のpan・pinchは残す").toEqual({
    stylusStart: true, stylusMove: true, fingerStart: false, fingerMove: false
  });
  await page.locator('[data-note-tool="text"]').click();
  expect(await dispatchTouches(), "テキストツールではScribbleの手書き入力を妨げない").toEqual({
    stylusStart: false, stylusMove: false, fingerStart: false, fingerMove: false
  });
});

test("@authenticated @ipad-input-core stable入力面は0〜32ms間隔の1点・交差strokeと残留touch後のpenを欠落させない", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const user = await createUser();
  await login(page, user);
  await page.locator("#newNoteBtn").click();
  await page.locator("#newNoteTitle").fill("高速Pencil診断E2Eノート");
  page = await openEditorPopup(page, () => page.locator('[data-create-note="blank"]').click());
  const debugUrl = new URL(page.url());
  debugUrl.searchParams.set("inputDebug", "1");
  await page.goto(debugUrl.toString(), { waitUntil: "domcontentloaded" });
  await expect(page.locator("#noteEditorStartup")).toBeHidden({ timeout: 30_000 });
  await expect(page.locator("#noteInputDebugPanel")).toBeVisible();

  const stage = page.locator("#notePageStage");
  const capture = stage.locator('[data-layer="drawing-input"]');
  await expect(capture).toHaveClass(/active/);
  const box = await stage.boundingBox();
  expect(box).toBeTruthy();
  await capture.evaluate(async (node, bounds) => {
    const fire = (type, pointerId, x, y, pressure) => node.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId, pointerType: "pen", button: 0,
      clientX: bounds.x + bounds.width * x, clientY: bounds.y + bounds.height * y,
      width: 2, height: 2, pressure
    }));
    for (const [group, interval] of [0, 4, 8, 16, 32].entries()) {
      for (let index = 0; index < 100; index += 1) {
        const pointerId = 400 + group * 100 + index;
        fire("pointerdown", pointerId, .3, .3, .5);
        fire("pointerup", pointerId, .3, .3, 0);
        if (interval) await new Promise(resolve => setTimeout(resolve, interval));
      }
    }
    for (let index = 0; index < 100; index += 1) {
      const horizontal = index % 2 === 0;
      fire("pointerdown", 1000 + index, horizontal ? .2 : .5, horizontal ? .5 : .2, .5);
      fire("pointermove", 1000 + index, horizontal ? .8 : .5, horizontal ? .5 : .8, .5);
      fire("pointerup", 1000 + index, horizontal ? .8 : .5, horizontal ? .5 : .8, 0);
    }
  }, box);

  const rawUpdateSupported = await capture.evaluate((node, bounds) => {
    if (!("onpointerrawupdate" in window)) return false;
    const fire = (type, x, y, pressure) => node.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 899, pointerType: "pen", button: 0,
      clientX: bounds.x + bounds.width * x, clientY: bounds.y + bounds.height * y,
      width: 2, height: 2, pressure
    }));
    fire("pointerdown", .2, .9, .5);
    fire("pointerrawupdate", .7, .9, .5);
    fire("lostpointercapture", .7, .9, 0);
    return true;
  }, box);

  await capture.dispatchEvent("pointermove", {
    pointerId: 1898, pointerType: "pen", button: 0, buttons: 1,
    clientX: box.x + box.width * .16, clientY: box.y + box.height * .82,
    width: 2, height: 2, pressure: .5
  });
  await capture.dispatchEvent("pointerdown", {
    pointerId: 1898, pointerType: "pen", button: 0, buttons: 1,
    clientX: box.x + box.width * .14, clientY: box.y + box.height * .8,
    width: 2, height: 2, pressure: .5
  });
  await capture.dispatchEvent("pointermove", {
    pointerId: 1898, pointerType: "pen", button: 0, buttons: 1,
    clientX: box.x + box.width * .36, clientY: box.y + box.height * .86,
    width: 2, height: 2, pressure: .5
  });
  await capture.dispatchEvent("pointerup", {
    pointerId: 1898, pointerType: "pen", button: 0, buttons: 0,
    clientX: box.x + box.width * .36, clientY: box.y + box.height * .86,
    width: 2, height: 2, pressure: 0
  });
  const missingDownPointerId = 1899;
  await capture.dispatchEvent("pointermove", {
    pointerId: missingDownPointerId, pointerType: "pen", button: 0, buttons: 1,
    clientX: box.x + box.width * .2, clientY: box.y + box.height * .72,
    width: 2, height: 2, pressure: .5
  });
  await capture.dispatchEvent("pointerup", {
    pointerId: missingDownPointerId, pointerType: "pen", button: 0, buttons: 0,
    clientX: box.x + box.width * .26, clientY: box.y + box.height * .74,
    width: 2, height: 2, pressure: 0
  });
  await new Promise(resolve => setTimeout(resolve, 4));
  await capture.dispatchEvent("pointermove", {
    pointerId: missingDownPointerId, pointerType: "pen", button: 0, buttons: 1,
    clientX: box.x + box.width * .32, clientY: box.y + box.height * .74,
    width: 2, height: 2, pressure: .5
  });
  await capture.dispatchEvent("pointerup", {
    pointerId: missingDownPointerId, pointerType: "pen", button: 0, buttons: 0,
    clientX: box.x + box.width * .38, clientY: box.y + box.height * .76,
    width: 2, height: 2, pressure: 0
  });
  await stage.dispatchEvent("pointerdown", {
    pointerId: 900, pointerType: "touch", button: 0,
    clientX: box.x + box.width * .4, clientY: box.y + box.height * .4,
    width: 16, height: 16, pressure: .5
  });
  await capture.dispatchEvent("pointerdown", {
    pointerId: 901, pointerType: "pen", button: 0,
    clientX: box.x + box.width * .55, clientY: box.y + box.height * .55,
    width: 2, height: 2, pressure: .5
  });
  await capture.dispatchEvent("pointerup", {
    pointerId: 901, pointerType: "pen", button: 0,
    clientX: box.x + box.width * .55, clientY: box.y + box.height * .55,
    width: 2, height: 2, pressure: 0
  });
  await stage.dispatchEvent("pointerup", {
    pointerId: 900, pointerType: "touch", button: 0,
    clientX: box.x + box.width * .4, clientY: box.y + box.height * .4,
    width: 16, height: 16, pressure: 0
  });

  const expectedPointerdownCount = 602 + Number(rawUpdateSupported);
  const expectedStrokeCount = expectedPointerdownCount + 2;
  const diagnostics = page.locator("#noteInputDebugValues");
  await expect(diagnostics).toContainText("pen pointerdown");
  await testInfo.attach("input-diagnostics.txt", {
    body: Buffer.from(await diagnostics.innerText(), "utf8"),
    contentType: "text/plain"
  });
  await expect(diagnostics.locator("dt", { hasText: "pen pointerdown" }).locator("+ dd"))
    .toHaveText(String(expectedPointerdownCount));
  await expect(diagnostics.locator("dt", { hasText: "確定stroke" }).locator("+ dd"))
    .toHaveText(String(expectedStrokeCount));
  await expect(diagnostics.locator("dt", { hasText: "孤立session復旧" }).locator("+ dd"))
    .toHaveText("3");
  await expect(diagnostics.locator("dt").filter({ hasText: /^contact move復旧$/ }).locator("+ dd"))
    .toHaveText("3");
  for (const label of ["window capture", "document capture", "editor capture", "stage capture", "drawing surface", "capture gate通過"]) {
    await expect(diagnostics.locator("dt", { hasText: label }).locator("+ dd"))
      .toHaveText(String(expectedPointerdownCount));
  }
  await expect(stage.locator("[data-element-id]")).toHaveCount(expectedStrokeCount, { timeout: 30_000 });
  await expect(page.locator("#noteSaveStatus")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
  await expect(stage.locator("circle[data-element-id]"), "rawupdateは確定点にせず1点strokeを丸い点として残す")
    .toHaveCount(501 + Number(rawUpdateSupported), { timeout: 10_000 });
  await expect(diagnostics).toContainText("破棄stroke");
  await expect(diagnostics).toContainText("0");
  if (rawUpdateSupported) {
    await expect(diagnostics.locator("dt", { hasText: "raw update" }).locator("+ dd")).toHaveText("1");
  }
  for (const [index, tool] of ["select", "shape", "text"].entries()) {
    await page.locator(`[data-note-tool="${tool}"]`).click();
    await expect(capture).not.toHaveClass(/active/);
    const pointerId = 2200 + index;
    await stage.dispatchEvent("pointerdown", {
      pointerId, pointerType: "pen", button: 0,
      clientX: box.x + box.width * (.2 + index * .1), clientY: box.y + box.height * .2,
      width: 2, height: 2, pressure: .5
    });
    await stage.dispatchEvent("pointercancel", {
      pointerId, pointerType: "pen", button: 0,
      clientX: box.x + box.width * (.2 + index * .1), clientY: box.y + box.height * .2,
      width: 2, height: 2, pressure: 0
    });
  }
  await expect(diagnostics.locator("dt", { hasText: "capture gate除外" }).locator("+ dd")).toHaveText("3");
  await expect(diagnostics.locator("dt", { hasText: "capture gate通過" }).locator("+ dd"))
    .toHaveText(String(expectedPointerdownCount));
  await expect(diagnostics.locator("dt", { hasText: "確定stroke" }).locator("+ dd"))
    .toHaveText(String(expectedStrokeCount));

  await page.locator('[data-note-tool="pen"]').click();
  const debugPanel = page.locator("#noteInputDebugPanel");
  const timingLabels = ["pointerdown最大", "pointermove最大", "pointerup最大"];
  const hotPathRuns = [];
  for (let run = 0; run < 3; run += 1) {
    await capture.dispatchEvent("pointerdown", {
      pointerId: 2300 + run, pointerType: "pen", button: 0, buttons: 1,
      clientX: box.x + box.width * .42, clientY: box.y + box.height * .32,
      width: 2, height: 2, pressure: .5
    });
    await capture.dispatchEvent("pointerup", {
      pointerId: 2300 + run, pointerType: "pen", button: 0, buttons: 0,
      clientX: box.x + box.width * .43, clientY: box.y + box.height * .33,
      width: 2, height: 2, pressure: 0
    });
    await debugPanel.dispatchEvent("noteinputdebugresethotpath");
    await capture.evaluate((node, { bounds, runIndex }) => {
      const fire = (type, pointerId, x, y, pressure) => node.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId, pointerType: "pen", button: 0,
        buttons: type === "pointerup" ? 0 : 1,
        clientX: bounds.x + bounds.width * x, clientY: bounds.y + bounds.height * y,
        width: 2, height: 2, pressure
      }));
      for (let index = 0; index < 20; index += 1) {
        const pointerId = 2400 + runIndex * 20 + index;
        const y = .36 + index / 1000;
        fire("pointerdown", pointerId, .4, y, .5);
        fire("pointermove", pointerId, .44, y + .01, .5);
        fire("pointerup", pointerId, .46, y + .015, 0);
      }
    }, { bounds: box, runIndex: run });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const timings = {};
    for (const label of timingLabels) {
      timings[label] = Number((await diagnostics.locator("dt", { hasText: label }).locator("+ dd").textContent()).replace("ms", ""));
      expect(timings[label], `${label} run ${run + 1}は1フレーム未満`).toBeLessThan(16.7);
    }
    hotPathRuns.push(timings);
  }
  const hotPathMedians = Object.fromEntries(timingLabels.map(label => [
    label,
    hotPathRuns.map(run => run[label]).sort((left, right) => left - right)[1]
  ]));
  for (const [label, value] of Object.entries(hotPathMedians)) {
    expect(value, `${label}の3回中央値は8ms以内`).toBeLessThanOrEqual(8);
  }
  const hotPathMetrics = { runs: hotPathRuns, medians: hotPathMedians };
  console.log(`INPUT_HOTPATH_METRICS ${JSON.stringify(hotPathMetrics)}`);
  await testInfo.attach("input-hotpath-metrics.json", {
    body: Buffer.from(JSON.stringify(hotPathMetrics, null, 2), "utf8"),
    contentType: "application/json"
  });
  await expect(page.locator("#noteSaveStatus")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
});

test("@authenticated @ipad-input-core ツール切替中の同一pointerIdを三入力経路で二重処理しない", async ({ page }) => {
  test.setTimeout(90_000);
  const user = await createUser();
  await login(page, user);
  await page.locator("#newNoteBtn").click();
  await page.locator("#newNoteTitle").fill("入力経路排他E2Eノート");
  page = await openEditorPopup(page, () => page.locator('[data-create-note="blank"]').click());
  const debugUrl = new URL(page.url());
  debugUrl.searchParams.set("inputDebug", "1");
  await page.goto(debugUrl.toString(), { waitUntil: "domcontentloaded" });
  await expect(page.locator("#noteEditorStartup")).toBeHidden({ timeout: 30_000 });

  const stage = page.locator("#notePageStage");
  const capture = stage.locator('[data-layer="drawing-input"]');
  const diagnostics = page.locator("#noteInputDebugValues");
  const metric = label => diagnostics.locator("dt", { hasText: label }).locator("+ dd");
  const box = await stage.boundingBox();
  expect(box).toBeTruthy();
  const point = (x, y) => ({
    clientX: box.x + box.width * x,
    clientY: box.y + box.height * y,
    width: 2,
    height: 2
  });

  await expect(capture).toHaveClass(/active/);
  const sharedPointerId = 2601;
  await capture.dispatchEvent("pointerdown", {
    pointerId: sharedPointerId, pointerType: "pen", button: 0, buttons: 1,
    ...point(.2, .22), pressure: .5
  });
  await expect(metric("stage capture")).toHaveText("1");
  await expect(metric("drawing surface")).toHaveText("1");
  await expect(metric("capture gate通過")).toHaveText("1");
  await expect(metric("strokeSession")).toHaveText("1");

  await page.locator('[data-note-tool="select"]').click();
  await expect(capture).not.toHaveClass(/active/);
  await stage.dispatchEvent("pointermove", {
    pointerId: sharedPointerId, pointerType: "pen", button: 0, buttons: 1,
    ...point(.32, .27), pressure: .5
  });
  await stage.dispatchEvent("pointermove", {
    pointerId: sharedPointerId, pointerType: "touch", button: 0, buttons: 1,
    ...point(.36, .3), pressure: .5
  });
  await stage.dispatchEvent("pointerup", {
    pointerId: sharedPointerId, pointerType: "touch", button: 0, buttons: 0,
    ...point(.36, .3), pressure: 0
  });
  await expect(metric("stage capture"), "無効化後のpen moveは新しいcapture経路を作らない").toHaveText("1");
  await expect(metric("strokeSession"), "pointerType切替後も同一pointerIdを復旧しない").toHaveText("1");
  await expect(metric("確定stroke")).toHaveText("0");
  await expect(metric("破棄stroke")).toHaveText("1");
  await expect(metric("active pointer")).toHaveText("なし");

  await page.locator('[data-note-tool="pen"]').click();
  await expect(capture).toHaveClass(/active/);
  await page.locator("#noteInputSettingsBtn").click();
  await expect(page.locator("#noteFingerDraw")).not.toBeChecked();
  await page.locator("#noteFingerDraw").check();
  await expect(page.locator("#noteFingerDraw")).toBeChecked();
  await page.locator("#noteToolSettingsDoneBtn").click();

  await capture.dispatchEvent("pointerdown", {
    pointerId: 2602, pointerType: "mouse", button: 0, buttons: 1,
    ...point(.2, .42), pressure: .5
  });
  await capture.dispatchEvent("pointermove", {
    pointerId: 2602, pointerType: "mouse", button: 0, buttons: 1,
    ...point(.42, .46), pressure: .5
  });
  await capture.dispatchEvent("pointerup", {
    pointerId: 2602, pointerType: "mouse", button: 0, buttons: 0,
    ...point(.42, .46), pressure: 0
  });
  await expect(metric("strokeSession"), "drawing layer bubbleは1回だけsessionを作る").toHaveText("2");
  await expect(metric("確定stroke")).toHaveText("1");

  // Pencil終了直後の単独touchを抑止する350msのpalm guardを越えてから、
  // capture layerを通過してstage bubbleへ届く指描画経路を検証する。
  await page.waitForTimeout(400);
  await capture.dispatchEvent("pointerdown", {
    pointerId: sharedPointerId, pointerType: "touch", button: 0, buttons: 1,
    ...point(.2, .62), pressure: .5
  });
  await capture.dispatchEvent("pointermove", {
    pointerId: sharedPointerId, pointerType: "touch", button: 0, buttons: 1,
    ...point(.23, .76), pressure: .5
  });
  await capture.dispatchEvent("pointerup", {
    pointerId: sharedPointerId, pointerType: "touch", button: 0, buttons: 0,
    ...point(.23, .76), pressure: 0
  });

  for (const label of ["window capture", "document capture", "editor capture", "stage capture", "drawing surface", "capture gate通過"]) {
    await expect(metric(label), `${label}は最初のpen downだけを数える`).toHaveText("1");
  }
  await expect(metric("capture gate除外")).toHaveText("0");
  await expect(metric("pen pointerdown"), "三経路は各1回だけbeginPointerへ到達する").toHaveText("3");
  await expect(metric("strokeSession"), "三経路は各1回だけsessionを作る").toHaveText("3");
  await expect(metric("確定stroke"), "mouseとtouchを各1回だけ確定する").toHaveText("2");
  await expect(metric("破棄stroke"), "ツール切替で中断したpenだけを破棄する").toHaveText("1");
  await expect(metric("孤立session復旧")).toHaveText("0");
  await expect(metric("active pointer")).toHaveText("なし");
  await expect(stage.locator("[data-element-id]"), "二重経路によるstroke増殖がない").toHaveCount(2);
  await expect(page.locator("#noteSaveStatus")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
});

test("@authenticated @ipad-input-core 横長PDFで背景・描画・入力・カーソル・選択・crop・textを同じページ座標へ固定する", async ({ page }) => {
  test.setTimeout(120_000);
  const user = await createUser();
  const note = await seedReadyNote(user.uid, "横長PDF座標E2Eノート");
  await seedNotePageBackground(user.uid, note.noteId, note.pageId, {
    image: createRgbPng(2000, 1000),
    size: { width: 2000, height: 1000 }
  });
  await login(page, user);
  await page.goto(`/?firebaseEmulator=1&inputDebug=1&noteEditor=1&noteId=${note.noteId}&editorTabId=${crypto.randomUUID()}`, {
    waitUntil: "domcontentloaded"
  });
  await expect(page.locator("#noteEditorStartup")).toBeHidden({ timeout: 30_000 });

  const stage = page.locator("#notePageStage");
  const capture = stage.locator('[data-layer="drawing-input"]');
  await expect(capture).toHaveClass(/active/);
  await expect(stage.locator(".note-background-image")).toBeVisible();
  const box = await stage.boundingBox();
  expect(box).toBeTruthy();
  expect(box.width / box.height).toBeCloseTo(2, 2);
  const point = (x, y) => ({ clientX: box.x + box.width * x, clientY: box.y + box.height * y });

  await capture.dispatchEvent("pointerdown", {
    pointerId: 2301, pointerType: "pen", button: 0, buttons: 1, ...point(.18, .2), pressure: .5
  });
  await capture.dispatchEvent("pointermove", {
    pointerId: 2301, pointerType: "pen", button: 0, buttons: 1, ...point(.76, .72), pressure: .5
  });
  await expect(stage.locator('[data-note-draft]:not([data-note-draft="settled"])')).toHaveCount(1);
  const pageLayerDeltas = await stage.evaluate(root => {
    const rootRect = root.getBoundingClientRect();
    const delta = node => {
      const rect = node.getBoundingClientRect();
      return Math.max(
        Math.abs(rect.left - rootRect.left),
        Math.abs(rect.top - rootRect.top),
        Math.abs(rect.width - rootRect.width),
        Math.abs(rect.height - rootRect.height)
      );
    };
    return Object.fromEntries(Object.entries({
      paper: root.querySelector(".note-paper-layer"),
      background: root.querySelector(".note-background-image"),
      elements: root.querySelector('[data-layer="elements"]'),
      masks: root.querySelector('[data-layer="masks"]'),
      input: root.querySelector('[data-layer="drawing-input"]'),
      draft: root.querySelector('[data-note-draft]:not([data-note-draft="settled"])')
    }).map(([name, node]) => [name, node ? delta(node) : Number.POSITIVE_INFINITY]));
  });
  for (const [layer, delta] of Object.entries(pageLayerDeltas)) {
    expect(delta, `${layer}を横長ページ矩形へ一致させる`).toBeLessThanOrEqual(1);
  }
  await capture.dispatchEvent("pointerup", {
    pointerId: 2301, pointerType: "pen", button: 0, buttons: 0, ...point(.76, .72), pressure: 0
  });

  await page.locator('[data-note-tool="eraser-object"]').click();
  await page.locator("#noteStyleBtn").click();
  await page.locator("#noteEraserMode").selectOption("pixel");
  await page.locator("#noteStyleBtn").click();
  await stage.dispatchEvent("pointermove", {
    pointerId: 2302, pointerType: "mouse", button: 0, buttons: 0, ...point(.72, .62)
  });
  const cursor = page.locator("#notePixelEraserCursor");
  await expect(cursor).toBeVisible();
  const cursorBox = await cursor.boundingBox();
  expect(cursorBox.width).toBeCloseTo(cursorBox.height, 0);
  expect(cursorBox.x + cursorBox.width / 2).toBeCloseTo(point(.72, .62).clientX, 0);
  expect(cursorBox.y + cursorBox.height / 2).toBeCloseTo(point(.72, .62).clientY, 0);

  await page.locator('[data-note-tool="mask"]').click();
  await stage.dispatchEvent("pointerdown", { pointerId: 2303, pointerType: "mouse", button: 0, ...point(.2, .25) });
  await stage.dispatchEvent("pointermove", { pointerId: 2303, pointerType: "mouse", button: 0, ...point(.55, .55) });
  await stage.dispatchEvent("pointerup", { pointerId: 2303, pointerType: "mouse", button: 0, ...point(.55, .55) });
  const mask = stage.locator(".note-mask");
  const transformOverlay = stage.locator(".note-transform-overlay");
  await expect(transformOverlay).toBeVisible();
  const maskBox = await mask.boundingBox();
  const transformBox = await transformOverlay.boundingBox();
  expect(transformBox.x).toBeCloseTo(maskBox.x, 0);
  expect(transformBox.y).toBeCloseTo(maskBox.y, 0);
  expect(transformBox.width).toBeCloseTo(maskBox.width, 0);
  expect(transformBox.height).toBeCloseTo(maskBox.height, 0);
  for (const [handle, expectedX, expectedY] of [
    ["resize-nw", transformBox.x, transformBox.y],
    ["resize-se", transformBox.x + transformBox.width, transformBox.y + transformBox.height]
  ]) {
    const handleBox = await stage.locator(`[data-transform-handle="${handle}"]`).boundingBox();
    expect(Math.abs(handleBox.x + handleBox.width / 2 - expectedX)).toBeLessThanOrEqual(2);
    expect(Math.abs(handleBox.y + handleBox.height / 2 - expectedY)).toBeLessThanOrEqual(2);
  }

  await page.locator('[data-note-tool="text"]').click();
  await stage.dispatchEvent("pointerdown", { pointerId: 2304, pointerType: "mouse", button: 0, ...point(.15, .62) });
  await stage.dispatchEvent("pointermove", { pointerId: 2304, pointerType: "mouse", button: 0, ...point(.62, .86) });
  await stage.dispatchEvent("pointerup", { pointerId: 2304, pointerType: "mouse", button: 0, ...point(.62, .86) });
  const textEditor = stage.locator('[data-note-text-editor="true"]');
  await expect(textEditor).toBeFocused();
  const textBox = await textEditor.boundingBox();
  expect(textBox.x).toBeCloseTo(point(.15, .62).clientX, 0);
  expect(textBox.y).toBeCloseTo(point(.15, .62).clientY, 0);
  expect(textBox.width).toBeCloseTo(box.width * .47, 0);
  expect(textBox.height).toBeCloseTo(box.height * .24, 0);
  await textEditor.press("Escape");
  await expect(textEditor).toHaveCount(0);

  await page.locator("#noteImageFileInput").setInputFiles({
    name: "landscape-object.png", mimeType: "image/png", buffer: TEST_PNG
  });
  const image = stage.locator(".note-image-element");
  await expect(image).toBeVisible({ timeout: 20_000 });
  await page.locator('[data-note-tool="select"]').click();
  await expect(image).toHaveClass(/note-selected/);
  await page.locator('#noteSelectionActions [data-selection-action="crop"]').click();
  const cropOverlay = stage.locator(".note-crop-overlay");
  await expect(cropOverlay).toBeVisible();
  const imageBox = await image.boundingBox();
  const cropBox = await cropOverlay.boundingBox();
  expect(cropBox.x).toBeCloseTo(imageBox.x, 0);
  expect(cropBox.y).toBeCloseTo(imageBox.y, 0);
  expect(cropBox.width).toBeCloseTo(imageBox.width, 0);
  expect(cropBox.height).toBeCloseTo(imageBox.height, 0);
  for (const [handle, expectedX, expectedY] of [
    ["crop-nw", cropBox.x, cropBox.y],
    ["crop-se", cropBox.x + cropBox.width, cropBox.y + cropBox.height]
  ]) {
    const handleBox = await stage.locator(`[data-transform-handle="${handle}"]`).boundingBox();
    expect(Math.abs(handleBox.x + handleBox.width / 2 - expectedX)).toBeLessThanOrEqual(2);
    expect(Math.abs(handleBox.y + handleBox.height / 2 - expectedY)).toBeLessThanOrEqual(2);
  }
});

test("@authenticated @ipad-input-core 明示的なツール・zoom・閲覧・ページ変更は描画途中のdotを残さない", async ({ page }) => {
  const user = await createUser();
  await login(page, user);
  await page.locator("#newNoteBtn").click();
  await page.locator("#newNoteTitle").fill("Pencil中断境界E2Eノート");
  page = await openEditorPopup(page, () => page.locator('[data-create-note="blank"]').click());

  const stage = page.locator("#notePageStage");
  const capture = stage.locator('[data-layer="drawing-input"]');
  const viewport = page.locator("#noteViewport");
  const box = await stage.boundingBox();
  expect(box).toBeTruthy();
  const beginDot = pointerId => capture.dispatchEvent("pointerdown", {
    pointerId, pointerType: "pen", button: 0,
    clientX: box.x + box.width * .4, clientY: box.y + box.height * .4,
    width: 2, height: 2, pressure: .5
  });
  const expectNoStroke = () => expect(stage.locator("[data-element-id]"), "明示中断したdotを正本へ残さない").toHaveCount(0);

  await beginDot(2101);
  await page.locator('[data-note-tool="highlighter"]').click();
  await expectNoStroke();
  await page.locator('[data-note-tool="pen"]').click();

  await beginDot(2102);
  await viewport.dispatchEvent("pagezoomstart");
  await expectNoStroke();

  await beginDot(2103);
  await page.locator("#noteMarkupDoneBtn").click();
  await expectNoStroke();
  await page.locator("#noteMarkupDoneBtn").click();

  await openPageSidebar(page);
  await page.locator('[data-page-action="add-ruled"]').click();
  await expect(page.locator("#notePageCounter")).toHaveText("2 / 2");
  await page.locator('#notePageList [aria-label="1ページを開く"]').click();
  await expect(page.locator("#notePageCounter")).toHaveText("1 / 2");
  await beginDot(2104);
  await page.locator('#notePageList [aria-label="2ページを開く"]').click();
  await expect(page.locator("#notePageCounter")).toHaveText("2 / 2");
  await page.locator('#notePageList [aria-label="1ページを開く"]').click();
  await expectNoStroke();

  const endDot = pointerId => capture.dispatchEvent("pointerup", {
    pointerId, pointerType: "pen", button: 0,
    clientX: box.x + box.width * .4, clientY: box.y + box.height * .4,
    width: 2, height: 2, pressure: 0
  });
  await beginDot(2110);
  await endDot(2110);
  await expect(stage.locator("[data-element-id]")).toHaveCount(1);

  await beginDot(2111);
  await endDot(2110); // 旧pointerIdの遅延終了通知
  const viewportBox = await viewport.boundingBox();
  const touchEvent = (pointerId, x, y, pressure = .5) => ({
    pointerId, pointerType: "touch", button: 0,
    clientX: viewportBox.x + viewportBox.width * x,
    clientY: viewportBox.y + viewportBox.height * y,
    width: 12, height: 12, pressure
  });
  await viewport.dispatchEvent("pointerdown", touchEvent(2112, .35, .45));
  await viewport.dispatchEvent("pointerdown", touchEvent(2113, .65, .55));
  await viewport.dispatchEvent("pointermove", touchEvent(2113, .75, .6));
  await viewport.dispatchEvent("pointerup", touchEvent(2113, .75, .6, 0));
  await viewport.dispatchEvent("pointerup", touchEvent(2112, .35, .45, 0));
  await endDot(2111);
  await expect(stage.locator("[data-element-id]"), "旧pointer終了と後続touchで新strokeを破棄しない").toHaveCount(2);

  await page.locator("#noteMarkupDoneBtn").click();
  await expect(page.locator(".note-toolbar")).toBeHidden();
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#noteEditorStartup")).toBeHidden({ timeout: 30_000 });
  await expect(page.locator("#notePageStage [data-element-id]"), "完了直前のidle strokeを再読込後も保持する").toHaveCount(2);

  const toolbar = page.locator(".note-toolbar");
  await expect(toolbar).toBeVisible();
  await page.locator("#noteMarkupDoneBtn").click();
  await expect(toolbar).toBeHidden();
  await page.locator("#noteStudyModeBtn").click();
  await expect(page.locator("#noteStudyControls")).toBeVisible();
  await expect(toolbar).toBeHidden();
  await page.locator("#noteEditModeBtn").click();
  await expect(page.locator("#noteStudyControls")).toBeHidden();
  await expect(toolbar, "閲覧状態のまま暗記から編集へ戻ってもパレットを出さない").toBeHidden();
  await page.locator("#noteMarkupDoneBtn").click();
  await expect(toolbar).toBeVisible();
  await page.locator("#noteStudyModeBtn").click();
  await expect(toolbar).toBeHidden();
  await expect(page.locator("#noteStudyControls")).toBeVisible();
});

test("@authenticated @ipad-input-core マークアップ完了はクラウド保存失敗でも端末内下書きを保持して再試行できる", async ({ page }) => {
  test.setTimeout(90_000);
  const blockedRequests = await guardProductionFirebase(page);
  const user = await createUser();
  await login(page, user);
  await page.locator("#newNoteBtn").click();
  await page.locator("#newNoteTitle").fill("マークアップ保存失敗E2Eノート");
  page = await openEditorPopup(page, () => page.locator('[data-create-note="blank"]').click(), { blockedRequests });

  let failedRevisionUploads = 0;
  await page.route("**/v0/b/demo-dental-qa.firebasestorage.app/o**", async route => {
    const request = route.request();
    const objectName = new URL(request.url()).searchParams.get("name") || "";
    if (["POST", "PUT"].includes(request.method()) && objectName.includes("/revisions/")) {
      failedRevisionUploads += 1;
      await route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: 403, message: "forced markup revision failure" } })
      });
      return;
    }
    await route.continue();
  });

  const stage = page.locator("#notePageStage");
  const capture = stage.locator('[data-layer="drawing-input"]');
  const box = await stage.boundingBox();
  expect(box).toBeTruthy();
  const point = (x, y) => ({ clientX: box.x + box.width * x, clientY: box.y + box.height * y });
  await capture.dispatchEvent("pointerdown", {
    pointerId: 2201, pointerType: "pen", button: 0, ...point(.22, .3), width: 2, height: 2, pressure: .5
  });
  await capture.dispatchEvent("pointermove", {
    pointerId: 2201, pointerType: "pen", button: 0, ...point(.62, .48), width: 2, height: 2, pressure: .5
  });
  await capture.dispatchEvent("pointerup", {
    pointerId: 2201, pointerType: "pen", button: 0, ...point(.62, .48), width: 2, height: 2, pressure: 0
  });
  await expect(stage.locator("[data-element-id]")).toHaveCount(1);

  await page.locator("#noteMarkupDoneBtn").click();
  await expect(page.locator(".note-toolbar"), "クラウド失敗でもローカル保存完了後はパレットを閉じる").toBeHidden();
  await expect(page.locator("#noteSaveStatus")).toHaveAttribute("data-state", "recoverable-error", { timeout: 20_000 });
  expect(failedRevisionUploads).toBeGreaterThan(0);
  await expect.poll(() => localNoteStoreCounts(page)).toMatchObject({ pageDrafts: 1, pendingSaves: 1 });
  const failedCloudState = await readNotes(user.uid);
  const note = failedCloudState.notes.find(item => item.title === "マークアップ保存失敗E2Eノート");
  expect(note?.pages[0]?.contentRevision).toBe(0);

  await page.locator("#noteSaveStatus").click();
  await expect(page.locator("#noteSaveStatusDetail")).toContainText("端末内");
  await expect(page.locator("#noteRetrySaveBtn")).toBeVisible();
  await page.unroute("**/v0/b/demo-dental-qa.firebasestorage.app/o**");
  await page.locator("#noteRetrySaveBtn").click();
  await expect(page.locator("#noteSaveStatus")).toHaveAttribute("data-state", "saved", { timeout: 20_000 });
  await expect.poll(() => localNoteStoreCounts(page)).toEqual({
    pendingAssets: 0,
    pageDrafts: 0,
    pendingSaves: 0,
    conflicts: 0
  });
  await expect.poll(async () => {
    const stored = await readNotes(user.uid);
    return stored.notes.find(item => item.id === note.id)?.pages[0]?.contentRevision || 0;
  }, { timeout: 20_000 }).toBeGreaterThan(0);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#noteEditorStartup")).toBeHidden({ timeout: 20_000 });
  await expect(page.locator("#notePageStage [data-element-id]"), "再試行後はクラウドから筆跡を復元できる").toHaveCount(1);
  expect(blockedRequests).toEqual([]);
});

test("@authenticated @ipad-transient-ui ページスワイプはローカル保存後に遷移し、ズーム・ピンチ・描画中は発火しない", async ({ page }) => {
  test.setTimeout(120_000);
  const user = await createUser();
  await login(page, user);
  await page.locator("#newNoteBtn").click();
  await page.locator("#newNoteTitle").fill("スワイプ排他E2Eノート");
  page = await openEditorPopup(page, () => page.locator('[data-create-note="blank"]').click());

  await openPageSidebar(page);
  await page.locator('[data-page-action="add-ruled"]').click();
  await expect(page.locator("#notePageCounter")).toHaveText("2 / 2");
  await page.locator('#notePageList [aria-label="1ページを開く"]').click();
  await expect(page.locator("#notePageCounter")).toHaveText("1 / 2");

  await page.locator("#noteInputSettingsBtn").click();
  await page.locator("#noteFingerDraw").uncheck();
  await page.locator("#notePageNavigation").selectOption("swipe");
  await page.locator("#noteToolSettingsDoneBtn").click();

  const stage = page.locator("#notePageStage");
  const viewport = page.locator("#noteViewport");
  const stageBox = await stage.boundingBox();
  const viewportBox = await viewport.boundingBox();
  expect(stageBox).toBeTruthy();
  expect(viewportBox).toBeTruthy();
  const stagePoint = (x, y) => ({ clientX: stageBox.x + stageBox.width * x, clientY: stageBox.y + stageBox.height * y });
  const viewportPoint = (x, y) => ({ clientX: viewportBox.x + viewportBox.width * x, clientY: viewportBox.y + viewportBox.height * y });
  const swipe = async (pointerId, from, to, { expectFollow = true } = {}) => {
    await viewport.dispatchEvent("pointerdown", { pointerId, pointerType: "touch", button: 0, ...from, width: 40, height: 40, pressure: .5 });
    await viewport.dispatchEvent("pointermove", { pointerId, pointerType: "touch", button: 0, ...to, width: 40, height: 40, pressure: .5 });
    if (expectFollow) await expect(stage, "ページはpointerup前から指へ追従する").toHaveCSS("translate", /-?[1-9]/);
    await viewport.dispatchEvent("pointerup", { pointerId, pointerType: "touch", button: 0, ...to, width: 40, height: 40, pressure: 0 });
  };

  const before = await stage.locator("path[data-element-id]").count();
  await stage.dispatchEvent("pointerdown", { pointerId: 301, pointerType: "pen", button: 0, ...stagePoint(.18, .22), pressure: .5 });
  await stage.dispatchEvent("pointermove", { pointerId: 301, pointerType: "pen", button: 0, ...stagePoint(.42, .28), pressure: .5 });
  await stage.dispatchEvent("pointerup", { pointerId: 301, pointerType: "pen", button: 0, ...stagePoint(.42, .28), pressure: 0 });
  await expect(stage.locator("path[data-element-id]")).toHaveCount(before + 1);

  await swipe(302, viewportPoint(.78, .5), viewportPoint(.18, .52));
  await expect(page.locator("#notePageCounter"), "保留中の筆跡をローカル保存してから次ページへ移る").toHaveText("2 / 2", { timeout: 20_000 });
  await swipe(303, viewportPoint(.18, .5), viewportPoint(.78, .52));
  await expect(page.locator("#notePageCounter")).toHaveText("1 / 2", { timeout: 20_000 });
  await expect(stage.locator("path[data-element-id]"), "スワイプ往復後も直前の筆跡を保持する").toHaveCount(before + 1);

  await page.locator("#noteInputSettingsBtn").click();
  await page.locator("#noteFingerDraw").check();
  await expect(page.locator("#notePencilMode")).not.toBeChecked();
  await page.locator("#noteToolSettingsDoneBtn").click();
  const fingerSwipe = async (pointerId, from, to, expectedPage) => {
    await stage.dispatchEvent("pointerdown", { pointerId, pointerType: "touch", button: 0, ...from, width: 8, height: 8, pressure: .5 });
    await stage.dispatchEvent("pointermove", { pointerId, pointerType: "touch", button: 0, ...to, width: 8, height: 8, pressure: .5 });
    await expect(stage.locator("[data-note-draft]"), "横方向ロック後は指描画draftをページ送りへ引き継ぐ").toHaveCount(0);
    await expect(page.locator("#noteAdjacentPagePreview")).toBeVisible();
    await stage.dispatchEvent("pointerup", { pointerId, pointerType: "touch", button: 0, ...to, width: 8, height: 8, pressure: 0 });
    await expect(page.locator("#notePageCounter")).toHaveText(expectedPage, { timeout: 20_000 });
  };
  await fingerSwipe(309, stagePoint(.78, .5), stagePoint(.18, .52), "2 / 2");
  await fingerSwipe(310, stagePoint(.18, .5), stagePoint(.78, .52), "1 / 2");

  await viewport.dispatchEvent("wheel", {
    ctrlKey: true, deltaY: -220, ...viewportPoint(.5, .5)
  });
  await expect.poll(() => stage.evaluate(node => Number(getComputedStyle(node).getPropertyValue("--page-zoom")))).toBeGreaterThan(1);
  await viewport.evaluate(node => { node.scrollLeft = Math.max(20, (node.scrollWidth - node.clientWidth) / 2); });
  await swipe(304, viewportPoint(.78, .42), viewportPoint(.12, .44), { expectFollow: false });
  await expect(page.locator("#notePageCounter"), "拡大中かつ横スクロール端でない場合はページを送らない").toHaveText("1 / 2");

  await page.locator("#noteMoreMenu summary").click();
  await page.locator('[data-note-action="reset-view"]').click();
  await viewport.dispatchEvent("pointerdown", { pointerId: 305, pointerType: "touch", button: 0, ...viewportPoint(.28, .38), width: 8, height: 8, pressure: .5 });
  await viewport.dispatchEvent("pointerdown", { pointerId: 306, pointerType: "touch", button: 0, ...viewportPoint(.68, .62), width: 8, height: 8, pressure: .5 });
  await viewport.dispatchEvent("pointermove", { pointerId: 306, pointerType: "touch", button: 0, ...viewportPoint(.84, .68), width: 8, height: 8, pressure: .5 });
  await viewport.dispatchEvent("pointerup", { pointerId: 306, pointerType: "touch", button: 0, ...viewportPoint(.84, .68), width: 8, height: 8, pressure: 0 });
  await viewport.dispatchEvent("pointerup", { pointerId: 305, pointerType: "touch", button: 0, ...viewportPoint(.28, .38), width: 8, height: 8, pressure: 0 });
  await expect(page.locator("#notePageCounter"), "ピンチ中はページを送らない").toHaveText("1 / 2");

  await stage.dispatchEvent("pointerdown", { pointerId: 307, pointerType: "pen", button: 0, ...stagePoint(.55, .55), pressure: .5 });
  await stage.dispatchEvent("pointermove", { pointerId: 307, pointerType: "pen", button: 0, ...stagePoint(.68, .62), pressure: .5 });
  await swipe(308, viewportPoint(.78, .58), viewportPoint(.12, .6), { expectFollow: false });
  await expect(page.locator("#notePageCounter"), "Pencil描画中のtouchではページを送らない").toHaveText("1 / 2");
  await stage.dispatchEvent("pointerup", { pointerId: 307, pointerType: "pen", button: 0, ...stagePoint(.68, .62), pressure: 0 });
});

test("@authenticated @ipad-writing-mask 交差する複数画・日本語IME・保存チップ・編集画面内マスクを統合する", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const blockedRequests = await guardProductionFirebase(page);
  const pageErrors = [];
  page.on("pageerror", error => recordUnexpectedPageError(pageErrors, error));
  const user = await createUser();
  await login(page, user);
  await page.locator("#newNoteBtn").click();
  await page.locator("#newNoteTitle").fill("複数画・テキスト・マスクE2Eノート");
  page = await openEditorPopup(page, () => page.locator('[data-create-note="blank"]').click(), {
    blockedRequests,
    onPageError: error => recordUnexpectedPageError(pageErrors, error)
  });

  const stage = page.locator("#notePageStage");
  const capture = stage.locator('[data-layer="drawing-input"]');
  await expect(capture).toHaveClass(/active/);
  await expect(capture).toHaveCSS("pointer-events", "auto");
  await capture.evaluate(node => { node.dataset.lifecycleProbe = "stage-initialized"; });
  const box = await stage.boundingBox();
  expect(box).toBeTruthy();
  const at = (x, y) => ({ x, y });
  const draw = async (start, end, { expectStroke = true } = {}) => {
    const committedBefore = await stage.locator('path[data-element-id]').count();
    const currentBox = await stage.boundingBox();
    expect(currentBox).toBeTruthy();
    const startPoint = { x: currentBox.x + currentBox.width * start.x, y: currentBox.y + currentBox.height * start.y };
    const endPoint = { x: currentBox.x + currentBox.width * end.x, y: currentBox.y + currentBox.height * end.y };
    await page.mouse.move(startPoint.x, startPoint.y);
    await page.mouse.down();
    await page.mouse.move(endPoint.x, endPoint.y, { steps: 3 });
    await page.mouse.up();
    if (expectStroke) {
      await expect(stage.locator('path[data-element-id]'), "各pointerupで1画を確定する").toHaveCount(committedBefore + 1);
    }
  };

  const before = await stage.locator('path[data-element-id]').count();
  await draw(at(.25, .3), at(.7, .3));
  await draw(at(.48, .22), at(.48, .42));
  await expect(stage.locator('path[data-element-id]')).toHaveCount(before + 2);
  for (let index = 0; index < 5; index += 1) {
    await draw(at(.3, .38), at(.38 + index * .02, .43 + index * .01));
  }
  await expect(stage.locator('path[data-element-id]')).toHaveCount(before + 7);
  for (let index = 0; index < 10; index += 1) {
    const column = index % 5;
    const row = Math.floor(index / 5);
    const x = .12 + column * .16;
    const y = .1 + row * .1;
    await draw(at(x, y), at(x + .08, y));
    await draw(at(x + .04, y - .025), at(x + .04, y + .055));
    await draw(at(x + .015, y + .03), at(x + .09, y + .055));
  }
  await expect(stage.locator('path[data-element-id]'), "10文字分の交差する3画をすべて保持する").toHaveCount(before + 37);
  await expect(stage.locator('[data-layer="drawing-input"]'), "renderPage後もcapture layerは同一要素を1件だけ維持する").toHaveCount(1);
  await expect(capture).toHaveAttribute("data-lifecycle-probe", "stage-initialized");

  const browserSelectionBoundary = await page.evaluate(() => {
    const chip = document.querySelector("#localEnvironmentToggle");
    const selectionEvent = new Event("selectstart", { bubbles: true, cancelable: true });
    const contextEvent = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    chip.dispatchEvent(selectionEvent);
    chip.dispatchEvent(contextEvent);
    return {
      selectionPrevented: selectionEvent.defaultPrevented,
      contextPrevented: contextEvent.defaultPrevented,
      bannerPointerEvents: getComputedStyle(document.querySelector("#localEnvironmentBanner")).pointerEvents,
      localInsideHeader: Boolean(document.querySelector(".note-editor-header #localEnvironmentBanner"))
    };
  });
  expect(browserSelectionBoundary).toEqual({
    selectionPrevented: true,
    contextPrevented: true,
    bannerPointerEvents: "auto",
    localInsideHeader: true
  });

  const saveChip = page.locator("#noteSaveStatus");
  const savedWidth = await saveChip.evaluate(element => element.getBoundingClientRect().width);
  expect(savedWidth).toBeGreaterThan(70);
  expect(savedWidth).toBeLessThan(100);
  await expect(saveChip).toHaveCSS("border-radius", "10px");
  const saveLabelOverflow = await page.locator("#noteSaveStatusButtonText").evaluate(label => {
    const original = label.textContent;
    label.textContent = "保存エラー";
    const result = {
      clientWidth: label.clientWidth,
      scrollWidth: label.scrollWidth,
      whiteSpace: getComputedStyle(label).whiteSpace,
      textOverflow: getComputedStyle(label).textOverflow
    };
    label.textContent = original;
    return result;
  });
  expect(saveLabelOverflow.scrollWidth).toBeGreaterThan(saveLabelOverflow.clientWidth);
  expect(saveLabelOverflow.whiteSpace).toBe("nowrap");
  expect(saveLabelOverflow.textOverflow).toBe("ellipsis");
  await saveChip.click();
  await expect(page.locator("#noteSavePopover")).toBeVisible();
  await expect(page.locator("#noteSaveStatusText")).not.toBeEmpty();
  await page.locator("#noteSaveStatus").click();

  await page.locator('[data-note-tool="text"]').click();
  await expect(stage).toHaveAttribute("data-tool", "text");
  const textStageBox = await stage.boundingBox();
  expect(textStageBox).toBeTruthy();
  const textStart = { x: textStageBox.x + textStageBox.width * .62, y: textStageBox.y + textStageBox.height * .5 };
  const textEnd = { x: textStageBox.x + textStageBox.width * .9, y: textStageBox.y + textStageBox.height * .64 };
  await stage.dispatchEvent("pointerdown", { pointerId: 301, pointerType: "mouse", button: 0, clientX: textStart.x, clientY: textStart.y });
  const textEditor = stage.locator('textarea[data-note-text-editor="true"]');
  await expect(textEditor).toBeVisible();
  await expect(textEditor).not.toBeFocused();
  await expect(textEditor).toHaveClass(/is-sizing/);
  await expect(textEditor).toHaveCSS("pointer-events", "none");
  await stage.dispatchEvent("pointermove", { pointerId: 301, pointerType: "mouse", button: 0, clientX: textEnd.x, clientY: textEnd.y });
  await stage.dispatchEvent("pointerup", { pointerId: 301, pointerType: "mouse", button: 0, clientX: textEnd.x, clientY: textEnd.y });
  await expect(textEditor).toBeFocused();
  await expect(textEditor).not.toHaveClass(/is-sizing/);
  await textEditor.evaluate(editor => {
    editor.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "歯科" }));
    editor.value = "あいうえお\n歯科衛生士\nこれは複数行のテキスト入力です。";
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: "歯科" }));
  });
  const imeOutsideTap = await page.locator('[data-note-tool="mask"]').evaluate(button => {
    const pointer = new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 302, pointerType: "touch" });
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    button.dispatchEvent(pointer);
    button.dispatchEvent(click);
    return {
      pointerPrevented: pointer.defaultPrevented,
      clickPrevented: click.defaultPrevented,
      currentTool: document.querySelector("#notePageStage")?.dataset.tool,
      editorFocused: document.activeElement?.matches?.('[data-note-text-editor="true"]') === true
    };
  });
  expect(imeOutsideTap).toEqual({
    pointerPrevented: true,
    clickPrevented: true,
    currentTool: "text",
    editorFocused: true
  });
  await expect(textEditor).toHaveValue("あいうえお\n歯科衛生士\nこれは複数行のテキスト入力です。");
  await textEditor.evaluate(editor => {
    editor.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "歯科" }));
  });
  await textEditor.press("Control+Enter");
  await expect(textEditor).toHaveCount(0);
  const committedText = stage.locator('text[data-element-id]').filter({ hasText: "歯科衛生士" });
  await expect(committedText).toHaveCount(1);
  expect(await committedText.locator("tspan").count(), "確定後も明示改行と折り返しを含む全行を描画する").toBeGreaterThanOrEqual(3);
  await expect(committedText).toContainText("これは複数行のテキスト入力です。");

  await page.locator('[data-note-tool="mask"]').click();
  await expect(capture).not.toHaveClass(/active/);
  await draw(at(.18, .42), at(.58, .52), { expectStroke: false });
  await expect(stage.locator(".note-mask")).toHaveCount(1);
  await expect(page.locator("#noteSelectionActionsTitle")).toHaveText("1個選択中");
  await expect(page.locator('#noteSelectionActions [data-selection-action="crop"]')).toBeHidden();
  await page.locator('#noteSelectionActions [data-selection-action="weak-on"]').click();
  await expect(stage.locator(".note-mask.weak")).toHaveCount(1);
  await page.locator('#noteSelectionActions [data-selection-action="duplicate"]').click();
  await expect(stage.locator(".note-mask")).toHaveCount(2);
  const selectedMaskId = await stage.locator(".note-mask.note-selected").getAttribute("data-mask-id");
  await page.locator('#noteSelectionActions [data-selection-action="back"]').click();
  await expect(stage.locator(".note-mask").first()).toHaveAttribute("data-mask-id", selectedMaskId);
  await page.locator('#noteSelectionActions [data-selection-action="front"]').click();
  await expect(stage.locator(".note-mask").last()).toHaveAttribute("data-mask-id", selectedMaskId);

  await page.locator("#noteMaskVisibilityBtn").click();
  await expect(stage.locator(".note-mask.editing-hidden")).toHaveCount(2);
  await expect(stage.locator(".note-mask").first()).toHaveCSS("opacity", "0");
  await expect(stage.locator(".note-mask.editable.editing-hidden").first()).toHaveCSS("pointer-events", "auto");
  await draw(at(.3, .46), at(.31, .47), { expectStroke: false });
  await expect(stage.locator(".note-mask"), "編集時非表示のマスクは選択・移動でき、重複作成されない").toHaveCount(2);
  await expect(stage.locator(".note-mask.note-selected")).toHaveCount(1);
  await expect(stage.locator(".note-mask.editing-hidden")).toHaveCount(2);

  await page.locator("#noteMoreMenu summary").click();
  await page.locator('[data-note-action="export"]').click();
  await page.locator("#noteExportPurpose").selectOption("screen");
  await expect(page.locator("#noteExportStatus"), "画面どおりPDFは編集時の非表示状態を反映する").toContainText("現在非表示の暗記マスク2件");
  await page.locator('#noteExportDialog button[value="close"]').click();

  await page.locator('[data-note-tool="pen"]').click();
  await expect(stage.locator(".note-transform-overlay")).toHaveCount(0);
  await stage.locator(".note-mask").first().scrollIntoViewIfNeeded();
  const pathCountBeforeMaskStroke = await stage.locator('path[data-element-id]').count();
  await draw(at(.22, .46), at(.52, .49));
  await expect(stage.locator('path[data-element-id]')).toHaveCount(pathCountBeforeMaskStroke + 1);
  await expect(stage.locator(".note-mask")).toHaveCount(2);

  await page.locator("#noteStudyModeBtn").click();
  await expect(stage).toHaveClass(/study-mode/);
  await expect(page.locator("#noteStudyModeBtn")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#noteEditModeBtn")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#noteStudyControls")).toHaveCSS("flex-wrap", "nowrap");
  const studyControlsBox = await page.locator("#noteStudyControls").boundingBox();
  expect(studyControlsBox.x).toBeGreaterThanOrEqual(0);
  expect(studyControlsBox.x + studyControlsBox.width).toBeLessThanOrEqual((await page.viewportSize()).width);
  for (const button of await page.locator("#noteStudyControls button").all()) {
    const buttonBox = await button.boundingBox();
    expect(buttonBox.width).toBeGreaterThanOrEqual(44);
    expect(buttonBox.height).toBeGreaterThanOrEqual(44);
  }
  await testInfo.attach(`study-mode-${testInfo.project.name}.png`, {
    body: await page.locator("#noteEditorView").screenshot(), contentType: "image/png"
  });
  await expect(stage.locator(".note-mask.editing-hidden")).toHaveCount(0);
  await expect(stage.locator(".note-mask").first()).toHaveCSS("opacity", "1");
  await page.locator('[data-study-action="hide-all"]').click();
  await expect(stage.locator(".note-mask").first()).toHaveCSS("opacity", "1");
  await page.locator('[data-study-action="show-all"]').click();
  await expect(stage.locator(".note-mask.revealed").first()).toHaveCSS("opacity", "1");
  // Both masks here are weak: shown, they keep the image memory screen's
  // light red fill and red dashed edge.
  await expect(stage.locator(".note-mask.revealed").first()).toHaveCSS("background-color", "rgba(185, 28, 28, 0.18)");
  await expect(stage.locator(".note-mask.revealed").first()).toHaveCSS("border-top-style", "dashed");
  await expect(stage.locator(".note-mask.revealed").first()).toHaveCSS("pointer-events", "auto");
  await page.locator("#noteEditModeBtn").click();
  await expect(page.locator("#noteEditModeBtn")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#noteStudyModeBtn")).toHaveAttribute("aria-pressed", "false");
  await testInfo.attach(`edit-mode-${testInfo.project.name}.png`, {
    body: await page.locator("#noteEditorView").screenshot(), contentType: "image/png"
  });

  await page.locator("#noteMoreMenu summary").click();
  await page.locator('[data-note-action="export"]').click();
  await page.locator("#noteExportPurpose").selectOption("screen");
  await expect(page.locator("#noteExportStatus")).toContainText("現在非表示の暗記マスク2件");
  await page.locator('#noteExportDialog button[value="close"]').click();
  await page.locator("#noteMaskVisibilityBtn").click();
  await expect(stage.locator(".note-mask.editing-hidden")).toHaveCount(0);

  await page.locator('[data-note-tool="mask"]').click();
  await page.locator("#noteMaskSelectModeBtn").click();
  await stage.locator(".note-mask").first().click({ force: true });
  await page.locator('#noteSelectionActions [data-selection-action="select-page-masks"]').click();
  await expect(page.locator("#noteSelectionActionsTitle")).toHaveText("2個選択中");
  page.once("dialog", dialog => dialog.accept());
  await page.locator('#noteSelectionActions [data-selection-action="delete"]').click();
  await expect(stage.locator(".note-mask")).toHaveCount(0);
  await page.locator("#noteUndoBtn").click();
  await expect(stage.locator(".note-mask")).toHaveCount(2);

  await expect(saveChip).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
  await page.evaluate(() => {
    const status = document.querySelector("#noteSaveStatus");
    status.dataset.state = "offline";
    status.setAttribute("aria-label", "オフライン。この端末内に保存済み");
    document.querySelector("#noteSaveStatusButtonText").textContent = "オフライン";
  });
  await expect(page.locator("#localEnvironmentToggle")).toBeVisible();
  for (const width of [744, 760, 768, 1024]) {
    await page.setViewportSize({ width, height: 1024 });
    const headerFits = await page.locator("#noteEditorView > .note-editor-header").evaluate(header => {
      const bounds = header.getBoundingClientRect();
      const childrenFit = [...header.children]
        .filter(child => getComputedStyle(child).display !== "none")
        .every(child => {
          const rect = child.getBoundingClientRect();
          return rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1;
        });
      return header.scrollWidth <= header.clientWidth + 1 && childrenFit;
    });
    expect(headerFits, `${width}px幅でLOCAL表示と最長保存状態名をheader内へ収める`).toBe(true);
  }
  expect(blockedRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});
