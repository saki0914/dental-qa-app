import { expect, test } from "@playwright/test";
import { guardProductionFirebase } from "../helpers/readOnlyApp.mjs";

const TEST_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

async function waitForCloudSave(page) {
  const status = page.locator("#cloudStatus");
  await expect(status).toContainText(/クラウド保存を待機しています|クラウドへ保存中です/, { timeout: 5_000 });
  await expect(status).toContainText("クラウドに分離保存しました", { timeout: 20_000 });
}

async function addQuestion(page, { subject, question, answer, explanation, image = false }) {
  await page.locator("#editSubject").fill(subject);
  await page.locator("#editSubcategories").fill("E2E, Emulator");
  await page.locator("#editQuestion").fill(question);
  await page.locator("#editAnswers").fill(answer);
  await page.locator("#editExplanation").fill(explanation);
  if (image) {
    await page.locator("#editImageFile").setInputFiles({
      name: "question.png",
      mimeType: "image/png",
      buffer: TEST_PNG
    });
    await expect(page.locator("#imagePreview")).toBeVisible();
  }
  await page.locator("#addBtn").click();
  await expect(page.locator("#questionTableBody")).toContainText(question);
  await waitForCloudSave(page);
}

test("@authenticated Emulator上でログイン後の問題CRUDと画像暗記を永続化する", async ({ page }) => {
  const blockedRequests = await guardProductionFirebase(page);
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));

  const email = `e2e-${Date.now()}-${Math.random().toString(16).slice(2)}@example.test`;
  const password = "DentalE2E!123";

  const response = await page.goto("/?firebaseEmulator=1", { waitUntil: "domcontentloaded" });
  expect(response?.ok()).toBeTruthy();
  await expect(page.locator("#authStatus")).toContainText("未ログイン", { timeout: 20_000 });

  await page.locator("#emailInput").fill(email);
  await page.locator("#passwordInput").fill(password);
  await page.locator("#passwordConfirmInput").fill(password);
  await page.locator("#signUpBtn").click();
  await expect(page.locator("#authStatus")).toContainText(email, { timeout: 20_000 });
  await expect(page.locator("#tabBtnManage")).toBeVisible();

  await page.locator("#tabBtnAuth").click();
  await page.locator("#signOutBtn").click();
  await expect(page.locator("#authStatus")).toContainText("未ログイン");
  await page.locator("#emailInput").fill(email);
  await page.locator("#passwordInput").fill(password);
  await page.locator("#signInBtn").click();
  await expect(page.locator("#authStatus")).toContainText(email, { timeout: 20_000 });

  await page.locator("#tabBtnManage").click();
  await addQuestion(page, {
    subject: "E2E歯科学",
    question: "更新前の画像付き問題",
    answer: "エミュレータ",
    explanation: "本番Firebaseへ接続せず検証する",
    image: true
  });

  await page.locator("#editQuestion").fill("更新後の画像付き問題");
  await page.locator("#updateBtn").click();
  await expect(page.locator("#questionTableBody")).toContainText("更新後の画像付き問題");
  await expect(page.locator("#questionTableBody")).not.toContainText("更新前の画像付き問題");
  await waitForCloudSave(page);

  await page.locator("#clearFormBtn").click();
  await addQuestion(page, {
    subject: "E2E歯科学",
    question: "削除確認用の問題",
    answer: "削除",
    explanation: "CRUDのDを確認する"
  });

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#authStatus")).toContainText(email, { timeout: 20_000 });
  await page.locator("#tabBtnManage").click();
  await expect(page.locator("#questionTableBody")).toContainText("更新後の画像付き問題");
  await expect(page.locator("#questionTableBody")).toContainText("削除確認用の問題");

  await page.locator("#tabBtnStudy").click();
  const questionImage = page.locator("#questionImage");
  await expect(questionImage).toBeVisible();
  await expect.poll(() => questionImage.evaluate(image => image.naturalWidth)).toBeGreaterThan(0);

  await page.locator("#tabBtnManage").click();
  const deleteTarget = page.locator('[data-manage-row]:has-text("削除確認用の問題")');
  await deleteTarget.locator("[data-delete-question]").check();
  page.once("dialog", dialog => dialog.accept());
  await page.locator("#manageDeleteCheckedBtn").click();
  await expect(page.locator("#questionTableBody")).not.toContainText("削除確認用の問題");
  await waitForCloudSave(page);

  await page.locator("#tabBtnPdf").click();
  await page.locator("#pdfTitleInput").fill("E2E画像教材");
  await page.locator("#pdfFileInput").setInputFiles({
    name: "material.png",
    mimeType: "image/png",
    buffer: TEST_PNG
  });
  await page.locator("#addPdfBtn").click();
  await expect(page.locator("#pdfTableBody")).toContainText("E2E画像教材", { timeout: 20_000 });

  const materialImage = page.locator("#pdfViewerArea img");
  await expect(materialImage).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => materialImage.evaluate(image => image.naturalWidth)).toBeGreaterThan(0);

  await page.locator("#addMaskModeBtn").click();
  const pageWrap = page.locator(".pdf-page-wrap").first();
  await pageWrap.scrollIntoViewIfNeeded();
  const box = await pageWrap.boundingBox();
  expect(box).not.toBeNull();
  const pointer = {
    pointerType: "mouse",
    pointerId: 1,
    button: 0
  };
  await pageWrap.dispatchEvent("pointerdown", {
    ...pointer,
    clientX: box.x + box.width * 0.2,
    clientY: box.y + box.height * 0.2
  });
  await pageWrap.dispatchEvent("pointermove", {
    ...pointer,
    clientX: box.x + box.width * 0.6,
    clientY: box.y + box.height * 0.5
  });
  await pageWrap.dispatchEvent("pointerup", {
    ...pointer,
    clientX: box.x + box.width * 0.6,
    clientY: box.y + box.height * 0.5
  });
  await expect(page.locator("#pdfMaskTableBody tr[data-mask-id]")).toHaveCount(1);
  await waitForCloudSave(page);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#authStatus")).toContainText(email, { timeout: 20_000 });
  await page.locator("#tabBtnManage").click();
  await expect(page.locator("#questionTableBody")).not.toContainText("削除確認用の問題");
  await page.locator("#tabBtnPdf").click();
  await expect(page.locator("#pdfTableBody")).toContainText("E2E画像教材");
  await expect(page.locator("#pdfMaskTableBody tr[data-mask-id]")).toHaveCount(1);
  await expect(page.locator("#pdfViewerArea img")).toBeVisible({ timeout: 20_000 });

  page.once("dialog", dialog => dialog.accept());
  await page.locator("#deletePdfBtn").click();
  await expect(page.locator("#pdfTableBody")).not.toContainText("E2E画像教材");
  await expect(page.locator("#pdfStatus")).toContainText("画像教材を削除しました");
  await waitForCloudSave(page);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#authStatus")).toContainText(email, { timeout: 20_000 });
  await page.locator("#tabBtnPdf").click();
  await expect(page.locator("#pdfTableBody")).not.toContainText("E2E画像教材");

  expect(blockedRequests, "production Firebase requests must never be attempted").toEqual([]);
  expect(pageErrors, "unhandled browser errors").toEqual([]);
});
