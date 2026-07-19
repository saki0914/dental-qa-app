import { expect } from "@playwright/test";

const SECRET_PATTERNS = [
  /AIza[0-9A-Za-z_-]{20,}/g,
  /([?&](?:key|token|auth|access_token|id_token|password|email)=)[^&#]+/gi
];

const PRODUCTION_FIREBASE_HOSTS = new Set([
  "identitytoolkit.googleapis.com",
  "securetoken.googleapis.com",
  "firebaseinstallations.googleapis.com",
  "firestore.googleapis.com",
  "firebasestorage.googleapis.com",
  "storage.googleapis.com"
]);
const productionFirebaseAttemptsByPage = new WeakMap();
const guardedPages = new WeakSet();

function getProductionFirebaseAttempts(page) {
  if (!productionFirebaseAttemptsByPage.has(page)) {
    productionFirebaseAttemptsByPage.set(page, []);
  }
  return productionFirebaseAttemptsByPage.get(page);
}

export async function guardProductionFirebase(page) {
  const attempts = getProductionFirebaseAttempts(page);
  if (guardedPages.has(page)) return attempts;

  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    const isProductionProject = url.href.includes("dental-qa-hub-e7cce");
    if (PRODUCTION_FIREBASE_HOSTS.has(url.hostname) || isProductionProject) {
      attempts.push(`${route.request().method()} ${url.origin}${url.pathname}`);
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });

  guardedPages.add(page);
  return attempts;
}

export function sanitizeText(value) {
  let text = String(value ?? "");
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, (match, prefix) => prefix ? prefix + "[REDACTED]" : "[REDACTED]");
  }
  return text;
}

export function sanitizeUrl(value) {
  try {
    const url = new URL(String(value));
    for (const key of [...url.searchParams.keys()]) {
      if (/key|token|auth|password|email/i.test(key)) {
        url.searchParams.set(key, "[REDACTED]");
      }
    }
    return sanitizeText(url.toString());
  } catch {
    return sanitizeText(value);
  }
}

function isOptionalBrowserRequest(url) {
  try {
    return new URL(url).pathname === "/favicon.ico";
  } catch {
    return false;
  }
}

function isUnsafeFirebaseWrite(url, method) {
  const upperMethod = method.toUpperCase();
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(upperMethod)) return false;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }

  const host = parsed.hostname;
  const path = parsed.pathname;

  if (/firestore\.googleapis\.com$/.test(host)) {
    return /:commit$|:batchWrite$|:write$|\/documents\/|\/Write\/channel/i.test(path);
  }

  if (/firebasestorage\.googleapis\.com$|storage\.googleapis\.com$/.test(host)) {
    return upperMethod !== "GET" && upperMethod !== "HEAD" && upperMethod !== "OPTIONS";
  }

  if (/identitytoolkit\.googleapis\.com$/.test(host)) {
    return /signUp|deleteAccount|setAccountInfo|update|sendOobCode|resetPassword/i.test(path);
  }

  return false;
}

export function createDiagnostics(page) {
  const diagnostics = {
    pageErrors: [],
    consoleErrors: [],
    failedRequests: [],
    badResponses: [],
    unsafeFirebaseWrites: [],
    mutatingRequests: [],
    externalHosts: new Set(),
    productionFirebaseAttempts: getProductionFirebaseAttempts(page)
  };

  page.on("pageerror", error => {
    diagnostics.pageErrors.push(sanitizeText(error.stack || error.message || error));
  });

  page.on("console", message => {
    if (message.type() === "error") {
      const location = message.location();
      diagnostics.consoleErrors.push({
        text: sanitizeText(message.text()),
        url: sanitizeUrl(location.url || ""),
        lineNumber: location.lineNumber,
        columnNumber: location.columnNumber
      });
    }
  });

  page.on("request", request => {
    const requestUrl = request.url();
    const method = request.method().toUpperCase();
    try {
      const parsed = new URL(requestUrl);
      if (!/^127\.0\.0\.1$|^localhost$/.test(parsed.hostname)) {
        diagnostics.externalHosts.add(parsed.hostname);
      }
    } catch {
      // Keep malformed URLs out of reports except through request failure handling.
    }

    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      const entry = { method, url: sanitizeUrl(requestUrl), resourceType: request.resourceType() };
      diagnostics.mutatingRequests.push(entry);
      if (isUnsafeFirebaseWrite(requestUrl, method)) diagnostics.unsafeFirebaseWrites.push(entry);
    }
  });

  page.on("requestfailed", request => {
    const requestUrl = request.url();
    if (isOptionalBrowserRequest(requestUrl)) return;
    diagnostics.failedRequests.push({
      method: request.method(),
      url: sanitizeUrl(requestUrl),
      resourceType: request.resourceType(),
      failure: sanitizeText(request.failure()?.errorText || "unknown")
    });
  });

  page.on("response", response => {
    const request = response.request();
    const requestUrl = response.url();
    if (isOptionalBrowserRequest(requestUrl)) return;
    if (response.status() >= 400) {
      diagnostics.badResponses.push({
        status: response.status(),
        method: request.method(),
        url: sanitizeUrl(requestUrl),
        resourceType: request.resourceType()
      });
    }
  });

  return diagnostics;
}

