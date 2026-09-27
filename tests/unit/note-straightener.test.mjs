import assert from "node:assert/strict";
import test from "node:test";
import { canStraightenStroke, straightenedPoints } from "../../js/core/note-straightener.js";

const points = [{ x: .1, y: .1, pressure: .2 }, { x: .3, y: .31, pressure: .9 }];

test("保持時間未満・短すぎる線・移動超過は直線化しない", () => {
  assert.equal(canStraightenStroke({ points, elapsedMs: 649, movementPx: 0 }), false);
  assert.equal(canStraightenStroke({ points, elapsedMs: 700, movementPx: 9 }), false);
  assert.equal(canStraightenStroke({ points: [{ x: .1, y: .1 }, { x: .101, y: .101 }], elapsedMs: 700, movementPx: 0 }), false);
});

test("終点保持後は始点を保ち、終点移動で角度と長さを調整する", () => {
  assert.equal(canStraightenStroke({ points, elapsedMs: 700, movementPx: 2 }), true);
  assert.deepEqual(straightenedPoints(points, { x: .8, y: .6, pressure: .5 }), [
    { x: .1, y: .1, pressure: .2 },
    { x: .8, y: .6, pressure: .5 }
  ]);
});
