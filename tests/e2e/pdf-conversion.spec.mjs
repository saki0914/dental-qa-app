import { expect, test } from "@playwright/test";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, getDoc } from "firebase/firestore";

import { guardProductionFirebase } from "../helpers/readOnlyApp.mjs";
import { createPdfFixture } from "../helpers/pdf-fixture.mjs";

const PROJECT_ID = "demo-dental-qa";
const STORAGE_BUCKET = `${PROJECT_ID}.firebasestorage.app`;
const STORAGE_ORIGIN = "http://127.0.0.1:9199";

async function createEmulatorUser(email, password) {
  const response = await fetch(
    "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-api-key",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true })
    }
  );
  const body = await response.json();
  expect(response.ok, JSON.stringify(body)).toBeTruthy();
  expect(body.localId).toBeTruthy();
  expect(body.idToken).toBeTruthy();
  return body;
}

async function signIn(page, email, password) {
  await page.locator("#tabBtnAuth").click();
  await page.locator("#emailInput").fill(email);
  await page.locator("#passwordInput").fill(password);
  await page.locator("#signInBtn").click();
  await expect(page.locator("#authStatus")).toContainText(email, { timeout: 20_000 });
  await expect(page.locator("#tabBtnPdf")).toBeVisible({ timeout: 20_000 });
}

async function openPdfEditor(page) {
  await page.locator("#tabBtnPdf").click();
  await page.locator("#pdfEditModeBtn").click();
  await expect(page.locator("#pdfEditView")).toBeVisible();
}

async function fillPdfMaterial(page, { title, fileName, buffer }) {
  await page.locator("#pdfTitleInput").fill(title);
  await page.locator("#pdfSubjectInput").fill("PDF変換E2E");
  await page.locator("#pdfCategoryInput").fill("PDF,変換");
  await page.locator("#pdfFileInput").setInputFiles({
    name: fileName,
    mimeType: "application/pdf",
    buffer
  });
  await expect(page.locator("#pdfFileOrderDescription"))
    .toContainText("PDFは文書内のページ順で登録します");
}

async function readStoredPdfMaterials(userId) {
  const testEnvironment = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      host: "127.0.0.1",
      port: 8080
    }
  });
  try {
    const db = testEnvironment.authenticatedContext(userId).firestore();
    const snapshot = await getDoc(doc(db, "users", userId, "app", "pdfMaterials"));
    return snapshot.exists() ? snapshot.data().pdfMaterials || [] : [];
  } finally {
    await testEnvironment.cleanup();
  }
}

function storageObjectUrl(path) {
  return `${STORAGE_ORIGIN}/v0/b/${STORAGE_BUCKET}/o/${encodeURIComponent(path)}?alt=media`;
}

