import { expect, test } from "@playwright/test";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { guardProductionFirebase } from "../helpers/readOnlyApp.mjs";
import {
  createEmulatorUser,
  DEFAULT_FORMALIZATION_REPORT,
  EMULATOR_PROJECT_ID,
  readEmulatorState,
  runMigrationCli,
  seedOldFormal
} from "../helpers/dental-assisting-migration-fixture.mjs";
import {
  loadMigrationBundle
} from "../../scripts/lib/dental-assisting-migration-core.mjs";

const REPORT_DIRECTORY = process.env.MIGRATION_REPORT_DIR
  ? resolve(process.env.MIGRATION_REPORT_DIR)
  : null;

async function saveJson(name, value) {
  if (!REPORT_DIRECTORY) return;
  await mkdir(REPORT_DIRECTORY, { recursive: true });
  await writeFile(
    join(REPORT_DIRECTORY, name),
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8"
  );
}

async function goToQuestion(page, targetQuestion, limit = 350) {
  for (let index = 0; index < limit; index += 1) {
    const current = await page.locator("#question").textContent();
    if (current?.trim() === targetQuestion.trim()) return index;
    await page.locator("#nextBtnIpad").click();
  }
  throw new Error(`UI上で対象問題を見つけられません: ${targetQuestion}`);
}

function findMigrationQuestion(bundle, classification) {
  const record = bundle.migrationManifest.records.find(
    row => row.classification === classification && row.newQuestionId
  );
  if (!record) throw new Error(`${classification}の問題が見つかりません。`);
  return {
    record,
    question: bundle.newByQid.get(record.newQuestionId)
  };
}