export async function openApp(page) {
  await guardProductionFirebase(page);
  const response = await page.goto("/", { waitUntil: "domcontentloaded" });
  expect(response, "top page should return a response").not.toBeNull();
  expect(response.ok(), "top page HTTP status " + response.status()).toBeTruthy();
  await expect(page.locator("#tab-auth"), "auth screen should become visible after initialization").toBeVisible({ timeout: 20_000 });
  return response;
}

export async function expectNoRuntimeErrors(diagnostics) {
  expect(diagnostics.pageErrors, "unhandled pageerror").toEqual([]);
  expect(diagnostics.consoleErrors, "console.error messages").toEqual([]);
}

export async function expectNoResourceErrors(diagnostics) {
  expect(diagnostics.failedRequests, "failed resource requests").toEqual([]);
  expect(diagnostics.badResponses, "HTTP 4xx/5xx resource responses").toEqual([]);
}

export async function expectNoUnsafeFirebaseWrites(diagnostics) {
  expect(diagnostics.unsafeFirebaseWrites, "Firebase write-like requests").toEqual([]);
  expect(diagnostics.productionFirebaseAttempts, "production Firebase requests").toEqual([]);
}

export async function expectReadOnlyClean(diagnostics) {
  await expectNoRuntimeErrors(diagnostics);
  await expectNoResourceErrors(diagnostics);
  await expectNoUnsafeFirebaseWrites(diagnostics);
}

export async function expectHiddenOrDisabled(locator, description) {
  const count = await locator.count();
  expect(count, description + " should exist at most once").toBeLessThanOrEqual(1);
  if (count === 0) return;

  const actionable = await locator.evaluate(element => {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const hidden = style.visibility === "hidden" || style.display === "none" || rect.width === 0 || rect.height === 0;
    const disabled = element.disabled === true || element.getAttribute("aria-disabled") === "true";
    return !hidden && !disabled;
  });

  expect(actionable, description + " must be hidden or disabled before login").toBe(false);
}

export async function expectNoBodyHorizontalOverflow(page, tolerance = 2) {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    bodyScrollWidth: document.body.scrollWidth,
    innerWidth: window.innerWidth
  }));

  expect(metrics.scrollWidth, "document horizontal overflow: " + JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.innerWidth + tolerance);
  expect(metrics.bodyScrollWidth, "body horizontal overflow: " + JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.innerWidth + tolerance);
}

export async function expectElementIntersectsViewport(locator, description) {
  await expect(locator, description).toBeVisible();
  const result = await locator.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight;
  });
  expect(result, description + " should intersect viewport").toBe(true);
}

export async function expectVisibleElementsWithinViewport(page, selector, description) {
  const outside = await page.locator(selector).evaluateAll(elements => {
    return elements
      .filter(element => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      })
      .map(element => {
        const rect = element.getBoundingClientRect();
        return { id: element.id, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      })
      .filter(rect => rect.right <= 0 || rect.bottom <= 0 || rect.left >= window.innerWidth || rect.top >= window.innerHeight);
  });

  expect(outside, description + " should not be completely outside the viewport").toEqual([]);
}
