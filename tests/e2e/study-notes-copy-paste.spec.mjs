// Revision 17: what is chosen on a page (writing, text, shapes, images and
// masks) is copied with 「コピー」 or ⌘C and pasted with 「貼り付け」 or ⌘V on
// another page of the note or in another note's tab: at the same place, a
// little apart on the page it came from, and keeping its shape on a page of
// another aspect ratio. A pasted image shows the picture of the note it came
// from.
import { expect, test } from "@playwright/test";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc } from "firebase/firestore";
import { getBytes, ref, uploadBytes } from "firebase/storage";
import { guardProductionFirebase } from "../helpers/readOnlyApp.mjs";

const BUCKET = "gs://demo-dental-qa.firebasestorage.app";
// An 8×4 PNG: red on the left half, blue on the right.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAIAAAA8r+mnAAAAFUlEQVR4nGO4o6YGR6rJr+GIgXoSAAgcKbGJG512AAAAAElFTkSuQmCC", "base64");
const PORTRAIT = { width: 1240, height: 1754 };
const LANDSCAPE = { width: 1754, height: 1240 };

function recordUnexpectedPageError(errors, error) {
  const message = error?.message || String(error);
  const emulatorChannelClosed = message.includes("127.0.0.1:8080/google.firestore.v1.Firestore/") &&
    message.includes("/channel?") &&
    message.includes("due to access control checks.");
  if (!emulatorChannelClosed) errors.push(message);
}

