import { expect, test } from "@playwright/test";
import { expectNoBodyHorizontalOverflow, guardProductionFirebase } from "../helpers/readOnlyApp.mjs";

// 穴埋め問題の4択（改訂19）
// Fill-in-the-blank questions answered with four choices on the iPhone
// version (revision 19).

const SUBJECT = "E2E穴埋め";
const SECRETARY = {
  subject: SUBJECT,
  subcategories: ["第1章", "秘書の心構え"],
  question: "秘書の本分は、上司が専念できるよう周辺業務を引き受けて上司を【a】することにある。秘書は【b】を持たず、上司に代わって【c】はしない。",
  answers: ["補佐", "権限", "決定"],
  orderedAnswers: true,
  explanation: "決定は上司、補佐は秘書。",
  distractors: { a: ["代行", "代理", "支配"] }
};
const MOTIVATION = {
  subject: SUBJECT,
  subcategories: ["第2章", "動機づけ"],
  question: "動機づけの2種類について空欄を埋めよ。\n【a】動機づけ：外部からの刺激や【b】によって行動が動機づけられること\n【c】動機づけ：自分の【d】や【e】などによって行動が動機づけられること",
  answers: ["外発的", "報酬", "内発的", "興味", "関心"],
  orderedAnswers: true,
  explanation: "外発的と内発的の違い。"
};
const FILLERS = [
  { question: "【a】は相手のための装い。", answers: ["身だしなみ"] },
  { question: "おしゃれは自分の【a】のため。", answers: ["満足"] },
  { question: "上座は入口から【a】席。", answers: ["遠い"] },
  { question: "来客は客の【a】前を歩いて案内する。", answers: ["斜め"] }
].map(item => ({ subject: SUBJECT, subcategories: ["第2章", "マナー"], explanation: "", ...item }));
const CHOICE = {
  subject: SUBJECT,
  subcategories: ["第3章"],
  question: "秘書の仕事として適当なのはどれか。\na. 上司の代わりに決裁する\nb. 上司の日程を管理する\nc. 上司に無断で約束する\nd. 人事を決める",
  answers: ["b"],
  explanation: "日程管理は秘書の仕事。"
};

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
}

async function waitForCloudSave(page) {
  await page.waitForTimeout(800);
  await expect(page.locator("#cloudStatus")).toContainText("クラウドに分離保存しました", { timeout: 20_000 });
}

async function signInAndImport(page, questions) {
  const blockedRequests = await guardProductionFirebase(page);
  const email = `blank-${Date.now()}-${Math.random().toString(16).slice(2)}@example.test`;
  const password = "DentalBlank!123";
  await createEmulatorUser(email, password);
  await page.goto("/?firebaseEmulator=1", { waitUntil: "domcontentloaded" });
  await page.locator("#emailInput").fill(email);
  await page.locator("#passwordInput").fill(password);
  await page.locator("#signInBtn").click();
  await expect(page.locator("#authStatus")).toContainText(email, { timeout: 20_000 });

  await page.locator("#tabBtnManage").click();
  await page.locator("#bulkImportFile").setInputFiles({
    name: "questions.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(questions))
  });
  const dialogs = [];
  const acceptDialog = async dialog => {
    dialogs.push(dialog.message());
    await dialog.accept();
  };
  page.on("dialog", acceptDialog);
  await page.locator("#bulkImportExecuteBtn").click();
  await expect(page.locator("#bulkImportStatus")).toContainText("一括追加・保存完了", { timeout: 20_000 });
  page.off("dialog", acceptDialog);
  return { email, password, blockedRequests, dialogs };
}

async function openStudy(page, mode = "#chooseIphone") {
  await page.locator("#tabBtnStudy").click();
  await page.locator(mode).click();
  await page.locator("#subjectFilter").selectOption({ label: SUBJECT });
}

async function optionTexts(page) {
  return (await page.locator("#studyBlankPopover .study-blank-option").allTextContents()).sort();
}

