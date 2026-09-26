import { expect, test } from "@playwright/test";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, getDocs, setDoc, updateDoc } from "firebase/firestore";
import { ref, uploadBytes } from "firebase/storage";
import { PDFDocument } from "pdf-lib";
import { deflateSync } from "node:zlib";
import { guardProductionFirebase } from "../helpers/readOnlyApp.mjs";
import { createPdfFixture } from "../helpers/pdf-fixture.mjs";

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

async function login(page, user) {
  await page.goto("/?firebaseEmulator=1", { waitUntil: "domcontentloaded" });
  await page.locator("#tabBtnAuth").click();
  await page.locator("#emailInput").fill(user.email);
  await page.locator("#passwordInput").fill(user.password);
  await page.locator("#signInBtn").click();
  await expect(page.locator("#authStatus")).toContainText(user.email, { timeout: 20_000 });
  await expect(page.locator("#localEnvironmentBanner")).toBeVisible();
  await page.locator("#tabBtnPdf").click();
  await page.locator("#noteModeBtn").click();
  await expect(page.locator("#noteListView")).toBeVisible();
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
    const storage = environment.authenticatedContext(uid).storage();
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

async function seedReadyNote(uid, title, { legacyWithoutStatus = false } = {}) {
  const environment = await initializeTestEnvironment({ projectId: "demo-dental-qa", firestore: { host: "127.0.0.1", port: 8080 } });
  const noteId = `note-session-${crypto.randomUUID()}`;
  const pageId = `page-session-${crypto.randomUUID()}`;
  try {
    const db = environment.authenticatedContext(uid).firestore();
    await Promise.all([
      setDoc(doc(db, "users", uid, "notes", noteId), {
        schemaVersion: 1,
        title,
        type: "standalone",
        ...(legacyWithoutStatus ? {} : { status: "ready" }),
        pageCount: 1,
        noteMaskCount: 0,
        orderRevision: 1,
        materialRefs: [],
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
    return { noteId, pageId };
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
      const request = indexedDB.open("dentalQaNoteLocal", 2);
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
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("dentalQaNoteLocal", 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const key = `${value.uid}|${value.noteId}|${value.pageId}`;
    const put = (storeName, record) => new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, "readwrite");
      transaction.objectStore(storeName).put(record);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    const updatedAt = new Date().toISOString();
    const revisionFields = Number.isInteger(value.expectedRevision)
      ? { expectedRevision: value.expectedRevision }
      : {};
    await put("pageDrafts", {
      key,
      uid: value.uid,
      noteId: value.noteId,
      pageId: value.pageId,
      content: value.content,
      ...revisionFields,
      updatedAt
    });
    await put("pendingSaves", {
      key,
      uid: value.uid,
      noteId: value.noteId,
      pageId: value.pageId,
      ...revisionFields,
      updatedAt
    });
    database.close();
  }, { uid, noteId, pageId, content, expectedRevision });
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

test("@authenticated 白紙ノートへ描画・画像・マスクを保存し2ページPDFを書き出す", async ({ page }) => {
  test.setTimeout(120_000);
  const blockedRequests = await guardProductionFirebase(page);
  const pdfCdnRequests = [];
  const pageErrors = [];
  const dialogs = [];
  page.on("dialog", async dialog => {
    dialogs.push(dialog.message());
    await dialog.accept();
  });
  page.on("request", request => {
    const hostname = new URL(request.url()).hostname;
    if (["cdn.jsdelivr.net", "cdnjs.cloudflare.com"].includes(hostname)) {
      pdfCdnRequests.push(request.url());
    }
  });
  page.on("pageerror", error => recordUnexpectedPageError(pageErrors, error));
  const user = await createUser();
  await login(page, user);
  await expect(page.locator("#localEnvironmentStatus")).toContainText("Auth: 接続済み / Firestore: 接続済み / Storage: 接続済み");

  await page.locator("#newNoteBtn").click();
  await page.locator("#newNoteTitle").fill("E2E 学習ノート");
  await page.locator('[data-create-note="blank"]').click();
  await expect(page.locator("#noteEditorView")).toBeVisible();
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
  const maskBeforeResize = await stage.locator(".note-mask").boundingBox();
  const maskResizeHandle = await stage.locator('[data-transform-handle="resize-se"]').boundingBox();
  await page.mouse.move(maskResizeHandle.x + maskResizeHandle.width / 2, maskResizeHandle.y + maskResizeHandle.height / 2);
  await page.mouse.down();
  await page.mouse.move(maskResizeHandle.x + maskResizeHandle.width / 2 + 35, maskResizeHandle.y + maskResizeHandle.height / 2 + 18, { steps: 5 });
  await page.mouse.up();
  const maskAfterResize = await stage.locator(".note-mask").boundingBox();
  expect(maskAfterResize.width).toBeGreaterThan(maskBeforeResize.width);

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
  await stage.locator('[data-crop-action="reset"]').click();
  await expect(stage.locator(".note-crop-overlay"), "全体表示後もcrop編集を継続する").toBeVisible();
  const imageAfterReset = await stage.locator(".note-image-element").boundingBox();
  expect(imageAfterReset.width).toBeCloseTo(imageBeforeCrop.width, 0);
  await stage.locator('[data-crop-action="apply"]').click();
  await expect(stage.locator(".note-crop-overlay")).toHaveCount(0);
  await expect(page.locator("#noteSaveStatus")).toContainText("保存済み", { timeout: 20_000 });

  await page.locator("#toggleNoteStudyBtn").click();
  await expect(page.locator("#noteStudyControls")).toBeVisible();
  await page.locator("#toggleNoteStudyBtn").click();

  await page.locator(".note-more-menu summary").click();
  await page.locator('[data-note-action="export"]').click();
  await expect(page.locator("#noteExportDialog")).toBeVisible();
  await expect(page.locator("#noteExportPageNumbers")).toBeChecked();
  await page.locator("#createNotePdfBtn").click();
  await expect(page.locator("#noteExportStatus")).toContainText("作成したPDF", { timeout: 60_000 });
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

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#authStatus")).toContainText(user.email, { timeout: 20_000 });
  await page.locator("#tabBtnPdf").click();
  await page.locator("#noteModeBtn").click();
  await expect(page.locator("#noteList")).toContainText("E2E 学習ノート");
  await page.locator(".note-card:has-text('E2E 学習ノート') button", { hasText: "編集" }).click();
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

test("@authenticated lineは移動・保存再読込でき、後続panのpointercancelで巻き戻らない", async ({ page }) => {
  test.setTimeout(90_000);
  const user = await createUser();
  await login(page, user);
  await page.locator("#newNoteBtn").click();
  await page.locator("#newNoteTitle").fill("line変形E2Eノート");
  await page.locator('[data-create-note="blank"]').click();
  await expect(page.locator("#noteEditorView")).toBeVisible();

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

  await page.locator("#closeNoteBtn").click();
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#authStatus")).toContainText(user.email, { timeout: 20_000 });
  await page.locator("#tabBtnPdf").click();
  await page.locator("#noteModeBtn").click();
  await page.locator(".note-card:has-text('line変形E2Eノート') button", { hasText: "編集" }).click();
  const reloadedLine = page.locator("#notePageStage line:not(.note-element-hit)");
  await expect(reloadedLine).toHaveCount(1);
  expect(Number(await reloadedLine.getAttribute("x1"))).toBeCloseTo(movedX, 6);
});

test("@authenticated ハンドルで図形変形・回転・arrow端点移動し自由形投げ縄で複数選択する", async ({ page }) => {
  test.setTimeout(90_000);
  const user = await createUser();
  await login(page, user);
  await page.locator("#newNoteBtn").click();
  await page.locator("#newNoteTitle").fill("直接変形E2Eノート");
  await page.locator('[data-create-note="blank"]').click();
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
  await page.mouse.move(point(.06, .06).x, point(.06, .06).y);
  await page.mouse.down();
  for (const vertex of [point(.72, .06), point(.72, .58), point(.06, .58), point(.06, .06)]) {
    await page.mouse.move(vertex.x, vertex.y, { steps: 5 });
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

test("@authenticated 日本語複数行テキストを再編集し書式・配置・ボックス幅を直接変更する", async ({ page }) => {
  test.setTimeout(90_000);
  const user = await createUser();
  await login(page, user);
  await page.locator("#newNoteBtn").click();
  await page.locator("#newNoteTitle").fill("日本語テキストE2Eノート");
  await page.locator('[data-create-note="blank"]').click();
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
  await text.click({ force: true });
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

test("@authenticated ハイライト・オブジェクト消しゴム・ピクセル消しゴムを実操作してUndoできる", async ({ page }) => {
  test.setTimeout(90_000);
  const user = await createUser();
  await login(page, user);
  await page.locator("#newNoteBtn").click();
  await page.locator("#newNoteTitle").fill("消しゴムE2Eノート");
  await page.locator('[data-create-note="blank"]').click();
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
  await drag(point(.39, .23), point(.39, .33), 7);
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
  page.on("dialog", async dialog => {
    dialogs.push(dialog.message());
    await dialog.accept();
  });
  const user = await createUser();
  await login(page, user);
  let journalSeenBeforeUpload = false;

  await page.locator("#newNoteBtn").click();
  await page.locator("#newNoteTitle").fill("画像復旧E2Eノート");
  await page.locator('[data-create-note="blank"]').click();
  await expect(page.locator("#noteEditorView")).toBeVisible();

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
  await expect(page.locator("#noteSaveStatus")).toContainText("端末内に保持", { timeout: 20_000 });
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
  await page.locator("#tabBtnPdf").click();
  await page.locator("#noteModeBtn").click();
  await page.locator(".note-card:has-text('画像復旧E2Eノート') button", { hasText: "編集" }).click();
  await expect(page.locator("#notePageStage .note-image-element img")).toHaveAttribute("src", /blob:/, { timeout: 20_000 });
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
  await expect(page.locator("#noteRetrySaveBtn")).toBeVisible();
  await page.locator("#noteRetrySaveBtn").click();
  await expect(page.locator("#noteSaveStatus")).toContainText("保存済み", { timeout: 20_000 });
  await expect.poll(() => localNoteStoreCounts(page)).toEqual({ pendingAssets: 0, pageDrafts: 0, pendingSaves: 0, conflicts: 0 });

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#authStatus")).toContainText(user.email, { timeout: 20_000 });
  await page.locator("#tabBtnPdf").click();
  await page.locator("#noteModeBtn").click();
  await page.locator(".note-card:has-text('画像復旧E2Eノート') button", { hasText: "編集" }).click();
  await expect(page.locator("#notePageStage .note-image-element")).toHaveCount(1, { timeout: 20_000 });
  const stored = await readNotes(user.uid);
  expect(stored.notes[0].pages[0].contentRevision).toBeGreaterThan(0);
  expect(blockedRequests).toEqual([]);
});

test("@authenticated 一般ページ下書きも再読込後に自動再送する", async ({ page }) => {
  test.setTimeout(90_000);
  const blockedRequests = await guardProductionFirebase(page);
  const user = await createUser();
  await login(page, user);

  await page.locator("#newNoteBtn").click();
  await page.locator("#newNoteTitle").fill("下書き再送E2Eノート");
  await page.locator('[data-create-note="blank"]').click();
  await expect(page.locator("#noteEditorView")).toBeVisible();

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
  await page.locator("#tabBtnPdf").click();
  await page.locator("#noteModeBtn").click();
  await page.locator(".note-card:has-text('下書き再送E2Eノート') button", { hasText: "編集" }).click();
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
  await page.locator('[data-create-note="blank"]').click();
  await expect(page.locator("#noteEditorView")).toBeVisible();

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
  await page.locator("#closeNoteBtn").click();
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
  await page.locator('[data-create-note="blank"]').click();
  await expect(page.locator("#noteEditorView")).toBeVisible();

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
  await page.locator("#closeNoteBtn").click();
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
  await page.locator('[data-create-note="blank"]').click();
  await expect(page.locator("#noteEditorView")).toBeVisible();

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
  await page.locator("#closeNoteBtn").click();

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
  await page.locator('[data-create-note="blank"]').click();
  await expect(page.locator("#noteEditorView")).toBeVisible();

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
  await page.locator("#tabBtnPdf").click();
  await page.locator("#noteModeBtn").click();
  await expect(page.locator(".note-card:has-text('下書き競合E2Eノート')")).toContainText("競合あり", { timeout: 20_000 });
  await expect.poll(() => localNoteStoreCounts(page)).toEqual({ pendingAssets: 0, pageDrafts: 1, pendingSaves: 1, conflicts: 1 });
  const storedAfter = await readNotes(user.uid);
  expect(storedAfter.notes.find(item => item.id === note.id)?.pages[0]?.contentRevision).toBe(1);

  await page.locator(".note-card:has-text('下書き競合E2Eノート') button", { hasText: "編集" }).click();
  await expect(page.locator("#noteSaveStatus")).toContainText("競合あり");
  await expect(page.locator("#notePageStage [data-element-id]")).toHaveCount(1);
  expect(blockedRequests).toEqual([]);
});

test("@authenticated 削除済みノートの端末下書きを一覧から新規ノートへ復元する", async ({ page }) => {
  test.setTimeout(90_000);
  const blockedRequests = await guardProductionFirebase(page);
  page.on("dialog", dialog => dialog.accept());
  const user = await createUser();
  await login(page, user);
  await page.locator("#newNoteBtn").click();
  await page.locator("#newNoteTitle").fill("孤立下書きE2Eノート");
  await page.locator('[data-create-note="blank"]').click();
  await expect(page.locator("#noteEditorView")).toBeVisible();

  const before = await readNotes(user.uid);
  const sourceNote = before.notes.find(item => item.title === "孤立下書きE2Eノート");
  const sourcePage = sourceNote.pages[0];
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

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#authStatus")).toContainText(user.email, { timeout: 20_000 });
  await page.locator("#tabBtnPdf").click();
  await page.locator("#noteModeBtn").click();
  const recoveryCard = page.locator(".note-recovery-card");
  await expect(recoveryCard).toContainText("一覧にないノートの未保存下書き", { timeout: 20_000 });
  await recoveryCard.getByRole("button", { name: "新規ノートとして復元" }).click();
  await expect(page.locator("#noteEditorView")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#notePageStage path[data-element-id]")).toHaveCount(1);
  await expect.poll(() => localNoteStoreCounts(page)).toEqual({
    pendingAssets: 0,
    pageDrafts: 0,
    pendingSaves: 0,
    conflicts: 0
  });
  const after = await readNotes(user.uid);
  expect(after.notes.some(note => note.status === "ready" && note.title === "孤立下書きE2Eノート（復元コピー）")).toBe(true);
  expect(blockedRequests).toEqual([]);
});

test("@authenticated 画像アップロード中にページを切り替えても元ページへ保存する", async ({ page }) => {
  test.setTimeout(90_000);
  const blockedRequests = await guardProductionFirebase(page);
  const user = await createUser();
  await login(page, user);
  await page.locator("#newNoteBtn").click();
  await page.locator("#newNoteTitle").fill("画像ページ固定E2Eノート");
  await page.locator('[data-create-note="blank"]').click();
  await expect(page.locator("#noteEditorView")).toBeVisible();

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
  const user = await createUser();
  const material = await seedOpenableMaterial(user.uid);

  try {
    await Promise.all([login(page, user), login(secondPage, user)]);
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
    await Promise.all([firstMaterialButton.click(), secondMaterialButton.click()]);
    await Promise.all([
      expect(page.locator("#noteEditorView")).toBeVisible(),
      expect(secondPage.locator("#noteEditorView")).toBeVisible()
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
  await page.locator("#noteMaterialPicker button", { hasText: "既定ノート更新E2E教材" }).click();
  await expect(page.locator("#noteEditorView")).toBeVisible();
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
  page.on("dialog", async dialog => { await dialog.accept(); });
  const user = await createUser();
  const material = await seedOpenableMaterial(user.uid);
  await login(page, user);

  await page.locator("#newNoteBtn").click();
  await page.locator('[data-create-note="material"]').click();
  await page.locator("#noteMaterialPicker button", { hasText: "既定ノート更新E2E教材" }).click();
  await expect(page.locator("#noteEditorView")).toBeVisible();
  await expect(page.locator("#notePageCounter")).toHaveText("1 / 1");
  const firstState = await readNotes(user.uid);
  const firstNote = firstState.notes.find(item => item.sourceMaterialId === material.materialId && !item.deletedAt);
  expect(firstNote).toBeTruthy();
  expect(firstNote.id).toBe(material.defaultNoteId);

  await page.locator("#closeNoteBtn").click();
  await updateNoteRoot(user.uid, firstNote.id, {
    deletedAt: new Date().toISOString(),
    deletedReason: "user",
    deletedMaterialRefs: []
  });

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

  await materialRow.locator("[data-open-note]").click();
  await expect(page.locator("#notePageCounter")).toHaveText("1 / 2");

  const replacedState = await readNotes(user.uid);
  const linkedNotes = replacedState.notes.filter(item => item.sourceMaterialId === material.materialId);
  expect(linkedNotes).toHaveLength(2);
  const newNote = linkedNotes.find(item => !item.deletedAt);
  expect(newNote.id).toBe(replacedMaterial.defaultNoteId);
  expect(newNote.pages).toHaveLength(2);
  expect(linkedNotes.find(item => item.id === firstNote.id)?.deletedReason).toBe("material-replaced");
  expect(blockedRequests).toEqual([]);
});

test("@authenticated クラウド版採用後は古い競合キューを再送しない", async ({ page }) => {
  test.setTimeout(90_000);
  const blockedRequests = await guardProductionFirebase(page);
  page.on("dialog", async dialog => {
    if (dialog.message().includes("ローカル版を競合コピー")) await dialog.dismiss();
    else if (dialog.type() === "prompt" && dialog.message().includes("ノートを閉じる操作")) await dialog.accept("continue");
    else await dialog.accept();
  });
  const user = await createUser();
  await login(page, user);
  await page.locator("#newNoteBtn").click();
  await page.locator("#newNoteTitle").fill("競合破棄E2Eノート");
  await page.locator('[data-create-note="blank"]').click();
  await expect(page.locator("#noteEditorView")).toBeVisible();
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

  await updateNotePage(user.uid, note.id, notePage.pageId, { contentRevision: 2 });
  await drawStroke(32, .25);
  await expect(page.locator("#noteSaveStatus")).toContainText("競合あり", { timeout: 20_000 });
  await expect.poll(() => localNoteStoreCounts(page)).toMatchObject({ pageDrafts: 1, pendingSaves: 1, conflicts: 1 });
  await page.locator("#closeNoteBtn").click();
  await expect(page.locator("#noteListView")).toBeVisible();
  await expect(page.locator(".note-card:has-text('競合破棄E2Eノート')")).toContainText("競合あり");
  await page.locator(".note-card:has-text('競合破棄E2Eノート') button", { hasText: "競合を解決" }).click();
  await expect.poll(() => localNoteStoreCounts(page)).toEqual({ pendingAssets: 0, pageDrafts: 0, pendingSaves: 0, conflicts: 0 });

  await page.locator(".note-card:has-text('競合破棄E2Eノート') button", { hasText: "編集" }).click();
  await page.locator("#closeNoteBtn").click();
  await page.waitForTimeout(1200);
  const after = await readNotes(user.uid);
  expect(after.notes.find(item => item.id === note.id)?.pages[0]?.contentRevision).toBe(2);
  expect(blockedRequests).toEqual([]);
});

test("@authenticated ページ追加・並び替え・削除はorderRevision競合を検出し、再読込後に再試行できる", async ({ page }) => {
  test.setTimeout(90_000);
  const dialogs = [];
  page.on("dialog", async dialog => {
    dialogs.push(dialog.message());
    await dialog.accept();
  });
  const user = await createUser();
  await login(page, user);
  await page.locator("#newNoteBtn").click();
  await page.locator("#newNoteTitle").fill("ページ競合E2Eノート");
  await page.locator('[data-create-note="blank"]').click();
  await expect(page.locator("#noteEditorView")).toBeVisible();
  const [{ id: noteId }] = (await readNotes(user.uid)).notes;

  await updateNoteRoot(user.uid, noteId, { orderRevision: 2 });
  await openPageSidebar(page);
  await page.locator('[data-page-action="add-ruled"]').click();
  await expect.poll(() => dialogs.some(message => message.includes("別の端末でページ順が変更"))).toBe(true);
  await expect(page.locator("#notePageCounter")).toHaveText("1 / 1");

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#authStatus")).toContainText(user.email, { timeout: 20_000 });
  await page.locator("#tabBtnPdf").click();
  await page.locator("#noteModeBtn").click();
  await page.locator(".note-card:has-text('ページ競合E2Eノート') button", { hasText: "編集" }).click();
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
  await page.locator("#tabBtnPdf").click();
  await page.locator("#noteModeBtn").click();
  await page.locator(".note-card:has-text('ページ競合E2Eノート') button", { hasText: "編集" }).click();
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
  await page.locator("#tabBtnPdf").click();
  await page.locator("#noteModeBtn").click();
  await page.locator(".note-card:has-text('ページ競合E2Eノート') button", { hasText: "編集" }).click();
  await openPageSidebar(page);
  await page.locator("#notePageList .note-page-row-actions").nth(1).getByRole("button", { name: "削除" }).click();
  await expect(page.locator("#notePageCounter")).toHaveText("1 / 1");
});

test("@authenticated PDFを教材へ追加せずノート専用Storage背景として順番どおり作成する", async ({ page }) => {
  test.setTimeout(120_000);
  const blockedRequests = await guardProductionFirebase(page);
  const pageErrors = [];
  page.on("pageerror", error => recordUnexpectedPageError(pageErrors, error));
  const user = await createUser();
  await login(page, user);
  const fixture = await createPdfFixture({ pageCount: 2 });

  await page.locator("#newNoteBtn").click();
  await page.locator("#newNoteTitle").fill("E2E PDFノート");
  await page.locator("#notePdfInput").setInputFiles({ name: "two-pages.pdf", mimeType: "application/pdf", buffer: fixture });
  await expect(page.locator("#noteEditorView")).toBeVisible({ timeout: 90_000 });
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
  await row.locator("[data-open-note]").click();
  await expect(page.locator("#noteEditorView")).toBeVisible();
  await expect(page.locator("#notePageStage .note-background-image")).toBeVisible({ timeout: 20_000 });
  await page.locator("#closeNoteBtn").click();

  await page.locator("#pdfEditModeBtn").click();
  row = page.locator('#pdfEditTableBody tr:has-text("既定ノートE2E教材")');
  await row.locator("[data-open-note]").click();
  await expect(page.locator("#noteEditorView")).toBeVisible();

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
