// Revision 16: a summary note's changes reflected in its source notes (by
// hand, and asked about when the summary is left), the source notes'
// changes taken after asking, and the summary creation screen's tag and
// note pull-downs, which scrolls in either orientation.
import { expect, test } from "@playwright/test";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, getDocs, increment, setDoc, updateDoc } from "firebase/firestore";
import { getBytes, ref, uploadBytes } from "firebase/storage";
import { guardProductionFirebase } from "../helpers/readOnlyApp.mjs";

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
  const email = `summary-sync-${suffix}@example.test`;
  const password = "DentalNote!123";
  const response = await fetch("http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-api-key", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password, returnSecureToken: true })
  });
  const data = await response.json();
  expect(response.ok, JSON.stringify(data)).toBeTruthy();
  return { email, password, uid: data.localId };
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

async function login(page, user) {
  await page.goto("/?firebaseEmulator=1", { waitUntil: "domcontentloaded" });
  await page.locator("#tabBtnAuth").click();
  await page.locator("#emailInput").fill(user.email);
  await page.locator("#passwordInput").fill(user.password);
  await page.locator("#signInBtn").click();
  await expect(page.locator("#authStatus")).toContainText(user.email, { timeout: 20_000 });
  await openNoteList(page);
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

async function seedNote(uid, title, pageCount, { tags = [], marked = [] } = {}) {
  const noteId = `note-sync-${crypto.randomUUID()}`;
  const pageIds = Array.from({ length: pageCount }, () => `page-sync-${crypto.randomUUID()}`);
  await withEnvironment(async environment => {
    const db = environment.authenticatedContext(uid).firestore();
    await setDoc(doc(db, "users", uid, "notes", noteId), {
      schemaVersion: 1, title, type: "standalone", status: "ready", pageCount, noteMaskCount: 0, orderRevision: 1,
      materialRefs: [], deletedAt: null, tags, testMarkedPageIds: marked.map(index => pageIds[index])
    });
    await Promise.all(pageIds.map((pageId, index) => setDoc(doc(db, "users", uid, "notes", noteId, "pages", pageId), {
      schemaVersion: 1, noteId, order: index + 1, pageType: "blank", contentRevision: 0, contentPath: "", contentHash: "",
      noteMaskCount: 0, deletedAt: null, size: { width: 1240, height: 1754 }, background: { type: "blank", paperColor: "#FFFFFF" }
    })));
  });
  return { noteId, pageIds };
}

// Content as another tab of the app would have saved it.
// (The test's own Storage reads and writes skip the rules: the Storage
// Emulator's rules runtime sometimes never answers, which is not what these
// tests are about.)
async function writePageContent(uid, noteId, pageId, { elements = [], noteMasks = [] }, revision) {
  await withEnvironment(async environment => {
    const contentPath = `users/${uid}/notes/${noteId}/pages/${pageId}/revisions/seed-${revision}-${crypto.randomUUID()}.json`;
    const json = JSON.stringify({ schemaVersion: 1, noteId, pageId, revision, elements, noteMasks, savedAt: new Date().toISOString() });
    await environment.withSecurityRulesDisabled(async adminContext => {
      await uploadBytes(ref(adminContext.storage(BUCKET), contentPath), Buffer.from(json), { contentType: "application/json" });
      const db = adminContext.firestore();
      const pageReference = doc(db, "users", uid, "notes", noteId, "pages", pageId);
      const previousMaskCount = Number((await getDoc(pageReference)).data()?.noteMaskCount || 0);
      await updateDoc(pageReference, { contentPath, contentRevision: revision, contentHash: `seed-${revision}-${crypto.randomUUID()}`, noteMaskCount: noteMasks.length });
      await updateDoc(doc(db, "users", uid, "notes", noteId), { noteMaskCount: increment(noteMasks.length - previousMaskCount) });
    });
  });
}

async function readNote(uid, noteId) {
  return withEnvironment(async environment => {
    const db = environment.authenticatedContext(uid).firestore();
    const note = await getDoc(doc(db, "users", uid, "notes", noteId));
    const pages = await getDocs(collection(db, "users", uid, "notes", noteId, "pages"));
    return { id: noteId, ...note.data(), pages: pages.docs.map(item => ({ pageId: item.id, ...item.data() })).sort((a, b) => a.order - b.order) };
  });
}

async function readPageContent(uid, noteId, pageId) {
  return withEnvironment(async environment => {
    let result = null;
    await environment.withSecurityRulesDisabled(async adminContext => {
      const page = (await getDoc(doc(adminContext.firestore(), "users", uid, "notes", noteId, "pages", pageId))).data();
      const bytes = await getBytes(ref(adminContext.storage(BUCKET), page.contentPath));
      result = { revision: page.contentRevision, content: JSON.parse(Buffer.from(bytes).toString("utf8")) };
    });
    return result;
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

const place = (mask, rect) => ({ x: rect.x + mask.x * rect.width, y: rect.y + mask.y * rect.height, width: mask.width * rect.width, height: mask.height * rect.height });
const back = (mask, rect) => ({ x: (mask.x - rect.x) / rect.width, y: (mask.y - rect.y) / rect.height, width: mask.width / rect.width, height: mask.height / rect.height });
const near = (left, right) => Math.abs(left.x - right.x) < 2e-4 && Math.abs(left.y - right.y) < 2e-4;

function expectBoundsClose(actual, expected, message, tolerance = 1e-3) {
  for (const field of ["x", "y", "width", "height"]) {
    expect(Math.abs(actual[field] - expected[field]), `${message}: ${field} ${actual[field]} / ${expected[field]}`).toBeLessThan(tolerance);
  }
}

async function maskCenter(stage, maskId) {
  const box = await stage.locator(`.note-mask[data-mask-id="${maskId}"]`).boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function createSummary(listPage, { title, perPage, memo, choose = null, blockedRequests }) {
  await listPage.bringToFront();
  await listPage.locator("#newNoteBtn").click();
  const popupPromise = listPage.waitForEvent("popup", { timeout: 60_000 });
  await listPage.locator('[data-create-note="summary"]').click();
  const creator = await popupPromise;
  await guardProductionFirebase(creator, blockedRequests);
  await expect(creator.locator("#noteSummaryCreateBtn")).toBeVisible({ timeout: 30_000 });
  if (choose) await choose(creator);
  await creator.locator(`input[name="noteSummaryPerPage"][value="${perPage}"]`).check();
  await creator.locator(`input[name="noteSummaryMemo"][value="${memo}"]`).check();
  await creator.locator("#newNoteTitle").fill(title);
  await creator.locator("#noteSummaryCreateBtn").click();
  await creator.waitForURL(url => Boolean(url.searchParams.get("noteId")), { timeout: 90_000 });
  await expect(creator.locator("#noteEditorStartup")).toBeHidden({ timeout: 60_000 });
  await creator.setViewportSize({ width: 1180, height: 1500 });
  return creator;
}

test("@authenticated まとめで変えたマスクを元ノートに反映でき、離れるときと開いたときに必ず確かめられる", async ({ page, context }) => {
  test.setTimeout(480_000);
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
  const source = await seedNote(user.uid, "授業ノートA", 2, { tags: ["口腔解剖学"], marked: [0, 1] });
  const [pageA1, pageA2] = source.pageIds;
  const other = await seedNote(user.uid, "生化学ノート", 1, { tags: ["生化学"], marked: [0] });
  const a1 = { id: "a1", x: .1, y: .1, width: .3, height: .06, weak: false, underline: true };
  const a2 = { id: "a2", x: .5, y: .4, width: .2, height: .05, weak: false, underline: false };
  const a3 = { id: "a3", x: .1, y: .7, width: .2, height: .05, weak: false, underline: false };
  const b1 = { id: "b1", x: .2, y: .3, width: .3, height: .05, weak: false, underline: true };
  await writePageContent(user.uid, source.noteId, pageA1, { noteMasks: [a1, a2, a3] }, 1);
  await writePageContent(user.uid, source.noteId, pageA2, { noteMasks: [b1] }, 1);
  await writePageContent(user.uid, other.noteId, other.pageIds[0], { noteMasks: [{ id: "c1", x: .3, y: .3, width: .2, height: .05 }] }, 1);

  await login(page, user);
  await page.setViewportSize({ width: 1180, height: 820 });
  // The list shows #口腔解剖学: the creation screen starts there.
  await page.locator("#noteTagPane .note-tag-item").filter({ hasText: "#口腔解剖学" }).click();
  await expect(page.locator("#noteList .note-card")).toHaveCount(1);
  const summaryTab = await createSummary(page, {
    title: "同期まとめ",
    perPage: 2,
    memo: "none",
    blockedRequests,
    choose: async creator => {
      const tagSelect = creator.locator('select[data-summary-scope="tag"]');
      const noteSelect = creator.locator('select[data-summary-scope="note"]');
      await expect(tagSelect).toHaveValue("tag:口腔解剖学");
      await expect(noteSelect).toHaveValue("");
      const boxes = creator.locator('#noteSummaryPicker input[type="checkbox"]');
      await expect(boxes).toHaveCount(2);
      await expect(creator.locator(".note-summary-order li")).toHaveCount(2);
      await tagSelect.selectOption("all");
      await expect(boxes).toHaveCount(3);
      await expect(creator.locator(".note-summary-order li"), "選び直すと該当するページを全部選ぶ").toHaveCount(3);
      await noteSelect.selectOption(other.noteId);
      await expect(boxes).toHaveCount(1);
      await expect(creator.locator(".note-summary-order li")).toHaveText([/生化学ノート  p\.1/]);
      await tagSelect.selectOption("tag:口腔解剖学");
      await expect(noteSelect, "タグに入らないノートは選び直す").toHaveValue("");
      await expect(boxes).toHaveCount(2);
      await expect(creator.locator(".note-summary-sources h4")).toHaveText("「テストに出る」ページ（2ページ）");
    }
  });
  const summaryId = new URL(summaryTab.url()).searchParams.get("noteId");
  const summary = await readNote(user.uid, summaryId);
  expect(summary.tags, "一覧で選んでいたタグが付く").toEqual(["口腔解剖学"]);
  const [slotA1, slotA2] = summary.pages[0].summary.slots;
  expect([slotA1.pageId, slotA2.pageId]).toEqual([pageA1, pageA2]);
  const stage = summaryTab.locator("#notePageStage");
  let shares = await maskShares(stage);
  const idAt = (mask, slot) => shares.find(item => near(item, place(mask, slot.rect)))?.id;
  const a1Id = idAt(a1, slotA1);
  const a2Id = idAt(a2, slotA1);
  const a3Id = idAt(a3, slotA1);
  const b1Id = idAt(b1, slotA2);
  expect([a1Id, a2Id, a3Id, b1Id].every(Boolean)).toBe(true);
  await expect(summaryTab.locator("#noteSummaryBanner")).toBeHidden();

  // 1. One mask moved in the summary and reflected from its menu.
  await summaryTab.locator('[data-note-tool="mask"]').click();
  await summaryTab.locator("#noteMaskEditModeBtn").click();
  const a1From = await maskCenter(stage, a1Id);
  await dragOn(summaryTab, a1From, { x: a1From.x + 24, y: a1From.y + 18 });
  await expect(summaryTab.locator("#noteSummaryBannerPending")).toContainText("元ノートに反映していない変更があります（まとめ 1ページ）");
  const reflectButton = summaryTab.locator('#noteSelectionActions [data-selection-action="reflect-source"]');
  await expect(reflectButton).toBeVisible();
  const a1Moved = (await maskShares(stage)).find(item => item.id === a1Id);
  dialogs.length = 0;
  await reflectButton.click();
  await expect(summaryTab.locator("#noteEditorNotice")).toContainText("1件の変更を元ノートに反映しました", { timeout: 60_000 });
  expect(dialogs.join("\n")).toContain("マスクを変更（位置・大きさ）");
  await expect(summaryTab.locator("#noteSummaryBanner")).toBeHidden();
  let sourcePage1 = await readPageContent(user.uid, source.noteId, pageA1);
  expect(sourcePage1.revision).toBe(2);
  expectBoundsClose(sourcePage1.content.noteMasks.find(mask => mask.id === "a1"), back(a1Moved, slotA1.rect), "元ノートのマスクが同じ位置へ動く");
  expect(sourcePage1.content.noteMasks).toHaveLength(3);
  expect((await readNote(user.uid, source.noteId)).noteMaskCount, "マスクの数は変わらない").toBe(4);

  // 2. Three more changes; leaving asks about them. The new mask is kept in
  // the summary, the others go to the source.
  await stage.locator(`.note-mask[data-mask-id="${a2Id}"]`).click();
  await summaryTab.locator('#noteSelectionActions [data-selection-action="underline-on"]').click();
  await stage.locator(`.note-mask[data-mask-id="${a3Id}"]`).click();
  await summaryTab.locator('#noteSelectionActions [data-selection-action="delete"]').click();
  await expect(stage.locator(`.note-mask[data-mask-id="${a3Id}"]`)).toHaveCount(0);
  await summaryTab.locator("#noteMaskAddModeBtn").click();
  const stageBox = await stage.boundingBox();
  const onA2 = place({ x: .6, y: .6, width: .2, height: .04 }, slotA2.rect);
  await dragOn(summaryTab,
    { x: stageBox.x + onA2.x * stageBox.width, y: stageBox.y + onA2.y * stageBox.height },
    { x: stageBox.x + (onA2.x + onA2.width) * stageBox.width, y: stageBox.y + (onA2.y + onA2.height) * stageBox.height });
  shares = await maskShares(stage);
  const ownId = shares.find(item => !item.inherited)?.id;
  expect(ownId).toBeTruthy();
  await waitSaved(summaryTab);
  await expect.poll(async () => (await readNote(user.uid, summaryId)).summaryPendingPageIds, { timeout: 20_000 }).toEqual([summary.pages[0].pageId]);
  const closed = summaryTab.waitForEvent("close", { timeout: 60_000 });
  await summaryTab.locator("#closeNoteBtn").click();
  const pushDialog = summaryTab.locator("#noteSummaryPushDialog");
  await expect(pushDialog).toBeVisible();
  await expect(summaryTab.locator("#noteSummaryPushTitle")).toHaveText("元ノートに反映していない変更があります");
  const changeBoxes = pushDialog.locator("input[data-summary-change-id]");
  await expect(changeBoxes).toHaveCount(3);
  await expect(pushDialog.locator(".note-summary-push-list")).toContainText("マスクを変更（下線を付けた）");
  await expect(pushDialog.locator(".note-summary-push-list")).toContainText("マスクを削除");
  await expect(pushDialog.locator(".note-summary-push-list")).toContainText("まとめで作ったマスクを追加");
  // Cancel stays in the summary.
  await pushDialog.locator('[data-summary-push="cancel"]').click();
  await expect(pushDialog).toBeHidden();
  await expect(summaryTab.locator("#noteEditorView")).toBeVisible();
  await summaryTab.locator("#closeNoteBtn").click();
  await expect(pushDialog).toBeVisible();
  await pushDialog.locator("label").filter({ hasText: "まとめで作ったマスクを追加" }).locator("input").uncheck();
  await pushDialog.locator('[data-summary-push="apply"]').click();
  await closed;
  sourcePage1 = await readPageContent(user.uid, source.noteId, pageA1);
  expect(sourcePage1.content.noteMasks.map(mask => mask.id).sort()).toEqual(["a1", "a2"]);
  expect(sourcePage1.content.noteMasks.find(mask => mask.id === "a2").underline).toBe(true);
  const sourcePage2 = await readPageContent(user.uid, source.noteId, pageA2);
  expect(sourcePage2.revision, "反映しなかった変更は元ノートを変えない").toBe(1);
  await expect.poll(async () => (await readNote(user.uid, summaryId)).summaryPendingPageIds, { timeout: 20_000 }).toEqual([]);

  // 3. Opened again: nothing to ask (the source changed by the summary's
  // own reflecting), the kept mask stays the summary's own.
  const reopened = await context.newPage();
  await guardProductionFirebase(reopened, blockedRequests);
  await reopened.setViewportSize({ width: 1180, height: 1500 });
  await openEditor(reopened, summaryId);
  const stage2 = reopened.locator("#notePageStage");
  await expect(reopened.locator("#noteSummaryUpdateDialog")).toBeHidden();
  await expect(reopened.locator("#noteSummaryBanner")).toBeHidden();
  shares = await maskShares(stage2);
  expect(shares.map(item => item.id).sort()).toEqual([a1Id, a2Id, b1Id, ownId].sort());
  expect(shares.find(item => item.id === a2Id).underlined).toBe(true);
  expect(shares.find(item => item.id === ownId).inherited).toBe(false);

  // 4. The source changes while the summary is open: the banner says so when
  // the summary is in front again; "今はしない" keeps it; "更新する" takes it.
  const b1Moved = { ...b1, x: .4 };
  await writePageContent(user.uid, source.noteId, pageA2, { noteMasks: [b1Moved] }, 2);
  const updatesRow = reopened.locator("#noteSummaryBannerUpdates");
  await expect.poll(async () => {
    await reopened.evaluate(() => globalThis.dispatchEvent(new Event("focus")));
    return updatesRow.isVisible();
  }, { timeout: 30_000, intervals: [2_500] }).toBe(true);
  await expect(updatesRow).toContainText("元ノートに更新があります（まとめ 1ページ分）");
  await reopened.locator('[data-summary-banner="update-details"]').click();
  await expect(reopened.locator("#noteSummaryUpdateList")).toContainText("授業ノートA  p.2");
  await expect(reopened.locator("#noteSummaryUpdateList")).toContainText("マスク");
  await reopened.locator("#noteSummaryUpdateLaterBtn").click();
  await expect(reopened.locator("#noteSummaryUpdateDialog")).toBeHidden();
  await expect(updatesRow, "今はしない間は出し続ける").toBeVisible();
  expect(near((await maskShares(stage2)).find(item => item.id === b1Id), place(b1, slotA2.rect)), "答えるまでは変えない").toBe(true);
  await reopened.locator('[data-summary-banner="update"]').click();
  await expect(reopened.locator("#noteEditorNotice")).toContainText("元ノートの変更を1ページに反映しました", { timeout: 60_000 });
  await expect(reopened.locator("#noteSummaryBanner")).toBeHidden();
  expect(near((await maskShares(stage2)).find(item => item.id === b1Id), place(b1Moved, slotA2.rect))).toBe(true);

  // 5. A change left when the tab is closed without asking (iPad Safari
  // cannot ask): the list and the next opening tell about it.
  await reopened.locator('[data-note-tool="mask"]').click();
  await reopened.locator("#noteMaskEditModeBtn").click();
  const b1From = await maskCenter(stage2, b1Id);
  await dragOn(reopened, b1From, { x: b1From.x - 20, y: b1From.y + 25 });
  await waitSaved(reopened);
  await expect.poll(async () => (await readNote(user.uid, summaryId)).summaryPendingPageIds, { timeout: 20_000 }).toEqual([summary.pages[0].pageId]);
  await reopened.close();
  await page.bringToFront();
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#authStatus")).toContainText(user.email, { timeout: 20_000 });
  await openNoteList(page);
  const summaryCard = page.locator(".note-card").filter({ hasText: "同期まとめ" });
  await expect(summaryCard.locator(".note-card-alert")).toContainText("元ノートに反映していない変更があります（1ページ）", { timeout: 20_000 });
  const third = await context.newPage();
  await guardProductionFirebase(third, blockedRequests);
  await third.setViewportSize({ width: 1180, height: 1500 });
  await openEditor(third, summaryId);
  await expect(third.locator("#noteSummaryBannerPending")).toContainText("元ノートに反映していない変更があります（まとめ 1ページ）");
  await third.locator('[data-summary-banner="push"]').click();
  const review = third.locator("#noteSummaryPushDialog");
  await expect(review).toBeVisible();
  await expect(third.locator("#noteSummaryPushTitle")).toHaveText("元ノートへの反映");
  await expect(review.locator("input[data-summary-change-id]")).toHaveCount(1);
  await review.locator('[data-summary-push="local"]').click();
  await expect(review).toBeHidden();
  await expect(third.locator("#noteEditorNotice")).toContainText("このまとめだけの変更にしました");
  await expect(third.locator("#noteSummaryBanner")).toBeHidden();
  await expect.poll(async () => (await readNote(user.uid, summaryId)).summaryPendingPageIds, { timeout: 20_000 }).toEqual([]);
  expect((await readPageContent(user.uid, source.noteId, pageA2)).revision, "まとめだけの変更は元ノートを変えない").toBe(2);

  // 6. A source note open in another tab is not written to.
  const stage3 = third.locator("#notePageStage");
  await third.locator('[data-note-tool="mask"]').click();
  await third.locator("#noteMaskEditModeBtn").click();
  const b1Again = await maskCenter(stage3, b1Id);
  await dragOn(third, b1Again, { x: b1Again.x + 30, y: b1Again.y });
  const b1Final = (await maskShares(stage3)).find(item => item.id === b1Id);
  const sourceTab = await context.newPage();
  await guardProductionFirebase(sourceTab, blockedRequests);
  await openEditor(sourceTab, source.noteId);
  await third.bringToFront();
  await third.locator('#noteSelectionActions [data-selection-action="reflect-source"]').click();
  await expect(third.locator("#noteEditorNotice")).toContainText("元ノートが別のタブで開かれています", { timeout: 30_000 });
  expect((await readPageContent(user.uid, source.noteId, pageA2)).revision).toBe(2);
  await expect(third.locator("#noteSummaryBannerPending")).toBeVisible();
  // Left through the app, the source tab lets go at once (a tab the test
  // opened itself cannot be closed by the page: it shows the list instead).
  await sourceTab.locator("#closeNoteBtn").click();
  await sourceTab.waitForURL(url => !url.searchParams.get("noteEditor"), { timeout: 60_000 });
  await sourceTab.close();
  await third.bringToFront();
  await stage3.locator(`.note-mask[data-mask-id="${b1Id}"]`).click();
  await third.locator('#noteSelectionActions [data-selection-action="reflect-source"]').click();
  await expect(third.locator("#noteEditorNotice")).toContainText("1件の変更を元ノートに反映しました", { timeout: 60_000 });
  const final = await readPageContent(user.uid, source.noteId, pageA2);
  expect(final.revision).toBe(3);
  expectBoundsClose(final.content.noteMasks.find(mask => mask.id === "b1"), back(b1Final, slotA2.rect), "閉じた後は反映できる");
  await expect(third.locator("#noteSummaryBanner")).toBeHidden();
  expect(blockedRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test("@authenticated まとめノート作成画面は横画面でも縦画面でもスクロールでき、作成ボタンが常に見える", async ({ page }) => {
  test.setTimeout(180_000);
  const blockedRequests = await guardProductionFirebase(page);
  const pageErrors = [];
  page.on("pageerror", error => recordUnexpectedPageError(pageErrors, error));
  page.context().on("page", target => target.on("pageerror", error => recordUnexpectedPageError(pageErrors, error)));
  const user = await createUser();
  await seedNote(user.uid, "多ページノート", 30, { tags: ["解剖学"], marked: Array.from({ length: 30 }, (_, index) => index) });
  await seedNote(user.uid, "別ノート", 2, { tags: ["生化学"], marked: [0, 1] });
  await login(page, user);
  await page.setViewportSize({ width: 1180, height: 820 });
  await page.locator("#newNoteBtn").click();
  const popupPromise = page.waitForEvent("popup", { timeout: 60_000 });
  await page.locator('[data-create-note="summary"]').click();
  const creator = await popupPromise;
  await guardProductionFirebase(creator, blockedRequests);
  await creator.setViewportSize({ width: 1180, height: 820 });
  const create = creator.locator("#noteSummaryCreateBtn");
  await expect(create).toBeVisible({ timeout: 30_000 });
  await expect(creator.locator('#noteSummaryPicker input[type="checkbox"]')).toHaveCount(32);
  const tagOptions = await creator.locator('select[data-summary-scope="tag"] option').allTextContents();
  expect(tagOptions[0]).toBe("すべてのタグ（32ページ）");
  expect(tagOptions.slice(1).sort()).toEqual(["#生化学（2ページ）", "#解剖学（30ページ）"].sort());
  const scroller = creator.locator(".wrap");
  const layout = async () => creator.evaluate(() => {
    const wrap = document.querySelector(".wrap");
    const columns = [...document.querySelectorAll(".note-summary-column")].map(node => node.getBoundingClientRect());
    const button = document.getElementById("noteSummaryCreateBtn").getBoundingClientRect();
    const rows = [...document.querySelectorAll(".note-summary-order li")];
    const last = rows[rows.length - 1].getBoundingClientRect();
    return {
      overflowY: getComputedStyle(wrap).overflowY,
      scrollable: wrap.scrollHeight > wrap.clientHeight + 10,
      scrollTop: wrap.scrollTop,
      columns: columns.map(rect => ({ left: rect.left, top: rect.top, bottom: rect.bottom })),
      buttonInView: button.top >= 0 && button.bottom <= innerHeight,
      lastInView: last.top >= 0 && last.bottom <= innerHeight
    };
  });
  // Landscape: two columns side by side, the list longer than the screen.
  let state = await layout();
  expect(state.overflowY).toBe("auto");
  expect(state.scrollable, "画面より長い").toBe(true);
  expect(state.columns).toHaveLength(2);
  expect(state.columns[1].left, "横画面では2列").toBeGreaterThan(state.columns[0].left + 100);
  expect(state.buttonInView, "作成ボタンは下に固定して見える").toBe(true);
  expect(state.lastInView).toBe(false);
  await creator.mouse.move(300, 500);
  for (let step = 0; step < 12 && !(await layout()).lastInView; step += 1) await creator.mouse.wheel(0, 600);
  state = await layout();
  expect(state.scrollTop, "スクロールできる").toBeGreaterThan(0);
  expect(state.lastInView, "並べる順番の最後まで見える").toBe(true);
  expect(state.buttonInView).toBe(true);
  // Portrait: one column, still scrolling, the button still in view.
  await creator.setViewportSize({ width: 820, height: 1180 });
  await scroller.evaluate(node => { node.scrollTop = 0; });
  state = await layout();
  expect(state.columns[1].top, "縦画面では1列").toBeGreaterThan(state.columns[0].bottom - 1);
  expect(state.scrollable).toBe(true);
  expect(state.buttonInView).toBe(true);
  await creator.mouse.move(400, 600);
  for (let step = 0; step < 16 && !(await layout()).lastInView; step += 1) await creator.mouse.wheel(0, 600);
  state = await layout();
  expect(state.lastInView).toBe(true);
  expect(state.buttonInView).toBe(true);
  // The pull-downs narrow the pages down and choose them all.
  await creator.locator('select[data-summary-scope="tag"]').selectOption("tag:生化学");
  await expect(creator.locator('#noteSummaryPicker input[type="checkbox"]')).toHaveCount(2);
  await expect(creator.locator(".note-summary-order li")).toHaveCount(2);
  await expect(creator.locator(".note-summary-result")).toContainText("2ページを1ページに4枚ずつ並べます");
  await expect(create).toBeEnabled();
  expect(blockedRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});
