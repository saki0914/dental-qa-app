import { expect, test } from "@playwright/test";
import {
  createDiagnostics,
  expectHiddenOrDisabled,
  expectReadOnlyClean,
  openApp
} from "../helpers/readOnlyApp.mjs";

const dangerousControls = [
  ["#addBtn", "question add button"],
  ["#updateBtn", "question update button"],
  ["#removeImageBtn", "question image remove button"],
  ["#bulkImportExecuteBtn", "bulk import execute button"],
  ["#manageDeleteCheckedBtn", "question bulk delete button"],
  ["#addPdfBtn", "image material add button"],
  ["#updatePdfBtn", "image material update button"],
  ["#deletePdfBtn", "image material delete button"],
  ["#addMaskModeBtn", "mask add mode button"],
  ["#updateMaskBtn", "mask update button"],
  ["#deleteMaskBtn", "mask delete button"],
  ["#resetProgressBtn", "progress reset button"],
  ["#resetPdfRevealBtn", "image material reveal reset button"]
];

test("dangerous controls are not actionable before login", async ({ page }) => {
  const diagnostics = createDiagnostics(page);
  await openApp(page);

  await expect(page.locator("#tabBtnAuth")).toBeVisible();
  await expect(page.locator("#tabBtnStudy")).toBeHidden();
  await expect(page.locator("#tabBtnManage")).toBeHidden();
  await expect(page.locator("#tabBtnProgress")).toBeHidden();
  await expect(page.locator("#tabBtnPdf")).toBeHidden();

  await expect(page.locator("#tab-manage")).toBeHidden();
  await expect(page.locator("#tab-progress")).toBeHidden();
  await expect(page.locator("#tab-pdf")).toBeHidden();

  for (const [selector, description] of dangerousControls) {
    await expectHiddenOrDisabled(page.locator(selector), description);
  }

  expect(diagnostics.mutatingRequests, "no mutating requests should be triggered by auth guard checks").toEqual([]);
  await expectReadOnlyClean(diagnostics);
});
