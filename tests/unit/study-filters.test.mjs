import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateStudyCounters,
  filterQuestionsForStudy,
  getStudyPrimaryCategories,
  getStudyRelatedCategories,
  normalizeStudySelection
} from "../../js/core/study-filters.js";

const questions = [
  { id: "q1", subject: "保存", subcategories: ["1章", "基礎", "頻出"] },
  { id: "q2", subject: "保存", subcategories: ["1章", "基礎", "臨床"] },
  { id: "q3", subject: "保存", subcategories: ["2章", "応用"] },
  { id: "q4", subject: "補綴", subcategories: ["1章", "頻出"] }
];

test("教科に属する章と追加カテゴリだけを返す", () => {
  assert.deepEqual(getStudyPrimaryCategories(questions, "保存"), ["1章", "2章"]);
  assert.deepEqual(getStudyRelatedCategories(questions, "保存", "1章"), ["基礎", "臨床", "頻出"]);
});

test("教科・章・複数カテゴリをAND条件で絞り込む", () => {
  const filtered = filterQuestionsForStudy(questions, {
    subject: "保存",
    primaryCategory: "1章",
    selectedRelatedCategories: ["基礎", "頻出"]
  });
  assert.deepEqual(filtered.map(question => question.id), ["q1"]);

  const noMatches = filterQuestionsForStudy(questions, {
    subject: "保存",
    primaryCategory: "1章",
    selectedRelatedCategories: ["臨床", "頻出"]
  });
  assert.deepEqual(noMatches, []);
});

test("教科変更後に存在しない章とカテゴリを破棄する", () => {
  assert.deepEqual(normalizeStudySelection(questions, {
    subject: "補綴",
    primaryCategory: "2章",
    selectedRelatedCategories: ["応用"]
  }), {
    subject: "補綴",
    primaryCategory: "",
    selectedRelatedCategories: []
  });
});

test("表示対象だけからカウンターを計算する", () => {
  assert.deepEqual(calculateStudyCounters(questions.slice(0, 3), 1, {
    q1: 1,
    q2: 2,
    q4: 1
  }), { total: 3, current: 2, known: 1, weak: 1 });
});
