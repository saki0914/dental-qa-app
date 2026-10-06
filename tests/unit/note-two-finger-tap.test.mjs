import assert from "node:assert/strict";
import test from "node:test";
import { createTwoFingerTapRecognizer } from "../../js/core/note-two-finger-tap.js";

const touch = (type, pointerId, clientX, clientY, timeStamp) => ({ type, pointerType: "touch", pointerId, clientX, clientY, timeStamp });

// The result of each lift: null, "tap" (a new two-finger tap) or "repeat"
// (the second tap of a two-finger double tap).
function run(recognizer, events) {
  const results = [];
  events.forEach(event => {
    if (event.type === "pointerdown") recognizer.down(event);
    else if (event.type === "pointermove") recognizer.move(event);
    else {
      const tap = recognizer.up(event);
      results.push(tap ? (tap.repeat ? "repeat" : "tap") : null);
    }
  });
  return results;
}

const twoFingerTap = (start, { first = 1, gap = 30, hold = 120 } = {}) => [
  touch("pointerdown", first, 100, 100, start),
  touch("pointerdown", first + 1, 220, 110, start + gap),
  touch("pointerup", first, 102, 101, start + hold),
  touch("pointerup", first + 1, 221, 111, start + hold + 15)
];

test("2本の指をほぼ同時に置いてすぐ離すと2本指タップとして認識する", () => {
  const recognizer = createTwoFingerTapRecognizer();
  assert.deepEqual(run(recognizer, [
    touch("pointerdown", 1, 100, 100, 0),
    touch("pointerdown", 2, 220, 110, 40),
    touch("pointermove", 1, 103, 102, 80),
    touch("pointerup", 1, 103, 102, 150),
    touch("pointerup", 2, 221, 111, 170)
  ]), [null, "tap"]);
  assert.equal(recognizer.tracking, false);
  // A slower tap (about half a second) still counts.
  assert.deepEqual(run(recognizer, twoFingerTap(5000, { hold: 460 })).at(-1), "tap");
});

test("1本指のタップ、3本指、ペンが触れたタップは2本指タップにしない", () => {
  const recognizer = createTwoFingerTapRecognizer();
  assert.deepEqual(run(recognizer, [
    touch("pointerdown", 1, 100, 100, 0),
    touch("pointerup", 1, 100, 100, 90)
  ]), [null]);
  assert.deepEqual(run(recognizer, [
    touch("pointerdown", 1, 100, 100, 1000),
    touch("pointerdown", 2, 200, 100, 1020),
    touch("pointerdown", 3, 300, 100, 1040),
    touch("pointerup", 1, 100, 100, 1100),
    touch("pointerup", 2, 200, 100, 1100),
    touch("pointerup", 3, 300, 100, 1100)
  ]), [null, null, null]);
  recognizer.down(touch("pointerdown", 1, 100, 100, 2000));
  recognizer.down(touch("pointerdown", 2, 200, 100, 2010));
  recognizer.down({ type: "pointerdown", pointerType: "pen", pointerId: 9, clientX: 150, clientY: 150, timeStamp: 2020 });
  assert.equal(recognizer.up(touch("pointerup", 1, 100, 100, 2080)), null);
  assert.equal(recognizer.up(touch("pointerup", 2, 200, 100, 2090)), null);
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
  ]).at(-1), null);
  // Both fingers dragging together pan the page.
  assert.deepEqual(run(recognizer, [
    touch("pointerdown", 1, 100, 100, 1000),
    touch("pointerdown", 2, 200, 100, 1010),
    touch("pointermove", 1, 100, 130, 1080),
    touch("pointermove", 2, 200, 130, 1080),
    touch("pointerup", 1, 100, 130, 1150),
    touch("pointerup", 2, 200, 130, 1150)
  ]).at(-1), null);
  // Held too long.
  assert.deepEqual(run(recognizer, [
    touch("pointerdown", 1, 100, 100, 2000),
    touch("pointerdown", 2, 200, 100, 2010),
    touch("pointerup", 1, 100, 100, 2600),
    touch("pointerup", 2, 200, 100, 2610)
  ]).at(-1), null);
  // The second finger came much later.
  assert.deepEqual(run(recognizer, [
    touch("pointerdown", 1, 100, 100, 3000),
    touch("pointerdown", 2, 200, 100, 3300),
    touch("pointerup", 1, 100, 100, 3350),
    touch("pointerup", 2, 200, 100, 3360)
  ]).at(-1), null);
  // A cancelled contact is not a tap.
  assert.deepEqual(run(recognizer, [
    touch("pointerdown", 1, 100, 100, 4000),
    touch("pointerdown", 2, 200, 100, 4010),
    touch("pointercancel", 1, 100, 100, 4050),
    touch("pointerup", 2, 200, 100, 4060)
  ]).at(-1), null);
  // A clean tap afterwards is recognized again.
  assert.deepEqual(run(recognizer, [
    touch("pointerdown", 1, 100, 100, 5000),
    touch("pointerdown", 2, 200, 100, 5010),
    touch("pointerup", 2, 200, 100, 5100),
    touch("pointerup", 1, 100, 100, 5110)
  ]).at(-1), "tap");
});

test("2本指のダブルタップ（続けて2回）は2回目を同じ操作の続きとして扱う", () => {
  const recognizer = createTwoFingerTapRecognizer();
  // Tap, then the second tap 150 ms after the first ended: a double tap.
  assert.equal(run(recognizer, twoFingerTap(0)).at(-1), "tap");
  assert.equal(run(recognizer, twoFingerTap(135 + 150, { first: 3 })).at(-1), "repeat");
  // A third quick tap still belongs to the same burst.
  assert.equal(run(recognizer, twoFingerTap(420 + 200, { first: 5 })).at(-1), "repeat");
  // Well after the burst, a tap is new again (it ends at 1490 ms).
  assert.equal(run(recognizer, twoFingerTap(755 + 600, { first: 7 })).at(-1), "tap");
  // A failed attempt (a pinch) does not extend the burst: the next tap comes
  // 510 ms after the last tap and 190 ms after the pinch.
  assert.equal(run(recognizer, [
    touch("pointerdown", 9, 100, 100, 1700),
    touch("pointerdown", 10, 200, 100, 1710),
    touch("pointermove", 10, 260, 100, 1760),
    touch("pointerup", 9, 100, 100, 1800),
    touch("pointerup", 10, 260, 100, 1810)
  ]).at(-1), null);
  assert.equal(run(recognizer, twoFingerTap(2000, { first: 11 })).at(-1), "tap");
});
