import { expect, test } from "@playwright/test";
import {
  createDiagnostics,
  expectNoRuntimeErrors,
  expectNoUnsafeFirebaseWrites,
  guardProductionFirebase,
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

test("invalid Emulator host fails closed without production Firebase fallback", async ({ page }) => {
  const productionFirebaseAttempts = await guardProductionFirebase(page);
  const dialogs = [];
  page.on("dialog", async dialog => {
    dialogs.push(dialog.message());
    await dialog.accept();
  });

  const response = await page.goto("/?firebaseEmulator=1&emulatorHost=8.8.8.8", {
    waitUntil: "domcontentloaded"
  });
  expect(response?.ok()).toBe(true);
  await expect(page.locator("#cloudStatus")).toContainText("本番Firebaseには接続していません", {
    timeout: 20_000
  });
  await expect(page.locator("#localEnvironmentBanner")).toBeHidden();
  expect(dialogs.some(message => message.includes("本番Firebaseには接続していません"))).toBe(true);
  expect(productionFirebaseAttempts).toEqual([]);

  const hostChecks = await page.evaluate(async () => {
    const { isFirebaseEmulatorEnabled } = await import("/js/config/firebase.js");
    return {
      localDefault: isFirebaseEmulatorEnabled({ hostname: "127.0.0.1", search: "?firebaseEmulator=1" }),
      lanDefault: isFirebaseEmulatorEnabled({ hostname: "192.168.1.126", search: "?firebaseEmulator=1" }),
      lanExplicit: isFirebaseEmulatorEnabled({ hostname: "192.168.1.126", search: "?firebaseEmulator=1&emulatorHost=192.168.1.126" }),
      lanMismatch: isFirebaseEmulatorEnabled({ hostname: "192.168.1.126", search: "?firebaseEmulator=1&emulatorHost=192.168.1.127" }),
      publicHost: isFirebaseEmulatorEnabled({ hostname: "example.com", search: "?firebaseEmulator=1" })
    };
  });
  expect(hostChecks).toEqual({
    localDefault: true,
    lanDefault: true,
    lanExplicit: true,
    lanMismatch: false,
    publicHost: false
  });
});

test("停止中のEmulatorは接続エラーとなり本番へフォールバックしない", async ({ page }) => {
  test.setTimeout(30_000);
  const productionFirebaseAttempts = await guardProductionFirebase(page);
  page.on("dialog", dialog => dialog.accept());
  await page.goto("/?firebaseEmulator=1", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#localEnvironmentStatus")).toContainText("接続エラー", { timeout: 20_000 });
  await expect(page.locator("#cloudStatus")).toContainText("Emulatorへ接続できません", { timeout: 20_000 });
  await expect(page.locator("#tabBtnStudy")).toBeHidden();
  await expect(page.locator("#tabBtnManage")).toBeHidden();
  await expect(page.locator("#tabBtnPdf")).toBeHidden();
  expect(productionFirebaseAttempts).toEqual([]);
});

test("Storage Emulatorだけが停止していても接続エラーとなり本番へフォールバックしない", async ({ page }) => {
  test.setTimeout(30_000);
  const productionFirebaseAttempts = await guardProductionFirebase(page);
  const storageRequests = [];

  for (const port of [9099, 8080]) {
    await page.route(`http://127.0.0.1:${port}/**`, route => route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, OPTIONS",
        "access-control-allow-headers": "*"
      },
      body: "{}"
    }));
  }
  await page.route("http://127.0.0.1:9199/**", async route => {
    storageRequests.push(route.request().url());
    await route.abort("connectionrefused");
  });
  page.on("dialog", dialog => dialog.accept());

  await page.goto("/?firebaseEmulator=1", { waitUntil: "domcontentloaded" });

  await expect(page.locator("#localEnvironmentStatus")).toHaveText(
    "Auth: 接続済み / Firestore: 接続済み / Storage: 接続エラー",
    { timeout: 20_000 }
  );
  await expect(page.locator("#cloudStatus")).toContainText("Storage Emulatorへ接続できません", {
    timeout: 20_000
  });
  await expect(page.locator("#tabBtnStudy")).toBeHidden();
  await expect(page.locator("#tabBtnManage")).toBeHidden();
  await expect(page.locator("#tabBtnPdf")).toBeHidden();
  expect(storageRequests).toHaveLength(3);
  expect(productionFirebaseAttempts).toEqual([]);
});
