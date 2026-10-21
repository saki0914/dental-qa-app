// Revision 15: the mask tool's ＋追加 / 選択・編集 modes, red underlines of
// masks and summary notes made from pages marked "テストに出る".
import { expect, test } from "@playwright/test";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, getDocs, increment, setDoc, updateDoc } from "firebase/firestore";
import { getMetadata, ref, uploadBytes } from "firebase/storage";
import { PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import { guardProductionFirebase } from "../helpers/readOnlyApp.mjs";

const TEST_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);
const BUCKET = "gs://demo-dental-qa.firebasestorage.app";

function recordUnexpectedPageError(errors, error) {
  const message = error?.message || String(error);
  const emulatorChannelClosed = message.includes("127.0.0.1:8080/google.firestore.v1.Firestore/") &&
    message.includes("/channel?") &&
    message.includes("due to access control checks.");
  if (!emulatorChannelClosed) errors.push(message);
}

async function createUser() {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const email = `summary-${suffix}@example.test`;
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
  await openNoteList(page);
}

async function openNoteList(page) {
  const newNoteButton = page.locator("#newNoteBtn");
  await expect.poll(async () => await newNoteButton.isVisible() || await page.locator("#tabBtnPdf").isVisible(), { timeout: 20_000 }).toBe(true);
  if (!await newNoteButton.isVisible()) {
    await page.locator("#tabBtnPdf").click();
    if (!await newNoteButton.isVisible()) await page.locator("#noteModeBtn").click();
  }
  await expect(newNoteButton).toBeVisible();
}

async function withEnvironment(callback) {
  const environment = await initializeTestEnvironment({
    projectId: "demo-dental-qa",
    firestore: { host: "127.0.0.1", port: 8080 },
    storage: { host: "127.0.0.1", port: 9199 }
  });
  try {
    return await callback(environment);
  } finally {
    await environment.cleanup();
  }
}

const blankPageDocument = (noteId, order, extra = {}) => ({
  schemaVersion: 1,
  noteId,
  order,
  pageType: "blank",
  contentRevision: 0,
  contentPath: "",
  contentHash: "",
  noteMaskCount: 0,
  deletedAt: null,
  size: { width: 1240, height: 1754 },
  background: { type: "blank", paperColor: "#FFFFFF" },
  ...extra
});

async function seedNote(uid, title, pageCount, { root = {}, page = () => ({}) } = {}) {
  const noteId = `note-summary-${crypto.randomUUID()}`;
  const pageIds = Array.from({ length: pageCount }, () => `page-summary-${crypto.randomUUID()}`);
  await withEnvironment(async environment => {
    const db = environment.authenticatedContext(uid).firestore();
    await setDoc(doc(db, "users", uid, "notes", noteId), {
      schemaVersion: 1, title, type: "standalone", status: "ready", pageCount,
      noteMaskCount: 0, orderRevision: 1, materialRefs: [], deletedAt: null, ...root
    });
    await Promise.all(pageIds.map((pageId, index) => setDoc(doc(db, "users", uid, "notes", noteId, "pages", pageId), {
      ...blankPageDocument(noteId, index + 1),
      ...page(index)
    })));
  });
  return { noteId, pageIds };
}

// Content as another tab of the app would have saved it (revision `revision`).
async function writePageContent(uid, noteId, pageId, { elements = [], noteMasks = [] }, revision) {
  await withEnvironment(async environment => {
    const context = environment.authenticatedContext(uid);
    const contentPath = `users/${uid}/notes/${noteId}/pages/${pageId}/revisions/seed-${revision}-${crypto.randomUUID()}.json`;
    const json = JSON.stringify({ schemaVersion: 1, noteId, pageId, revision, elements, noteMasks, savedAt: new Date().toISOString() });
    await uploadBytes(ref(context.storage(BUCKET), contentPath), Buffer.from(json), { contentType: "application/json" });
    await environment.withSecurityRulesDisabled(async adminContext => {
      const db = adminContext.firestore();
      const pageReference = doc(db, "users", uid, "notes", noteId, "pages", pageId);
      const previousMaskCount = Number((await getDoc(pageReference)).data()?.noteMaskCount || 0);
      await updateDoc(pageReference, {
        contentPath, contentRevision: revision, contentHash: `seed-${revision}-${crypto.randomUUID()}`, noteMaskCount: noteMasks.length
      });
      // The note keeps the sum of its pages' mask counts, as the app does.
      await updateDoc(doc(db, "users", uid, "notes", noteId), { noteMaskCount: increment(noteMasks.length - previousMaskCount) });
    });
  });
}

async function seedMaterialNote(uid) {
  const materialId = `material-summary-${crypto.randomUUID()}`;
  const imagePath = `users/${uid}/imageMaterials/${materialId}/page-1.png`;
  await withEnvironment(async environment => {
    const context = environment.authenticatedContext(uid);
    await uploadBytes(ref(context.storage(BUCKET), imagePath), TEST_PNG, { contentType: "image/png" });
    await setDoc(doc(context.firestore(), "users", uid, "app", "pdfMaterials"), {
      pdfMaterials: [{
        id: materialId, title: "まとめE2E教材", subject: "E2E", categories: [], tags: [],
        pages: [{ page: 1, imagePath, width: 1240, height: 1754 }],
        masks: [{ id: "material-mask-1", page: 1, x: 30, y: 40, width: 20, height: 5, weak: false }],
        sourceType: "images", sourceName: ""
      }],
      pdfRevealStates: {}, selectedPdfId: materialId, selectedMaskId: null, pdfSearchQuery: ""
    });
  });
  const pageId = "material-page-0001";
  const noteId = `note-material-${crypto.randomUUID()}`;
  await withEnvironment(async environment => {
    const db = environment.authenticatedContext(uid).firestore();
    await setDoc(doc(db, "users", uid, "notes", noteId), {
      schemaVersion: 1, title: "教材ノートE2E", type: "material-linked", sourceMaterialId: materialId,
      materialRefs: [materialId], status: "ready", pageCount: 1, noteMaskCount: 0, orderRevision: 1,
      deletedAt: null, testMarkedPageIds: [pageId]
    });
    await setDoc(doc(db, "users", uid, "notes", noteId, "pages", pageId), {
      ...blankPageDocument(noteId, 1),
      pageType: "material-page",
      background: { type: "material-page", materialId, materialPage: 1 }
    });
  });
  return { materialId, noteId, pageId };
}

async function readNote(uid, noteId) {
  return withEnvironment(async environment => {
    const db = environment.authenticatedContext(uid).firestore();
    const note = await getDoc(doc(db, "users", uid, "notes", noteId));
    const pages = await getDocs(collection(db, "users", uid, "notes", noteId, "pages"));
    return {
      id: noteId,
      ...note.data(),
      pages: pages.docs.map(item => ({ pageId: item.id, ...item.data() })).sort((a, b) => a.order - b.order)
    };
  });
}

