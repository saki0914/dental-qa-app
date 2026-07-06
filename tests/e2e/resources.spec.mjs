import { expect, test } from "@playwright/test";
import {
  createDiagnostics,
  expectNoResourceErrors,
  expectNoRuntimeErrors,
  expectNoUnsafeFirebaseWrites,
  openApp
} from "../helpers/readOnlyApp.mjs";

test("critical page resources load without HTTP or network failures", async ({ page }) => {
  const diagnostics = createDiagnostics(page);
  await openApp(page);

  const hosts = [...diagnostics.externalHosts].sort();
  expect(hosts, "Firebase SDK host should be contacted for module imports").toContain("www.gstatic.com");
  await expectNoRuntimeErrors(diagnostics);
  await expectNoResourceErrors(diagnostics);
  await expectNoUnsafeFirebaseWrites(diagnostics);
});
