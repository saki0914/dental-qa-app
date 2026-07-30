import test from "node:test";
import assert from "node:assert/strict";
import {
  findUnsafeEmptyOverwriteAreas,
  mergeCloudState,
  restoreLegacyQuestionStatuses
} from "../../js/core/cloud-sync-state.js";

test("部分的な分割文書は欠損領域だけ旧mainから補完する", () => {
  const result = mergeCloudState({
    main: {
      allQuestions: [{ id: "legacy-question" }],
      pdfMaterials: [{ id: "legacy-material" }],
      progress: { legacy: { known: 1, unknown: 1 } },
      questionStatuses: { "legacy-question": 2 },
      deviceMode: "ipad"
    },
    questions: {
      allQuestions: [{ id: "split-question" }]
    },
    pdfMaterials: null,
    progress: null,
    settings: null
  });

  assert.equal(result.hasData, true);
  assert.equal(result.source, "split-with-legacy-fallback");
  assert.deepEqual(result.state.allQuestions, [{ id: "split-question" }]);
  assert.deepEqual(result.state.pdfMaterials, [{ id: "legacy-material" }]);
  assert.deepEqual(result.state.questionStatuses, { "legacy-question": 2 });
  assert.equal(result.state.deviceMode, "ipad");
});

test("メタデータだけのmainは保存データとして扱わない", () => {
  const result = mergeCloudState({
    main: { schemaVersion: "split-v2", updatedAt: { seconds: 1 } }
  });

  assert.equal(result.hasData, false);
  assert.equal(result.source, "none");
  assert.deepEqual(result.state, {});
});

test("旧wrongQuestionIdsを既存statusを壊さずquestionStatusesへ補完する", () => {
  const restored = restoreLegacyQuestionStatuses({
    questionStatuses: {
      known: 1,
      alreadyWeak: "weak"
    },
    wrongQuestionIds: ["known", "alreadyWeak", "legacyWeak"]
  });

  assert.deepEqual(restored, {
    known: 1,
    alreadyWeak: "weak",
    legacyWeak: 2
  });
});

test("問題・教材・進捗・status・設定の意図しない空上書きを検出する", () => {
  const unsafe = findUnsafeEmptyOverwriteAreas({
    questions: { questionCount: 2 },
    pdfMaterials: { pdfMaterials: [{ id: "material" }] },
    progress: {
      progress: { 保存済み: { known: 1, unknown: 0 } },
      questionStatuses: { q1: 1 },
      wrongQuestionIds: ["q2"]
    },
    settings: {
      deviceMode: "ipad",
      schemaVersion: "split-v2"
    }
  }, {
    questions: { allQuestions: [] },
    pdfMaterials: { pdfMaterials: [] },
    progress: {
      progress: {},
      questionStatuses: {},
      wrongQuestionIds: []
    },
    settings: {
      schemaVersion: "split-v2"
    }
  });

  assert.deepEqual(unsafe, [
    "questions",
    "pdfMaterials",
    "progress",
    "questionStatuses",
    "wrongQuestionIds",
    "settings"
  ]);
});

test("明示的な全削除・進捗リセットは空上書きガードを解除できる", () => {
  const unsafe = findUnsafeEmptyOverwriteAreas({
    questions: { allQuestions: [{ id: "q1" }] },
    pdfMaterials: { pdfMaterials: [{ id: "material" }] },
    progress: {
      progress: { 保存済み: { known: 1, unknown: 0 } },
      questionStatuses: { q1: 1 }
    },
    settings: { deviceMode: "ipad" }
  }, {
    questions: { allQuestions: [] },
    pdfMaterials: { pdfMaterials: [] },
    progress: { progress: {}, questionStatuses: {}, wrongQuestionIds: [] },
    settings: {}
  }, {
    allowEmptyQuestions: true,
    allowEmptyPdfMaterials: true,
    allowEmptyProgress: true,
    allowEmptySettings: true
  });

  assert.deepEqual(unsafe, []);
});