async function listNoteIds(uid) {
  return withEnvironment(async environment => {
    const snapshots = await getDocs(collection(environment.authenticatedContext(uid).firestore(), "users", uid, "notes"));
    return snapshots.docs.map(item => ({ id: item.id, ...item.data() }));
  });
}

async function storageObjectExists(uid, path) {
  return withEnvironment(async environment => {
    try {
      await getMetadata(ref(environment.authenticatedContext(uid).storage(BUCKET), path));
      return true;
    } catch (error) {
      if (String(error?.code || "").includes("object-not-found")) return false;
      throw error;
    }
  });
}

async function openEditor(page, noteId) {
  await page.goto(`/?firebaseEmulator=1&noteEditor=1&noteId=${noteId}&editorTabId=${crypto.randomUUID()}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#noteEditorStartup")).toBeHidden({ timeout: 60_000 });
}

async function waitSaved(page) {
  await expect(page.locator("#noteSaveStatus")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
}

async function dragOn(page, from, to, steps = 6) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up();
}

// The note mask nodes' bounds in shares of the page (their percent styles).
async function maskShares(stage) {
  return stage.locator(".note-mask[data-read-only=\"false\"]").evaluateAll(nodes => nodes.map(node => ({
    id: node.dataset.maskId,
    inherited: node.classList.contains("inherited"),
    underlined: node.classList.contains("underlined"),
    x: parseFloat(node.style.left) / 100,
    y: parseFloat(node.style.top) / 100,
    width: parseFloat(node.style.width) / 100,
    height: parseFloat(node.style.height) / 100
  })));
}

const place = (mask, rect) => ({
  x: rect.x + mask.x * rect.width,
  y: rect.y + mask.y * rect.height,
  width: mask.width * rect.width,
  height: mask.height * rect.height
});

function expectBoundsClose(actual, expected, message) {
  for (const field of ["x", "y", "width", "height"]) {
    expect(Math.abs(actual[field] - expected[field]), `${message}: ${field}`).toBeLessThan(2e-4);
  }
}

async function createSummaryFromList(listPage, { title, perPage, memo, order = null, blockedRequests }) {
  await listPage.bringToFront();
  await listPage.locator("#newNoteBtn").click();
  const popupPromise = listPage.waitForEvent("popup", { timeout: 60_000 });
  await listPage.locator('[data-create-note="summary"]').click();
  const creator = await popupPromise;
  await guardProductionFirebase(creator, blockedRequests);
  await expect(creator.locator("#noteSummaryPicker")).toBeVisible({ timeout: 30_000 });
  await expect(creator.locator("#noteSummaryCreateBtn")).toBeVisible({ timeout: 30_000 });
  if (order) await order(creator);
  await creator.locator(`input[name="noteSummaryPerPage"][value="${perPage}"]`).check();
  await creator.locator(`input[name="noteSummaryMemo"][value="${memo}"]`).check();
  await creator.locator("#newNoteTitle").fill(title);
  await creator.locator("#noteSummaryCreateBtn").click();
  await creator.waitForURL(url => Boolean(url.searchParams.get("noteId")), { timeout: 90_000 });
  await expect(creator.locator("#noteEditorStartup")).toBeHidden({ timeout: 60_000 });
  // The whole summary page in view (the mouse works inside the viewport only).
  await creator.setViewportSize({ width: 1180, height: 1500 });
  return creator;
}

async function takeOutOfSummary(target, label) {
  await target.bringToFront();
  await target.locator(".note-more-menu summary").click();
  await target.locator('[data-note-action="summary-sources"]').click();
  await expect(target.locator("#noteSummaryDialog")).toBeVisible();
  const slotRow = target.locator(".note-summary-slot").filter({ hasText: label });
  await expect(slotRow).toHaveCount(1);
  await slotRow.getByRole("button", { name: "まとめから外す" }).click();
  await expect(target.locator("#noteSummaryDialogStatus")).toContainText("まとめから外しました", { timeout: 60_000 });
  await expect(target.locator(".note-summary-slot").filter({ hasText: label })).toHaveCount(0);
  await target.locator('#noteSummaryDialog button[value="close"]').click();
  await expect(target.locator("#noteSummaryDialog")).toBeHidden();
}

// The JPEG of the first page of a PDF this app wrote, decoded in the page.
async function pdfPagePixels(page, pdfBytes, points) {
  const pdf = await PDFDocument.load(pdfBytes);
  const images = [];
  pdf.context.enumerateIndirectObjects().forEach(([, object]) => {
    if (object instanceof PDFRawStream && object.dict.get(PDFName.of("Subtype"))?.toString() === "/Image") images.push(object);
  });
  expect(images.length, "ページ画像").toBeGreaterThan(0);
  const base64 = Buffer.from(images[0].contents).toString("base64");
  return page.evaluate(async ({ base64, points }) => {
    const image = new Image();
    image.src = `data:image/jpeg;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    // Every pixel of a 7 x 7 square around each point.
    return points.map(([x, y]) => {
      const left = Math.max(0, Math.round(x * canvas.width) - 3);
      const top = Math.max(0, Math.round(y * canvas.height) - 3);
      const data = context.getImageData(left, top, 7, 7).data;
      const pixels = [];
      for (let index = 0; index < data.length; index += 4) pixels.push([data[index], data[index + 1], data[index + 2]]);
      return pixels;
    });
  }, { base64, points });
}