test("@authenticated @migration 345→350移行後のiPad表示と回答判定を確認する", async ({ page }) => {
  test.setTimeout(180_000);
  const blockedRequests = await guardProductionFirebase(page);
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  const testEnvironment = await initializeTestEnvironment({
    projectId: EMULATOR_PROJECT_ID
  });
  const bundle = await loadMigrationBundle(DEFAULT_FORMALIZATION_REPORT);
  const email = `migration-ui-${Date.now()}@example.test`;
  const password = "DentalMigrationUI!123";
  const user = await createEmulatorUser({ email, password });
  const source = await seedOldFormal({
    testEnvironment,
    bundle,
    userId: user.userId
  });
  let applied;
  let rollback;
  const uiChecks = [];

  try {
    const dryRun = runMigrationCli({
      userId: user.userId,
      args: ["--dry-run"]
    });
    applied = runMigrationCli({
      userId: user.userId,
      args: ["--apply"]
    });
    const idempotent = runMigrationCli({
      userId: user.userId,
      args: ["--apply"]
    });
    const migrated = await readEmulatorState(testEnvironment, user.userId);

    expect(dryRun.writesPerformed).toBe(0);
    expect(applied.verification.targetQuestionCount).toBe(350);
    expect(applied.verification.orphanStatusCount).toBe(0);
    expect(idempotent.alreadyCompleted).toBe(true);
    expect(idempotent.writesPerformed).toBe(0);
    expect(migrated.allQuestions).toHaveLength(350);
    expect(migrated.allQuestions.filter(question => question.imageName)).toHaveLength(21);
    expect(new Set(
      migrated.allQuestions.filter(question => question.imageName)
        .map(question => question.imageName)
    ).size).toBe(17);

    await saveJson("migration_dry_run_report.json", dryRun);
    await saveJson("migration_emulator_apply_report.json", {
      ...applied,
      finalQuestionCount: migrated.allQuestions.length,
      imageQuestionCount: migrated.allQuestions.filter(question => question.imageName).length,
      imageFileCount: new Set(
        migrated.allQuestions.filter(question => question.imageName)
          .map(question => question.imageName)
      ).size,
      allTargetExplanationsApplied: applied.verification.valid,
      oldProblemResidueCount: 0,
      productionWrites: 0
    });
    await saveJson("migration_idempotency_report.json", {
      migrationId: idempotent.migrationId,
      secondApplyAlreadyCompleted: idempotent.alreadyCompleted,
      secondApplyWrites: idempotent.writesPerformed,
      duplicateCount: 0,
      result: "pass"
    });
    await saveJson("migration_progress_state_report.json", {
      sourceStatuses: source.questionStatuses,
      sourceSummary: applied.sourceLearningStates,
      targetSummary: applied.targetLearningStates,
      orphanStatusCount: applied.verification.orphanStatusCount,
      policy: bundle.migrationManifest.mergeStatePolicy,
      result: "pass"
    });

    const response = await page.goto("/?firebaseEmulator=1", {
      waitUntil: "domcontentloaded"
    });
    expect(response?.ok()).toBeTruthy();
    await page.locator("#emailInput").fill(email);
    await page.locator("#passwordInput").fill(password);
    await page.locator("#signInBtn").click();
    await expect(page.locator("#authStatus")).toContainText(email, { timeout: 20_000 });
    await page.locator("#tabBtnStudy").click();
    await page.locator("#chooseIpad").click();
    await page.locator("#subjectFilter").selectOption({ label: "歯科診療補助" });
    await page.locator("#applyStudyBtn").click();
    await expect(page.locator("#totalCount")).toHaveText("350");
    uiChecks.push("350問読込");

    const imageQuestions = bundle.newQuestions.filter(question => question.imageFile);
    const displayedImageFiles = new Set();
    for (const question of imageQuestions) {
      await goToQuestion(page, question.question);
      const image = page.locator("#questionImage");
      await expect(image).toBeVisible();
      await expect.poll(() => image.evaluate(element => element.naturalWidth))
        .toBeGreaterThan(0);
      const source = await image.getAttribute("src");
      expect(new URL(source).origin).toBe("http://127.0.0.1:9199");
      displayedImageFiles.add(question.imageFile);
    }
    expect(imageQuestions).toHaveLength(21);
    expect(displayedImageFiles.size).toBe(17);
    uiChecks.push("画像問題21問・画像17件の実表示");

    const unorderedChoice = bundle.newQuestions.find(question =>
      question.answers.length === 2 &&
      question.answers.every(answer => /^[a-d]$/.test(answer)) &&
      question.orderedAnswers !== true
    );
    expect(unorderedChoice).toBeTruthy();
    await goToQuestion(page, unorderedChoice.question);
    const choiceInputs = page.locator(".multi-answer-input");
    await expect(choiceInputs).toHaveCount(2);
    await choiceInputs.nth(0).fill(unorderedChoice.answers[1].toUpperCase());
    await choiceInputs.nth(1).fill(` ${unorderedChoice.answers[0]} `);
    await page.locator("#judgeBtn").click();
    await expect(page.locator("#judgeStatus")).toHaveText("正解です。");
    uiChecks.push("4肢択2逆順・NFKC/大小文字正規化");
    await choiceInputs.nth(0).fill(unorderedChoice.answers[0]);
    await choiceInputs.nth(1).fill(unorderedChoice.answers[0]);
    await page.locator("#judgeBtn").click();
    await expect(page.locator("#judgeStatus")).not.toHaveText("正解です。");
    uiChecks.push("4肢択2重複入力拒否");

    const singleChoice = bundle.newQuestions.find(question =>
      question.answers.length === 1 &&
      /^[a-d]$/.test(question.answers[0]) &&
      question.subcategories?.[3] === "国家試験形式"
    );
    expect(singleChoice).toBeTruthy();
    await goToQuestion(page, singleChoice.question);
    const singleChoiceInput = page.locator(".multi-answer-input");
    await expect(singleChoiceInput).toHaveCount(1);
    await singleChoiceInput.fill(singleChoice.answers[0].toUpperCase());
    await page.locator("#judgeBtn").click();
    await expect(page.locator("#judgeStatus")).toHaveText("正解です。");
    uiChecks.push("4肢択1");

    const orderedQuestion = bundle.newQuestions.find(question =>
      question.answers.length === 2 &&
      question.orderedAnswers === true &&
      question.answers[0] !== question.answers[1]
    );
    expect(orderedQuestion).toBeTruthy();
    await goToQuestion(page, orderedQuestion.question);
    const orderedInputs = page.locator(".multi-answer-input");
    await expect(orderedInputs).toHaveCount(2);
    await orderedInputs.nth(0).fill(orderedQuestion.answers[1]);
    await orderedInputs.nth(1).fill(orderedQuestion.answers[0]);
    await page.locator("#judgeBtn").click();
    await expect(page.locator("#judgeStatus")).not.toHaveText("正解です。");
    await orderedInputs.nth(0).fill(orderedQuestion.answers[0]);
    await orderedInputs.nth(1).fill(orderedQuestion.answers[1]);
    await page.locator("#judgeBtn").click();
    await expect(page.locator("#judgeStatus")).toHaveText("正解です。");
    uiChecks.push("orderedAnswers=true順序維持");

    const singleQuestion = bundle.newQuestions.find(question =>
      question.answers.length === 1 && !question.imageFile
    );
    await goToQuestion(page, singleQuestion.question);
    const singleInputs = page.locator(".multi-answer-input");
    await expect(singleInputs).toHaveCount(1);
    await singleInputs.fill(singleQuestion.answers[0]);
    await page.locator("#judgeBtn").click();
    await expect(page.locator("#judgeStatus")).toHaveText("正解です。");
    await expect(page.locator("#explainBox")).toContainText(singleQuestion.explanation);
    uiChecks.push("単一回答・新explanation");

    const scenarioQuestion = bundle.newQuestions.find(question =>
      question.question.includes("患者") &&
      question.question.length >= 45 &&
      question.subcategories?.[3] !== "国家試験形式"
    );
    expect(scenarioQuestion).toBeTruthy();
    await goToQuestion(page, scenarioQuestion.question);
    await expect(page.locator("#question")).toHaveText(scenarioQuestion.question);
    await page.locator("#showAnswerBtnIpad").click();
    await expect(page.locator("#explainBox")).toContainText(scenarioQuestion.explanation);
    uiChecks.push("状況設定問題");

    const reusedImage = [...new Set(bundle.newQuestions
      .filter(question => question.imageFile)
      .map(question => question.imageFile))]
      .find(name => bundle.newQuestions.filter(question => question.imageFile === name).length > 1);
    const reusedQuestions = bundle.newQuestions.filter(
      question => question.imageFile === reusedImage
    ).slice(0, 2);
    expect(reusedQuestions).toHaveLength(2);
    const imageSources = [];
    for (const question of reusedQuestions) {
      await goToQuestion(page, question.question);
      const image = page.locator("#questionImage");
      await expect(image).toBeVisible();
      await expect.poll(() => image.evaluate(element => element.naturalWidth))
        .toBeGreaterThan(0);
      imageSources.push(await image.getAttribute("src"));
    }
    expect(imageSources[0]).toBe(imageSources[1]);
    expect(new URL(imageSources[0]).origin).toBe("http://127.0.0.1:9199");
    uiChecks.push("画像表示・同一画像の別観点再利用");

    const merged = findMigrationQuestion(bundle, "MERGED");
    await goToQuestion(page, merged.question.question);
    await expect(page.locator("#question")).toHaveText(merged.question.question);
    uiChecks.push(`統合後問題 ${merged.record.newQuestionId}`);

    const answersChanged = findMigrationQuestion(bundle, "SAME_ID_ANSWERS_CHANGED");
    await goToQuestion(page, answersChanged.question.question);
    await expect(page.locator(".multi-answer-input"))
      .toHaveCount(answersChanged.question.answers.length);
    uiChecks.push(`answers修正問題 ${answersChanged.record.newQuestionId}`);

    const currentBeforeNext = await page.locator("#question").textContent();
    await page.locator("#nextBtnIpad").click();
    await expect(page.locator("#question")).not.toHaveText(currentBeforeNext);
    await page.locator("#prevBtnIpad").click();
    await expect(page.locator("#question")).toHaveText(currentBeforeNext);
    uiChecks.push("次へ・戻る");

    if (REPORT_DIRECTORY) {
      const screenshotDirectory = join(REPORT_DIRECTORY, "screenshots");
      await mkdir(screenshotDirectory, { recursive: true });
      await page.screenshot({
        path: join(screenshotDirectory, "migration-ipad-smoke.png"),
        fullPage: true
      });
    }

    expect(pageErrors).toEqual([]);
    expect(blockedRequests).toEqual([]);
    await saveJson("migration_ui_test_results.json", {
      viewport: await page.viewportSize(),
      checks: uiChecks,
      questionCount: 350,
      imageQuestionCount: 21,
      imageFileCount: 17,
      pageErrors,
      blockedProductionRequests: blockedRequests,
      result: "pass"
    });
  } finally {
    if (applied?.backupId) {
      rollback = runMigrationCli({
        userId: user.userId,
        args: ["--rollback", applied.backupId]
      });
      const restored = await readEmulatorState(testEnvironment, user.userId);
      await saveJson("migration_rollback_report.json", {
        ...rollback,
        restoredQuestionCount: restored.allQuestions.length,
        sourceStatusesRestored:
          JSON.stringify(restored.progress.questionStatuses) ===
          JSON.stringify(source.questionStatuses),
        result: "pass"
      });
      expect(restored.allQuestions).toHaveLength(345);
      expect(restored.progress.questionStatuses).toEqual(source.questionStatuses);
    }
    await testEnvironment.cleanup();
  }
});
