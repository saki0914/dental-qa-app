import assert from "node:assert/strict";
import test from "node:test";

import {
  filterImageMemoryMaterials,
  getImageMemoryCategories,
  normalizeImageMaterial,
  normalizeImageMemoryFilter
} from "../../js/core/image-memory-filters.js";

const materials = [
  { id: "m1", title: "保存1", subject: "保存", categories: ["1章", "基礎"] },
  { id: "m2", title: "保存2", subject: "保存", categories: ["2章"] },
  { id: "m3", title: "補綴1", subject: "補綴", categories: ["1章", "臨床"] }
];

test("旧tagsをカテゴリとして引き継ぎ、教科未登録は未分類にする", () => {
  const migrated = normalizeImageMaterial({ id: "legacy", tags: ["旧章", "旧章", ""] });
  assert.equal(migrated.subject, "未分類");
  assert.deepEqual(migrated.categories, ["旧章"]);
  assert.deepEqual(migrated.tags, ["旧章"]);
});

test("選択した教科に属するカテゴリだけを返す", () => {
  assert.deepEqual(getImageMemoryCategories(materials, "保存"), ["1章", "2章", "基礎"]);
  assert.deepEqual(getImageMemoryCategories(materials, "補綴"), ["1章", "臨床"]);
});

test("教科変更後に存在しないカテゴリを解除する", () => {
  assert.deepEqual(normalizeImageMemoryFilter(materials, {
    subject: "補綴",
    category: "基礎"
  }), { subject: "補綴", category: "" });
});

test("教科とカテゴリと検索語をANDで絞り込む", () => {
  const filtered = filterImageMemoryMaterials(materials, {
    subject: "保存",
    category: "1章",
    query: "基礎"
  });
  assert.deepEqual(filtered.map(material => material.id), ["m1"]);
});
