// Revision 17: a pen stroke held still at its end becomes the shape it was
// meant to be: a circle, an L (a polyline with sharp corners), a rectangle (a
// polygon) or, as before, a straight line. Writing is left as it was written,
// and the setting turns it all off.
import { expect, test } from "@playwright/test";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { getBytes, ref } from "firebase/storage";
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
  const email = `shape-${suffix}@example.test`;
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

async function seedNote(uid) {
  const noteId = `note-shape-${crypto.randomUUID()}`;
  const pageId = `page-shape-${crypto.randomUUID()}`;
  await withEnvironment(async environment => {
    const db = environment.authenticatedContext(uid).firestore();
    await setDoc(doc(db, "users", uid, "notes", noteId), {
      schemaVersion: 1, title: "図形ノート", type: "standalone", status: "ready", pageCount: 1, noteMaskCount: 0, orderRevision: 1,
      materialRefs: [], deletedAt: null
    });
    await setDoc(doc(db, "users", uid, "notes", noteId, "pages", pageId), {
      schemaVersion: 1, noteId, order: 1, pageType: "blank", contentRevision: 0, contentPath: "", contentHash: "",
      noteMaskCount: 0, deletedAt: null, size: { width: 1240, height: 1754 }, background: { type: "blank", paperColor: "#FFFFFF" }
    });
  });
  return { noteId, pageId };
}

async function readElements(uid, noteId, pageId) {
  return withEnvironment(async environment => {
    let elements = [];
    await environment.withSecurityRulesDisabled(async adminContext => {
      const page = (await getDoc(doc(adminContext.firestore(), "users", uid, "notes", noteId, "pages", pageId))).data();
      if (!page?.contentPath) return;
      const bytes = await getBytes(ref(adminContext.storage(BUCKET), page.contentPath));
      elements = JSON.parse(Buffer.from(bytes).toString("utf8")).elements;
    });
    return elements;
  });
}

// A pen stroke through `points` (shares of the page), held still at its end
// for `holdMs` before the pen is lifted.
async function penStroke(page, stage, points, { pointerId, holdMs = 0 }) {
  const box = await stage.boundingBox();
  const client = point => ({ clientX: box.x + box.width * point.x, clientY: box.y + box.height * point.y });
  await stage.dispatchEvent("pointerdown", { pointerId, pointerType: "pen", button: 0, buttons: 1, pressure: .5, ...client(points[0]) });
  for (const point of points.slice(1)) {
    await stage.dispatchEvent("pointermove", { pointerId, pointerType: "pen", button: -1, buttons: 1, pressure: .5, ...client(point) });
  }
  if (holdMs) await page.waitForTimeout(holdMs);
  await stage.dispatchEvent("pointerup", { pointerId, pointerType: "pen", button: 0, buttons: 0, pressure: 0, ...client(points.at(-1)) });
}

// A hand-drawn circle: a little uneven, a little past where it started.
function circlePoints(center, radius, aspect) {
  const points = [];
  for (let step = 0; step <= 52; step += 1) {
    const t = -Math.PI / 2 + step / 48 * 2 * Math.PI;
    const wobble = 1 + .03 * Math.sin(3 * t);
    points.push({ x: center.x + radius * wobble * Math.cos(t), y: center.y + radius * wobble * Math.sin(t) * aspect });
  }
  return points;
}

function through(corners, steps = 12) {
  const points = [corners[0]];
  for (let index = 1; index < corners.length; index += 1) {
    const from = corners[index - 1];
    const to = corners[index];
    for (let step = 1; step <= steps; step += 1) points.push({ x: from.x + (to.x - from.x) * step / steps, y: from.y + (to.y - from.y) * step / steps });
  }
  return points;
}

