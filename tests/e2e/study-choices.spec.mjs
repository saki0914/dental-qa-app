import { expect, test } from "@playwright/test";
import { expectNoBodyHorizontalOverflow, guardProductionFirebase } from "../helpers/readOnlyApp.mjs";

// 学習画面の選択問題と操作ボタン（改訂14）
// Choice questions and the navigation icons of the study screen (revision 14).

const SUBJECT = "E2E選択問題";
const SINGLE = {
  subject: SUBJECT,
  subcategories: ["発生", "鰓弓"],
  question: "鰓弓と神経支配の組み合わせで正しいのはどれか。\na. 第一鰓弓 — 顔面神経\nb. 第二鰓弓 — 舌咽神経\nc. 第三鰓弓 — 舌咽神経\nd. 第一鰓弓 — 舌咽神経",
  answers: ["c"],
  explanation: "第三鰓弓は舌咽神経の支配です。"
};
const DOUBLE = {
  subject: SUBJECT,
  subcategories: ["唾液"],
  question: "唾液中の抗菌因子はどれか。2つ選べ。\na. リゾチーム\nb. スタテリン\nc. ラクトフェリン\nd. 重炭酸塩",
  answers: ["a", "c"],
  explanation: "リゾチームとラクトフェリンが抗菌因子です。"
};
const WRITTEN = {
  subject: SUBJECT,
  subcategories: ["下垂体"],
  question: "下垂体の発生について答えよ。\n前葉：口腔の上皮である【a】から発生する\n後葉：間脳の【b】から発生する",
  answers: ["ラトケ嚢", "漏斗"],
  orderedAnswers: true,
  explanation: "前葉はラトケ嚢、後葉は漏斗から発生します。"
};
// Options, but the answer is the option's text: shown as a written question.
const NOT_LABEL = {
  subject: SUBJECT,
  subcategories: ["形の崩れ"],
  question: "正しいのはどれか。\na. 甲\nb. 乙",
  answers: ["乙"],
  explanation: "記号でない答えは記述式で出題されます。"
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
  const email = `choice-${Date.now()}-${Math.random().toString(16).slice(2)}@example.test`;
  const password = "DentalChoice!123";
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

  await page.locator("#tabBtnStudy").click();
  return { email, blockedRequests, dialogs };
}

