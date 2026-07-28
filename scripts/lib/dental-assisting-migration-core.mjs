import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export const TARGET_SUBJECT = "歯科診療補助";
export const EXPECTED_OLD_COUNT = 345;
export const EXPECTED_NEW_COUNT = 350;
export const EXPECTED_CHAPTER_COUNTS = {
  "1章_歯科診療補助の概要": 17,
  "2章_医療安全と感染予防": 212,
  "3章_歯科診療における基礎知識": 50,
  "4章_歯科診療補助における基礎知識": 71
};
export const EXPECTED_IMAGE_QUESTION_COUNT = 21;
export const EXPECTED_IMAGE_COUNT = 17;

const APP_FIELDS = [
  "subject",
  "subcategories",
  "question",
  "answers",
  "orderedAnswers",
  "imageFile",
  "explanation"
];

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export async function imageTreeSha256(imagesDirectory) {
  const names = (await readdir(imagesDirectory, { withFileTypes: true }))
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
    .sort();
  const digest = createHash("sha256");
  for (const name of names) {
    digest.update(name);
    digest.update("\0");
    digest.update(await sha256File(join(imagesDirectory, name)));
    digest.update("\n");
  }
  return digest.digest("hex");
}

function normalizeFormalQuestion(question) {
  const result = {};
  for (const field of APP_FIELDS) {
    if (field === "orderedAnswers") {
      result.orderedAnswers = question?.orderedAnswers === true;
    } else if (field === "imageFile") {
      result.imageFile = String(question?.imageFile || "");
    } else if (field === "subcategories" || field === "answers") {
      result[field] = Array.isArray(question?.[field]) ? [...question[field]] : [];
    } else {
      result[field] = String(question?.[field] || "");
    }
  }
  return result;
}

function normalizeStoredQuestion(question) {
  return {
    subject: String(question?.subject || ""),
    subcategories: Array.isArray(question?.subcategories) ? [...question.subcategories] : [],
    question: String(question?.question || ""),
    answers: Array.isArray(question?.answers) ? question.answers.map(String) : [],
    orderedAnswers: question?.orderedAnswers === true,
    imageFile: String(question?.imageFile || question?.imageName || ""),
    explanation: String(question?.explanation || "")
  };
}

export function exactQuestionKey(question, source = "formal") {
  const normalized = source === "stored"
    ? normalizeStoredQuestion(question)
    : normalizeFormalQuestion(question);
  return stableJson(normalized);
}

function assert(condition, message, detail = undefined) {
  if (!condition) {
    const error = new Error(message);
    if (detail !== undefined) error.detail = detail;
    throw error;
  }
}

function buildQuestionIdMap(questions, mapping, provenance = undefined) {
  let ids;
  if (Array.isArray(mapping?.questionDetails)) {
    ids = [...mapping.questionDetails]
      .sort((left, right) => left.placementIndex - right.placementIndex)
      .map(row => row.questionId);
  } else if (Array.isArray(provenance)) {
    ids = provenance.map(row => row.question_id);
  } else {
    throw new Error("questionIdの並びを側面ファイルから取得できません。");
  }
  assert(ids.length === questions.length, "questionId数と問題数が一致しません。", {
    questionCount: questions.length,
    questionIdCount: ids.length
  });
  assert(new Set(ids).size === ids.length, "questionIdが重複しています。");
  return new Map(ids.map((id, index) => [id, normalizeFormalQuestion(questions[index])]));
}

function countChapters(questions) {
  const counts = {};
  questions.forEach(question => {
    const chapter = question.subcategories?.[0] || "";
    counts[chapter] = (counts[chapter] || 0) + 1;
  });
  return counts;
}

function compareCounts(actual, expected) {
  return stableJson(actual) === stableJson(expected);
}