async function createUser() {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const email = `copy-${suffix}@example.test`;
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

async function seedNote(uid, title, sizes) {
  const noteId = `note-copy-${crypto.randomUUID()}`;
  const pageIds = sizes.map(() => `page-copy-${crypto.randomUUID()}`);
  await withEnvironment(async environment => {
    const db = environment.authenticatedContext(uid).firestore();
    await setDoc(doc(db, "users", uid, "notes", noteId), {
      schemaVersion: 1, title, type: "standalone", status: "ready", pageCount: sizes.length, noteMaskCount: 0, orderRevision: 1,
      materialRefs: [], deletedAt: null
    });
    await Promise.all(pageIds.map((pageId, index) => setDoc(doc(db, "users", uid, "notes", noteId, "pages", pageId), {
      schemaVersion: 1, noteId, order: index + 1, pageType: "blank", contentRevision: 0, contentPath: "", contentHash: "",
      noteMaskCount: 0, deletedAt: null, size: sizes[index], background: { type: "blank", paperColor: "#FFFFFF" }
    })));
  });
  return { noteId, pageIds };
}

// A picture pasted into the note before, as the app keeps it. (The test's
// own Storage reads and writes skip the rules: the Storage Emulator's rules
// runtime sometimes never answers, which is not what this test is about.)
async function seedAsset(uid, noteId) {
  const assetId = `asset-copy-${crypto.randomUUID()}`;
  const storagePath = `users/${uid}/notes/${noteId}/assets/${assetId}/original.png`;
  await withEnvironment(async environment => {
    await environment.withSecurityRulesDisabled(async adminContext => {
      await uploadBytes(ref(adminContext.storage(BUCKET), storagePath), PNG, { contentType: "image/png" });
      await setDoc(doc(adminContext.firestore(), "users", uid, "notes", noteId, "assets", assetId), {
        schemaVersion: 1, storagePath, mimeType: "image/png", naturalWidth: 8, naturalHeight: 4, byteSize: PNG.length,
        hash: "seed", createdAt: new Date(), deletedAt: null
      });
    });
  });
  return assetId;
}

async function writePageContent(uid, noteId, pageId, { elements = [], noteMasks = [] }) {
  await withEnvironment(async environment => {
    const contentPath = `users/${uid}/notes/${noteId}/pages/${pageId}/revisions/seed-1-${crypto.randomUUID()}.json`;
    const json = JSON.stringify({ schemaVersion: 1, noteId, pageId, revision: 1, elements, noteMasks, savedAt: new Date().toISOString() });
    await environment.withSecurityRulesDisabled(async adminContext => {
      await uploadBytes(ref(adminContext.storage(BUCKET), contentPath), Buffer.from(json), { contentType: "application/json" });
      const db = adminContext.firestore();
      await updateDoc(doc(db, "users", uid, "notes", noteId, "pages", pageId), {
        contentPath, contentRevision: 1, contentHash: `seed-1-${crypto.randomUUID()}`, noteMaskCount: noteMasks.length
      });
      await updateDoc(doc(db, "users", uid, "notes", noteId), { noteMaskCount: noteMasks.length });
    });
  });
}

async function readPageContent(uid, noteId, pageId) {
  return withEnvironment(async environment => {
    let result = null;
    await environment.withSecurityRulesDisabled(async adminContext => {
      const page = (await getDoc(doc(adminContext.firestore(), "users", uid, "notes", noteId, "pages", pageId))).data();
      if (!page?.contentPath) return;
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

// The saved content of a page once it holds `count` elements and masks.
async function savedContent(uid, noteId, pageId, count) {
  let saved = null;
  await expect.poll(async () => {
    saved = await readPageContent(uid, noteId, pageId);
    return saved ? saved.content.elements.length + saved.content.noteMasks.length : -1;
  }, { timeout: 30_000 }).toBe(count);
  return saved.content;
}

async function lassoAll(page, stage, from, to) {
  const box = await stage.boundingBox();
  const at = (x, y) => ({ x: box.x + box.width * x, y: box.y + box.height * y });
  const start = at(from.x, from.y);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (const vertex of [at(to.x, from.y), at(to.x, to.y), at(from.x, to.y), at(from.x, from.y)]) {
    await page.mouse.move(vertex.x, vertex.y, { steps: 6 });
  }
  await page.mouse.up();
}

const close = (actual, expected, message, tolerance = 1e-6) =>
  expect(Math.abs(actual - expected), `${message}: ${actual} / ${expected}`).toBeLessThan(tolerance);

function sourceItems(assetId) {
  const circleHeight = .2 * PORTRAIT.width / PORTRAIT.height;
  return {
    elements: [
      {
        id: "stroke-a", type: "stroke", pressureEnabled: false, straightened: false,
        points: [{ x: .1, y: .1 }, { x: .16, y: .14 }, { x: .22, y: .1 }, { x: .3, y: .14 }],
        style: { color: "#111111", widthRatio: .003, opacity: 1 }, zIndex: 10
      },
      {
        id: "text-a", type: "text", bounds: { x: .12, y: .2, width: .3, height: .04 }, rotation: 0, text: "歯髄腔", autoHeight: true,
        style: { fontSizeRatio: .025, color: "#1d4ed8" }, zIndex: 20
      },
      {
        id: "circle-a", type: "shape", shapeType: "ellipse", bounds: { x: .5, y: .1, width: .2, height: circleHeight }, rotation: 0,
        style: { strokeColor: "#dc2626", strokeWidthRatio: .003, strokeOpacity: 1, fillColor: "#ffffff", fillOpacity: 0, lineStyle: "solid" },
        zIndex: 30
      },
      {
        id: "image-a", type: "image", assetId, bounds: { x: .15, y: .3, width: .2, height: .1 * PORTRAIT.width / PORTRAIT.height },
        crop: { x: 0, y: 0, width: 1, height: 1 }, rotation: 0, opacity: 1, locked: false, aspectLocked: true, zIndex: 40
      }
    ],
    noteMasks: [
      { id: "mask-a", x: .6, y: .45, width: .2, height: .04, weak: false, underline: true },
      { id: "mask-b", x: .6, y: .55, width: .15, height: .04, weak: true, underline: false }
    ]
  };
}

test("@authenticated 選んだ手書き・テキスト・図形・画像・マスクを別のページと別のノートへコピーして貼り付けられる", async ({ page, context }) => {
  test.setTimeout(240_000);
  const blockedRequests = await guardProductionFirebase(page);
  const pageErrors = [];
  page.on("pageerror", error => recordUnexpectedPageError(pageErrors, error));
  context.on("page", target => target.on("pageerror", error => recordUnexpectedPageError(pageErrors, error)));
  const user = await createUser();
  const source = await seedNote(user.uid, "コピー元ノート", [PORTRAIT, PORTRAIT]);
  const target = await seedNote(user.uid, "貼り付け先ノート", [LANDSCAPE]);
  const assetId = await seedAsset(user.uid, source.noteId);
  const items = sourceItems(assetId);
  await writePageContent(user.uid, source.noteId, source.pageIds[0], items);
  await login(page, user);

  const sourceTab = await context.newPage();
  await guardProductionFirebase(sourceTab);
  await sourceTab.setViewportSize({ width: 1180, height: 900 });
  await openEditor(sourceTab, source.noteId);
  const targetTab = await context.newPage();
  await guardProductionFirebase(targetTab);
  await targetTab.setViewportSize({ width: 1180, height: 900 });
  await openEditor(targetTab, target.noteId);
  const sourceStage = sourceTab.locator("#notePageStage");
  const targetStage = targetTab.locator("#notePageStage");
  await expect(targetTab.locator("#notePastePill")).toBeHidden();
  await expect(targetTab.locator('#noteMoreMenu [data-note-action="paste"]'), "コピーするまで貼り付けはない").toBeHidden();

  // 1. Everything but the masks is chosen with 選択 and copied.
  await sourceTab.bringToFront();
  await expect(sourceStage.locator(".note-element")).toHaveCount(4);
  await sourceTab.locator('[data-note-tool="select"]').click();
  await lassoAll(sourceTab, sourceStage, { x: .05, y: .05 }, { x: .9, y: .42 });
  await expect(sourceStage.locator(".note-element.note-selected")).toHaveCount(4);
  const copyButton = sourceTab.locator('#noteSelectionActions [data-selection-action="copy"]');
  await expect(copyButton).toBeVisible();
  await copyButton.click();
  await expect(sourceTab.locator("#noteEditorNotice")).toContainText("4個をコピーしました");
  await expect(sourceTab.locator("#notePastePill"), "選択中のメニューがある間は出さない").toBeHidden();

  // 2. The other note's tab hears of it at once: ••• offers it with any tool,
  // and 選択 shows 「貼り付け（4個）」.
  await targetTab.bringToFront();
  await expect(targetTab.locator('#noteMoreMenu [data-note-action="paste"]')).not.toHaveClass(/hidden/);
  await expect(targetTab.locator("#notePastePill"), "ペンのときは出さない").toBeHidden();
  await targetTab.locator('[data-note-tool="select"]').click();
  const targetPill = targetTab.locator("#notePastePill");
  await expect(targetPill).toBeVisible();
  await expect(targetPill.locator('[data-paste-action="paste"]')).toHaveText("貼り付け（4個）");
  await targetPill.locator('[data-paste-action="paste"]').click();
  await expect(targetTab.locator("#noteEditorNotice")).toContainText("4個を貼り付けました。コピーしたときと同じ位置です。");
  await expect(targetStage.locator(".note-element")).toHaveCount(4);
  await expect(targetStage.locator(".note-element.note-selected"), "貼り付けたものを選んだまま").toHaveCount(4);
  await expect(targetTab.locator("#noteSelectionActions")).toBeVisible();
  await expect.poll(() => targetStage.locator(".note-image-element img").evaluate(image => image.complete ? image.naturalWidth : 0), {
    message: "元のノートの画像が出る", timeout: 30_000
  }).toBe(8);
  await waitSaved(targetTab);
  const pasted = await savedContent(user.uid, target.noteId, target.pageIds[0], 4);
  const aspect = (PORTRAIT.height / PORTRAIT.width) / (LANDSCAPE.height / LANDSCAPE.width);
  const byType = type => pasted.elements.find(element => element.type === type);
  expect(pasted.elements.map(element => element.id).some(id => id.endsWith("-a")), "新しいIDで貼る").toBe(false);
  expect(pasted.elements.map(element => element.type), "重なり順のまま").toEqual(["stroke", "text", "shape", "image"]);
  // The copy's box starts at (.1, .1): the width share is kept, the height
  // share follows the page so that the shapes keep theirs.
  byType("stroke").points.forEach((point, index) => {
    close(point.x, items.elements[0].points[index].x, "手書きの横位置");
    close(point.y, .1 + (items.elements[0].points[index].y - .1) * aspect, "手書きの縦位置");
  });
  const circle = byType("shape").bounds;
  close(circle.x, .5, "円の位置");
  close(circle.width * LANDSCAPE.width, circle.height * LANDSCAPE.height, "円は円のまま", 1e-3);
  close(byType("text").style.fontSizeRatio * LANDSCAPE.height, .025 * PORTRAIT.height * (LANDSCAPE.width / PORTRAIT.width), "文字はページ幅に対して同じ大きさ", 1e-6);
  expect(byType("text").text).toBe("歯髄腔");
  expect(byType("image").assetId, "画像は元のノートの画像を使う").toBe(assetId);
  expect(byType("image").assetNoteId).toBe(source.noteId);

  // 3. Another page of the same note: ⌘V pastes at the same place; again
  // moves it a little; undo takes the second paste back.
  await sourceTab.bringToFront();
  await sourceTab.locator(`.note-page-thumbnail[data-page-id="${source.pageIds[1]}"]`).click();
  await expect(sourceStage.locator(".note-element")).toHaveCount(0);
  const sourcePill = sourceTab.locator("#notePastePill");
  await expect(sourcePill, "別のページでは選択中でないので出す").toBeVisible();
  await sourceStage.focus();
  await sourceTab.keyboard.press("ControlOrMeta+V");
  await expect(sourceStage.locator(".note-element")).toHaveCount(4);
  await expect(sourceTab.locator("#noteEditorNotice")).toContainText("コピーしたときと同じ位置です。");
  await sourceTab.keyboard.press("ControlOrMeta+V");
  await expect(sourceStage.locator(".note-element")).toHaveCount(8);
  await expect(sourceTab.locator("#noteEditorNotice")).toContainText("少しずらしています。");
  await sourceTab.keyboard.press("ControlOrMeta+Z");
  await expect(sourceStage.locator(".note-element")).toHaveCount(4);
  await waitSaved(sourceTab);
  const page2 = await savedContent(user.uid, source.noteId, source.pageIds[1], 4);
  const page2Stroke = page2.elements.find(element => element.type === "stroke");
  page2Stroke.points.forEach((point, index) => {
    close(point.x, items.elements[0].points[index].x, "同じ縦横比のページへは同じ位置");
    close(point.y, items.elements[0].points[index].y, "同じ縦横比のページへは同じ位置");
  });
  expect(page2.elements.find(element => element.type === "image").assetNoteId, "同じノートの画像はそのまま").toBeUndefined();
  expect(page2.elements.find(element => element.type === "image").assetId).toBe(assetId);

  // 4. Masks are copied with the mask tool's 選択・編集 and pasted into the
  // other note, which turns to the mask tool for them.
  await sourceTab.locator(`.note-page-thumbnail[data-page-id="${source.pageIds[0]}"]`).click();
  await expect(sourceStage.locator(".note-element")).toHaveCount(4);
  await sourceTab.locator('[data-note-tool="mask"]').click();
  await sourceTab.locator("#noteMaskEditModeBtn").click();
  await sourceStage.locator('.note-mask[data-mask-id="mask-a"]').click();
  await sourceTab.locator('#noteSelectionActions [data-selection-action="select-page-masks"]').click();
  await sourceTab.locator('#noteSelectionActions [data-selection-action="copy"]').click();
  await expect(sourceTab.locator("#noteEditorNotice")).toContainText("2個をコピーしました");
  await targetTab.bringToFront();
  await targetStage.click({ position: { x: 20, y: 20 } });
  await expect(targetTab.locator("#noteSelectionActions")).toBeHidden();
  await expect(targetPill.locator('[data-paste-action="paste"]')).toHaveText("貼り付け（2個）");
  await targetPill.locator('[data-paste-action="paste"]').click();
  await expect(targetTab.locator("#noteMaskEditModeBtn")).toHaveAttribute("aria-pressed", "true");
  await expect(targetStage.locator(".note-mask")).toHaveCount(2);
  await expect(targetTab.locator("#noteSelectionActionsTitle")).toHaveText("2個選択中");
  await waitSaved(targetTab);
  const withMasks = await savedContent(user.uid, target.noteId, target.pageIds[0], 6);
  const [maskA, maskB] = withMasks.noteMasks;
  close(maskA.x, .6, "マスクの横位置");
  close(maskA.y, .45, "マスクの縦位置（いちばん上のマスクから）");
  close(maskB.y, .45 + (.55 - .45) * aspect, "2つ目のマスクの縦位置");
  close(maskA.width, .2, "マスクの幅");
  close(maskA.height, .04 * aspect, "マスクの高さ");
  expect([maskA.underline, maskA.weak, maskB.underline, maskB.weak], "下線と苦手はそのまま").toEqual([true, false, false, true]);
  expect(withMasks.noteMasks.every(mask => !("origin" in mask) && !mask.id.startsWith("mask-"))).toBe(true);

  // 5. ✕ forgets the copy in every tab.
  await targetStage.click({ position: { x: 20, y: 20 } });
  await expect(targetPill).toBeVisible();
  await targetPill.locator('[data-paste-action="clear"]').click();
  await expect(targetPill).toBeHidden();
  await expect(targetTab.locator('#noteMoreMenu [data-note-action="paste"]')).toHaveClass(/hidden/);
  await sourceTab.bringToFront();
  await expect(sourceTab.locator('#noteMoreMenu [data-note-action="paste"]')).toHaveClass(/hidden/);
  await expect(sourcePill).toBeHidden();

  expect(pageErrors).toEqual([]);
  expect(blockedRequests).toEqual([]);
});
