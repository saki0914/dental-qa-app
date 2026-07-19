import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateStudyCounters,
  filterQuestionsForStudy,
  getStudyPrimaryCategories,
  getStudyRelatedCategories,
  migrateStudyConditionGroups,
  normalizeStudyCondition,
  normalizeStudyConditionGroups
} from "../../js/core/study-filters.js";

const questions = [
  { id: "q1", subject: "保存", subcategories: ["1章", "基礎", "頻出"] },
  { id: "q2", subject: "保存", subcategories: ["1章", "基礎", "臨床"] },
  { id: "q3", subject: "保存", subcategories: ["2章", "応用"] },
  { id: "q4", subject: "補綴", subcategories: ["1章", "頻出"] }
];

test("選択中の教科と章に属する追加カテゴリだけを返す", () => {
  assert.deepEqual(getStudyPrimaryCategories(questions, "保存"), ["1章", "2章"]);
  assert.deepEqual(getStudyRelatedCategories(questions, "保存", "1章"), ["基礎", "臨床", "頻出"]);
});

test("追加した条件同士をORで評価して教科と章を横断する", () => {
  const filtered = filterQuestionsForStudy(questions, {
    conditionGroups: [
      { subject: "保存", primaryCategory: "2章", selectedRelatedCategories: [] },
      { subject: "補綴", primaryCategory: "1章", selectedRelatedCategories: ["頻出"] }
    ]
  });
  assert.deepEqual(filtered.map(question => question.id), ["q3", "q4"]);
});

test("各条件内では章と追加カテゴリをANDで評価する", () => {
  const filtered = filterQuestionsForStudy(questions, {
    draftCondition: {
      subject: "保存",
      primaryCategory: "1章",
      selectedRelatedCategories: ["基礎", "頻出"]
    }
  });
  assert.deepEqual(filtered.map(question => question.id), ["q1"]);
});

test("同名の章が別教科にあっても条件の教科を厳密に評価する", () => {
  const filtered = filterQuestionsForStudy(questions, {
    conditionGroups: [
      { subject: "補綴", primaryCategory: "1章", selectedRelatedCategories: [] }
    ]
  });
  assert.deepEqual(filtered.map(question => question.id), ["q4"]);
});

test("無効な条件を破棄し重複条件を除去する", () => {
  const condition = { subject: "保存", primaryCategory: "1章", selectedRelatedCategories: ["頻出"] };
  assert.deepEqual(normalizeStudyConditionGroups(questions, [
    condition,
    condition,
    { subject: "存在しない教科", primaryCategory: "1章", selectedRelatedCategories: [] },
    { subject: "保存", primaryCategory: "存在しない章", selectedRelatedCategories: [] }
  ]), [condition]);

  assert.deepEqual(normalizeStudyCondition(questions, {
    subject: "保存",
    primaryCategory: "1章",
    selectedRelatedCategories: ["頻出", "存在しないカテゴリ"]
  }), condition);
});

test("mainの旧条件セットを教科付き条件へ移行する", () => {
  assert.deepEqual(migrateStudyConditionGroups(questions, {
    subjectFilter: "保存",
    subcategoryConditionGroups: [
      ["1章", "頻出"],
      ["2章", "応用"]
    ]
  }), [
    { subject: "保存", primaryCategory: "1章", selectedRelatedCategories: ["頻出"] },
    { subject: "保存", primaryCategory: "2章", selectedRelatedCategories: ["応用"] }
  ]);
});

test("表示対象だけからカウンターを計算する", () => {
  assert.deepEqual(calculateStudyCounters(questions.slice(0, 3), 1, {
    q1: 1,
    q2: 2,
    q4: 1
  }), { total: 3, current: 2, known: 1, weak: 1 });
});