function validateManifestRecords(manifest, oldByQid, newByQid) {
  assert(Array.isArray(manifest.records), "移行マニフェストrecordsがありません。");
  const oldIds = manifest.records
    .map(record => record.oldQuestionId)
    .filter(Boolean);
  const newIds = manifest.records
    .map(record => record.newQuestionId)
    .filter(Boolean);
  assert(oldIds.length === oldByQid.size, "全旧問題の対応がありません。", {
    mapped: oldIds.length,
    expected: oldByQid.size
  });
  assert(new Set(oldIds).size === oldByQid.size, "旧questionIdの対応が一意ではありません。");
  assert(
    [...oldByQid.keys()].every(id => oldIds.includes(id)),
    "移行マニフェストに不足する旧questionIdがあります。"
  );
  assert(
    new Set(newIds).size === newByQid.size &&
      [...newByQid.keys()].every(id => newIds.includes(id)),
    "移行マニフェストが新350問を一意に網羅していません。"
  );
}

export async function loadMigrationBundle(formalizationReportPath) {
  const reportPath = resolve(formalizationReportPath);
  const formalization = JSON.parse(await readFile(reportPath, "utf8"));
  assert(formalization.formalizationResult === "pass", "正式化済みrunではありません。");
  const newRun = resolve(formalization.newFormalRun);
  const oldRun = resolve(formalization.oldFormalRun);
  assert(dirname(reportPath) === newRun, "formalization_report.jsonと新正式runが一致しません。");

  const [
    oldQuestions,
    oldMapping,
    oldProvenance,
    newQuestions,
    newMapping,
    migrationManifest,
    releaseManifest,
    unresolvedText
  ] = await Promise.all([
    readFile(join(oldRun, "questions.json"), "utf8").then(JSON.parse),
    readFile(join(oldRun, "question_mapping.json"), "utf8").then(JSON.parse),
    readFile(join(oldRun, "provenance.json"), "utf8").then(JSON.parse),
    readFile(join(newRun, "questions.json"), "utf8").then(JSON.parse),
    readFile(join(newRun, "question_mapping.json"), "utf8").then(JSON.parse),
    readFile(join(newRun, "app_migration_manifest_345_to_350.json"), "utf8").then(JSON.parse),
    readFile(join(newRun, "release_manifest.json"), "utf8").then(JSON.parse),
    readFile(join(newRun, "unresolved_items.md"), "utf8")
  ]);

  assert(oldQuestions.length === EXPECTED_OLD_COUNT, "移行元正式runは345問ではありません。");
  assert(newQuestions.length === EXPECTED_NEW_COUNT, "移行先正式runは350問ではありません。");
  assert(
    compareCounts(countChapters(newQuestions), EXPECTED_CHAPTER_COUNTS),
    "移行先の章別件数が一致しません。",
    countChapters(newQuestions)
  );
  assert(
    newQuestions.every(question => question.subject === TARGET_SUBJECT),
    "移行先に対象外subjectがあります。"
  );

  const questionsSha256 = await sha256File(join(newRun, "questions.json"));
  const imagesSha256 = await imageTreeSha256(join(newRun, "images"));
  assert(
    questionsSha256 === releaseManifest.questionsSha256,
    "questions.jsonのSHA-256がrelease_manifestと一致しません。"
  );
  assert(
    imagesSha256 === releaseManifest.imagesTreeSha256,
    "images/tree SHA-256がrelease_manifestと一致しません。"
  );
  assert(unresolvedText.includes("0件"), "新正式runに未解決項目があります。");

  const imageQuestionCount = newQuestions.filter(question => question.imageFile).length;
  const imageNames = (await readdir(join(newRun, "images"), { withFileTypes: true }))
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
    .sort();
  assert(
    imageQuestionCount === EXPECTED_IMAGE_QUESTION_COUNT,
    "画像問題数が21問ではありません。"
  );
  assert(imageNames.length === EXPECTED_IMAGE_COUNT, "画像ファイル数が17件ではありません。");
  assert(
    new Set(newQuestions.filter(question => question.imageFile).map(question => question.imageFile))
      .size === imageNames.length,
    "画像参照と画像ファイルが一致しません。"
  );
  assert(
    imageNames.every(name =>
      newQuestions.some(question => basename(question.imageFile || "") === name)
    ),
    "未使用画像があります。"
  );

  const oldByQid = buildQuestionIdMap(oldQuestions, oldMapping, oldProvenance);
  const newByQid = buildQuestionIdMap(newQuestions, newMapping);
  validateManifestRecords(migrationManifest, oldByQid, newByQid);

  return {
    reportPath,
    formalization,
    oldRun,
    newRun,
    oldQuestions,
    newQuestions,
    oldByQid,
    newByQid,
    migrationManifest,
    releaseManifest,
    imageNames,
    imagesDirectory: join(newRun, "images"),
    hashes: {
      oldQuestionsSha256: await sha256File(join(oldRun, "questions.json")),
      newQuestionsSha256: questionsSha256,
      newImagesTreeSha256: imagesSha256
    }
  };
}

