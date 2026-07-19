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
  assert.deepEqual(getStudyPrimaryCategories(questions, ["保存"]), ["1章", "2章"]);
  assert.deepEqual(getStudyRelatedCategories(questions, ["保存"], ["1章"]), ["基礎", "臨床", "頻出"]);
});

test("複数教科・複数章をOR条件で横断する", () => {
  const filtered = filterQuestionsForStudy(questions, {
    selectedSubjects: ["保存", "補綴"],
    selectedPrimaryCategories: ["2章", "1章"]
  });
  assert.deepEqual(filtered.map(question => question.id), ["q1", "q2", "q3", "q4"]);
});

test("追加カテゴリは複数教科・章の対象内でAND条件にする", () => {
  const filtered = filterQuestionsForStudy(questions, {
    selectedSubjects: ["保存", "補綴"],
    selectedPrimaryCategories: ["1章", "2章"],
    selectedRelatedCategories: ["基礎", "頻出"]
  });
  assert.deepEqual(filtered.map(question => question.id), ["q1"]);

  const noMatches = filterQuestionsForStudy(questions, {
    selectedSubjects: ["保存"],
    selectedPrimaryCategories: ["1章"],
    selectedRelatedCategories: ["臨床", "頻出"]
  });
  assert.deepEqual(noMatches, []);
});

test("教科変更後も有効な章を維持し、無効な条件だけ破棄する", () => {
  assert.deepEqual(normalizeStudySelection(questions, {
    selectedSubjects: ["補綴", "存在しない教科"],
    selectedPrimaryCategories: ["1章", "2章"],
    selectedRelatedCategories: ["頻出", "応用"]
  }), {
    selectedSubjects: ["補綴"],
    selectedPrimaryCategories: ["1章"],
    selectedRelatedCategories: ["頻出"]
  });
});

test("旧単一選択形式を複数選択形式へ移行する", () => {
  assert.deepEqual(normalizeStudySelection(questions, {
    subject: "保存",
    primaryCategory: "1章",
    selectedRelatedCategories: ["基礎"]
  }), {
    selectedSubjects: ["保存"],
    selectedPrimaryCategories: ["1章"],
    selectedRelatedCategories: ["基礎"]
  });
});

test("表示対象だけからカウンターを計算する", () => {
  assert.deepEqual(calculateStudyCounters(questions.slice(0, 3), 1, {
    q1: 1,
    q2: 2,
    q4: 1
  }), { total: 3, current: 2, known: 1, weak: 1 });
});
