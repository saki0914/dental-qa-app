import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";

import {
  aggregateMergedState,
  buildDryRunReport,
  buildMigrationPlan,
  deterministicRuntimeId,
  loadMigrationBundle,
  materializeMigratedState,
  summarizeLearningStates,
  verifyMigratedState
} from "../../scripts/lib/dental-assisting-migration-core.mjs";

const formalizationReport = resolve(
  process.env.DENTAL_ASSISTING_FORMALIZATION_REPORT ||
    "/Users/sakin/Library/Mobile Documents/com~apple~CloudDocs/歯科診療補助/教科書/" +
    "subject/runs/20260728-012040-national-exam-semantic-quality-final/" +
    "formalization_report.json"
);

let bundlePromise;
function getBundle() {
  bundlePromise ||= loadMigrationBundle(formalizationReport);
  return bundlePromise;
}

function createSourceState(bundle, statusForQid = () => null) {
  const allQuestions = [...bundle.oldByQid].map(([qid, question]) => ({
    id: `legacy-${qid}`,
    subject: question.subject,
    subcategories: [...question.subcategories],
    question: question.question,
    answers: [...question.answers],
    explanation: question.explanation,
    orderedAnswers: question.orderedAnswers,
    imageName: question.imageFile,
    imagePath: question.imageFile ? `users/test/questions/legacy/${question.imageFile}` : "",
    imageUrl: question.imageFile ? `http://127.0.0.1:9199/${question.imageFile}` : ""
  }));
  const questionStatuses = {};
  for (const [qid] of bundle.oldByQid) {
    const state = statusForQid(qid);
    if (state === 1 || state === 2) questionStatuses[`legacy-${qid}`] = state;
  }
  return {
    allQuestions,
    progressDocument: {
      questionStatuses,
      wrongQuestionIds: Object.entries(questionStatuses)
        .filter(([, state]) => state === 2)
        .map(([id]) => id),
      progress: {}
    },
    settingsDocument: {
      filteredQuestionIds: allQuestions.map(question => question.id),
      currentIndex: 344
    }
  };
}

function createImageAssets(bundle) {
  return Object.fromEntries(bundle.imageNames.map(name => [
    name,
    {
      imageName: name,
      imagePath: `users/test/questions/migrations/${bundle.migrationManifest.migrationId}/${name}`,
      imageUrl: `http://127.0.0.1:9199/${encodeURIComponent(name)}`
    }
  ]));
}

test("正式化レポートから旧345問・新350問・移行マニフェストを厳密に読み込む", async () => {
  const bundle = await getBundle();
  assert.equal(bundle.oldByQid.size, 345);
  assert.equal(bundle.newByQid.size, 350);
  assert.equal(bundle.migrationManifest.records.length, 362);
  assert.equal(bundle.imageNames.length, 17);
});

test("345→350のdry-run計画は書込みを行わず期待件数を返す", async () => {
  const bundle = await getBundle();
  const source = createSourceState(bundle, qid => Number(qid.slice(1)) % 3 || null);
  const plan = buildMigrationPlan(source, bundle);
  const report = buildDryRunReport(source, plan, bundle);
  assert.equal(report.writesPerformed, 0);
  assert.equal(report.source.questionCount, 345);
  assert.equal(report.target.questionCount, 350);
  assert.equal(report.operations.new, 17);
  assert.equal(report.operations.replaced, 4);
  assert.equal(report.operations.mergeGroups, 9);
  assert.equal(report.operations.removedSourceRecords, 16);
});

test("移行後350問は新正式questions.jsonと全件一致しexplanationも更新される", async () => {
  const bundle = await getBundle();
  const source = createSourceState(bundle);
  const plan = buildMigrationPlan(source, bundle);
  const assets = createImageAssets(bundle);
  const migrated = materializeMigratedState(source, plan, assets);
  const verification = verifyMigratedState(migrated, bundle, plan, assets);
  assert.equal(verification.valid, true, JSON.stringify(verification.errors));
  assert.equal(verification.targetQuestionCount, 350);
  assert.deepEqual(verification.chapterCounts, {
    "1章_歯科診療補助の概要": 17,
    "2章_医療安全と感染予防": 212,
    "3章_歯科診療における基礎知識": 50,
    "4章_歯科診療補助における基礎知識": 71
  });
  assert.equal(verification.imageQuestionCount, 21);
  assert.equal(verification.imageAssetCount, 17);
});

