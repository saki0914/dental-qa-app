import { expect, test } from "@playwright/test";
import {
  createDiagnostics,
  expectNoResourceErrors,
  expectNoRuntimeErrors,
  expectNoUnsafeFirebaseWrites,
  openApp
} from "../helpers/readOnlyApp.mjs";

test("top page loads and exposes the current unauthenticated UI", async ({ page }) => {
  const diagnostics = createDiagnostics(page);
  const response = await openApp(page);

  expect(response.ok()).toBe(true);
  await expect(page).toHaveTitle(/\S/);
  await expect(page.locator(".wrap")).toBeVisible();
  await expect(page.locator("#tab-auth")).toBeVisible();
  await expect(page.locator("#authStatus")).toContainText("未ログイン");
  await expect(page.locator("#emailInput")).toBeVisible();
  await expect(page.locator("#passwordInput")).toBeVisible();

  await expect(page.locator("#tab-study")).toHaveCount(1);
  await expect(page.locator("#tab-manage")).toHaveCount(1);
  await expect(page.locator("#tab-progress")).toHaveCount(1);
  await expect(page.locator("#tab-pdf")).toHaveCount(1);

  await expect(page.locator("#tab-study")).toBeHidden();
  await expect(page.locator("#tab-manage")).toBeHidden();
  await expect(page.locator("#tab-progress")).toBeHidden();
  await expect(page.locator("#tab-pdf")).toBeHidden();

  await expectNoRuntimeErrors(diagnostics);
  await expectNoResourceErrors(diagnostics);
  await expectNoUnsafeFirebaseWrites(diagnostics);
});