test("@authenticated 選択問題は選択肢を押すと正誤と解説が出て「できる／まだ」に記録され、記述式は解答欄で判定する", async ({ page }) => {
  test.setTimeout(90_000);
  const { email, blockedRequests, dialogs } = await signInAndImport(page, [SINGLE, DOUBLE, WRITTEN, NOT_LABEL]);
  expect(dialogs.join("\n")).toContain(
    "行4: 問題文の最後に選択肢（a. 〜）がありますが、answers が選択肢の記号ではないため記述式で出題されます。"
  );
  await page.locator("#chooseIpad").click();
  await page.locator("#subjectFilter").selectOption({ label: SUBJECT });
  await expect(page.locator("#totalCount")).toHaveText("4");

  // 1つ選ぶ問題: the text before the options is the question, the options are buttons.
  const question = page.locator("#question");
  const options = page.locator("#studyChoices .study-option");
  await expect(question).toHaveText("鰓弓と神経支配の組み合わせで正しいのはどれか。");
  await expect(page.locator("#studyChoices .study-option-key")).toHaveText(["a", "b", "c", "d"]);
  await expect(page.locator("#studyChoices .study-option-text")).toHaveText([
    "第一鰓弓 — 顔面神経",
    "第二鰓弓 — 舌咽神経",
    "第三鰓弓 — 舌咽神経",
    "第一鰓弓 — 舌咽神経"
  ]);
  await expect(page.locator("#studyQuestionNo")).toHaveText("Q01");
  await expect(page.locator("#studyQuestionTags")).toHaveText(`${SUBJECT}・発生`);
  await expect(page.locator(".multi-answer-input")).toHaveCount(0);
  await expect(page.locator("#userAnswer")).toBeHidden();
  await expect(page.locator("#judgeBtn")).toBeHidden();
  await expect(page.locator("#choiceSubmitBtn")).toBeHidden();
  // The question reads like the drill: body size in bold, not the 30px headline.
  expect(await question.evaluate(node => {
    const style = getComputedStyle(node);
    return [style.fontSize, style.fontWeight];
  })).toEqual(["15px", "700"]);

  await page.locator('[data-choice-label="b"]').click();
  await expect(page.locator('[data-choice-label="b"]')).toHaveClass(/is-wrong/);
  await expect(page.locator('[data-choice-label="c"]')).toHaveClass(/is-right/);
  await expect(page.locator("#studyChoices .study-option:disabled")).toHaveCount(4);
  await expect(page.locator("#answerBox")).toBeVisible();
  await expect(page.locator("#answerBox")).toHaveText("不正解　正答：c");
  await expect(page.locator("#explainBox")).toHaveText(SINGLE.explanation);
  await expect(page.locator("#studyCard")).toHaveClass(/is-incorrect/);
  await expect(page.locator("#wrongCount")).toHaveText("1");
  await expect(page.locator("#judgeStatus")).toHaveText("");

  // 解き直す: the next answer replaces the record.
  await page.locator("#choiceRetryBtn").click();
  await expect(page.locator("#answerBox")).toBeHidden();
  await expect(page.locator("#studyChoices .study-option:disabled")).toHaveCount(0);
  await expect(page.locator("#studyCard")).not.toHaveClass(/is-incorrect/);
  await page.locator('[data-choice-label="c"]').click();
  await expect(page.locator("#answerBox")).toHaveText("正解　正答：c");
  await expect(page.locator("#studyCard")).toHaveClass(/is-correct/);
  await expect(page.locator("#correctCount")).toHaveText("1");
  await expect(page.locator("#wrongCount")).toHaveText("0");

  // 2つ選ぶ問題: up to two options are selected, then 解答する.
  await page.locator("#nextBtnIpad").click();
  await expect(question).toHaveText("唾液中の抗菌因子はどれか。2つ選べ。");
  await expect(page.locator("#studyQuestionNo")).toHaveText("Q02");
  await expect(page.locator("#studyQuestionTags")).toHaveText(`${SUBJECT}・唾液・2つ選べ`);
  const submit = page.locator("#choiceSubmitBtn");
  await expect(submit).toBeVisible();
  await expect(submit).toBeDisabled();
  await page.locator('[data-choice-label="c"]').click();
  await page.locator('[data-choice-label="b"]').click();
  await page.locator('[data-choice-label="d"]').click();
  await expect(page.locator("#studyChoices .study-option.is-selected")).toHaveCount(2);
  await expect(page.locator('[data-choice-label="d"]')).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#answerBox")).toBeHidden();
  await page.locator('[data-choice-label="b"]').click();
  await expect(submit).toBeDisabled();
  await page.locator('[data-choice-label="a"]').click();
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.locator("#answerBox")).toHaveText("正解　正答：a、c");
  await expect(page.locator("#studyChoices .study-option.is-right")).toHaveCount(2);
  await expect(submit).toBeHidden();
  await expect(page.locator("#correctCount")).toHaveText("2");

  // 記述式: the answer boxes and 判定する stay as before.
  await page.locator("#nextBtnIpad").click();
  await expect(question).toHaveText(WRITTEN.question);
  await expect(page.locator("#studyChoices")).toBeHidden();
  await expect(page.locator("#studyChoiceActions")).toBeHidden();
  const inputs = page.locator(".multi-answer-input");
  await expect(inputs).toHaveCount(2);
  await expect(page.locator("#judgeBtn")).toBeVisible();
  await inputs.nth(0).fill("ラトケ嚢");
  await inputs.nth(1).fill("漏斗");
  await page.locator("#judgeBtn").click();
  await expect(page.locator("#judgeStatus")).toHaveText("正解です。");
  await expect(page.locator("#explainBox")).toContainText(WRITTEN.explanation);

  // Options whose answer is not a label: a written question.
  await page.locator("#nextBtnIpad").click();
  await expect(question).toHaveText(NOT_LABEL.question);
  await expect(page.locator("#studyChoices")).toBeHidden();
  await expect(page.locator(".multi-answer-input")).toHaveCount(1);

  await waitForCloudSave(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#authStatus")).toContainText(email, { timeout: 20_000 });
  await expect(page.locator("#tabBtnStudy")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#totalCount")).toHaveText("4");
  await expect(page.locator("#correctCount")).toHaveText("3");
  await expect(page.locator("#wrongCount")).toHaveText("0");
  expect(blockedRequests).toEqual([]);
});

test("@authenticated 戻る・答えを見る・次へは左・中央・右のアイコンで、答えを先に見た選択問題は記録しない", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const { blockedRequests } = await signInAndImport(page, [SINGLE, DOUBLE]);
  await page.locator("#chooseIphone").click();
  await page.locator("#subjectFilter").selectOption({ label: SUBJECT });
  await expect(page.locator("#totalCount")).toHaveText("2");

  const nav = ["#prevBtn", "#showAnswerBtn", "#nextBtn"].map(selector => page.locator(selector));
  expect(await Promise.all(nav.map(button => button.getAttribute("aria-label")))).toEqual(["戻る", "答えを見る", "次へ"]);
  for (const button of nav) {
    await expect(button).toBeVisible();
    expect((await button.textContent()).trim(), "文字ではなくアイコン").toBe("");
    await expect(button.locator("svg")).toHaveCount(1);
  }
  const boxes = await Promise.all(nav.map(button => button.boundingBox()));
  expect(Math.abs(boxes[0].y - boxes[1].y)).toBeLessThanOrEqual(1);
  expect(Math.abs(boxes[1].y - boxes[2].y)).toBeLessThanOrEqual(1);
  expect(boxes[0].x + boxes[0].width).toBeLessThanOrEqual(boxes[1].x);
  expect(boxes[1].x + boxes[1].width).toBeLessThanOrEqual(boxes[2].x);
  for (const box of boxes) expect(box.height).toBeGreaterThanOrEqual(44);
  await expect(nav[0]).toBeDisabled();

  // 答えを見る first: the correct option is shown and nothing is recorded.
  await nav[1].click();
  await expect(page.locator('[data-choice-label="c"]')).toHaveClass(/is-right/);
  await expect(page.locator("#studyChoices .study-option:disabled")).toHaveCount(4);
  await expect(page.locator("#answerBox")).toHaveText("正答：c");
  await expect(page.locator("#explainBox")).toHaveText(SINGLE.explanation);
  await expect(page.locator("#studyCard")).not.toHaveClass(/is-correct|is-incorrect/);
  await expect(page.locator("#correctCount")).toHaveText("0");
  await expect(page.locator("#wrongCount")).toHaveText("0");

  // The iPhone version answers choice questions with the options too.
  await nav[2].click();
  await expect(page.locator("#question")).toHaveText("唾液中の抗菌因子はどれか。2つ選べ。");
  await expect(nav[0]).toBeEnabled();
  await page.locator('[data-choice-label="a"]').click();
  await page.locator('[data-choice-label="b"]').click();
  await page.locator("#choiceSubmitBtn").click();
  await expect(page.locator("#answerBox")).toHaveText("不正解　正答：a、c");
  await expect(page.locator('[data-choice-label="b"]')).toHaveClass(/is-wrong/);
  await expect(page.locator("#studyChoices .study-option.is-right")).toHaveCount(2);
  await expect(page.locator("#wrongCount")).toHaveText("1");

  await nav[0].click();
  await expect(page.locator("#question")).toHaveText("鰓弓と神経支配の組み合わせで正しいのはどれか。");
  await expect(page.locator("#studyQuestionNo")).toHaveText("Q01");
  await expect(page.locator("#answerBox")).toBeHidden();
  await expect(page.locator("#studyChoices .study-option:disabled")).toHaveCount(0);
  await expectNoBodyHorizontalOverflow(page);
  expect(blockedRequests).toEqual([]);
});
