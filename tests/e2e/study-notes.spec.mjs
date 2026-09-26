import { expect, test } from "@playwright/test";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, getDocs, setDoc, updateDoc } from "firebase/firestore";
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

async function updateNoteRoot(uid, noteId, fields) {
  const environment = await initializeTestEnvironment({ projectId: "demo-dental-qa", firestore: { host: "127.0.0.1", port: 8080 } });
  try {
    const db = environment.authenticatedContext(uid).firestore();
    await updateDoc(doc(db, "users", uid, "notes", noteId), fields);
  } finally {
    await environment.cleanup();
  }
}

async function localNoteStoreCounts(page) {
  return page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("dentalQaNoteLocal", 1);
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
      pendingSaves: await count("pendingSaves")
    };
    database.close();
    return result;
  });
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
  await expect(stage.locator('path[data-element-id]')).toHaveCount(1);

  await page.locator('[data-note-tool="mask"]').click();
  await stage.dispatchEvent("pointerdown", { pointerId: 2, pointerType: "mouse", button: 0, clientX: box.x + box.width * .25, clientY: box.y + box.height * .18 });
  await stage.dispatchEvent("pointermove", { pointerId: 2, pointerType: "mouse", button: 0, clientX: box.x + box.width * .58, clientY: box.y + box.height * .25 });
  await stage.dispatchEvent("pointerup", { pointerId: 2, pointerType: "mouse", button: 0, clientX: box.x + box.width * .58, clientY: box.y + box.height * .25 });
  await expect(stage.locator(".note-mask")).toHaveCount(1);

  await openPageSidebar(page);
  await page.locator('[data-page-action="add-ruled"]').click();
  await expect(page.locator("#notePageCounter")).toHaveText("2 / 2");
  await page.locator("#noteImageFileInput").setInputFiles({ name: "paste.png", mimeType: "image/png", buffer: TEST_PNG });
  await expect.poll(async () => ({
    imageCount: await stage.locator(".note-image-element").count(),
    dialogs
  }), { timeout: 20_000 }).toEqual({ imageCount: 1, dialogs: [] });
  await expect(page.locator("#noteSaveStatus")).toContainText("保存済み", { timeout: 20_000 });

  await page.locator("#toggleNoteStudyBtn").click();
  await expect(page.locator("#noteStudyControls")).toBeVisible();
  await page.locator("#toggleNoteStudyBtn").click();

  await page.locator(".note-more-menu summary").click();
  await page.locator('[data-note-action="export"]').click();
  await expect(page.locator("#noteExportDialog")).toBeVisible();
  await page.locator("#createNotePdfBtn").click();
  await expect(page.locator("#noteExportStatus")).toContainText("作成したPDF", { timeout: 60_000 });
  await expect(page.locator("#noteExportFilename")).toHaveValue(/AI共有用.*\.pdf$/);
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#downloadNotePdfBtn").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^(download|.*AI共有用.*\.pdf)$/);
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
  await expect(page.locator("#notePageStage path[data-element-id]")).toHaveCount(1);

  const stored = await readNotes(user.uid);
  expect(stored.notes).toHaveLength(1);
  expect(stored.notes[0].pages).toHaveLength(2);
  expect(stored.pdfMaterials).toHaveLength(0);
  expect(blockedRequests).toEqual([]);
  expect(pdfCdnRequests, "PDF出力はjsDelivr/cdnjsへ接続しない").toEqual([]);
  expect(pageErrors).toEqual([]);
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
    try {
      await store.uploadAsset("note-oversized", blob);
      return { error: "", contextCalled };
    } catch (error) {
      return { error: error?.message || String(error), contextCalled };
    }
  }, oversizedPng.toString("base64"));

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

  await page.locator("#newNoteBtn").click();
  await page.locator("#newNoteTitle").fill("画像復旧E2Eノート");
  await page.locator('[data-create-note="blank"]').click();
  await expect(page.locator("#noteEditorView")).toBeVisible();

  await page.route("**/v0/b/demo-dental-qa.firebasestorage.app/o**", async route => {
    const request = route.request();
    const objectName = new URL(request.url()).searchParams.get("name") || "";
    if (["POST", "PUT"].includes(request.method()) && objectName.includes("/notes/") && objectName.includes("/assets/")) {
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

  await page.unroute("**/v0/b/demo-dental-qa.firebasestorage.app/o**");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#authStatus")).toContainText(user.email, { timeout: 20_000 });
  await page.locator("#tabBtnPdf").click();
  await page.locator("#noteModeBtn").click();
  await page.locator(".note-card:has-text('画像復旧E2Eノート') button", { hasText: "編集" }).click();
  await expect(page.locator("#notePageStage .note-image-element")).toHaveCount(1, { timeout: 20_000 });
  await expect.poll(() => localNoteStoreCounts(page)).toEqual({ pendingAssets: 0, pageDrafts: 0, pendingSaves: 0 });
  const stored = await readNotes(user.uid);
  expect(stored.notes[0].pages[0].contentRevision).toBeGreaterThan(0);
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
