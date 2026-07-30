import { expect, test } from "@playwright/test";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, getDoc } from "firebase/firestore";
import { guardProductionFirebase } from "../helpers/readOnlyApp.mjs";
import { restoreQuestionsFromChunks } from "../../js/core/question-import.js";

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

async function performAndWaitForCloudSave(page, action) {
  const status = page.locator("#cloudStatus");
  await action();
  await expect(status).toContainText(
    /クラウド保存を待機しています|クラウドへ保存中です/,
    { timeout: 10_000 }
  );
  await expect(status).toContainText(
    "クラウドに分離保存しました",
    { timeout: 20_000 }
  );
}

async function readStoredQuestions(userId) {
  const testEnvironment = await initializeTestEnvironment({
    projectId: "demo-dental-qa",
    firestore: {
      host: "127.0.0.1",
      port: 8080
    }
  });
  try {
    const db = testEnvironment.authenticatedContext(userId).firestore();
    const appRef = name => doc(db, "users", userId, "app", name);
    const [manifestSnapshot, syncSnapshot] = await Promise.all([
      getDoc(appRef("questions")),
      getDoc(appRef("sync"))
    ]);
    const manifest = manifestSnapshot.data();
    const chunks = [];
    for (let index = 0; index < manifest.chunkCount; index += 1) {
      const suffix = String(index + 1).padStart(4, "0");
      chunks.push((await getDoc(appRef(`questions-${suffix}`))).data());
    }
    return {
      questions: restoreQuestionsFromChunks(manifest, chunks),
      revision: syncSnapshot.data()?.revision
    };
  } finally {
    await testEnvironment.cleanup();
  }
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

test("@authenticated iPadの削除後に古いiPhoneの保存を拒否して削除を維持する", async ({ browser }) => {
  test.setTimeout(90_000);
  const email = `sync-conflict-${Date.now()}-${Math.random().toString(16).slice(2)}@example.test`;
  const password = "DentalSync!123";
  const user = await createEmulatorUser(email, password);
  const ipadContext = await browser.newContext({
    viewport: { width: 768, height: 1024 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2
  });
  const iphoneContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 3
  });
  const ipad = await ipadContext.newPage();
  const iphone = await iphoneContext.newPage();
  const ipadBlockedRequests = await guardProductionFirebase(ipad);
  const iphoneBlockedRequests = await guardProductionFirebase(iphone);

  try {
    await ipad.goto("/?firebaseEmulator=1", { waitUntil: "domcontentloaded" });
    await signIn(ipad, email, password);
    await performAndWaitForCloudSave(ipad, () => addQuestion(ipad, "削除後も消えたままの問題"));
    await performAndWaitForCloudSave(ipad, () => addQuestion(ipad, "残す問題"));

    await iphone.goto("/?firebaseEmulator=1", { waitUntil: "domcontentloaded" });
    await signIn(iphone, email, password);

    await ipad.locator("#tabBtnManage").click();
    const deleteRow = ipad.locator(
      '[data-manage-row]:has-text("削除後も消えたままの問題")'
    );
    await deleteRow.locator("[data-delete-question]").check();
    ipad.once("dialog", dialog => dialog.accept());
    await performAndWaitForCloudSave(
      ipad,
      () => ipad.locator("#manageDeleteCheckedBtn").click()
    );
    await expect(ipad.locator("#questionTableBody"))
      .not.toContainText("削除後も消えたままの問題");

    await iphone.locator("#tabBtnStudy").click();
    await iphone.locator("#chooseIpad").click();
    await expect(iphone.locator("#cloudStatus")).toContainText(
      "他の端末で先にクラウドデータが更新されたため",
      { timeout: 20_000 }
    );
    await expect(iphone.locator("#authStatus")).toContainText(
      "他端末との保存競合により操作停止中"
    );
    await expect(iphone.locator("#tabBtnManage")).toBeHidden();

    iphone.once("dialog", dialog => dialog.accept());
    await Promise.all([
      ipad.reload({ waitUntil: "domcontentloaded" }),
      iphone.reload({ waitUntil: "domcontentloaded" })
    ]);
    await Promise.all([
      expect(ipad.locator("#tabBtnManage")).toBeVisible({ timeout: 20_000 }),
      expect(iphone.locator("#tabBtnManage")).toBeVisible({ timeout: 20_000 })
    ]);
    await Promise.all([
      ipad.locator("#tabBtnManage").click(),
      iphone.locator("#tabBtnManage").click()
    ]);
    await expect(ipad.locator("#questionTableBody"))
      .not.toContainText("削除後も消えたままの問題");
    await expect(iphone.locator("#questionTableBody"))
      .not.toContainText("削除後も消えたままの問題");
    await expect(ipad.locator("#questionTableBody")).toContainText("残す問題");
    await expect(iphone.locator("#questionTableBody")).toContainText("残す問題");

    const stored = await readStoredQuestions(user.localId);
    expect(stored.questions.map(question => question.question)).toEqual(["残す問題"]);
    expect(stored.revision).toBe(3);
    expect(ipadBlockedRequests).toEqual([]);
    expect(iphoneBlockedRequests).toEqual([]);
  } finally {
    await Promise.all([
      ipadContext.close(),
      iphoneContext.close()
    ]);
  }
});

test("@authenticated 非dirty端末はpageshowとvisibility復帰で他端末の更新を自動反映する", async ({ browser }) => {
  test.setTimeout(90_000);
  const email = `sync-foreground-${Date.now()}-${Math.random().toString(16).slice(2)}@example.test`;
  const password = "DentalSync!123";
  await createEmulatorUser(email, password);
  const writerContext = await browser.newContext({ viewport: { width: 768, height: 1024 } });
  const readerContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const writer = await writerContext.newPage();
  const reader = await readerContext.newPage();
  const writerBlockedRequests = await guardProductionFirebase(writer);
  const readerBlockedRequests = await guardProductionFirebase(reader);

  try {
    await writer.goto("/?firebaseEmulator=1", { waitUntil: "domcontentloaded" });
    await signIn(writer, email, password);
    await performAndWaitForCloudSave(writer, () => addQuestion(writer, "同期の基準問題"));

    await reader.goto("/?firebaseEmulator=1", { waitUntil: "domcontentloaded" });
    await signIn(reader, email, password);
    await reader.locator("#tabBtnManage").click();
    await expect(reader.locator("#questionTableBody")).toContainText("同期の基準問題");

    await performAndWaitForCloudSave(writer, () => addQuestion(writer, "pageshowで反映する問題"));
    await reader.evaluate(() => {
      window.dispatchEvent(new Event("pageshow"));
    });
    await expect(reader.locator("#cloudStatus")).toContainText(
      "他の端末で更新されたクラウド内容を自動反映しました",
      { timeout: 20_000 }
    );
    await expect(reader.locator("#questionTableBody")).toContainText("pageshowで反映する問題");

    await performAndWaitForCloudSave(
      writer,
      () => addQuestion(writer, "visibilitychangeで反映する問題")
    );
    await reader.evaluate(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(reader.locator("#cloudStatus")).toContainText(
      "他の端末で更新されたクラウド内容を自動反映しました",
      { timeout: 20_000 }
    );
    await expect(reader.locator("#questionTableBody"))
      .toContainText("visibilitychangeで反映する問題");
    expect(writerBlockedRequests).toEqual([]);
    expect(readerBlockedRequests).toEqual([]);
  } finally {
    await Promise.all([
      writerContext.close(),
      readerContext.close()
    ]);
  }
});
