// Revision 16: tags of the note list (nested with "/", as in Obsidian), the
// search of the list and jumping to a page by its number.
import { expect, test } from "@playwright/test";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, getDocs, setDoc } from "firebase/firestore";
import { guardProductionFirebase } from "../helpers/readOnlyApp.mjs";

function recordUnexpectedPageError(errors, error) {
  const message = error?.message || String(error);
  const emulatorChannelClosed = message.includes("127.0.0.1:8080/google.firestore.v1.Firestore/") &&
    message.includes("/channel?") &&
    message.includes("due to access control checks.");
  if (!emulatorChannelClosed) errors.push(message);
}

async function createUser() {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const email = `tags-${suffix}@example.test`;
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

async function seedNote(uid, title, { pageCount = 1, tags, updatedAt = new Date("2026-10-01T09:00:00Z") } = {}) {
  const noteId = `note-tags-${crypto.randomUUID()}`;
  await withEnvironment(async environment => {
    const db = environment.authenticatedContext(uid).firestore();
    await setDoc(doc(db, "users", uid, "notes", noteId), {
      schemaVersion: 1, title, type: "standalone", status: "ready", pageCount,
      noteMaskCount: 0, orderRevision: 1, materialRefs: [], deletedAt: null, updatedAt,
      ...(tags ? { tags } : {})
    });
    await Promise.all(Array.from({ length: pageCount }, (_, index) => setDoc(
      doc(db, "users", uid, "notes", noteId, "pages", `page-${index + 1}`),
      {
        schemaVersion: 1, noteId, order: index + 1, pageType: "blank", contentRevision: 0, contentPath: "", contentHash: "",
        noteMaskCount: 0, deletedAt: null, size: { width: 1240, height: 1754 }, background: { type: "blank", paperColor: "#FFFFFF" }
      }
    )));
  });
  return noteId;
}

async function readNotes(uid) {
  return withEnvironment(async environment => {
    const snapshots = await getDocs(collection(environment.authenticatedContext(uid).firestore(), "users", uid, "notes"));
    return snapshots.docs.map(item => ({ id: item.id, ...item.data() }));
  });
}

async function readNote(uid, noteId) {
  return withEnvironment(async environment => {
    const snapshot = await getDoc(doc(environment.authenticatedContext(uid).firestore(), "users", uid, "notes", noteId));
    return snapshot.data();
  });
}

const cardTitles = page => page.locator("#noteList .note-card h4").allTextContents();

test("@authenticated ノートに入れ子のタグを付け、タグの木・プルダウン・検索で絞り込み、タグ名をまとめて変更・削除できる", async ({ page, context }) => {
  test.setTimeout(240_000);
  const blockedRequests = await guardProductionFirebase(page);
  const pageErrors = [];
  const dialogs = [];
  const prompts = [];
  page.on("pageerror", error => recordUnexpectedPageError(pageErrors, error));
  page.on("dialog", dialog => {
    dialogs.push(dialog.message());
    if (dialog.type() === "prompt") void dialog.accept(prompts.shift() ?? "");
    else void dialog.accept();
  });
  context.on("page", target => target.on("pageerror", error => recordUnexpectedPageError(pageErrors, error)));
  const user = await createUser();
  const anatomy4 = await seedNote(user.uid, "鰓弓と神経", { tags: ["口腔解剖学/4章"] });
  const anatomy = await seedNote(user.uid, "口腔解剖学まとめ", { tags: ["口腔解剖学"] });
  const anatomy10 = await seedNote(user.uid, "歯の発生", { tags: ["口腔解剖学/10章", "国試対策"] });
  const biochem = await seedNote(user.uid, "生化学ドリル", { tags: ["生化学"] });
  const blank = await seedNote(user.uid, "白紙メモ");
  const blankBefore = await readNote(user.uid, blank);

  await login(page, user);
  await page.setViewportSize({ width: 1180, height: 900 });
  await expect(page.locator("#noteList .note-card")).toHaveCount(5);
  const pane = page.locator("#noteTagPane");
  await expect(pane).toBeVisible();
  await expect(page.locator(".note-list-tag-select"), "広い画面ではタグの木を使う").toBeHidden();
  const paneItem = name => pane.locator(".note-tag-item").filter({ has: page.locator(".note-tag-name", { hasText: new RegExp(`^${name}$`) }) });
  await expect(paneItem("すべてのノート").locator(".note-tag-count")).toHaveText("5");
  await expect(paneItem("#口腔解剖学").locator(".note-tag-count"), "下の階層のタグを持つノートも数える").toHaveText("3");
  await expect(paneItem("#生化学").locator(".note-tag-count")).toHaveText("1");
  await expect(paneItem("#国試対策").locator(".note-tag-count")).toHaveText("1");
  await expect(paneItem("タグなし").locator(".note-tag-count")).toHaveText("1");
  await expect(paneItem("#4章"), "閉じた親の下は出さない").toHaveCount(0);

  // A parent tag shows the notes under it; its children open with ▸.
  await paneItem("#口腔解剖学").click();
  await expect(page.locator("#noteList .note-card")).toHaveCount(3);
  await expect(page.locator("#noteListStatus")).toContainText("#口腔解剖学のノート 3件（全5件）");
  await pane.locator('[data-tag-toggle="口腔解剖学"]').click();
  const tagNames = pane.locator(".note-tag-tree .note-tag-name");
  await expect(tagNames).toHaveCount(7);
  const names = await tagNames.allTextContents();
  const parentIndex = names.indexOf("#口腔解剖学");
  expect(names.slice(parentIndex, parentIndex + 3), "子のタグは親のすぐ下に、数の順で").toEqual(["#口腔解剖学", "#4章", "#10章"]);
  expect([names[0], names[names.length - 1]]).toEqual(["すべてのノート", "タグなし"]);
  await paneItem("#4章").click();
  expect(await cardTitles(page)).toEqual(["鰓弓と神経"]);
  await expect(paneItem("#4章")).toHaveAttribute("aria-pressed", "true");
  await paneItem("タグなし").click();
  expect(await cardTitles(page)).toEqual(["白紙メモ"]);
  // A tag chip of a card chooses its tag.
  await paneItem("すべてのノート").click();
  await page.locator(".note-card").filter({ hasText: "歯の発生" }).locator(".note-tag-chip", { hasText: "#国試対策" }).click();
  expect(await cardTitles(page)).toEqual(["歯の発生"]);

  // The search looks at titles and tags, within the tag shown.
  await paneItem("すべてのノート").click();
  await page.locator("#noteSearchInput").fill("ドリル");
  await expect(page.locator("#noteList .note-card")).toHaveCount(1);
  await expect(page.locator("#noteListStatus")).toContainText("「ドリル」を含むノート 1件（全5件）");
  await page.locator("#noteSearchInput").fill("＃４章");
  await expect.poll(() => cardTitles(page)).toEqual(["鰓弓と神経"]);
  await page.locator("#noteSearchInput").fill("存在しない語");
  await expect(page.locator(".note-list-empty")).toContainText("条件に合うノートはありません");
  await page.locator("#noteSearchInput").fill("");
  await expect(page.locator("#noteList .note-card")).toHaveCount(5);

  // Tags of a note: one from the tags in use, one typed (full-width letters
  // and "／" made half-width), a duplicate refused.
  await page.locator(".note-card").filter({ hasText: "白紙メモ" }).locator('[data-note-card-action="tags"]').click();
  const dialog = page.locator("#noteTagDialog");
  await expect(dialog).toBeVisible();
  await expect(page.locator("#noteTagDialogNoteName")).toHaveText("「白紙メモ」");
  await expect(page.locator("#noteTagDialogExisting option"), "今あるタグ5つ（と「選んでください」）").toHaveCount(6);
  await page.locator("#noteTagDialogExisting").selectOption("生化学");
  await expect(page.locator("#noteTagDialogTags .note-tag-chip")).toHaveText(["#生化学"]);
  await page.locator("#noteTagDialogInput").fill("＃国試対策／Ａ問題");
  await page.locator("#noteTagDialogInput").press("Enter");
  await expect(page.locator("#noteTagDialogTags .note-tag-chip")).toHaveText(["#生化学", "#国試対策/A問題"]);
  await page.locator("#noteTagDialogInput").fill("生化学");
  await page.locator("#noteTagDialogAddBtn").click();
  await expect(page.locator("#noteTagDialogStatus")).toContainText("すでに付いています");
  await page.locator("#noteTagDialogInput").fill("");
  await page.locator("#noteTagDialogSaveBtn").click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".note-card").filter({ hasText: "白紙メモ" }).locator(".note-tag-chip")).toHaveText(["#生化学", "#国試対策/A問題"]);
  const tagged = await readNote(user.uid, blank);
  expect(tagged.tags).toEqual(["生化学", "国試対策/A問題"]);
  expect(tagged.updatedAt?.toMillis?.(), "タグはノートの編集日時を変えない").toBe(blankBefore.updatedAt?.toMillis?.());
  await expect(paneItem("#国試対策").locator(".note-tag-count")).toHaveText("2");

  // Renaming a tag renames the tags under it; the list keeps showing it.
  await paneItem("#口腔解剖学").click();
  await page.locator("#noteTagManageBtn").click();
  const manage = page.locator("#noteTagManageDialog");
  await expect(manage).toBeVisible();
  prompts.push("解剖学");
  await manage.locator('[data-tag-manage="rename"][data-tag="口腔解剖学"]').click();
  await expect(page.locator("#noteTagManageStatus")).toContainText("3件のノートのタグを「#解剖学」に変えました");
  expect(dialogs.some(message => message.includes("3件のノートのタグが変わります"))).toBe(true);
  await expect(manage.locator(".note-tag-manage-name")).toContainText(["#解剖学", "#解剖学/4章", "#解剖学/10章"]);
  // Deleting a tag takes it off; the notes stay.
  await manage.locator('[data-tag-manage="delete"][data-tag="生化学"]').click();
  await expect(page.locator("#noteTagManageStatus")).toContainText("2件のノートから「#生化学」を外しました");
  await page.locator("#noteTagManageCloseBtn").click();
  await expect(paneItem("#解剖学")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#noteList .note-card")).toHaveCount(3);
  const byId = new Map((await readNotes(user.uid)).map(note => [note.id, note]));
  expect(byId.get(anatomy4).tags).toEqual(["解剖学/4章"]);
  expect(byId.get(anatomy).tags).toEqual(["解剖学"]);
  expect(byId.get(anatomy10).tags).toEqual(["解剖学/10章", "国試対策"]);
  expect(byId.get(biochem).tags).toEqual([]);
  expect(byId.get(blank).tags).toEqual(["国試対策/A問題"]);
  expect(byId.size, "ノートは消えない").toBe(5);

  // The tag and the opened tags stay on this device after reloading.
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#authStatus")).toContainText(user.email, { timeout: 20_000 });
  await openNoteList(page);
  await expect(page.locator("#noteList .note-card")).toHaveCount(3, { timeout: 20_000 });
  await expect(paneItem("#解剖学")).toHaveAttribute("aria-pressed", "true");

  // A narrow screen chooses the tag from a pull-down.
  await page.setViewportSize({ width: 600, height: 900 });
  await expect(pane).toBeHidden();
  const select = page.locator("#noteTagFilterSelect");
  await expect(select).toBeVisible();
  await expect(select).toHaveValue("tag:解剖学");
  await select.selectOption("tag:解剖学/10章");
  expect(await cardTitles(page)).toEqual(["歯の発生"]);
  await select.selectOption("tag:解剖学");
  await page.setViewportSize({ width: 1180, height: 900 });

  // A note made while a tag shows gets that tag.
  await page.locator("#newNoteBtn").click();
  await page.locator("#newNoteTitle").fill("タグ付き白紙");
  const popupPromise = page.waitForEvent("popup", { timeout: 60_000 });
  await page.locator('[data-create-note="blank"]').click();
  const editor = await popupPromise;
  await guardProductionFirebase(editor, blockedRequests);
  // The tab opens blank ("ノートを準備しています…") until the note exists.
  await editor.waitForURL(url => Boolean(url.searchParams.get("noteId")), { timeout: 60_000 });
  await expect(editor.locator("#noteEditorView")).toBeVisible({ timeout: 60_000 });
  await expect(editor.locator("#noteEditorStartup")).toBeHidden({ timeout: 60_000 });
  const created = (await readNotes(user.uid)).find(note => note.title === "タグ付き白紙");
  expect(created.tags).toEqual(["解剖学"]);
  // The editor's menu edits the tags too.
  await editor.locator(".note-more-menu summary").click();
  await editor.locator('[data-note-action="tags"]').click();
  await expect(editor.locator("#noteTagDialog")).toBeVisible();
  await expect(editor.locator("#noteTagDialogTags .note-tag-chip")).toHaveText(["#解剖学"]);
  await expect(editor.locator("#noteTagDialogExisting option"), "ほかのノートのタグも選べる").not.toHaveCount(1);
  await editor.locator("#noteTagDialogExisting").selectOption("解剖学/4章");
  await editor.locator("#noteTagDialogSaveBtn").click();
  await expect(editor.locator("#noteTagDialog")).toBeHidden();
  await expect(editor.locator("#noteEditorNotice")).toContainText("タグを保存しました");
  await expect.poll(async () => (await readNotes(user.uid)).find(note => note.title === "タグ付き白紙").tags).toEqual(["解剖学", "解剖学/4章"]);
  await editor.close();
  expect(blockedRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test("@authenticated ページ番号を入力するとそのページへ移動し、範囲外の番号は移動しない", async ({ page }) => {
  test.setTimeout(120_000);
  const blockedRequests = await guardProductionFirebase(page);
  const pageErrors = [];
  page.on("pageerror", error => recordUnexpectedPageError(pageErrors, error));
  const user = await createUser();
  const noteId = await seedNote(user.uid, "長いノート", { pageCount: 12 });
  await login(page, user);
  await page.goto(`/?firebaseEmulator=1&noteEditor=1&noteId=${noteId}&editorTabId=${crypto.randomUUID()}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#noteEditorStartup")).toBeHidden({ timeout: 60_000 });
  const counter = page.locator("#notePageCounter");
  await expect(counter).toHaveText("1 / 12");
  await expect(counter).toHaveAttribute("role", "button");
  await counter.click();
  const dialog = page.locator("#notePageJumpDialog");
  await expect(dialog).toBeVisible();
  await expect(page.locator("#notePageJumpRange")).toHaveText("（1〜12）");
  await expect(page.locator("#notePageJumpInput")).toHaveValue("1");
  await page.locator("#notePageJumpInput").fill("9");
  await page.locator("#notePageJumpInput").press("Enter");
  await expect(dialog).toBeHidden();
  await expect(counter).toHaveText("9 / 12");
  await expect(page.locator("#notePageList li").nth(8)).toHaveClass(/active/);
  // Out of range: the dialog says so and stays.
  await counter.click();
  await page.locator("#notePageJumpInput").fill("13");
  await page.locator("#notePageJumpGoBtn").click();
  await expect(page.locator("#notePageJumpStatus")).toContainText("1〜12のページ番号を入力してください");
  await expect(dialog).toBeVisible();
  await page.locator("#notePageJumpInput").fill("0");
  await page.locator("#notePageJumpGoBtn").click();
  await expect(page.locator("#notePageJumpStatus")).toContainText("1〜12のページ番号");
  await page.locator("#notePageJumpCancelBtn").click();
  await expect(dialog).toBeHidden();
  await expect(counter).toHaveText("9 / 12");
  // The keyboard opens it too, and the first page can be reached.
  await counter.focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await page.locator("#notePageJumpInput").fill("1");
  await page.locator("#notePageJumpInput").press("Enter");
  await expect(counter).toHaveText("1 / 12");
  // An iPad held upright keeps the counter in the header (and the header
  // fits); a phone-sized screen jumps from the ••• menu.
  for (const width of [820, 768, 744]) {
    await page.setViewportSize({ width, height: 1024 });
    await expect(counter, `${width}px`).toBeVisible();
    const fits = await page.locator("#noteEditorView > .note-editor-header").evaluate(header => {
      const bounds = header.getBoundingClientRect();
      return header.scrollWidth <= header.clientWidth + 1 && [...header.children]
        .filter(child => getComputedStyle(child).display !== "none")
        .every(child => {
          const rect = child.getBoundingClientRect();
          return rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1 && rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1;
        });
    });
    expect(fits, `${width}px幅でheaderに収まる`).toBe(true);
  }
  await page.setViewportSize({ width: 600, height: 900 });
  await expect(counter).toBeHidden();
  await page.locator("#noteMoreMenu summary").click();
  await page.locator('[data-note-action="page-jump"]').click();
  await expect(dialog).toBeVisible();
  await page.locator("#notePageJumpInput").fill("12");
  await page.locator("#notePageJumpInput").press("Enter");
  await expect(dialog).toBeHidden();
  await expect.poll(() => page.locator("#notePageList li.active .note-page-thumbnail").getAttribute("data-page-id")).toBe("page-12");
  expect(blockedRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});
