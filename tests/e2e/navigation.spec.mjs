import { expect, test } from "@playwright/test";
import {
  createDiagnostics,
  expectNoRuntimeErrors,
  expectNoUnsafeFirebaseWrites,
  openApp
} from "../helpers/readOnlyApp.mjs";

test("unauthenticated navigation remains on the login surface", async ({ page }) => {
  const diagnostics = createDiagnostics(page);
  await openApp(page);

  await expect(page.locator("#tabBtnAuth")).toHaveClass(/active/);
  await expect(page.locator("#tab-auth")).toBeVisible();
  await page.locator("#tabBtnAuth").click();
  await expect(page.locator("#tab-auth")).toBeVisible();

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#tab-auth")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#authStatus")).toContainText("未ログイン");
  await expect(page.locator("#tabBtnStudy")).toBeHidden();
  await expect(page.locator("#tabBtnManage")).toBeHidden();
  await expect(page.locator("#tabBtnProgress")).toBeHidden();
  await expect(page.locator("#tabBtnPdf")).toBeHidden();

  expect(diagnostics.mutatingRequests, "safe unauthenticated navigation should not trigger mutating requests").toEqual([]);
  await expectNoRuntimeErrors(diagnostics);
  await expectNoUnsafeFirebaseWrites(diagnostics);
});