export function resolveOldRuntimeRecords(allQuestions, bundle) {
  const targetQuestions = allQuestions.filter(question => question.subject === TARGET_SUBJECT);
  assert(targetQuestions.length === EXPECTED_OLD_COUNT, "Firestoreの移行元問題数が345問ではありません。", {
    actual: targetQuestions.length
  });
  const runtimeByKey = new Map();
  targetQuestions.forEach(question => {
    assert(typeof question.id === "string" && question.id, "問題レコードにidがありません。");
    const key = exactQuestionKey(question, "stored");
    assert(!runtimeByKey.has(key), "Firestoreに同一内容の旧問題が重複しています。");
    runtimeByKey.set(key, question);
  });

  const runtimeByQid = new Map();
  const missing = [];
  bundle.oldByQid.forEach((formalQuestion, qid) => {
    const runtime = runtimeByKey.get(exactQuestionKey(formalQuestion, "formal"));
    if (!runtime) missing.push(qid);
    else runtimeByQid.set(qid, runtime);
  });
  assert(!missing.length, "Firestoreと旧正式345問を一意に対応付けられません。", { missing });
  assert(
    new Set([...runtimeByQid.values()].map(question => question.id)).size === EXPECTED_OLD_COUNT,
    "複数の旧questionIdが同じruntime idへ対応しています。"
  );
  return runtimeByQid;
}

export function deterministicRuntimeId(migrationId, questionId) {
  return `da-${sha256Text(`${migrationId}:${questionId}`).slice(0, 28)}`;
}

export function aggregateMergedState(states) {
  assert(
    states.every(state => state === null || state === 1 || state === 2),
    "統合元に不明な学習状態があります。",
    states
  );
  if (states.some(state => state === 2)) return 2;
  if (states.length && states.every(state => state === 1)) return 1;
  return null;
}

function readQuestionState(questionStatuses, runtimeId) {
  if (!Object.prototype.hasOwnProperty.call(questionStatuses, runtimeId)) return null;
  const value = questionStatuses[runtimeId];
  assert(value === 1 || value === 2, "不明な学習状態があります。", {
    runtimeId,
    value
  });
  return value;
}

function buildGroups(records) {
  const groups = new Map();
  records.forEach(record => {
    if (!record.newQuestionId) return;
    if (!groups.has(record.newQuestionId)) groups.set(record.newQuestionId, []);
    groups.get(record.newQuestionId).push(record);
  });
  return groups;
}

function createBlueprint(formalQuestion, recordId, questionId, group, sourceRuntimeIds, state) {
  const classifications = [...new Set(group.map(record => record.classification))].sort();
  return {
    questionId,
    recordId,
    formalQuestion,
    imageFile: formalQuestion.imageFile,
    classifications,
    sourceQuestionIds: group.map(record => record.oldQuestionId).filter(Boolean),
    sourceRuntimeIds,
    learningState: state
  };
}