test.describe("PDFから画像教材への変換", () => {
  test.describe.configure({ retries: 1 });

  test("@authenticated 実PDFをページ画像へ変換してUI・Firestore・Storageへ永続化する", async ({ page }) => {
    test.setTimeout(120_000);
    const blockedRequests = await guardProductionFirebase(page);
    const pageErrors = [];
    page.on("pageerror", error => pageErrors.push(error.message));

    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const email = `pdf-convert-${suffix}@example.test`;
    const password = "DentalPdf!123";
    const user = await createEmulatorUser(email, password);
    const pdf = await createPdfFixture({ pageCount: 2 });
    const fileName = "two-page-material.pdf";
    const title = "実PDF変換教材";

    await page.goto("/?firebaseEmulator=1", { waitUntil: "domcontentloaded" });
    await signIn(page, email, password);
    await openPdfEditor(page);
    await fillPdfMaterial(page, { title, fileName, buffer: pdf });
    await page.locator("#addPdfBtn").click();

    await expect(page.locator("#pdfEditStatus"))
      .toContainText("教材を追加しました", { timeout: 90_000 });
    await expect(page.locator("#pdfEditTableBody")).toContainText(title);
    await expect(page.locator("#pdfEditPreview img")).toHaveCount(2);
    await expect.poll(() => page.locator("#pdfEditPreview img").evaluateAll(
      images => images.map(image => image.alt)
    )).toEqual([
      "two-page-material_page_001.jpg",
      "two-page-material_page_002.jpg"
    ]);
    await expect.poll(() => page.locator("#pdfEditPreview img").evaluateAll(
      images => images.map(image => image.naturalWidth > 0)
    )).toEqual([true, true]);

    const storedMaterials = await readStoredPdfMaterials(user.localId);
    expect(storedMaterials).toHaveLength(1);
    const [stored] = storedMaterials;
    expect(stored).toMatchObject({
      title,
      sourceType: "pdf-converted",
      sourceName: fileName
    });
    expect(stored.pages).toHaveLength(2);
    expect(stored.pages.map(item => item.page)).toEqual([1, 2]);
    expect(stored.pages.map(item => item.imageName)).toEqual([
      "two-page-material_page_001.jpg",
      "two-page-material_page_002.jpg"
    ]);

    for (const storedPage of stored.pages) {
      expect(storedPage.imagePath).toContain(`users/${user.localId}/imageMaterials/`);
      const storageLocation = new URL(storedPage.imageUrl);
      expect(storageLocation.origin).toBe(STORAGE_ORIGIN);
      expect(storageLocation.pathname)
        .toMatch(/^\/v0\/b\/demo-dental-qa\.firebasestorage\.app\/o\//);
      const response = await page.request.get(storedPage.imageUrl, {
        headers: { Authorization: `Bearer ${user.idToken}` }
      });
      expect(response.status()).toBe(200);
      expect(response.headers()["content-type"]).toContain("image/jpeg");
    }

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("#authStatus")).toContainText(email, { timeout: 20_000 });
    await page.locator("#tabBtnPdf").click();
    await page.locator("#pdfStudyModeBtn").click();
    await expect(page.locator("#pdfTableBody")).toContainText(title);
    await expect(page.locator("#pdfViewerArea img")).toHaveCount(2);
    await expect.poll(() => page.locator("#pdfViewerArea img").evaluateAll(
      images => images.map(image => image.alt)
    )).toEqual([
      "two-page-material_page_001.jpg",
      "two-page-material_page_002.jpg"
    ]);

    expect(blockedRequests, "production Firebase requests must never be attempted").toEqual([]);
    expect(pageErrors, "unhandled browser errors").toEqual([]);
  });

  test("@authenticated PDFの中間ページでアップロードに失敗した場合は先行ページを削除する", async ({ page }) => {
    test.setTimeout(120_000);
    const blockedRequests = await guardProductionFirebase(page);
    const pageErrors = [];
    page.on("pageerror", error => pageErrors.push(error.message));

    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const email = `pdf-rollback-${suffix}@example.test`;
    const password = "DentalPdf!123";
    const user = await createEmulatorUser(email, password);
    const pdf = await createPdfFixture({ pageCount: 3 });
    const title = "失敗時に残らないPDF教材";

    await page.goto("/?firebaseEmulator=1", { waitUntil: "domcontentloaded" });
    await signIn(page, email, password);
    await openPdfEditor(page);

    const uploadPaths = [];
    const deletedPaths = [];
    await page.route(`**/v0/b/${STORAGE_BUCKET}/o**`, async route => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      if (["POST", "PUT"].includes(method) && url.searchParams.has("name")) {
        uploadPaths.push(url.searchParams.get("name"));
        if (uploadPaths.length === 2) {
          await route.fulfill({
            status: 403,
            contentType: "application/json",
            body: JSON.stringify({ error: { code: 403, message: "forced second-page failure" } })
          });
          return;
        }
      } else if (method === "DELETE") {
        const encodedPath = url.pathname.split("/o/")[1] || "";
        deletedPaths.push(decodeURIComponent(encodedPath));
      }
      await route.continue();
    });

    const dialogs = [];
    page.on("dialog", async dialog => {
      dialogs.push(dialog.message());
      await dialog.accept();
    });
    await fillPdfMaterial(page, {
      title,
      fileName: "rollback-three-page.pdf",
      buffer: pdf
    });
    await page.locator("#addPdfBtn").click();

    await expect(page.locator("#pdfEditStatus"))
      .toContainText("教材追加に失敗しました", { timeout: 90_000 });
    await expect.poll(() => dialogs.length).toBe(1);
    expect(dialogs[0]).toContain("教材追加に失敗しました");
    expect(uploadPaths).toHaveLength(2);
    expect(uploadPaths[0]).toContain(`users/${user.localId}/imageMaterials/`);
    expect(deletedPaths).toEqual([uploadPaths[0]]);
    await expect(page.locator("#pdfEditTableBody")).not.toContainText(title);

    const deletedObject = await page.request.get(storageObjectUrl(uploadPaths[0]), {
      headers: { Authorization: `Bearer ${user.idToken}` }
    });
    expect(deletedObject.status()).toBe(404);
    const storedMaterials = await readStoredPdfMaterials(user.localId);
    expect(storedMaterials).toEqual([]);

    expect(blockedRequests, "production Firebase requests must never be attempted").toEqual([]);
    expect(pageErrors, "unhandled browser errors").toEqual([]);
  });
});
