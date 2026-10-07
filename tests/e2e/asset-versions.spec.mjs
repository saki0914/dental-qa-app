import { expect, test } from "@playwright/test";
import { createDiagnostics, expectNoResourceErrors, expectNoRuntimeErrors, openApp } from "../helpers/readOnlyApp.mjs";

// Revision 13: every JS module and style sheet is requested by a URL with the
// version of its content (index.html's import map), so that a release is never
// served from a browser's cache.
test("JSとCSSは内容の版付きURLで読み込み、同じモジュールを二重に読み込まない", async ({ page }) => {
  const diagnostics = createDiagnostics(page);
  const requests = [];
  page.on("request", request => requests.push(request.url()));
  await openApp(page);
  await page.waitForLoadState("load");
  const build = await page.locator('meta[name="app-build"]').getAttribute("content");
  expect(build).toMatch(/^[0-9a-f]{10}$/);
  const origin = new URL(page.url()).origin;
  const own = requests.filter(url => new URL(url).origin === origin);
  const scripts = own.filter(url => /\/js\/.+\.js(\?|$)/.test(new URL(url).pathname + new URL(url).search));
  expect(scripts.length, "アプリのモジュールを読み込んだ").toBeGreaterThan(20);
  expect(scripts.filter(url => !/\?v=[0-9a-f]{10}$/.test(url)), "版の付かないJSの要求がない").toEqual([]);
  const paths = scripts.map(url => new URL(url).pathname);
  expect(paths.length - new Set(paths).size, "同じモジュールを別のURLで二重に読み込まない").toBe(0);
  expect(paths).toContain("/js/features/study-notes.js");
  const styles = own.filter(url => new URL(url).pathname.endsWith(".css"));
  expect(styles.length).toBe(2);
  expect(styles.filter(url => !/\?v=[0-9a-f]{10}$/.test(url))).toEqual([]);
  await expectNoRuntimeErrors(diagnostics);
  await expectNoResourceErrors(diagnostics);
});
