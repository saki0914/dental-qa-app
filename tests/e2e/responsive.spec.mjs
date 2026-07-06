import { expect, test } from "@playwright/test";
import {
  createDiagnostics,
  expectElementIntersectsViewport,
  expectNoBodyHorizontalOverflow,
  expectNoRuntimeErrors,
  expectNoUnsafeFirebaseWrites,
  expectVisibleElementsWithinViewport,
  openApp
} from "../helpers/readOnlyApp.mjs";

const viewports = [
  { name: "iPhone", width: 390, height: 844 },
  { name: "iPad portrait", width: 768, height: 1024 },
  { name: "iPad landscape", width: 1024, height: 768 },
  { name: "desktop", width: 1440, height: 900 }
];

for (const viewport of viewports) {
  test("initial unauthenticated layout fits " + viewport.name + " " + viewport.width + "x" + viewport.height, async ({ page }) => {
    const diagnostics = createDiagnostics(page);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openApp(page);

    await expectNoBodyHorizontalOverflow(page);
    await expectElementIntersectsViewport(page.locator("#tabBtnAuth"), "auth tab");
    await expectElementIntersectsViewport(page.locator("#emailInput"), "email input");
    await expectElementIntersectsViewport(page.locator("#passwordInput"), "password input");
    await expectVisibleElementsWithinViewport(page, ".tabs, .study-actions.is-floating, .pdf-mask-compact-actions", "initial navigation and fixed controls");

    const visibleInputsOutsideViewport = await page.locator("#tab-auth input").evaluateAll(elements => {
      return elements
        .filter(element => {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        })
        .filter(element => {
          const rect = element.getBoundingClientRect();
          return rect.left < -2 || rect.right > window.innerWidth + 2;
        })
        .map(element => element.id);
    });
    expect(visibleInputsOutsideViewport, "login inputs should not overflow horizontally").toEqual([]);

    await expectNoRuntimeErrors(diagnostics);
    await expectNoUnsafeFirebaseWrites(diagnostics);
  });
}
