import { expect, test } from "@playwright/test";
import { guardProductionFirebase } from "../helpers/readOnlyApp.mjs";

const TEST_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

async function waitForCloudSave(page) {
  const status = page.locator("#cloudStatus");
  await page.waitForTimeout(800);
  await expect(status).toContainText("クラウドに分離保存しました", { timeout: 20_000 });
}

async function captureVisualPair(page, name) {
  if (!process.env.VISUAL_QA) return;
  await page.screenshot({ path: `test-results/visual-${name}-desktop.png`, fullPage: false });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `test-results/visual-${name}-mobile.png`, fullPage: false });
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function createEmulatorUser(email, password) {
  const response = await fetch(
    "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-api-key",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true })
    }
  );
  expect(response.ok, await response.text()).toBeTruthy();
}

async function addQuestion(page, { subject, subcategories, question, answer, explanation, image = false }) {
  await page.locator("#editSubject").fill(subject);
  await page.locator("#editSubcategories").fill(subcategories.join(", "));
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
  test.setTimeout(90_000);
  const blockedRequests = await guardProductionFirebase(page);
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));

  const email = `e2e-${Date.now()}-${Math.random().toString(16).slice(2)}@example.test`;
  const password = "DentalE2E!123";
  await createEmulatorUser(email, password);

  const response = await page.goto("/?firebaseEmulator=1", { waitUntil: "domcontentloaded" });
  expect(response?.ok()).toBeTruthy();
  await expect(page.locator("#authStatus")).toContainText("未ログイン", { timeout: 20_000 });

  await page.locator("#emailInput").fill(email);
  await page.locator("#passwordInput").fill(password);
  await expect(page.locator("#signUpBtn")).toHaveCount(0);
  await page.locator("#signInBtn").click();
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
    subcategories: ["E2E", "Emulator", "画像"],
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
    subcategories: ["E2E", "Emulator", "削除"],
    question: "削除確認用の問題",
    answer: "削除",
    explanation: "CRUDのDを確認する"
  });

  await page.locator("#bulkImportFile").setInputFiles({
    name: "questions.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify([
      {
        subject: "E2E歯科学",
        subcategories: ["E2E", "Emulator", "一括"],
        question: "一括登録した画像付き問題",
        answers: ["一括画像"],
        explanation: "JSONと画像を同時に保存する",
        imageFile: "bulk-question.png"
      },
      {
        subject: "E2E補綴学",
        subcategories: ["別章", "横断"],
        question: "教科と章をまたぐ問題",
        answers: ["横断選択"],
        explanation: "複数教科・複数章の選択を確認する"
      }
    ]))
  });
  await page.locator("#bulkImportImageFiles").setInputFiles({
    name: "bulk-question.png",
    mimeType: "image/png",
    buffer: TEST_PNG
  });
  page.on("dialog", dialog => dialog.accept());
  await page.locator("#bulkImportExecuteBtn").click();
  await expect(page.locator("#bulkImportStatus")).toContainText("一括追加・保存完了", { timeout: 20_000 });
  page.removeAllListeners("dialog");
  await expect(page.locator("#questionTableBody")).toContainText("一括登録した画像付き問題");

  await page.locator("#manageFullscreenBtn").click();
  await expect(page.locator("#tab-manage")).toHaveClass(/is-manage-fullscreen/);
  await expect(page.locator("body")).toHaveClass(/has-modal-surface/);
  await captureVisualPair(page, "manage-fullscreen");
  await page.locator("#manageFullscreenBtn").click();
  await expect(page.locator("#tab-manage")).not.toHaveClass(/is-manage-fullscreen/);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#authStatus")).toContainText(email, { timeout: 20_000 });
  await page.locator("#tabBtnManage").click();
  await expect(page.locator("#questionTableBody")).toContainText("更新後の画像付き問題");
  await expect(page.locator("#questionTableBody")).toContainText("削除確認用の問題");
  await expect(page.locator("#questionTableBody")).toContainText("一括登録した画像付き問題");
  await expect(page.locator("#questionTableBody")).toContainText("教科と章をまたぐ問題");

  await page.locator('[data-manage-row]:has-text("一括登録した画像付き問題")').click();
  await expect(page.locator("#imagePreview")).toBeVisible();
  await expect.poll(() => page.locator("#imagePreview").evaluate(image => image.naturalWidth)).toBeGreaterThan(0);

  await page.locator("#tabBtnStudy").click();
  await page.locator("#subjectFilter").selectOption({ label: "E2E歯科学" });
  await page.locator("#primarySubcategorySelect").selectOption({ label: "E2E" });
  await expect(page.locator("#totalCount")).toHaveText("3");
  await page.locator('#relatedSubcategoryChecklist input[value="Emulator"]').check();
  await page.locator('#relatedSubcategoryChecklist input[value="画像"]').check();
  await expect(page.locator("#totalCount")).toHaveText("1");
  await page.locator('#relatedSubcategoryChecklist input[value="削除"]').check();
  await expect(page.locator("#totalCount")).toHaveText("0");
  await expect(page.locator("#question")).toContainText("条件に合う問題がありません");
  await expect(page.locator('#relatedSubcategoryChecklist input[value="画像"]')).toBeChecked();
  await expect(page.locator('#relatedSubcategoryChecklist input[value="削除"]')).toBeChecked();
  await page.locator('#relatedSubcategoryChecklist input[value="削除"]').uncheck();
  await expect(page.locator("#totalCount")).toHaveText("1");
  await page.locator('#relatedSubcategoryChecklist input[value="Emulator"]').uncheck();
  await page.locator('#relatedSubcategoryChecklist input[value="画像"]').uncheck();
  await expect(page.locator("#totalCount")).toHaveText("3");
  await page.locator("#addConditionGroupBtn").click();
  await expect(page.locator("#conditionGroupList .condition-group-card")).toHaveCount(1);
  await page.locator("#subjectFilter").selectOption({ label: "E2E補綴学" });
  await page.locator("#primarySubcategorySelect").selectOption({ label: "別章" });
  await page.locator("#addConditionGroupBtn").click();
  await expect(page.locator("#conditionGroupList .condition-group-card")).toHaveCount(2);
  await expect(page.locator("#conditionGroupList")).toContainText("E2E歯科学");
  await expect(page.locator("#conditionGroupList")).toContainText("E2E補綴学");
  await expect(page.locator("#totalCount")).toHaveText("4");
  await page.locator("#conditionGroupList .condition-group-remove").last().click();
  await expect(page.locator("#conditionGroupList .condition-group-card")).toHaveCount(1);
  await expect(page.locator("#totalCount")).toHaveText("3");
  await page.locator("#primarySubcategorySelect").selectOption({ label: "別章" });
  await page.locator("#addConditionGroupBtn").click();
  await expect(page.locator("#conditionGroupList .condition-group-card")).toHaveCount(2);
  await expect(page.locator("#totalCount")).toHaveText("4");
  await captureVisualPair(page, "study-filter");
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
  await expect(page.locator("#pdfStudyView")).toBeVisible();
  await expect(page.locator("#pdfEditView")).toBeHidden();
  await expect(page.locator("#pdfTitleInput")).toBeHidden();
  await page.locator("#pdfEditModeBtn").click();
  await expect(page.locator("#pdfEditView")).toBeVisible();
  await expect(page.locator("#pdfMaskManagementPanel")).toBeHidden();
  await page.locator("#pdfTitleInput").fill("E2E画像教材");
  await page.locator("#pdfSubjectInput").fill("E2E歯科学");
  await page.locator("#pdfCategoryInput").fill("E2E,画像暗記");
  await page.locator("#pdfFileInput").setInputFiles({
    name: "material.png",
    mimeType: "image/png",
    buffer: TEST_PNG
  });
  await page.locator("#addPdfBtn").click();
  await expect(page.locator("#pdfEditStatus")).toContainText("教材を追加しました", { timeout: 20_000 });
  await expect(page.locator("#pdfEditTableBody")).toContainText("E2E画像教材");
  await expect(page.locator("#pdfEditPreview img")).toBeVisible({ timeout: 20_000 });

  await page.locator("#clearPdfEditorBtn").click();
  await expect(page.locator("#pdfTitleInput")).toHaveValue("");
  await expect(page.locator("#pdfEditPreview")).toContainText("編集する画像教材を選択してください");
  await page.locator("#pdfTitleInput").fill("E2E別教科教材");
  await page.locator("#pdfSubjectInput").fill("E2E補綴学");
  await page.locator("#pdfCategoryInput").fill("別章");
  await page.locator("#pdfFileInput").setInputFiles({
    name: "material-other.png",
    mimeType: "image/png",
    buffer: TEST_PNG
  });
  await page.locator("#addPdfBtn").click();
  await expect(page.locator("#pdfEditStatus")).toContainText("教材を追加しました", { timeout: 20_000 });
  await expect(page.locator("#pdfEditTableBody")).toContainText("E2E別教科教材");

  const firstMaterialEditRow = page.locator('#pdfEditTableBody tr:has-text("E2E画像教材")');
  await firstMaterialEditRow.locator("[data-edit-pdf]").click();
  await expect(firstMaterialEditRow.locator("[data-delete-pdf]")).toBeDisabled();
  await expect(firstMaterialEditRow.locator("[data-edit-pdf]")).toHaveText("更新対象");
  await page.locator("#pdfTitleInput").fill("E2E画像教材更新");
  await page.locator("#pdfFileInput").setInputFiles({
    name: "material-updated.png",
    mimeType: "image/png",
    buffer: TEST_PNG
  });
  await page.locator("#updatePdfBtn").click();
  await expect(page.locator("#pdfEditStatus")).toContainText("教材情報と画像を更新しました", { timeout: 20_000 });
  await expect(page.locator("#pdfEditTableBody")).toContainText("E2E画像教材更新");
  await captureVisualPair(page, "image-memory-edit");

  await page.locator("#pdfStudyModeBtn").click();
  await expect(page.locator("#pdfStudyView")).toBeVisible();
  await expect(page.locator("#pdfEditView")).toBeHidden();
  await expect(page.locator("#pdfSubjectFilterSelect")).toContainText("E2E歯科学");
  await page.locator("#pdfSubjectFilterSelect").selectOption("E2E歯科学");
  await expect(page.locator("#pdfCategoryFilterSelect")).toContainText("E2E");
  await expect(page.locator("#pdfCategoryFilterSelect")).toContainText("画像暗記");
  await expect(page.locator("#pdfCategoryFilterSelect")).not.toContainText("別章");
  await expect(page.locator("#tab-pdf .subcat-chip")).toHaveCount(0);
  await page.locator("#pdfCategoryFilterSelect").selectOption("E2E");
  await expect(page.locator("#pdfTableBody")).toContainText("E2E画像教材更新");
  await expect(page.locator("#pdfTableBody")).not.toContainText("E2E別教科教材");
  await expect(page.locator("#pdfTableBody tr.selected")).toContainText("E2E画像教材更新");

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
  await page.locator("#addMaskModeBtn").click();
  await page.locator("#markWeakMaskBtn").click();
  await expect(page.locator("#pdfMaskTableBody")).toContainText("苦手");
  await expect(page.locator(".pdf-mask")).toHaveClass(/is-weak/);
  const touchAction = await page.locator(".pdf-page-wrap").evaluate(node => getComputedStyle(node).touchAction);
  expect(touchAction).toContain("pan-x");
  await captureVisualPair(page, "image-memory-study");

  const zoomBox = await pageWrap.boundingBox();
  const zoomFocus = {
    x: zoomBox.x + zoomBox.width * 0.55,
    y: zoomBox.y + zoomBox.height * 0.55
  };
  const zoomAnchor = await pageWrap.evaluate((node, focus) => {
    const rect = node.getBoundingClientRect();
    return {
      xRatio: (focus.x - rect.left) / rect.width,
      yRatio: (focus.y - rect.top) / rect.height,
      width: rect.width
    };
  }, zoomFocus);
  for (let index = 0; index < 5; index += 1) {
    await page.locator("#pdfViewerArea").dispatchEvent("wheel", {
      clientX: zoomFocus.x,
      clientY: zoomFocus.y,
      ctrlKey: true,
      deltaY: -100
    });
  }
  const zoomResult = await pageWrap.evaluate((node, anchor) => {
    const rect = node.getBoundingClientRect();
    return {
      anchorX: rect.left + rect.width * anchor.xRatio,
      anchorY: rect.top + rect.height * anchor.yRatio,
      width: rect.width
    };
  }, zoomAnchor);
  expect(zoomResult.width).toBeGreaterThan(zoomAnchor.width);
  expect(Math.abs(zoomResult.anchorX - zoomFocus.x)).toBeLessThan(4);
  expect(Math.abs(zoomResult.anchorY - zoomFocus.y)).toBeLessThan(4);
  await waitForCloudSave(page);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#authStatus")).toContainText(email, { timeout: 20_000 });
  await page.locator("#tabBtnManage").click();
  await expect(page.locator("#questionTableBody")).not.toContainText("削除確認用の問題");
  await page.locator("#tabBtnStudy").click();
  await expect(page.locator("#conditionGroupList .condition-group-card")).toHaveCount(2);
  await expect(page.locator("#totalCount")).toHaveText("3");
  await page.locator("#tabBtnPdf").click();
  await expect(page.locator("#pdfStudyView")).toBeVisible();
  await expect(page.locator("#pdfSubjectFilterSelect")).toHaveValue("E2E歯科学");
  await expect(page.locator("#pdfCategoryFilterSelect")).toHaveValue("E2E");
  await expect(page.locator("#pdfTableBody")).toContainText("E2E画像教材更新");
  await expect(page.locator("#pdfMaskTableBody tr[data-mask-id]")).toHaveCount(1);
  await expect(page.locator("#pdfMaskTableBody")).toContainText("苦手");
  await expect(page.locator(".pdf-mask")).toHaveClass(/is-weak/);
  await expect(page.locator("#pdfViewerArea img")).toBeVisible({ timeout: 20_000 });

  await page.locator("#pdfEditModeBtn").click();
  const firstDeleteRow = page.locator('#pdfEditTableBody tr:has-text("E2E画像教材更新")');
  const secondDeleteRow = page.locator('#pdfEditTableBody tr:has-text("E2E別教科教材")');
  await firstDeleteRow.locator("[data-delete-pdf]").check();
  await secondDeleteRow.locator("[data-delete-pdf]").check();
  await expect(page.locator("#pdfDeleteCheckedBtn")).toContainText("2件");
  page.once("dialog", dialog => dialog.accept());
  await page.locator("#pdfDeleteCheckedBtn").click();
  await expect(page.locator("#pdfEditTableBody")).not.toContainText("E2E画像教材更新");
  await expect(page.locator("#pdfEditTableBody")).not.toContainText("E2E別教科教材");
  await expect(page.locator("#pdfEditStatus")).toContainText("2件の画像教材を削除しました", { timeout: 20_000 });

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#authStatus")).toContainText(email, { timeout: 20_000 });
  await page.locator("#tabBtnPdf").click();
  await page.locator("#pdfStudyModeBtn").click();
  await expect(page.locator("#pdfTableBody")).not.toContainText("E2E画像教材更新");
  await expect(page.locator("#pdfTableBody")).not.toContainText("E2E別教科教材");

  expect(blockedRequests, "production Firebase requests must never be attempted").toEqual([]);
  expect(pageErrors, "unhandled browser errors").toEqual([]);
});