export function buildMigrationPlan(currentState, bundle) {
  const allQuestions = currentState.allQuestions || [];
  const questionStatuses = currentState.progressDocument?.questionStatuses || {};
  const runtimeByQid = resolveOldRuntimeRecords(allQuestions, bundle);
  const allRuntimeIds = new Set(allQuestions.map(question => question.id));
  const orphanStatusIds = Object.keys(questionStatuses).filter(id => !allRuntimeIds.has(id));
  assert(!orphanStatusIds.length, "移行前に孤立学習状態があります。", { orphanStatusIds });
  const unknownStatuses = Object.entries(questionStatuses)
    .filter(([, value]) => value !== 1 && value !== 2);
  assert(!unknownStatuses.length, "移行前に不明な学習状態があります。", { unknownStatuses });

  const groups = buildGroups(bundle.migrationManifest.records);
  const blueprints = [];
  const preservedRuntimeIds = new Set();
  const resetRuntimeIds = new Set();
  const removedRuntimeIds = new Set();

  bundle.newByQid.forEach((formalQuestion, newQuestionId) => {
    const group = groups.get(newQuestionId) || [];
    assert(group.length, `新問題${newQuestionId}の移行記録がありません。`);
    const sourceQuestionIds = group.map(record => record.oldQuestionId).filter(Boolean);
    const sourceRuntimeIds = sourceQuestionIds.map(qid => runtimeByQid.get(qid)?.id);
    assert(
      sourceRuntimeIds.every(Boolean),
      `新問題${newQuestionId}の移行元runtime idを解決できません。`
    );

    const classifications = new Set(group.map(record => record.classification));
    let recordId;
    let state = null;
    if (classifications.has("NEW")) {
      assert(!sourceRuntimeIds.length, `NEW ${newQuestionId}に移行元があります。`);
      recordId = deterministicRuntimeId(bundle.migrationManifest.migrationId, newQuestionId);
      assert(!allRuntimeIds.has(recordId), `新規決定ID ${recordId} が既存問題と衝突します。`);
    } else if (classifications.has("REPLACED")) {
      assert(sourceRuntimeIds.length === 1, `REPLACED ${newQuestionId}の移行元が一意ではありません。`);
      recordId = deterministicRuntimeId(bundle.migrationManifest.migrationId, newQuestionId);
      assert(!allRuntimeIds.has(recordId), `置換決定ID ${recordId} が既存問題と衝突します。`);
      resetRuntimeIds.add(recordId);
      removedRuntimeIds.add(sourceRuntimeIds[0]);
    } else if (classifications.has("MERGED")) {
      const representative = runtimeByQid.get(newQuestionId);
      assert(representative, `MERGED ${newQuestionId}に代表旧問題がありません。`);
      recordId = representative.id;
      state = aggregateMergedState(
        sourceRuntimeIds.map(id => readQuestionState(questionStatuses, id))
      );
      sourceRuntimeIds.filter(id => id !== recordId).forEach(id => removedRuntimeIds.add(id));
      preservedRuntimeIds.add(recordId);
    } else {
      assert(sourceRuntimeIds.length === 1, `${newQuestionId}の引継ぎ元が一意ではありません。`);
      recordId = sourceRuntimeIds[0];
      const preserve = group.every(record => record.preserveLearningState === true);
      state = preserve ? readQuestionState(questionStatuses, recordId) : null;
      if (preserve) preservedRuntimeIds.add(recordId);
      else resetRuntimeIds.add(recordId);
    }
    blueprints.push(
      createBlueprint(
        formalQuestion,
        recordId,
        newQuestionId,
        group,
        sourceRuntimeIds,
        state
      )
    );
  });

  assert(blueprints.length === EXPECTED_NEW_COUNT, "移行計画が350問ではありません。");
  assert(
    new Set(blueprints.map(blueprint => blueprint.recordId)).size === EXPECTED_NEW_COUNT,
    "移行後runtime idが重複しています。"
  );

  const targetIndices = allQuestions
    .map((question, index) => question.subject === TARGET_SUBJECT ? index : -1)
    .filter(index => index >= 0);
  const insertionIndex = targetIndices[0] ?? allQuestions.length;
  const otherQuestions = allQuestions.filter(question => question.subject !== TARGET_SUBJECT);

  return {
    migrationId: bundle.migrationManifest.migrationId,
    runtimeByQid,
    blueprints,
    insertionIndex,
    otherQuestions,
    preservedRuntimeIds: [...preservedRuntimeIds].sort(),
    resetRuntimeIds: [...resetRuntimeIds].sort(),
    removedRuntimeIds: [...removedRuntimeIds].sort(),
    operationCounts: {
      sourceQuestions: EXPECTED_OLD_COUNT,
      finalQuestions: EXPECTED_NEW_COUNT,
      updatedOrMerged: blueprints.filter(item => item.sourceRuntimeIds.length > 0).length,
      new: blueprints.filter(item => item.classifications.includes("NEW")).length,
      replaced: blueprints.filter(item => item.classifications.includes("REPLACED")).length,
      mergeGroups: blueprints.filter(item => item.classifications.includes("MERGED")).length,
      removedSourceRecords: removedRuntimeIds.size,
      imagesToStage: bundle.imageNames.length
    }
  };
}