test("@authenticated 終点で止めた線は円・L字・四角・直線に整い、文字のような線と設定オフのときはそのまま", async ({ page }) => {
  test.setTimeout(120_000);
  const blockedRequests = await guardProductionFirebase(page);
  const pageErrors = [];
  page.on("pageerror", error => recordUnexpectedPageError(pageErrors, error));
  const user = await createUser();
  const { noteId, pageId } = await seedNote(user.uid);
  await login(page, user);
  await page.setViewportSize({ width: 1180, height: 1000 });
  await page.goto(`/?firebaseEmulator=1&noteEditor=1&noteId=${noteId}&editorTabId=${crypto.randomUUID()}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#noteEditorStartup")).toBeHidden({ timeout: 60_000 });
  const stage = page.locator("#notePageStage");
  await expect(page.locator('[data-note-tool="pen"]')).toHaveClass(/active/);
  const box = await stage.boundingBox();
  const aspect = box.width / box.height;
  const strokes = stage.locator("path.note-element[data-element-id]");

  await penStroke(page, stage, circlePoints({ x: .3, y: .2 }, .12, aspect), { pointerId: 1701, holdMs: 800 });
  await penStroke(page, stage, through([{ x: .6, y: .1 }, { x: .605, y: .3 }, { x: .85, y: .303 }]), { pointerId: 1702, holdMs: 800 });
  await penStroke(page, stage, through([{ x: .15, y: .45 }, { x: .5, y: .452 }, { x: .503, y: .6 }, { x: .148, y: .598 }, { x: .152, y: .455 }]), { pointerId: 1703, holdMs: 800 });
  await penStroke(page, stage, through([{ x: .6, y: .5 }, { x: .75, y: .52 }, { x: .9, y: .49 }]), { pointerId: 1704, holdMs: 800 });
  // し: down, then round to the upper right; held, it stays as written.
  const shi = [];
  for (let step = 0; step <= 12; step += 1) shi.push({ x: .25, y: .68 + step * .01 });
  for (let step = 1; step <= 16; step += 1) {
    const t = step / 16 * Math.PI * .9;
    shi.push({ x: .25 + .08 * (1 - Math.cos(t)), y: .8 + .04 * Math.sin(t) });
  }
  await penStroke(page, stage, shi, { pointerId: 1705, holdMs: 800 });
  await expect(strokes).toHaveCount(5);
  await page.screenshot({ path: test.info().outputPath("shapes.png") });

  // With the setting off, a held circle stays as written.
  await page.locator('[data-note-tool="pen"]').click();
  await expect(page.locator("#noteToolSettings")).toBeVisible();
  const setting = page.locator("#noteStraightenEnabled");
  await expect(setting.locator("xpath=..")).toContainText("終点長押しで直線・円・L字に整える");
  await setting.uncheck();
  await page.locator("#noteToolSettingsDoneBtn").click();
  await expect(page.locator("#noteToolSettings")).toBeHidden();
  await penStroke(page, stage, circlePoints({ x: .7, y: .8 }, .08, aspect), { pointerId: 1706, holdMs: 800 });
  await expect(strokes).toHaveCount(6);

  await expect(page.locator("#noteSaveStatus")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
  let elements = [];
  await expect.poll(async () => (elements = await readElements(user.uid, noteId, pageId)).length, { timeout: 30_000 }).toBe(6);
  const [circle, ell, rectangle, line, written, unsnapped] = elements;
  const px = point => ({ x: point.x * box.width, y: point.y * box.height });

  expect(circle.strokeShape).toBe("circle");
  expect(circle.points.length).toBeGreaterThanOrEqual(37);
  expect(circle.points[0]).toEqual(circle.points.at(-1));
  // (The last point closes the circle: it is the first one again.)
  const round = circle.points.slice(0, -1).map(px);
  const center = { x: round.reduce((sum, point) => sum + point.x, 0) / round.length, y: round.reduce((sum, point) => sum + point.y, 0) / round.length };
  const radii = round.map(point => Math.hypot(point.x - center.x, point.y - center.y));
  expect(Math.max(...radii) - Math.min(...radii), "真円（画面の上で）").toBeLessThan(Math.max(...radii) * .01);

  expect(ell.strokeShape).toBe("polyline");
  expect(ell.points).toHaveLength(4);
  expect(ell.points[1], "角は2回（鋭いまま描く）").toEqual(ell.points[2]);
  expect(ell.points[0].x, "縦の辺は真縦").toBe(ell.points[1].x);
  expect(ell.points[2].y, "横の辺は真横").toBe(ell.points[3].y);

  expect(rectangle.strokeShape).toBe("polygon");
  expect(rectangle.points).toHaveLength(8);
  expect(new Set(rectangle.points.map(point => point.x)).size, "四角の辺は縦・横").toBe(2);
  expect(new Set(rectangle.points.map(point => point.y)).size).toBe(2);

  expect(line.strokeShape).toBe("line");
  expect(line.points, "これまでどおり始点と終点の直線").toHaveLength(2);

  expect(written.strokeShape, "文字のような線はそのまま").toBeUndefined();
  expect(written.straightened).toBe(false);
  expect(written.points.length).toBeGreaterThan(10);
  expect(unsnapped.strokeShape, "設定がオフならそのまま").toBeUndefined();
  expect(unsnapped.straightened).toBe(false);

  expect(pageErrors).toEqual([]);
  expect(blockedRequests).toEqual([]);
});
