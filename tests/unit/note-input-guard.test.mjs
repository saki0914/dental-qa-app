import assert from "node:assert/strict";
import test from "node:test";
import {
  createNoteInputGuard,
  isDrawingInputCaptureEnabled,
  registerInputDebugPointerdownCapture
} from "../../js/core/note-input-guard.js";

test("Pencil capture入口は描画レイヤーと同じ状態条件だけで有効になる", () => {
  const editable = {
    hasContent: true,
    studyMode: false,
    markupMode: true,
    readOnlyEditor: false
  };
  assert.equal(isDrawingInputCaptureEnabled({ ...editable, tool: "pen" }), true);
  assert.equal(isDrawingInputCaptureEnabled({ ...editable, tool: "highlighter" }), true);
  for (const tool of ["select", "shape", "text"]) {
    assert.equal(isDrawingInputCaptureEnabled({ ...editable, tool }), false, `${tool}ではcaptureしない`);
  }
  assert.equal(isDrawingInputCaptureEnabled({ ...editable, hasContent: false, tool: "pen" }), false);
  assert.equal(isDrawingInputCaptureEnabled({ ...editable, studyMode: true, tool: "pen" }), false);
  assert.equal(isDrawingInputCaptureEnabled({ ...editable, markupMode: false, tool: "pen" }), false);
  assert.equal(isDrawingInputCaptureEnabled({ ...editable, readOnlyEditor: true, tool: "pen" }), false);
});

test("inputDebug無効時はwindow・document相当targetへcapture診断listenerを登録しない", () => {
  const registrations = [];
  const target = label => ({
    addEventListener: (...args) => registrations.push([label, ...args]),
    removeEventListener: () => {}
  });
  registerInputDebugPointerdownCapture({
    enabled: false,
    targets: [target("window"), target("document")],
    listener: () => {}
  });
  assert.deepEqual(registrations, []);
});

test("inputDebug有効時だけcapture診断listenerを登録して解除できる", () => {
  const registrations = [];
  const removals = [];
  const target = {
    addEventListener: (...args) => registrations.push(args),
    removeEventListener: (...args) => removals.push(args)
  };
  const listener = () => {};
  const dispose = registerInputDebugPointerdownCapture({ enabled: true, targets: [target], listener });
  assert.deepEqual(registrations, [["pointerdown", listener, { capture: true }]]);
  dispose();
  assert.deepEqual(removals, [["pointerdown", listener, { capture: true }]]);
});

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

test("古いpen pointerの遅延終了イベントは現在のpen接触を解除しない", () => {
  const guard = createNoteInputGuard();
  guard.notePointerDown({ pointerType: "pen", pointerId: 41 });
  guard.notePointerEnd({ pointerType: "pen", pointerId: 41 });
  guard.notePointerDown({ pointerType: "pen", pointerId: 42 });
  assert.equal(guard.activePenPointerId(), 42);
  assert.equal(guard.notePointerEnd({ pointerType: "pen", pointerId: 41 }), false);
  assert.equal(guard.isPenActive(), true);
  assert.equal(guard.activePenPointerId(), 42);
  assert.equal(guard.notePointerEnd({ pointerType: "pen", pointerId: 42 }), true);
  assert.equal(guard.isPenActive(), false);
});
