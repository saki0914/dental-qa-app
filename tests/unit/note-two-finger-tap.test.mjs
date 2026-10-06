import assert from "node:assert/strict";
import test from "node:test";
import { createTwoFingerTapRecognizer } from "../../js/core/note-two-finger-tap.js";

const touch = (type, pointerId, clientX, clientY, timeStamp) => ({ type, pointerType: "touch", pointerId, clientX, clientY, timeStamp });

function run(recognizer, events) {
  const results = [];
  events.forEach(event => {
    if (event.type === "pointerdown") recognizer.down(event);
    else if (event.type === "pointermove") recognizer.move(event);
    else results.push(recognizer.up(event));
  });
  return results;
}

test("2本の指をほぼ同時に置いてすぐ離すと2本指タップとして認識する", () => {
  const recognizer = createTwoFingerTapRecognizer();
  assert.deepEqual(run(recognizer, [
    touch("pointerdown", 1, 100, 100, 0),
    touch("pointerdown", 2, 220, 110, 40),
    touch("pointermove", 1, 103, 102, 80),
    touch("pointerup", 1, 103, 102, 150),
    touch("pointerup", 2, 221, 111, 170)
  ]), [false, true]);
  assert.equal(recognizer.tracking, false);
});

test("1本指のタップ、3本指、ペンが触れたタップは2本指タップにしない", () => {
  const recognizer = createTwoFingerTapRecognizer();
  assert.deepEqual(run(recognizer, [
    touch("pointerdown", 1, 100, 100, 0),
    touch("pointerup", 1, 100, 100, 90)
  ]), [false]);
  assert.deepEqual(run(recognizer, [
    touch("pointerdown", 1, 100, 100, 1000),
    touch("pointerdown", 2, 200, 100, 1020),
    touch("pointerdown", 3, 300, 100, 1040),
    touch("pointerup", 1, 100, 100, 1100),
    touch("pointerup", 2, 200, 100, 1100),
    touch("pointerup", 3, 300, 100, 1100)
  ]), [false, false, false]);
  recognizer.down(touch("pointerdown", 1, 100, 100, 2000));
  recognizer.down(touch("pointerdown", 2, 200, 100, 2010));
  recognizer.down({ type: "pointerdown", pointerType: "pen", pointerId: 9, clientX: 150, clientY: 150, timeStamp: 2020 });
  assert.equal(recognizer.up(touch("pointerup", 1, 100, 100, 2080)), false);
  assert.equal(recognizer.up(touch("pointerup", 2, 200, 100, 2090)), false);
});

test("ピンチ・2本指の移動・長押し・遅れて置いた指はタップにしない", () => {
  const recognizer = createTwoFingerTapRecognizer();
  // Spreading the fingers is a pinch.
  assert.deepEqual(run(recognizer, [
    touch("pointerdown", 1, 100, 100, 0),
    touch("pointerdown", 2, 200, 100, 10),
    touch("pointermove", 1, 90, 100, 60),
    touch("pointermove", 2, 215, 100, 60),
    touch("pointerup", 1, 90, 100, 120),
    touch("pointerup", 2, 215, 100, 130)
  ]).at(-1), false);
  // Both fingers dragging together pan the page.
  assert.deepEqual(run(recognizer, [
    touch("pointerdown", 1, 100, 100, 1000),
    touch("pointerdown", 2, 200, 100, 1010),
    touch("pointermove", 1, 100, 130, 1080),
    touch("pointermove", 2, 200, 130, 1080),
    touch("pointerup", 1, 100, 130, 1150),
    touch("pointerup", 2, 200, 130, 1150)
  ]).at(-1), false);
  // Held too long.
  assert.deepEqual(run(recognizer, [
    touch("pointerdown", 1, 100, 100, 2000),
    touch("pointerdown", 2, 200, 100, 2010),
    touch("pointerup", 1, 100, 100, 2600),
    touch("pointerup", 2, 200, 100, 2610)
  ]).at(-1), false);
  // The second finger came much later.
  assert.deepEqual(run(recognizer, [
    touch("pointerdown", 1, 100, 100, 3000),
    touch("pointerdown", 2, 200, 100, 3300),
    touch("pointerup", 1, 100, 100, 3350),
    touch("pointerup", 2, 200, 100, 3360)
  ]).at(-1), false);
  // A cancelled contact is not a tap.
  assert.deepEqual(run(recognizer, [
    touch("pointerdown", 1, 100, 100, 4000),
    touch("pointerdown", 2, 200, 100, 4010),
    touch("pointercancel", 1, 100, 100, 4050),
    touch("pointerup", 2, 200, 100, 4060)
  ]).at(-1), false);
  // A clean tap afterwards is recognized again.
  assert.deepEqual(run(recognizer, [
    touch("pointerdown", 1, 100, 100, 5000),
    touch("pointerdown", 2, 200, 100, 5010),
    touch("pointerup", 2, 200, 100, 5100),
    touch("pointerup", 1, 100, 100, 5110)
  ]).at(-1), true);
});