test("@authenticated @ipad-writing-mask マスクは＋追加で隣に5個続けて作っても先のマスクが変わらず、選択・編集で直せ、赤い下線が付いて追従する", async ({ page }) => {
  test.setTimeout(180_000);
  const blockedRequests = await guardProductionFirebase(page);
  const pageErrors = [];
  const dialogs = [];
  page.on("pageerror", error => recordUnexpectedPageError(pageErrors, error));
  page.on("dialog", dialog => { dialogs.push(dialog.message()); void dialog.accept(); });
  const user = await createUser();
  const note = await seedNote(user.uid, "マスク連続作成E2E", 2);
  await login(page, user);
  await page.setViewportSize({ width: 1180, height: 820 });
  await openEditor(page, note.noteId);
  const stage = page.locator("#notePageStage");
  const masks = stage.locator(".note-mask");
  const underlines = stage.locator(".note-mask-underline");
  const box = await stage.boundingBox();
  const at = (x, y) => ({ x: box.x + box.width * x, y: box.y + box.height * y });
  const rounded = rect => ({ x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) });

  await expect(page.locator("#noteMaskAddModeBtn"), "マスクツール以外ではモードを出さない").toBeHidden();
  await page.locator('[data-note-tool="mask"]').click();
  await expect(page.locator("#noteMaskAddModeBtn")).toBeVisible();
  await expect(page.locator("#noteMaskAddModeBtn")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#noteMaskAddModeBtn")).toContainText("追加");
  await expect(page.locator("#noteMaskEditModeBtn")).toHaveAttribute("aria-pressed", "false");

  // Five masks side by side: each drag starts on the previous mask's right
  // edge, where its resize handle used to be.
  const created = [];
  for (let index = 0; index < 5; index += 1) {
    const previous = created[index - 1];
    const from = previous ? { x: previous.x + previous.width - 1, y: previous.y + 2 } : at(.08, .2);
    await dragOn(page, from, at(.08 + (index + 1) * .15, .25));
    await expect(masks).toHaveCount(index + 1);
    await expect(stage.locator("[data-transform-handle]"), "作成したマスクにつまみを出さない").toHaveCount(0);
    await expect(stage.locator(".note-mask.note-selected"), "作成したマスクを選択しない").toHaveCount(0);
    created.push(await masks.nth(index).boundingBox());
    for (let earlier = 0; earlier < index; earlier += 1) {
      expect(rounded(await masks.nth(earlier).boundingBox()), `${earlier + 1}個目は${index + 1}個目を作っても変わらない`).toEqual(rounded(created[earlier]));
    }
  }
  await expect(page.locator("#noteMaskAddModeBtn"), "＋追加のまま").toHaveAttribute("aria-pressed", "true");
  await expect(underlines, "マスクと一緒に赤い下線を付ける").toHaveCount(5);
  const expectUnderlineFollows = async (maskLocator, message) => {
    const id = await maskLocator.getAttribute("data-mask-id");
    const maskBox = await maskLocator.boundingBox();
    const lineBox = await stage.locator(`.note-mask-underline[data-underline-for="${id}"]`).boundingBox();
    expect(Math.abs(lineBox.x - maskBox.x), message).toBeLessThan(1.5);
    expect(Math.abs(lineBox.width - maskBox.width), message).toBeLessThan(1.5);
    expect(Math.abs(lineBox.y - (maskBox.y + maskBox.height)), message).toBeLessThan(1.5);
    await expect(stage.locator(`.note-mask-underline[data-underline-for="${id}"]`)).toHaveCSS("background-color", "rgb(220, 38, 38)");
  };
  for (let index = 0; index < 5; index += 1) await expectUnderlineFollows(masks.nth(index), `${index + 1}個目の下線はマスクの下端`);
  await page.mouse.click(at(.5, .6).x, at(.5, .6).y);
  await expect(masks, "タップではマスクを作らない").toHaveCount(5);

  // 選択・編集: only the chosen mask gets handles; it moves and resizes with
  // its underline; the underline can be taken off and put back; deleting the
  // mask deletes its underline.
  await page.locator("#noteMaskEditModeBtn").click();
  await expect(page.locator("#noteMaskEditModeBtn")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#noteMaskAddModeBtn")).toHaveAttribute("aria-pressed", "false");
  await expect(stage).toHaveAttribute("data-mask-mode", "edit");
  const third = masks.nth(2);
  const thirdId = await third.getAttribute("data-mask-id");
  await third.click();
  await expect(stage.locator(".note-mask.note-selected")).toHaveCount(1);
  await expect(stage.locator(".note-mask.note-selected")).toHaveAttribute("data-mask-id", thirdId);
  await expect(stage.locator('[data-transform-handle="resize-se"]')).toHaveCount(1);
  const beforeResize = await third.boundingBox();
  const handle = await stage.locator('[data-transform-handle="resize-se"]').boundingBox();
  await dragOn(page, { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 }, { x: handle.x + handle.width / 2 + 24, y: handle.y + handle.height / 2 + 36 });
  const resized = await stage.locator(`.note-mask[data-mask-id="${thirdId}"]`).boundingBox();
  expect(resized.height).toBeGreaterThan(beforeResize.height + 25);
  await expectUnderlineFollows(stage.locator(`.note-mask[data-mask-id="${thirdId}"]`), "サイズ変更に下線が追従する");
  const center = { x: resized.x + resized.width / 2, y: resized.y + resized.height / 2 };
  await dragOn(page, center, { x: center.x + 10, y: center.y + 90 });
  const moved = await stage.locator(`.note-mask[data-mask-id="${thirdId}"]`).boundingBox();
  expect(moved.y).toBeGreaterThan(resized.y + 80);
  await expectUnderlineFollows(stage.locator(`.note-mask[data-mask-id="${thirdId}"]`), "移動に下線が追従する");
  for (const index of [0, 1, 3, 4]) {
    expect(rounded(await masks.nth(index).boundingBox()), `${index + 1}個目は3個目の編集で変わらない`).toEqual(rounded(created[index]));
  }
  await expect(page.locator('#noteSelectionActions [data-selection-action="underline-on"]'), "下線のあるマスクには「下線を外す」だけを出す").toBeHidden();
  await page.locator('#noteSelectionActions [data-selection-action="underline-off"]').click();
  await expect(stage.locator(`.note-mask-underline[data-underline-for="${thirdId}"]`)).toHaveCount(0);
  await expect(underlines).toHaveCount(4);
  await expect(page.locator('#noteSelectionActions [data-selection-action="underline-off"]')).toBeHidden();
  await page.locator('#noteSelectionActions [data-selection-action="underline-on"]').click();
  await expect(underlines).toHaveCount(5);
  await page.locator('#noteSelectionActions [data-selection-action="delete"]').click();
  await expect(masks).toHaveCount(4);
  await expect(underlines, "マスクを消すと下線も消える").toHaveCount(4);
  await expect(stage.locator(`.note-mask-underline[data-underline-for="${thirdId}"]`)).toHaveCount(0);
  await page.locator("#noteMaskAddModeBtn").click();
  await expect(stage.locator(".note-mask.note-selected"), "＋追加へ戻ると選択を外す").toHaveCount(0);
  await expect(stage).toHaveAttribute("data-mask-mode", "add");

  // Study mode: a closed mask covers its underline; an opened one shows it.
  await page.locator("#noteStudyModeBtn").click();
  await expect(stage).toHaveClass(/study-mode/);
  await expect(page.locator("#noteMaskAddModeBtn"), "暗記モードでは追加・編集を出さない").toBeHidden();
  const first = masks.first();
  const firstId = await first.getAttribute("data-mask-id");
  const firstUnderline = stage.locator(`.note-mask-underline[data-underline-for="${firstId}"]`);
  await expect(first).toHaveCSS("background-color", "rgb(17, 24, 39)");
  await expect(firstUnderline, "閉じたマスクは下線も隠す").toHaveCSS("visibility", "hidden");
  await first.click();
  await expect(stage.locator(".note-mask.revealed")).toHaveCount(1);
  await expect(first, "開いたマスクから文字が見える").toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(firstUnderline, "開いたマスクの赤い下線が見える").toHaveCSS("visibility", "visible");
  await expectUnderlineFollows(first, "開いたマスクの下線の位置");
  await expect(stage.locator(".note-mask-underline:not(.revealed)").first()).toHaveCSS("visibility", "hidden");
  await page.locator("#noteEditModeBtn").click();
  await waitSaved(page);

  // The mask settings: new masks without an underline; then underlines put
  // on and taken off every mask of the note (both pages).
  await page.locator('[data-note-tool="mask"]').click();
  if (!await page.locator("#noteToolSettings").isVisible()) await page.locator('[data-note-tool="mask"]').click();
  await expect(page.locator("#noteToolSettingsTitle")).toHaveText("暗記マスク設定");
  await expect(page.locator("#noteMaskUnderline")).toBeChecked();
  await page.locator("#noteMaskUnderline").uncheck();
  await page.locator("#noteToolSettingsDoneBtn").click();
  await page.locator("#notePageList .note-page-thumbnail").nth(1).click();
  await expect(page.locator("#notePageCounter")).toHaveText("2 / 2");
  await dragOn(page, at(.2, .5), at(.5, .56));
  await expect(masks).toHaveCount(1);
  await expect(underlines, "設定を外すと下線なしで作る").toHaveCount(0);
  await page.locator('[data-note-tool="mask"]').click();
  await expect(page.locator("#noteToolSettings")).toBeVisible();
  await page.locator('[data-mask-underline-all="off"]').click();
  await expect(page.locator("#noteEditorNotice")).toContainText("4個のマスクの下線を外しました");
  await page.locator("#notePageList .note-page-thumbnail").nth(0).click();
  await expect(page.locator("#notePageCounter")).toHaveText("1 / 2");
  await expect(masks).toHaveCount(4);
  await expect(underlines, "表示していないページの下線も外す").toHaveCount(0);
  await page.locator('[data-note-tool="mask"]').click();
  if (!await page.locator("#noteToolSettings").isVisible()) await page.locator('[data-note-tool="mask"]').click();
  await page.locator('[data-mask-underline-all="on"]').click();
  await expect(page.locator("#noteEditorNotice")).toContainText("2ページの5個のマスクの下線を付けました");
  await expect(underlines).toHaveCount(4);
  expect(dialogs.filter(message => message.includes("赤い下線"))).toHaveLength(2);
  await waitSaved(page);

  // Kept after reloading.
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#noteEditorStartup")).toBeHidden({ timeout: 60_000 });
  await expect(masks).toHaveCount(4);
  await expect(underlines).toHaveCount(4);
  await page.locator("#notePageList .note-page-thumbnail").nth(1).click();
  await expect(masks).toHaveCount(1);
  await expect(underlines, "別ページのマスクにも保存されている").toHaveCount(1);
  expect(blockedRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test("@authenticated テストに出るページからまとめノートを作り、書き込み・マスク・下線を引き継いで編集・元ノートからの更新・PDF出力・削除の制限ができる", async ({ page, context }) => {
  test.setTimeout(420_000);
  const blockedRequests = await guardProductionFirebase(page);
  const pageErrors = [];
  const dialogs = [];
  const watch = target => {
    target.on("pageerror", error => recordUnexpectedPageError(pageErrors, error));
    target.on("dialog", dialog => { dialogs.push(dialog.message()); void dialog.accept(); });
  };
  watch(page);
  context.on("page", watch);
  const user = await createUser();

  // Source note A: three pages, two of them to be marked; source B: a page of
  // an image material with a material mask and a note mask.
  const source = await seedNote(user.uid, "授業ノートA", 3);
  const [pageA1, pageA2, pageA3] = source.pageIds;
  const ink = (x1, y1, x2, y2) => ({
    id: `ink-${crypto.randomUUID()}`, type: "stroke", zIndex: 10, pressureEnabled: false,
    points: [{ x: x1, y: y1, pressure: .5 }, { x: x2, y: y2, pressure: .5 }],
    style: { color: "#111111", widthRatio: .004, opacity: 1 }
  });
  const a1 = { id: "a1", x: .1, y: .1, width: .3, height: .06, weak: false, underline: true };
  const a2 = { id: "a2", x: .5, y: .5, width: .2, height: .05, weak: true };
  const b1 = { id: "b1", x: .2, y: .7, width: .4, height: .05, weak: false, underline: true };
  const inkA1 = ink(.1, .3, .9, .3);
  await writePageContent(user.uid, source.noteId, pageA1, { elements: [inkA1], noteMasks: [a1, a2] }, 1);
  await writePageContent(user.uid, source.noteId, pageA2, { elements: [ink(.2, .2, .8, .2)], noteMasks: [b1] }, 1);
  const material = await seedMaterialNote(user.uid);
  await writePageContent(user.uid, material.noteId, material.pageId, { noteMasks: [{ id: "n1", x: .6, y: .2, width: .2, height: .05, weak: false }] }, 1);

  await login(page, user);
  await page.setViewportSize({ width: 1180, height: 820 });

  // Marks on pages 1 and 2 of A, from its page list.
  const sourceTab = await context.newPage();
  await guardProductionFirebase(sourceTab, blockedRequests);
  await sourceTab.setViewportSize({ width: 1180, height: 820 });
  await openEditor(sourceTab, source.noteId);
  const marks = sourceTab.locator("#notePageList .note-page-test-mark");
  await expect(marks).toHaveCount(3);
  await expect(marks.nth(0)).toHaveAttribute("aria-pressed", "false");
  await marks.nth(0).click();
  await marks.nth(1).click();
  await expect(marks.nth(0)).toHaveAttribute("aria-pressed", "true");
  await expect(marks.nth(1)).toHaveAttribute("aria-pressed", "true");
  await expect(sourceTab.locator("#notePageList li.test-marked")).toHaveCount(2);
  await expect(sourceTab.locator("#notePageList li.test-marked .note-page-test-badge").first()).toBeVisible();
  await expect.poll(async () => [...((await readNote(user.uid, source.noteId)).testMarkedPageIds || [])].sort()).toEqual([pageA1, pageA2].sort());
  // Every tab keeps Firestore connections open and the browser allows six
  // per host: the test keeps at most three app tabs open.
  await sourceTab.close();

  // The summary: the marked pages listed (not page 3), B moved to the top,
  // A's page 2 taken out and put back (it goes last), six to a page.
  const summaryTab = await createSummaryFromList(page, {
    title: "まとめE2E",
    perPage: 6,
    memo: "narrow",
    blockedRequests,
    order: async creator => {
      const boxes = creator.locator('#noteSummaryPicker input[type="checkbox"]');
      await expect(boxes).toHaveCount(3);
      await expect(creator.locator("#noteSummaryPicker")).not.toContainText("p.3");
      const rows = creator.locator(".note-summary-order li");
      await expect(rows).toHaveCount(3);
      await expect(rows.nth(2)).toContainText("教材ノートE2E");
      await rows.nth(2).getByRole("button", { name: /上へ/ }).click();
      await creator.locator(".note-summary-order li").nth(1).getByRole("button", { name: /上へ/ }).click();
      await expect(creator.locator(".note-summary-order li").nth(0)).toContainText("教材ノートE2E");
      await creator.locator(`input[data-summary-key="${source.noteId}/${pageA2}"]`).uncheck();
      await expect(creator.locator(".note-summary-order li")).toHaveCount(2);
      await creator.locator(`input[data-summary-key="${source.noteId}/${pageA2}"]`).check();
      await expect(creator.locator(".note-summary-order li").nth(2)).toContainText("授業ノートA  p.2");
      await expect(creator.locator(".note-summary-result")).toContainText("3ページを1ページに");
    }
  });
  const summaryId = new URL(summaryTab.url()).searchParams.get("noteId");
  await expect(summaryTab.locator("#noteTitleInput")).toHaveValue("まとめE2E");
  await expect(summaryTab.locator("#notePageCounter")).toHaveText("1 / 1");
  await expect(summaryTab.locator("#notePageList .note-page-test-mark"), "まとめノートには印を付けない").toHaveCount(0);
  await expect(summaryTab.locator(".note-background-image")).toBeVisible();
  await expect(summaryTab.locator(".note-background-error")).toBeHidden();

  // The source notes are unchanged; the summary is a note of its own.
  const sourceAfter = await readNote(user.uid, source.noteId);
  expect(sourceAfter.pages.map(item => item.contentRevision)).toEqual([1, 1, 0]);
  const summary = await readNote(user.uid, summaryId);
  expect(summary.type).toBe("standalone");
  expect(summary.status).toBe("ready");
  expect(summary.summary).toMatchObject({ version: 1, perPage: 6, memo: "narrow" });
  expect(summary.pendingStoragePaths).toEqual([]);
  expect([...summary.summarySourceNoteIds].sort()).toEqual([material.noteId, source.noteId].sort());
  expect([...summary.summarySourcePages].sort()).toEqual([`${material.noteId}/${material.pageId}`, `${source.noteId}/${pageA1}`, `${source.noteId}/${pageA2}`].sort());
  const [summaryPage] = summary.pages;
  expect(summaryPage.size).toEqual({ width: 2480, height: 3508 });
  expect(summaryPage.background.imagePath).toMatch(new RegExp(`^users/${user.uid}/notes/${summaryId}/sourcePages/${summaryPage.pageId}/summary-`));
  const slots = summaryPage.summary.slots;
  expect(slots.map(slot => `${slot.noteId}/${slot.pageId}`)).toEqual([`${material.noteId}/${material.pageId}`, `${source.noteId}/${pageA1}`, `${source.noteId}/${pageA2}`]);
  const [slotB, slotA1, slotA2] = slots;
  for (const slot of slots) {
    expect(Math.abs(slot.rect.width * 2480 / (slot.rect.height * 3508) - 1240 / 1754), "縦横比を維持").toBeLessThan(1e-3);
  }

  // Every inherited mask sits where it was on its page; underlines come along.
  const stage = summaryTab.locator("#notePageStage");
  let shares = await maskShares(stage);
  expect(shares.filter(mask => mask.inherited)).toHaveLength(5);
  const byPlace = expected => shares.find(mask => Math.abs(mask.x - expected.x) < 2e-4 && Math.abs(mask.y - expected.y) < 2e-4);
  const expectedA1 = place(a1, slotA1.rect);
  expectBoundsClose(byPlace(expectedA1), expectedA1, "A p.1のマスク1");
  expectBoundsClose(byPlace(place(a2, slotA1.rect)), place(a2, slotA1.rect), "A p.1のマスク2");
  expectBoundsClose(byPlace(place(b1, slotA2.rect)), place(b1, slotA2.rect), "A p.2のマスク");
  expectBoundsClose(byPlace(place({ x: .3, y: .4, width: .2, height: .05 }, slotB.rect)), place({ x: .3, y: .4, width: .2, height: .05 }, slotB.rect), "教材マスク");
  expectBoundsClose(byPlace(place({ x: .6, y: .2, width: .2, height: .05 }, slotB.rect)), place({ x: .6, y: .2, width: .2, height: .05 }, slotB.rect), "教材ページのノートマスク");
  expect(byPlace(expectedA1).underlined).toBe(true);
  expect(byPlace(place(a2, slotA1.rect)).underlined).toBe(false);
  await expect(stage.locator(".note-mask-underline")).toHaveCount(2);

  // Each mask opens and closes on its own in study mode.
  await summaryTab.locator("#noteStudyModeBtn").click();
  const studyMasks = stage.locator(".note-mask");
  await expect(studyMasks).toHaveCount(5);
  for (let index = 0; index < 5; index += 1) {
    await studyMasks.nth(index).click();
    await expect(stage.locator(".note-mask.revealed")).toHaveCount(index + 1);
  }
  await studyMasks.nth(2).click();
  await expect(stage.locator(".note-mask.revealed")).toHaveCount(4);
  await summaryTab.locator("#noteEditModeBtn").click();

  // The summary's own writing and mask (with an underline), and an inherited
  // mask moved in the summary (A p.2's: its source will not change).
  const box = await stage.boundingBox();
  const at = (x, y) => ({ x: box.x + box.width * x, y: box.y + box.height * y });
  await summaryTab.locator('[data-note-tool="pen"]').click();
  await dragOn(summaryTab, at(.86, .8), at(.95, .85));
  await expect(stage.locator("path[data-element-id]")).toHaveCount(1);
  await summaryTab.locator('[data-note-tool="mask"]').click();
  await dragOn(summaryTab, at(.85, .9), at(.95, .93));
  shares = await maskShares(stage);
  expect(shares).toHaveLength(6);
  const own = shares.find(mask => !mask.inherited);
  expect(own.underlined, "まとめ側で作ったマスクにも下線").toBe(true);
  await summaryTab.locator("#noteMaskEditModeBtn").click();
  const b1Placed = place(b1, slotA2.rect);
  const b1Id = byPlace(b1Placed).id;
  const b1Box = await stage.locator(`.note-mask[data-mask-id="${b1Id}"]`).boundingBox();
  await dragOn(summaryTab, { x: b1Box.x + b1Box.width / 2, y: b1Box.y + b1Box.height / 2 }, { x: b1Box.x + b1Box.width / 2 + 12, y: b1Box.y + b1Box.height / 2 + 20 });
  await expect(summaryTab.locator("#noteSelectionActionsTitle")).toContainText("元ノートのマスク1個");
  const b1Moved = (await maskShares(stage)).find(mask => mask.id === b1Id);
  expect(b1Moved.y).toBeGreaterThan(b1Placed.y + .002);
  // A1's mask is moved in the summary too: its source will change it.
  const a1Id = byPlace(expectedA1).id;
  const a1Box = await stage.locator(`.note-mask[data-mask-id="${a1Id}"]`).boundingBox();
  await dragOn(summaryTab, { x: a1Box.x + a1Box.width / 2, y: a1Box.y + a1Box.height / 2 }, { x: a1Box.x + a1Box.width / 2 + 15, y: a1Box.y + a1Box.height / 2 + 15 });
  await waitSaved(summaryTab);

  // A second summary showing A's page 1 (two to a page, no memo space).
  const secondTab = await createSummaryFromList(page, {
    title: "まとめE2E 2",
    perPage: 2,
    memo: "none",
    blockedRequests,
    order: async creator => {
      await creator.locator(`input[data-summary-key="${material.noteId}/${material.pageId}"]`).uncheck();
      await creator.locator(`input[data-summary-key="${source.noteId}/${pageA2}"]`).uncheck();
      await expect(creator.locator(".note-summary-order li")).toHaveCount(1);
    }
  });
  const secondId = new URL(secondTab.url()).searchParams.get("noteId");
  await expect(secondTab.locator(".note-mask.inherited")).toHaveCount(2);
  await secondTab.close();

  // The source changes: A p.1 gets a new line, its mask 1 is made wider, its
  // mask 2 moves, a mask is added. A p.2 does not change.
  const a1Changed = { ...a1, width: .35 };
  const a2Moved = { ...a2, x: .6 };
  const a3 = { id: "a3", x: .1, y: .8, width: .2, height: .05, weak: false, underline: true };
  await writePageContent(user.uid, source.noteId, pageA1, { elements: [inkA1, ink(.1, .6, .9, .6)], noteMasks: [a1Changed, a2Moved, a3] }, 2);
  const oldPicture = summaryPage.background.imagePath;
  await summaryTab.reload({ waitUntil: "domcontentloaded" });
  await expect(summaryTab.locator("#noteEditorStartup")).toBeHidden({ timeout: 60_000 });
  await expect(summaryTab.locator("#noteEditorNotice")).toContainText("元ノートの変更を1ページに反映しました");
  shares = await maskShares(stage);
  expect(shares, "元ノートで追加したマスクが増え、まとめ側のマスクは残る").toHaveLength(7);
  expectBoundsClose(shares.find(mask => mask.id === a1Id), place(a1Changed, slotA1.rect), "元ノートで変えたマスクは元ノートを優先");
  expectBoundsClose(byPlace(place(a2Moved, slotA1.rect)), place(a2Moved, slotA1.rect), "元ノートで動かしたマスク");
  expectBoundsClose(byPlace(place(a3, slotA1.rect)), place(a3, slotA1.rect), "元ノートで追加したマスク");
  expect(byPlace(place(a3, slotA1.rect)).underlined, "追加したマスクの下線も反映").toBe(true);
  expectBoundsClose(shares.find(mask => mask.id === b1Id), b1Moved, "元ノートで変わらないマスクはまとめ側の調整を保つ");
  expect(shares.some(mask => mask.id === own.id), "まとめ側だけのマスクは残る").toBe(true);
  await expect(stage.locator("path[data-element-id]"), "まとめ側だけの書き込みは残る").toHaveCount(1);
  const synced = await readNote(user.uid, summaryId);
  expect(synced.pages[0].background.imagePath, "書き込みが変わった元ページの画像を作り直す").not.toBe(oldPicture);
  expect(synced.pages[0].summary.slots.map(slot => slot.rect)).toEqual(slots.map(slot => slot.rect));
  expect(synced.pendingStoragePaths).toEqual([]);
  await expect.poll(() => storageObjectExists(user.uid, oldPicture), { timeout: 20_000 }).toBe(false);
  await expect.poll(() => storageObjectExists(user.uid, synced.pages[0].background.imagePath)).toBe(true);

  // The second summary takes the change as well. A p.1 is then taken out
  // of it: its place is blank, its masks go, the note no longer names it.
  const secondAgain = await context.newPage();
  await guardProductionFirebase(secondAgain, blockedRequests);
  await secondAgain.setViewportSize({ width: 1180, height: 1500 });
  await openEditor(secondAgain, secondId);
  await expect(secondAgain.locator(".note-mask.inherited"), "同じ元ページを使う別のまとめにも反映").toHaveCount(3);
  const secondPictureBefore = (await readNote(user.uid, secondId)).pages[0].background.imagePath;
  await takeOutOfSummary(secondAgain, "授業ノートA  p.1");
  await expect(secondAgain.locator(".note-mask.inherited")).toHaveCount(0);
  const secondAfter = await readNote(user.uid, secondId);
  expect(secondAfter.summarySourcePages).toEqual([]);
  expect(secondAfter.summarySourceNoteIds).toEqual([]);
  expect(secondAfter.pages[0].summary.slots).toEqual([]);
  expect(secondAfter.pendingStoragePaths).toEqual([]);
  expect(secondAfter.pages[0].background.imagePath).not.toBe(secondPictureBefore);
  await expect.poll(() => storageObjectExists(user.uid, secondPictureBefore), { timeout: 20_000 }).toBe(false);
  await secondAgain.close();

  // A PDF without masks (answers visible), with the writing and underlines;
  // the masks and their open/closed state stay in the app.
  await summaryTab.locator("#noteStudyModeBtn").click();
  await stage.locator(".note-mask").nth(1).click();
  await expect(stage.locator(".note-mask.revealed")).toHaveCount(1);
  const revealedId = await stage.locator(".note-mask.revealed").getAttribute("data-mask-id");
  await summaryTab.locator(".note-more-menu summary").click();
  await summaryTab.locator('[data-note-action="export"]').click();
  await expect(summaryTab.locator("#noteExportPurpose")).toHaveValue("ai");
  await expect(summaryTab.locator("#noteExportStatus")).toContainText("赤い下線は残ります");
  await summaryTab.locator("#createNotePdfBtn").click();
  await expect(summaryTab.locator("#noteExportStatus")).toContainText("作成したPDF", { timeout: 90_000 });
  const downloadPromise = summaryTab.waitForEvent("download");
  await summaryTab.locator("#downloadNotePdfBtn").click();
  const download = await downloadPromise;
  const chunks = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  const pdfBytes = Buffer.concat(chunks);
  expect((await PDFDocument.load(pdfBytes)).getPageCount()).toBe(1);
  await summaryTab.locator('#noteExportDialog button[value="close"]').click();
  await expect(stage.locator(".note-mask")).toHaveCount(7);
  await expect(stage.locator(".note-mask.revealed"), "PDF出力で開閉状態を変えない").toHaveCount(1);
  await expect(stage.locator(".note-mask.revealed")).toHaveAttribute("data-mask-id", revealedId);
  const a1Now = place(a1Changed, slotA1.rect);
  const a2Now = place(a2Moved, slotA1.rect);
  const [underlineArea, maskedPaperArea, ownInkArea] = await pdfPagePixels(summaryTab, pdfBytes, [
    [a1Now.x + a1Now.width / 2, a1Now.y + a1Now.height + .0006],
    [a2Now.x + a2Now.width / 2, a2Now.y + a2Now.height / 2],
    [.905, .825]
  ]);
  const reddest = underlineArea.reduce((best, pixel) => pixel[0] - pixel[1] > best[0] - best[1] ? pixel : best);
  expect(reddest[0], `赤い下線がPDFに残る ${reddest}`).toBeGreaterThan(150);
  expect(reddest[1], `赤い下線がPDFに残る ${reddest}`).toBeLessThan(110);
  expect(Math.min(...maskedPaperArea.flat()), "マスクはPDFに描かない（答えの位置は用紙のまま）").toBeGreaterThan(200);
  const darkest = ownInkArea.reduce((best, pixel) => pixel[0] + pixel[1] + pixel[2] < best[0] + best[1] + best[2] ? pixel : best);
  expect(Math.max(...darkest), `まとめ側の書き込みもPDFに残る ${darkest}`).toBeLessThan(140);

  // A page or note that a summary shows is not deleted (the second summary
  // no longer shows A p.1).
  const reopenedSource = await context.newPage();
  await guardProductionFirebase(reopenedSource, blockedRequests);
  await reopenedSource.setViewportSize({ width: 1180, height: 820 });
  await openEditor(reopenedSource, source.noteId);
  const sourceTab2 = reopenedSource;
  const deleteFirstPage = sourceTab2.locator('#notePageList button[title="1ページ 削除"]');
  dialogs.length = 0;
  await deleteFirstPage.click();
  await expect.poll(() => dialogs.join("\n")).toContain("で使われているため削除できません");
  expect(dialogs.join("\n")).toContain("「まとめE2E」");
  expect(dialogs.join("\n"), "外したまとめは数えない").not.toContain("「まとめE2E 2」");
  await expect(sourceTab2.locator("#notePageCounter")).toHaveText("1 / 3");
  expect((await readNote(user.uid, source.noteId)).pages).toHaveLength(3);
  dialogs.length = 0;
  await sourceTab2.locator(".note-more-menu summary").click();
  await sourceTab2.locator('[data-note-action="delete"]').click();
  await expect.poll(() => dialogs.join("\n")).toContain("で使われているため削除できません");
  expect((await readNote(user.uid, source.noteId)).deletedAt).toBeNull();
  // An unused page can be deleted.
  dialogs.length = 0;
  await sourceTab2.locator('#notePageList button[title="3ページ 削除"]').click();
  await expect(sourceTab2.locator("#notePageCounter")).toHaveText(/\/ 2$/);

  // Taken out of the first summary as well, page 1 can be deleted.
  await summaryTab.bringToFront();
  await summaryTab.locator("#noteEditModeBtn").click();
  await takeOutOfSummary(summaryTab, "授業ノートA  p.1");
  const after = await readNote(user.uid, summaryId);
  expect(after.summarySourcePages).not.toContain(`${source.noteId}/${pageA1}`);
  expect(after.pendingStoragePaths).toEqual([]);
  await expect(summaryTab.locator(".note-mask.inherited"), "外した元ページのマスクを取り除く").toHaveCount(3);
  await expect(summaryTab.locator(".note-mask:not(.inherited)"), "まとめ側だけのマスクは残る").toHaveCount(1);
  await expect(summaryTab.locator("path[data-element-id]")).toHaveCount(1);
  await sourceTab2.bringToFront();
  dialogs.length = 0;
  await sourceTab2.locator('#notePageList button[title="1ページ 削除"]').click();
  await expect.poll(() => dialogs.join("\n")).toContain("1ページを削除しますか");
  await expect(sourceTab2.locator("#notePageCounter")).toHaveText(/\/ 1$/, { timeout: 20_000 }).catch(error => {
    throw new Error(`${error.message}\n${dialogs.join("\n")}`);
  });

  // The summary keeps everything after reloading.
  await summaryTab.bringToFront();
  await summaryTab.reload({ waitUntil: "domcontentloaded" });
  await expect(summaryTab.locator("#noteEditorStartup")).toBeHidden({ timeout: 60_000 });
  await expect(summaryTab.locator(".note-mask.inherited")).toHaveCount(3);
  await expect(summaryTab.locator(".note-mask:not(.inherited)")).toHaveCount(1);
  await expect(summaryTab.locator("path[data-element-id]")).toHaveCount(1);
  const finalSummary = await readNote(user.uid, summaryId);
  expect(finalSummary.pages[0].summary.slots.map(slot => slot.pageId)).toEqual([material.pageId, pageA2]);
  expect((await listNoteIds(user.uid)).filter(note => note.summary && !note.deletedAt)).toHaveLength(2);
  expect(blockedRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test("@authenticated 6ページ分を1ページにまとめても書き込み・マスク・赤い下線の位置がずれず、7ページ目は続きのページになる", async ({ page }) => {
  test.setTimeout(240_000);
  const blockedRequests = await guardProductionFirebase(page);
  const pageErrors = [];
  page.on("pageerror", error => recordUnexpectedPageError(pageErrors, error));
  page.context().on("page", target => target.on("pageerror", error => recordUnexpectedPageError(pageErrors, error)));
  const user = await createUser();
  const source = await seedNote(user.uid, "6ページノート", 7);
  const masksByPage = source.pageIds.map((_, index) => ({
    id: `m${index}`, x: .1 + index * .05, y: .2 + index * .05, width: .3, height: .05, weak: index % 2 === 1, underline: true
  }));
  for (const [index, pageId] of source.pageIds.entries()) {
    await writePageContent(user.uid, source.noteId, pageId, {
      elements: [{
        id: `ink-${index}`, type: "stroke", zIndex: 10, pressureEnabled: false,
        points: [{ x: .1, y: .6, pressure: .5 }, { x: .9, y: .6, pressure: .5 }],
        style: { color: "#111111", widthRatio: .004, opacity: 1 }
      }],
      noteMasks: [masksByPage[index]]
    }, 1);
  }
  await withEnvironment(async environment => {
    await updateDoc(doc(environment.authenticatedContext(user.uid).firestore(), "users", user.uid, "notes", source.noteId), {
      testMarkedPageIds: source.pageIds
    });
  });
  await login(page, user);
  const summaryTab = await createSummaryFromList(page, { title: "6枚まとめ", perPage: 6, memo: "wide", blockedRequests });
  const summaryId = new URL(summaryTab.url()).searchParams.get("noteId");
  await expect(summaryTab.locator("#notePageCounter")).toHaveText("1 / 2");
  const summary = await readNote(user.uid, summaryId);
  expect(summary.pages).toHaveLength(2);
  expect(summary.pages.map(item => item.summary.slots.length)).toEqual([6, 1]);
  const stage = summaryTab.locator("#notePageStage");
  const check = async (summaryPage, sourceIndexes) => {
    const shares = await maskShares(stage);
    expect(shares).toHaveLength(sourceIndexes.length);
    await expect(stage.locator(".note-mask-underline")).toHaveCount(sourceIndexes.length);
    for (const [slotIndex, sourceIndex] of sourceIndexes.entries()) {
      const slot = summaryPage.summary.slots[slotIndex];
      expect(slot.pageId).toBe(source.pageIds[sourceIndex]);
      const expected = place(masksByPage[sourceIndex], slot.rect);
      const actual = shares.find(mask => Math.abs(mask.x - expected.x) < 2e-4 && Math.abs(mask.y - expected.y) < 2e-4);
      expect(actual, `${sourceIndex + 1}ページ目のマスク`).toBeTruthy();
      expectBoundsClose(actual, expected, `${sourceIndex + 1}ページ目のマスク`);
      expect(actual.underlined).toBe(true);
      const box = await stage.boundingBox();
      const line = await stage.locator(`.note-mask-underline[data-underline-for="${actual.id}"]`).boundingBox();
      expect(Math.abs(line.x - (box.x + expected.x * box.width))).toBeLessThan(1.5);
      expect(Math.abs(line.y - (box.y + (expected.y + expected.height) * box.height)), "下線はマスクの下端のすぐ下").toBeLessThan(1.5);
      expect(slot.rect.x + slot.rect.width <= slot.cell.x + slot.cell.width * .6 + 1e-6, "広いメモ余白").toBe(true);
    }
  };
  await check(summary.pages[0], [0, 1, 2, 3, 4, 5]);
  await summaryTab.locator("#notePageList .note-page-thumbnail").nth(1).click();
  await expect(summaryTab.locator("#notePageCounter")).toHaveText("2 / 2");
  await check(summary.pages[1], [6]);
  // The picture of a page is drawn from its sources without their masks;
  // the ink of each source sits at the same share of its place.
  await summaryTab.locator("#notePageList .note-page-thumbnail").nth(0).click();
  await expect(summaryTab.locator("#notePageCounter")).toHaveText("1 / 2");
  const samples = await summaryTab.evaluate(async rects => {
    const image = document.querySelector(".note-background-image");
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    const darkest = (x, y) => {
      const data = context.getImageData(Math.round(x * canvas.width) - 3, Math.round(y * canvas.height) - 3, 7, 7).data;
      let value = 255 * 3;
      for (let index = 0; index < data.length; index += 4) value = Math.min(value, data[index] + data[index + 1] + data[index + 2]);
      return value / 3;
    };
    return {
      size: [canvas.width, canvas.height],
      ink: rects.map(rect => darkest(rect.x + rect.width * .5, rect.y + rect.height * .6)),
      paperAboveInk: rects.map(rect => darkest(rect.x + rect.width * .5, rect.y + rect.height * .5)),
      underMask: rects.map((rect, index) => darkest(rect.x + rect.width * (.1 + index * .05 + .15), rect.y + rect.height * (.2 + index * .05 + .025)))
    };
  }, summary.pages[0].summary.slots.map(slot => slot.rect));
  expect(samples.size).toEqual([2480, 3508]);
  samples.ink.forEach((value, index) => expect(value, `${index + 1}ページ目の書き込みの位置`).toBeLessThan(110));
  samples.paperAboveInk.forEach((value, index) => expect(value, `${index + 1}ページ目の書き込みはずれていない`).toBeGreaterThan(230));
  samples.underMask.forEach((value, index) => expect(value, `${index + 1}ページ目のマスクは画像に焼き付けない`).toBeGreaterThan(230));

  // 「元ノートから更新」 takes a change of a source page while the summary is
  // open (only its masks changed: the picture stays).
  const pictureBefore = (await readNote(user.uid, summaryId)).pages[0].background.imagePath;
  const movedMask = { ...masksByPage[0], x: .5, y: .7 };
  await writePageContent(user.uid, source.noteId, source.pageIds[0], {
    elements: [{
      id: "ink-0", type: "stroke", zIndex: 10, pressureEnabled: false,
      points: [{ x: .1, y: .6, pressure: .5 }, { x: .9, y: .6, pressure: .5 }],
      style: { color: "#111111", widthRatio: .004, opacity: 1 }
    }],
    noteMasks: [movedMask]
  }, 2);
  await summaryTab.locator(".note-more-menu summary").click();
  await summaryTab.locator('[data-note-action="summary-sources"]').click();
  await expect(summaryTab.locator(".note-summary-slot")).toHaveCount(6);
  await summaryTab.locator("#noteSummaryRefreshBtn").click();
  await expect(summaryTab.locator("#noteSummaryDialogStatus")).toContainText("元ノートの変更を1ページに反映しました", { timeout: 60_000 });
  await summaryTab.locator('#noteSummaryDialog button[value="close"]').click();
  const refreshed = await maskShares(stage);
  expectBoundsClose(
    refreshed.find(mask => Math.abs(mask.x - place(movedMask, summary.pages[0].summary.slots[0].rect).x) < 2e-4),
    place(movedMask, summary.pages[0].summary.slots[0].rect),
    "開いたまま元ノートから更新"
  );
  const afterRefresh = await readNote(user.uid, summaryId);
  expect(afterRefresh.pages[0].background.imagePath, "マスクだけの変更では画像を作り直さない").toBe(pictureBefore);
  await summaryTab.locator(".note-more-menu summary").click();
  await summaryTab.locator('[data-note-action="summary-sources"]').click();
  await summaryTab.locator("#noteSummaryRefreshBtn").click();
  await expect(summaryTab.locator("#noteSummaryDialogStatus")).toContainText("元ノートからの変更はありませんでした", { timeout: 60_000 });
  await summaryTab.locator('#noteSummaryDialog button[value="close"]').click();

  // A summary page is not duplicated; deleting one releases its sources.
  await summaryTab.locator('#notePageList button[title="1ページ 複製"]').click();
  await expect(summaryTab.locator("#noteEditorNotice")).toContainText("まとめページは複製できません");
  await expect(summaryTab.locator("#notePageCounter")).toHaveText(/\/ 2$/);
  summaryTab.once("dialog", dialog => void dialog.accept());
  await summaryTab.locator('#notePageList button[title="2ページ 削除"]').click();
  await expect(summaryTab.locator("#notePageCounter")).toHaveText("1 / 1");
  await expect.poll(async () => (await readNote(user.uid, summaryId)).summarySourcePages.length).toBe(6);
  expect((await readNote(user.uid, summaryId)).summarySourcePages).not.toContain(`${source.noteId}/${source.pageIds[6]}`);
  await waitSaved(summaryTab);

  // A copied summary note owns copies of its pictures: updating the original
  // (which deletes its former picture) leaves the copy whole.
  await page.bringToFront();
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#authStatus")).toContainText(user.email, { timeout: 20_000 });
  await openNoteList(page);
  const card = page.locator(".note-card").filter({ hasText: "6枚まとめ" }).first();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.getByRole("button", { name: "複製" }).click();
  await expect.poll(async () => (await listNoteIds(user.uid)).filter(note => note.title === "6枚まとめ のコピー" && note.status === "ready").length, { timeout: 60_000 }).toBe(1);
  const copy = (await listNoteIds(user.uid)).find(note => note.title === "6枚まとめ のコピー");
  const copied = await readNote(user.uid, copy.id);
  expect(copied.summary).toMatchObject({ perPage: 6, memo: "wide" });
  expect(copied.summarySourcePages).toHaveLength(6);
  expect(copied.pendingStoragePaths).toEqual([]);
  expect(copied.pages).toHaveLength(1);
  expect(copied.pages[0].background.imagePath).toMatch(new RegExp(`^users/${user.uid}/notes/${copy.id}/sourcePages/`));
  await expect.poll(() => storageObjectExists(user.uid, copied.pages[0].background.imagePath)).toBe(true);
  expect(blockedRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});