test("引継ぎ問題のruntime idと学習状態を維持する", async () => {
  const bundle = await getBundle();
  const source = createSourceState(bundle, qid => qid === "Q0001" ? 1 : null);
  const plan = buildMigrationPlan(source, bundle);
  const migrated = materializeMigratedState(source, plan, createImageAssets(bundle));
  const q0001 = migrated.allQuestions.find(question =>
    question.subject === "歯科診療補助" &&
    question.question === bundle.newByQid.get("Q0001").question
  );
  assert.equal(q0001.id, "legacy-Q0001");
  assert.equal(migrated.progressDocument.questionStatuses[q0001.id], 1);
});

test("REPLACEDとNEWは決定的IDを使い未回答で開始する", async () => {
  const bundle = await getBundle();
  const source = createSourceState(bundle, () => 1);
  const plan = buildMigrationPlan(source, bundle);
  const migrated = materializeMigratedState(source, plan, createImageAssets(bundle));
  for (const qid of ["Q0346", "Q0350"]) {
    const blueprint = plan.blueprints.find(item => item.questionId === qid);
    assert.equal(
      blueprint.recordId,
      deterministicRuntimeId(bundle.migrationManifest.migrationId, qid)
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        migrated.progressDocument.questionStatuses,
        blueprint.recordId
      ),
      false
    );
  }
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      migrated.progressDocument.questionStatuses,
      "legacy-Q0058"
    ),
    false
  );
});

test("MERGEDは全てできるなら1、いずれかまだなら2、未回答を含めばnullにする", () => {
  assert.equal(aggregateMergedState([1, 1]), 1);
  assert.equal(aggregateMergedState([1, 2, null]), 2);
  assert.equal(aggregateMergedState([1, null]), null);
  assert.equal(aggregateMergedState([null, null]), null);
});

test("統合元の学習状態を集約し孤立状態を残さない", async () => {
  const bundle = await getBundle();
  const source = createSourceState(bundle, qid => {
    if (qid === "Q0125") return 1;
    if (qid === "Q0126") return 2;
    return null;
  });
  const plan = buildMigrationPlan(source, bundle);
  const migrated = materializeMigratedState(source, plan, createImageAssets(bundle));
  assert.equal(migrated.progressDocument.questionStatuses["legacy-Q0125"], 2);
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      migrated.progressDocument.questionStatuses,
      "legacy-Q0126"
    ),
    false
  );
  assert.equal(
    migrated.progressDocument.wrongQuestionIds.includes("legacy-Q0125"),
    true
  );
});

test("旧問題不足・余分問題・不明状態では書込み計画を作らず停止する", async () => {
  const bundle = await getBundle();
  const missing = createSourceState(bundle);
  missing.allQuestions.pop();
  assert.throws(() => buildMigrationPlan(missing, bundle), /345問/);

  const unknown = createSourceState(bundle);
  unknown.progressDocument.questionStatuses["legacy-Q0001"] = 9;
  assert.throws(() => buildMigrationPlan(unknown, bundle), /不明な学習状態/);
});

test("移行後の学習状態件数を再計算できる", async () => {
  const bundle = await getBundle();
  const source = createSourceState(bundle, qid => {
    const number = Number(qid.slice(1));
    if (number % 3 === 0) return 1;
    if (number % 3 === 1) return 2;
    return null;
  });
  const plan = buildMigrationPlan(source, bundle);
  const migrated = materializeMigratedState(source, plan, createImageAssets(bundle));
  const counts = summarizeLearningStates(migrated);
  assert.equal(counts.total, 350);
  assert.equal(counts.known + counts.weak + counts.unanswered, 350);
});
