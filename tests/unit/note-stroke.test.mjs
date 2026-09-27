import assert from "node:assert/strict";
import test from "node:test";
import { strokeSegments } from "../../js/core/note-stroke.js";

test("旧形式でpressureEnabledのストロークは互換表示のため点ごとの筆圧を反映できる", () => {
  const segments = strokeSegments([
    { x: 0, y: 0, pressure: .1 },
    { x: .5, y: .5, pressure: .5 },
    { x: 1, y: 1, pressure: 1 }
  ], .01, true);
  assert.equal(segments.length, 2);
  assert.ok(segments[0].width < segments[1].width);
});

test("旧strokeとhighlighter相当はpressure値があっても固定幅を維持する", () => {
  const segments = strokeSegments([
    { x: 0, y: 0, pressure: .1 },
    { x: .5, y: .5, pressure: 1 },
    { x: 1, y: 1, pressure: .2 }
  ], .01, false);
  assert.deepEqual(segments.map(segment => segment.width), [.01, .01]);
});