function createRuntimeQuestion(blueprint, imageAssets) {
  const question = blueprint.formalQuestion;
  const image = question.imageFile ? imageAssets?.[question.imageFile] : null;
  if (question.imageFile) {
    assert(image?.imagePath && image?.imageUrl, `画像${question.imageFile}の準備が完了していません。`);
  }
  return {
    id: blueprint.recordId,
    subject: question.subject,
    subcategories: [...question.subcategories],
    question: question.question,
    answers: [...question.answers],
    explanation: question.explanation,
    imageUrl: image?.imageUrl || "",
    imagePath: image?.imagePath || "",
    imageName: question.imageFile || "",
    orderedAnswers: question.orderedAnswers === true
  };
}

export function materializeMigratedState(currentState, plan, imageAssets) {
  const targetQuestions = plan.blueprints.map(blueprint =>
    createRuntimeQuestion(blueprint, imageAssets)
  );
  const before = currentState.allQuestions.slice(0, plan.insertionIndex)
    .filter(question => question.subject !== TARGET_SUBJECT);
  const after = currentState.allQuestions.slice(plan.insertionIndex)
    .filter(question => question.subject !== TARGET_SUBJECT);
  const allQuestions = [...before, ...targetQuestions, ...after];

  const previousStatuses = currentState.progressDocument?.questionStatuses || {};
  const finalIds = new Set(allQuestions.map(question => question.id));
  const questionStatuses = {};
  Object.entries(previousStatuses).forEach(([id, state]) => {
    if (finalIds.has(id) && !plan.blueprints.some(item => item.recordId === id)) {
      questionStatuses[id] = state;
    }
  });
  plan.blueprints.forEach(blueprint => {
    if (blueprint.learningState === 1 || blueprint.learningState === 2) {
      questionStatuses[blueprint.recordId] = blueprint.learningState;
    }
  });
  const wrongQuestionIds = allQuestions
    .filter(question => questionStatuses[question.id] === 2)
    .map(question => question.id);
  const progress = {};
  allQuestions.forEach(question => {
    if (!progress[question.subject]) progress[question.subject] = { known: 0, unknown: 0 };
    const state = questionStatuses[question.id];
    if (state === 1 || state === 2) progress[question.subject].known += 1;
    if (state === 2) progress[question.subject].unknown += 1;
  });

  const settingsDocument = { ...(currentState.settingsDocument || {}) };
  if (Array.isArray(settingsDocument.filteredQuestionIds)) {
    settingsDocument.filteredQuestionIds = [
      ...new Set(settingsDocument.filteredQuestionIds.filter(id => finalIds.has(id)))
    ];
  }
  if (Number.isInteger(settingsDocument.currentIndex)) {
    settingsDocument.currentIndex = Math.min(
      settingsDocument.currentIndex,
      Math.max(0, allQuestions.length - 1)
    );
  }

  return {
    allQuestions,
    progressDocument: {
      ...(currentState.progressDocument || {}),
      progress,
      questionStatuses,
      wrongQuestionIds
    },
    settingsDocument
  };
}

