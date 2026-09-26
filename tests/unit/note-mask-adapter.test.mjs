import assert from "node:assert/strict";
import test from "node:test";
import { getMaterialPageMasks, normalizeMaterialMask } from "../../js/core/note-mask-adapter.js";

test("既存0〜100マスクを表示時だけ0〜1へ変換する", () => {
  const source = { id: "m1", page: 2, x: 20, y: 15, width: 30, height: 10, weak: true };
  assert.deepEqual(normalizeMaterialMask(source), { id: "m1", x: .2, y: .15, width: .3, height: .1, weak: true, readOnly: true, source: "material" });
  assert.equal(source.x, 20);
});

test("対象ページの既存教材マスクだけを返す", () => {
  const result = getMaterialPageMasks({ masks: [{ id: "a", page: 1, x: 0, y: 0, width: 10, height: 10 }, { id: "b", page: 2, x: 0, y: 0, width: 10, height: 10 }] }, 2);
  assert.deepEqual(result.map(mask => mask.id), ["b"]);
});
