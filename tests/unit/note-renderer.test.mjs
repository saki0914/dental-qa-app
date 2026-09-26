import assert from "node:assert/strict";
import test from "node:test";

import { renderNotePageToCanvas } from "../../js/core/note-renderer.js";

function createCanvasHarness() {
  const strokes = [];
  const fills = [];
  const context = {
    strokeStyle: "#000000",
    fillStyle: "#000000",
    globalAlpha: 1,
    lineWidth: 1,
    lineCap: "butt",
    lineJoin: "miter",
    save() {},
    restore() {},
    fillRect(...args) { fills.push({ color: this.fillStyle, args }); },
    beginPath() {},
    moveTo() {},
    lineTo() {},
    translate() {},
    rotate() {},
    setLineDash() {},
    fill() {},
    stroke() { strokes.push(this.strokeStyle); },
    fillText() {}
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => context
  };
  return { canvas, strokes, fills };
}

test("異なる要素種別もzIndex順に描画する", async t => {
  const { canvas, strokes } = createCanvasHarness();
  const previousDocument = globalThis.document;
  const previousPath2D = globalThis.Path2D;
  globalThis.document = { createElement: type => {
    assert.equal(type, "canvas");
    return canvas;
  } };
  globalThis.Path2D = class {
    moveTo() {}
    lineTo() {}
    closePath() {}
    ellipse() {}
    roundRect() {}
    rect() {}
  };
  t.after(() => {
    globalThis.document = previousDocument;
    globalThis.Path2D = previousPath2D;
  });

  await renderNotePageToCanvas({
    page: { background: { type: "blank" } },
    content: {
      elements: [
        {
          id: "shape-top",
          type: "shape",
          shapeType: "rectangle",
          bounds: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
          style: { strokeColor: "shape-top", strokeWidthRatio: 0.01 },
          zIndex: 30
        },
        {
          id: "highlighter-bottom",
          type: "highlighter",
          points: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
          style: { color: "highlighter-bottom", widthRatio: 0.02 },
          zIndex: 10
        },
        {
          id: "stroke-middle",
          type: "stroke",
          points: [{ x: 0, y: 1 }, { x: 1, y: 0 }],
          style: { color: "stroke-middle", widthRatio: 0.01 },
          zIndex: 20
        }
      ],
      noteMasks: []
    },
    resolveBackgroundBlob: async () => { throw new Error("背景画像は不要です"); },
    resolveAssetBlob: async () => { throw new Error("貼付画像は不要です"); },
    width: 100,
    height: 120
  });

  assert.deepEqual(strokes, ["highlighter-bottom", "stroke-middle", "shape-top"]);
});

test("AI共有用ではマスクを除外し学習用では教材・ノートマスクを描画する", async t => {
  const previousDocument = globalThis.document;
  const harness = createCanvasHarness();
  globalThis.document = { createElement: () => harness.canvas };
  t.after(() => { globalThis.document = previousDocument; });
  const base = {
    page: { background: { type: "blank" } },
    content: { elements: [], noteMasks: [{ id: "note", x: .1, y: .1, width: .2, height: .1, weak: false }] },
    materialMasks: [{ id: "material", x: .4, y: .4, width: .2, height: .1, weak: true }],
    resolveBackgroundBlob: async () => { throw new Error("不要"); },
    resolveAssetBlob: async () => { throw new Error("不要"); },
    width: 100,
    height: 120
  };

  await renderNotePageToCanvas({ ...base, maskMode: "none" });
  assert.equal(harness.fills.length, 1, "AI共有用は用紙背景だけを描画する");
  harness.fills.length = 0;
  await renderNotePageToCanvas({ ...base, maskMode: "all" });
  assert.deepEqual(harness.fills.map(fill => fill.color), ["#ffffff", "#ef4444", "#111827"]);
});
