import assert from "node:assert/strict";
import test from "node:test";
import { clampPageZoom, getTwoPointCenter, getTwoPointDistance } from "../../js/core/page-zoom-controller.js";

test("画像暗記とノートで共通の0.8〜5倍ズーム範囲を使う", () => {
  assert.equal(clampPageZoom(.2), .8);
  assert.equal(clampPageZoom(2.5), 2.5);
  assert.equal(clampPageZoom(8), 5);
});

test("2点の距離と中心を共通計算する", () => {
  const points = [{ clientX: 10, clientY: 10 }, { clientX: 40, clientY: 50 }];
  assert.equal(getTwoPointDistance(points), 50);
  assert.deepEqual(getTwoPointCenter(points), { x: 25, y: 30 });
});