test("@authenticated iPhone版の穴埋めは空欄を押すと4択が出て、選ぶと正誤が出て、すべて答えると「できる／まだ」に記録される", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const { email, blockedRequests } = await signInAndImport(page, [SECRETARY, MOTIVATION, ...FILLERS, CHOICE]);
  await openStudy(page);
  await expect(page.locator("#totalCount")).toHaveText("7");

  // The blanks are boxes; the question shows no 【a】.
  const question = page.locator("#question");
  await expect(question).not.toContainText("【a】");
  await expect(question).toContainText("秘書の本分は");
  const blanks = question.locator(".study-blank");
  await expect(blanks).toHaveCount(3);
  await expect(page.locator("#studyChoices")).toBeHidden();
  await expect(page.locator("#studyChoiceActions")).toBeHidden();
  const popover = page.locator("#studyBlankPopover");
  await expect(popover).toBeHidden();

  // The question's own wrong choices and its answer, four in all.
  const blankA = question.locator('.study-blank[data-blank-letter="a"]');
  await blankA.click();
  await expect(popover).toBeVisible();
  await expect(blankA).toHaveAttribute("aria-expanded", "true");
  expect(await optionTexts(page)).toEqual(["代理", "代行", "支配", "補佐"].sort());
  // Below the blank, inside the screen.
  const blankBox = await blankA.boundingBox();
  const popoverBox = await popover.boundingBox();
  expect(popoverBox.y).toBeGreaterThanOrEqual(blankBox.y + blankBox.height);
  expect(popoverBox.x).toBeGreaterThanOrEqual(0);
  expect(popoverBox.x + popoverBox.width).toBeLessThanOrEqual(390);
  for (const box of await Promise.all((await popover.locator(".study-blank-option").all()).map(option => option.boundingBox()))) {
    expect(box.height).toBeGreaterThanOrEqual(44);
  }

  // A wrong choice: red with the answer in green; nothing is recorded yet.
  await popover.getByRole("option", { name: "代行" }).click();
  await expect(popover).toBeHidden();
  await expect(question.locator(".study-blank-word.is-wrong")).toHaveText("代行");
  await expect(question.locator(".study-blank-word.is-correction")).toHaveText("→ 補佐");
  await expect(blanks).toHaveCount(2);
  await expect(page.locator("#answerBox")).toBeHidden();
  await expect(page.locator("#wrongCount")).toHaveText("0");

  // Each blank has four choices with its answer once.
  await question.locator('.study-blank[data-blank-letter="b"]').click();
  const choicesB = await optionTexts(page);
  expect(choicesB).toHaveLength(4);
  expect(choicesB.filter(choice => choice === "権限")).toHaveLength(1);
  await popover.getByRole("option", { name: "権限", exact: true }).click();
  await expect(question.locator(".study-blank-word.is-right")).toHaveText(["権限"]);
  await question.locator('.study-blank[data-blank-letter="c"]').click();
  await popover.getByRole("option", { name: "決定", exact: true }).click();

  // Every blank answered: recorded as まだ, with the answers and the explanation.
  await expect(page.locator("#answerBox")).toBeVisible();
  await expect(page.locator("#answerBox")).toHaveText("不正解（3つ中2つ正解）　正答：a 補佐、b 権限、c 決定");
  await expect(page.locator("#explainBox")).toContainText(SECRETARY.explanation);
  await expect(page.locator("#studyCard")).toHaveClass(/is-incorrect/);
  await expect(page.locator("#wrongCount")).toHaveText("1");
  await expect(question.locator(".study-blank")).toHaveCount(0);

  // 解き直す: empty boxes again; all right this time is できる.
  await page.locator("#choiceRetryBtn").click();
  await expect(page.locator("#answerBox")).toBeHidden();
  await expect(blanks).toHaveCount(3);
  await expect(page.locator("#studyCard")).not.toHaveClass(/is-incorrect/);
  for (const [letter, answer] of [["a", "補佐"], ["b", "権限"], ["c", "決定"]]) {
    await question.locator(`.study-blank[data-blank-letter="${letter}"]`).click();
    await popover.getByRole("option", { name: answer, exact: true }).click();
  }
  await expect(page.locator("#answerBox")).toHaveText("正解　正答：a 補佐、b 権限、c 決定");
  await expect(page.locator("#studyCard")).toHaveClass(/is-correct/);
  await expect(page.locator("#correctCount")).toHaveText("1");
  await expect(page.locator("#wrongCount")).toHaveText("0");

  // Automatic wrong choices: the opposite word is there every time.
  await page.locator("#nextBtn").click();
  await expect(question).toContainText("動機づけの2種類");
  const firstBlank = question.locator('.study-blank[data-blank-letter="a"]');
  await firstBlank.click();
  const automatic = await optionTexts(page);
  expect(automatic).toHaveLength(4);
  expect(automatic).toContain("外発的");
  expect(automatic).toContain("内発的");
  // Escape closes the choices; tapping outside does too.
  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();
  await firstBlank.click();
  await expect(popover).toBeVisible();
  await page.locator("#studyQuestionHead").click();
  await expect(popover).toBeHidden();
  await page.locator("#prevBtn").click();
  await page.locator("#nextBtn").click();
  await question.locator('.study-blank[data-blank-letter="a"]').click();
  expect(await optionTexts(page), "同じ問題では毎回同じ選択肢").toEqual(automatic);
  await page.keyboard.press("Escape");

  // 答えを見る first: the answers show and nothing is recorded.
  await page.locator("#showAnswerBtn").click();
  await expect(question.locator(".study-blank-word.is-revealed")).toHaveText(["外発的", "報酬", "内発的", "興味", "関心"]);
  await expect(question.locator(".study-blank")).toHaveCount(0);
  await expect(page.locator("#answerBox")).toHaveText("正答：a 外発的、b 報酬、c 内発的、d 興味、e 関心");
  await expect(page.locator("#studyCard")).not.toHaveClass(/is-correct|is-incorrect/);
  await expect(page.locator("#correctCount")).toHaveText("1");
  await expect(page.locator("#wrongCount")).toHaveText("0");
  await expectNoBodyHorizontalOverflow(page);

  // Choice questions stay as they are on the iPhone version.
  for (let step = 0; step < 5; step += 1) await page.locator("#nextBtn").click();
  await expect(question).toHaveText("秘書の仕事として適当なのはどれか。");
  await expect(page.locator("#studyChoices .study-option")).toHaveCount(4);
  await expect(question.locator(".study-blank")).toHaveCount(0);

  // The iPad version keeps the answer boxes for the same question.
  await page.locator("#chooseIpad").click();
  await page.locator("#prevBtnIpad").click();
  for (let step = 0; step < 4; step += 1) await page.locator("#prevBtnIpad").click();
  await expect(question).toContainText("【a】動機づけ");
  await expect(page.locator(".multi-answer-input")).toHaveCount(5);
  await expect(question.locator(".study-blank")).toHaveCount(0);
  await page.locator("#chooseIphone").click();

  await waitForCloudSave(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#authStatus")).toContainText(email, { timeout: 20_000 });
  await page.locator("#tabBtnStudy").click();
  await page.locator("#subjectFilter").selectOption({ label: SUBJECT });
  await expect(page.locator("#correctCount")).toHaveText("1");
  await expect(page.locator("#wrongCount")).toHaveText("0");
  expect(blockedRequests).toEqual([]);
});