export function verifyMigratedState(migratedState, bundle, plan, imageAssets) {
  const errors = [];
  const target = migratedState.allQuestions.filter(question => question.subject === TARGET_SUBJECT);
  if (target.length !== EXPECTED_NEW_COUNT) {
    errors.push({ code: "target_count", actual: target.length, expected: EXPECTED_NEW_COUNT });
  }
  const runtimeById = new Map(target.map(question => [question.id, question]));
  const targetKeys = new Set(target.map(question => exactQuestionKey(question, "stored")));
  const expectedKeys = new Set([...bundle.newByQid.values()].map(exactQuestionKey));
  if (targetKeys.size !== EXPECTED_NEW_COUNT || stableJson([...targetKeys].sort()) !== stableJson([...expectedKeys].sort())) {
    errors.push({ code: "content_mismatch" });
  }
  if (new Set(target.map(question => question.id)).size !== target.length) {
    errors.push({ code: "duplicate_runtime_id" });
  }
  const chapterCounts = countChapters(target);
  if (!compareCounts(chapterCounts, EXPECTED_CHAPTER_COUNTS)) {
    errors.push({ code: "chapter_counts", actual: chapterCounts });
  }
  const statuses = migratedState.progressDocument?.questionStatuses || {};
  const allIds = new Set(migratedState.allQuestions.map(question => question.id));
  const orphanStatuses = Object.keys(statuses).filter(id => !allIds.has(id));
  if (orphanStatuses.length) errors.push({ code: "orphan_status", ids: orphanStatuses });
  const wrongIds = migratedState.progressDocument?.wrongQuestionIds || [];
  const expectedWrong = migratedState.allQuestions
    .filter(question => statuses[question.id] === 2)
    .map(question => question.id);
  if (stableJson(wrongIds) !== stableJson(expectedWrong)) {
    errors.push({ code: "wrong_question_ids" });
  }
  plan.removedRuntimeIds.forEach(id => {
    if (runtimeById.has(id) || Object.prototype.hasOwnProperty.call(statuses, id)) {
      errors.push({ code: "retired_runtime_id_remaining", id });
    }
  });
  target.filter(question => question.imageName).forEach(question => {
    const asset = imageAssets?.[question.imageName];
    if (
      !asset ||
      question.imagePath !== asset.imagePath ||
      question.imageUrl !== asset.imageUrl
    ) {
      errors.push({ code: "image_reference", id: question.id, imageName: question.imageName });
    }
  });
  const imageQuestionCount = target.filter(question => question.imageName).length;
  if (imageQuestionCount !== EXPECTED_IMAGE_QUESTION_COUNT) {
    errors.push({ code: "image_question_count", actual: imageQuestionCount });
  }
  return {
    valid: errors.length === 0,
    errors,
    targetQuestionCount: target.length,
    chapterCounts,
    imageQuestionCount,
    imageAssetCount: Object.keys(imageAssets || {}).length,
    orphanStatusCount: orphanStatuses.length,
    migratedContentSha256: sha256Text(stableJson(target.map(normalizeStoredQuestion)))
  };
}

export function summarizeLearningStates(state, subject = TARGET_SUBJECT) {
  const questions = state.allQuestions.filter(question => question.subject === subject);
  const statuses = state.progressDocument?.questionStatuses || {};
  return {
    total: questions.length,
    known: questions.filter(question => statuses[question.id] === 1).length,
    weak: questions.filter(question => statuses[question.id] === 2).length,
    unanswered: questions.filter(question => statuses[question.id] !== 1 && statuses[question.id] !== 2).length
  };
}

export function buildDryRunReport(currentState, plan, bundle) {
  return {
    schemaVersion: "1.0",
    migrationId: plan.migrationId,
    mode: "dry-run",
    writesPerformed: 0,
    source: {
      questionCount: EXPECTED_OLD_COUNT,
      hash: bundle.hashes.oldQuestionsSha256,
      learningStates: summarizeLearningStates(currentState)
    },
    target: {
      questionCount: EXPECTED_NEW_COUNT,
      hash: bundle.hashes.newQuestionsSha256,
      chapterCounts: EXPECTED_CHAPTER_COUNTS,
      imageQuestions: EXPECTED_IMAGE_QUESTION_COUNT,
      images: EXPECTED_IMAGE_COUNT
    },
    operations: plan.operationCounts,
    learningStatePolicy: bundle.migrationManifest.mergeStatePolicy,
    preservedRuntimeIdCount: plan.preservedRuntimeIds.length,
    resetRuntimeIdCount: plan.resetRuntimeIds.length,
    removedRuntimeIdCount: plan.removedRuntimeIds.length,
    productionWrites: 0,
    result: "pass"
  };
}
