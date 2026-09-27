import assert from "node:assert/strict";
import test from "node:test";
import {
  cancelledStrokeCanBeCommitted,
  createClosedTransientUi,
  openTransientUi,
  reconcileCropSession,
  settingsTransientType,
  toolKeepsSelection,
  transientPanelMaxHeight,
  transientUiCanTransition,
  transientUiIsSettings
} from "../../js/core/note-transient-ui.js";

test("一時UIは常に1種類だけを表し、不正な種類は閉じる", () => {
  assert.deepEqual(createClosedTransientUi(), {
    type: "closed", ownerTool: null, targetElementIds: [], anchor: null
  });
  assert.deepEqual(openTransientUi("image-source-menu", {
    ownerTool: "image", targetElementIds: ["a", "a", "b"]
  }), {
    type: "image-source-menu", ownerTool: "image", targetElementIds: ["a", "b"], anchor: null
  });
  assert.equal(openTransientUi("unknown").type, "closed");
});

test("各編集ツールを固有の設定パネルへ割り当てる", () => {
  assert.equal(settingsTransientType("pen"), "pen-settings");
  assert.equal(settingsTransientType("highlighter"), "highlighter-settings");
  assert.equal(settingsTransientType("eraser-object"), "eraser-settings");
  assert.equal(settingsTransientType("shape"), "shape-settings");
  assert.equal(settingsTransientType("text"), "text-settings");
  assert.equal(settingsTransientType("image"), null);
  assert.equal(transientUiIsSettings(openTransientUi("text-settings")), true);
});

test("選択は選択・マスクツールだけが維持する", () => {
  assert.equal(toolKeepsSelection("select"), true);
  assert.equal(toolKeepsSelection("mask"), true);
  for (const tool of ["pen", "highlighter", "eraser-object", "shape", "text", "image", "pan"]) {
    assert.equal(toolKeepsSelection(tool), false);
  }
});

test("crop編集中は明示的な適用・キャンセルまで他の一時UIへ遷移しない", () => {
  const crop = openTransientUi("crop-editor", { targetElementIds: ["image-1"] });
  assert.equal(transientUiCanTransition(crop, "crop-editor", { cropActive: true }), true);
  assert.equal(transientUiCanTransition(crop, "closed", { cropActive: true }), false);
  assert.equal(transientUiCanTransition(crop, "pen-settings", { cropActive: true }), false);
  assert.equal(transientUiCanTransition(crop, "more-menu", { cropActive: true }), false);
  assert.equal(transientUiCanTransition(crop, "closed", { cropActive: false }), true);
});

test("crop対象画像が消えた場合はcropセッションと一時UIを同時に閉じる", () => {
  const cropSession = { elementId: "image-1", before: { elements: [] } };
  assert.deepEqual(reconcileCropSession(cropSession, [{ id: "image-1", type: "image" }]), {
    cropSession,
    shouldCloseTransientUi: false
  });
  assert.deepEqual(reconcileCropSession(cropSession, [{ id: "image-1", type: "shape" }]), {
    cropSession: null,
    shouldCloseTransientUi: true
  });
  assert.deepEqual(reconcileCropSession(cropSession, []), {
    cropSession: null,
    shouldCloseTransientUi: true
  });
});

test("compact設定パネルは全dock共通でviewport高の52%以下に収める", () => {
  assert.equal(transientPanelMaxHeight(1024, { compactLayout: true }), 1024 * .52);
  assert.equal(transientPanelMaxHeight(844, { compactLayout: true }), 844 * .52);
  assert.equal(transientPanelMaxHeight(300, { compactLayout: true }), 130);
  assert.equal(transientPanelMaxHeight(120, { compactLayout: true }), 0);
  assert.equal(transientPanelMaxHeight(900), 560);
  assert.equal(transientPanelMaxHeight(300), 220);
});

test("pointercancelは安全な手書きだけを確定し、ズーム開始では破棄する", () => {
  const points = [{ x: 0.1, y: 0.1 }, { x: 0.12, y: 0.14 }, { x: 0.2, y: 0.2 }];
  assert.equal(cancelledStrokeCanBeCommitted({ type: "pen", pointerType: "pen", points, reason: "pointercancel" }), true);
  assert.equal(cancelledStrokeCanBeCommitted({ type: "highlighter", pointerType: "pen", points, reason: "lostpointercapture" }), true);
  assert.equal(cancelledStrokeCanBeCommitted({ type: "pen", pointerType: "pen", points, reason: "interrupted-pen" }), true);
  assert.equal(cancelledStrokeCanBeCommitted({ type: "pen", pointerType: "touch", points, reason: "pointercancel" }), false);
  assert.equal(cancelledStrokeCanBeCommitted({ type: "pen", pointerType: "mouse", points, reason: "pointercancel" }), false);
  assert.equal(cancelledStrokeCanBeCommitted({ type: "pen", pointerType: "pen", points, reason: "pagezoomstart" }), false);
  assert.equal(cancelledStrokeCanBeCommitted({ type: "shape", pointerType: "pen", points, reason: "pointercancel" }), false);
  assert.equal(cancelledStrokeCanBeCommitted({ type: "pen", pointerType: "pen", points: [], reason: "interrupted-pen" }), false);
  assert.equal(cancelledStrokeCanBeCommitted({ type: "pen", pointerType: "pen", points: [points[0]], reason: "pointercancel" }), false);
});
