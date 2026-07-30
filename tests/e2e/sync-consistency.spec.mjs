import { expect, test } from "@playwright/test";
import { guardProductionFirebase } from "../helpers/readOnlyApp.mjs";

async function createEmulatorUser(email, password) {
  const response = await fetch(
    "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-api-key",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true })
    }
  );
  const body = await response.json();
  expect(response.ok, JSON.stringify(body)).toBeTruthy();
  return body;
}

async function signIn(page, email, password) {
  await page.locator("#emailInput").fill(email);
  await page.locator("#passwordInput").fill(password);
  await page.locator("#signInBtn").click();
  await expect(page.locator("#authStatus")).toContainText(email, { timeout: 20_000 });
  await expect(page.locator("#tabBtnManage")).toBeVisible({ timeout: 20_000 });
}

async function addQuestion(page, question) {
  await page.locator("#tabBtnManage").click();
  await page.locator("#editSubject").fill("同期テスト");
  await page.locator("#editQuestion").fill(question);
  await page.locator("#editAnswers").fill("保存");
  await page.locator("#editExplanation").fill("クラウド同期の検証");
  await page.locator("#addBtn").click();
  await expect(page.locator("#questionTableBody")).toContainText(question);
}

async function waitForCloudSave(page) {
  await expect(page.locator("#cloudStatus")).toContainText(
    "クラウドに分離保存しました",
    { timeout: 20_000 }
  );
}

test("@authenticated 高速な「できる／まだ」の最終状態を保存・復元する", async ({ page }) => {
  test.setTimeout(60_000);
  const blockedRequests = await guardProductionFirebase(page);
  const email = `sync-status-${Date.now()}-${Math.random().toString(16).slice(2)}@example.test`;
  const password = "DentalSync!123";
  await createEmulatorUser(email, password);

  await page.goto("/?firebaseEmulator=1", { waitUntil: "domcontentloaded" });
  await signIn(page, email, password);
  await addQuestion(page, "高速切替の問題");
  await waitForCloudSave(page);

  await page.locator("#tabBtnStudy").click();
  await expect(page.locator("#question")).toContainText("高速切替の問題");
  await page.locator("#unknownBtn").click();
  await page.locator("#knownBtn").click();
  await page.locator("#unknownBtn").click();
  await page.locator("#knownBtn").click();
  await waitForCloudSave(page);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#authStatus")).toContainText(email, { timeout: 20_000 });
  await expect(page.locator("#tabBtnStudy")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#correctCount")).toHaveText("1");
  await expect(page.locator("#wrongCount")).toHaveText("0");
  expect(blockedRequests).toEqual([]);
});

test("@authenticated 空データの別ユーザーへ前ユーザーの状態を持ち越さない", async ({ page }) => {
  test.setTimeout(60_000);
  const blockedRequests = await guardProductionFirebase(page);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const firstEmail = `sync-user-a-${suffix}@example.test`;
  const secondEmail = `sync-user-b-${suffix}@example.test`;
  const password = "DentalSync!123";
  await createEmulatorUser(firstEmail, password);
  await createEmulatorUser(secondEmail, password);

  await page.goto("/?firebaseEmulator=1", { waitUntil: "domcontentloaded" });
  await signIn(page, firstEmail, password);
  await addQuestion(page, "ユーザーAだけの問題");
  await waitForCloudSave(page);

  await page.locator("#tabBtnAuth").click();
  await page.locator("#signOutBtn").click();
  await expect(page.locator("#authStatus")).toContainText("未ログイン", { timeout: 20_000 });
  await signIn(page, secondEmail, password);

  await page.locator("#tabBtnManage").click();
  await expect(page.locator("#questionTableBody")).not.toContainText("ユーザーAだけの問題");
  await expect(page.locator("#questionTableBody")).toContainText("条件に合う問題がありません");
  await page.locator("#tabBtnStudy").click();
  await expect(page.locator("#totalCount")).toHaveText("0");

  // B側で空状態のまま設定を変更して保存しても、Aの問題が混入しないことを確認する。
  await page.locator("#chooseIpad").click();
  await waitForCloudSave(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#authStatus")).toContainText(secondEmail, { timeout: 20_000 });
  await page.locator("#tabBtnManage").click();
  await expect(page.locator("#questionTableBody")).not.toContainText("ユーザーAだけの問題");

  await page.locator("#tabBtnAuth").click();
  await page.locator("#signOutBtn").click();
  await expect(page.locator("#authStatus")).toContainText("未ログイン", { timeout: 20_000 });
  await signIn(page, firstEmail, password);
  await page.locator("#tabBtnManage").click();
  await expect(page.locator("#questionTableBody")).toContainText("ユーザーAだけの問題");
  expect(blockedRequests).toEqual([]);
});
