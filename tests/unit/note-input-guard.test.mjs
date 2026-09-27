import assert from "node:assert/strict";
import test from "node:test";
import { createNoteInputGuard } from "../../js/core/note-input-guard.js";

test("pen接触中と終了後cooldownのtouchを抑制し、2本指は維持する", () => {
  let clock = 0;
  const guard = createNoteInputGuard({ now: () => clock, cooldownMs: 300 });
  guard.notePointerDown({ pointerType: "pen" });
  assert.equal(guard.shouldIgnoreTouch({ pointerType: "touch", width: 8, height: 8 }), true);
  assert.equal(guard.shouldIgnoreTouch({ pointerType: "touch", width: 8, height: 8 }, { touchCount: 2 }), false);
  guard.notePointerEnd({ pointerType: "pen" });
  clock = 299;
  assert.equal(guard.shouldIgnoreTouch({ pointerType: "touch", width: 8, height: 8 }), true);
  clock = 301;
  assert.equal(guard.shouldIgnoreTouch({ pointerType: "touch", width: 8, height: 8 }), false);
});

test("大きいtouch接触を掌候補として無視する", () => {
  const guard = createNoteInputGuard({ palmContactPx: 30 });
  assert.equal(guard.isPalmCandidate({ pointerType: "touch", width: 42, height: 18 }), true);
  assert.equal(guard.isPalmCandidate({ pointerType: "touch", width: 8, height: 8 }), false);
});

test("Apple Pencilモードは1本指の編集入力を抑止しつつ2本指ジェスチャーを残す", () => {
  const guard = createNoteInputGuard();
  const touch = { pointerType: "touch", width: 8, height: 8 };
  assert.equal(guard.shouldIgnoreTouch(touch, { pencilMode: true, touchCount: 1 }), true);
  assert.equal(guard.shouldIgnoreTouch(touch, { pencilMode: true, touchCount: 2 }), false);
  assert.equal(guard.shouldIgnoreTouch({ pointerType: "pen" }, { pencilMode: true }), false);
});