test("@authenticated JSONの distractors と問題管理の「間違いの選択肢」を保存し、4択に使う", async ({ page }) => {
  test.setTimeout(120_000);
  const arrayForm = {
    subject: SUBJECT,
    subcategories: ["第4章"],
    question: "尊敬語は相手を【a】表現である。",
    answers: ["高める"],
    explanation: "",
    distractors: [["低める", "下げる", "守る"]]
  };
  const notBlank = {
    subject: SUBJECT,
    subcategories: ["第4章"],
    question: "秘書の本分は何か。",
    answers: ["補佐"],
    explanation: "",
    distractors: { a: ["代行"] }
  };
  const { email, password, blockedRequests, dialogs } = await signInAndImport(page, [SECRETARY, arrayForm, notBlank, ...FILLERS]);
  expect(dialogs.join("\n")).toContain(
    "行3: distractors は、問題文に【a】【b】…の空欄があり、空欄の数と answers の数が同じ問題だけで使われるため、登録しません。"
  );

  // The form shows the question's own wrong choices.
  const secretaryRow = page.locator("#questionTableBody tr", { hasText: "秘書の本分は、上司が" });
  await secretaryRow.locator("[data-edit-question]").click();
  const field = page.locator("#editDistractors");
  await expect(field).toHaveValue("a: 代行, 代理, 支配");
  const arrayRow = page.locator("#questionTableBody tr", { hasText: "尊敬語は相手を" });
  await arrayRow.locator("[data-edit-question]").click();
  await expect(field).toHaveValue("a: 低める, 下げる, 守る");
  await page.locator("#questionTableBody tr", { hasText: "秘書の本分は何か。" }).locator("[data-edit-question]").click();
  await expect(field).toHaveValue("");

  // A mistake is shown and nothing is saved.
  await secretaryRow.locator("[data-edit-question]").click();
  await field.fill("a: 補佐, 代行");
  const messages = [];
  const accept = async dialog => {
    messages.push(dialog.message());
    await dialog.accept();
  };
  page.on("dialog", accept);
  await page.locator("#updateBtn").click();
  await expect.poll(() => messages.join("\n")).toContain("間違いの選択肢の「a」に正解と同じ「補佐」があります。");
  page.off("dialog", accept);

  // New wrong choices for a and c.
  await field.fill("a: 代行, 代理, 支配\nc: 決裁, 判断, 承認");
  await page.locator("#updateBtn").click();
  await waitForCloudSave(page);

  await openStudy(page);
  const question = page.locator("#question");
  await expect(question).toContainText("秘書の本分は");
  await question.locator('.study-blank[data-blank-letter="c"]').click();
  expect(await optionTexts(page)).toEqual(["決定", "決裁", "判断", "承認"].sort());
  await page.keyboard.press("Escape");

  // Saved in the cloud: after signing in again the form still has them.
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#authStatus")).toContainText(email, { timeout: 20_000 });
  await page.locator("#tabBtnManage").click();
  await page.locator("#questionTableBody tr", { hasText: "秘書の本分は、上司が" }).locator("[data-edit-question]").click();
  await expect(field).toHaveValue("a: 代行, 代理, 支配\nc: 決裁, 判断, 承認");

  // Emptied: the question has no wrong choices of its own again.
  await field.fill("");
  await page.locator("#updateBtn").click();
  await waitForCloudSave(page);
  await openStudy(page);
  await page.locator("#question .study-blank[data-blank-letter=\"c\"]").click();
  const automatic = await optionTexts(page);
  expect(automatic).toContain("決定");
  expect(automatic).not.toContain("決裁");
  expect(blockedRequests).toEqual([]);
  expect(password).toBeTruthy();
});
