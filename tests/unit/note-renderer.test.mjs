import assert from "node:assert/strict";
import test from "node:test";

import { renderNotePageToCanvas } from "../../js/core/note-renderer.js";

function createCanvasHarness() {
  const strokes = [];
  const fills = [];
  const texts = [];
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
    quadraticCurveTo() {},
    arc() {},
    translate() {},
    rotate() {},
    setLineDash() {},
    fill() {},
    stroke() { strokes.push(this.strokeStyle); },
    rect() {},
    clip() {},
    font: "10px sans-serif",
    measureText(value) {
      // 1em per character at the current font size, like a CJK font.
      const size = Number(/([\d.]+)px/.exec(this.font)?.[1] || 10);
      return { width: [...String(value)].length * size };
    },
    fillText(value, x, y) { texts.push({ value, x, y, align: this.textAlign, color: this.fillStyle }); }
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => context
  };
  return { canvas, strokes, fills, texts };
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

test("固定幅のstrokeと半透明highlighterはSVGと同じ1本の曲線pathとして描画する", async t => {
  const { canvas, strokes } = createCanvasHarness();
  const context = canvas.getContext("2d");
  let curves = 0;
  context.quadraticCurveTo = () => { curves += 1; };
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: () => canvas };
  t.after(() => { globalThis.document = previousDocument; });
  const points = [
    { x: .1, y: .1, pressure: .5 }, { x: .2, y: .15, pressure: .5 }, { x: .3, y: .12, pressure: .5 },
    { x: .4, y: .2, pressure: .5 }, { x: .5, y: .18, pressure: .5 }
  ];

  await renderNotePageToCanvas({
    page: { background: { type: "blank" } },
    content: {
      elements: [
        { id: "highlighter", type: "highlighter", points, style: { color: "highlighter", widthRatio: .02, opacity: .3 }, zIndex: 1 },
        { id: "stroke", type: "stroke", points, style: { color: "stroke", widthRatio: .01 }, zIndex: 2 }
      ],
      noteMasks: []
    },
    resolveBackgroundBlob: async () => { throw new Error("背景画像は不要です"); },
    resolveAssetBlob: async () => { throw new Error("貼付画像は不要です"); },
    width: 100,
    height: 120
  });

  // 区間ごとに重ね描きすると半透明の継ぎ目が濃くなるため、要素ごとに1回だけstrokeする。
  assert.deepEqual(strokes, ["highlighter", "stroke"]);
  assert.equal(curves, 2 * (points.length - 2));
});

test("AI共有用ではマスクを除外し学習用では教材・ノートマスクを描画する", async t => {
  const previousDocument = globalThis.document;
  const harness = createCanvasHarness();
  globalThis.document = { createElement: () => harness.canvas };
  t.after(() => { globalThis.document = previousDocument; });
  const base = {
    page: { background: { type: "blank" } },
    content: { elements: [], noteMasks: [{ id: "same", x: .1, y: .1, width: .2, height: .1, weak: false }] },
    materialMasks: [{ id: "same", x: .4, y: .4, width: .2, height: .1, weak: true }],
    resolveBackgroundBlob: async () => { throw new Error("不要"); },
    resolveAssetBlob: async () => { throw new Error("不要"); },
    width: 100,
    height: 120
  };

  await renderNotePageToCanvas({ ...base, maskMode: "none" });
  assert.equal(harness.fills.length, 1, "AI共有用は用紙背景だけを描画する");
  harness.fills.length = 0;
  await renderNotePageToCanvas({ ...base, maskMode: "all" });
  assert.deepEqual(harness.fills.map(fill => fill.color), ["#ffffff", "#b91c1c", "#111827"], "暗記学習と同じ色（苦手は濃い赤）");
  harness.fills.length = 0;
  await renderNotePageToCanvas({ ...base, maskMode: "screen", revealedMaskIds: new Set(["material:same"]) });
  assert.deepEqual(harness.fills.map(fill => fill.color), ["#ffffff", "#111827", "rgba(185,28,28,.18)"], "同じ永続IDでも教材だけを除外し、ノートマスクは教材の後に描く。表示済みの苦手マスクは暗記学習と同じ薄い赤");
  assert.deepEqual(harness.strokes, ["#dc2626"], "画面どおりPDFでは表示済み教材マスクの破線の枠を残す");
});

test("日本語の明示改行・折り返しと中央・右寄せをCanvas PDF描画へ反映する", async t => {
  const previousDocument = globalThis.document;
  const harness = createCanvasHarness();
  globalThis.document = { createElement: () => harness.canvas };
  t.after(() => { globalThis.document = previousDocument; });
  const base = {
    page: { background: { type: "blank" } },
    materialMasks: [],
    resolveBackgroundBlob: async () => { throw new Error("不要"); },
    resolveAssetBlob: async () => { throw new Error("不要"); },
    width: 200,
    height: 200
  };
  await renderNotePageToCanvas({
    ...base,
    content: { elements: [{
      id: "jp-center", type: "text", text: "日本語の長い文章\n二行目", zIndex: 1,
      bounds: { x: .1, y: .1, width: .3, height: .5 }, rotation: 0,
      style: { fontSizeRatio: .05, lineHeight: 1.25, textAlign: "center", color: "#111111" }
    }], noteMasks: [] }
  });
  assert.ok(harness.texts.length >= 3, "日本語をボックス幅で折り返し、明示改行を維持する");
  assert.ok(harness.texts.every(item => item.align === "center" && item.x === 30));
  harness.texts.length = 0;
  await renderNotePageToCanvas({
    ...base,
    content: { elements: [{
      id: "jp-right", type: "text", text: "右寄せ", zIndex: 1,
      bounds: { x: .1, y: .1, width: .3, height: .2 }, rotation: 0,
      style: { fontSizeRatio: .05, lineHeight: 1.25, textAlign: "right", color: "#111111" }
    }], noteMasks: [] }
  });
  assert.ok(harness.texts.every(item => item.align === "right" && item.x === 60));
});

test("文字ごとの色をサムネイル・PDFの描画にも反映し、揃えは行全体で行う", async t => {
  const previousDocument = globalThis.document;
  const harness = createCanvasHarness();
  globalThis.document = { createElement: () => harness.canvas };
  t.after(() => { globalThis.document = previousDocument; });
  const base = {
    page: { background: { type: "blank" } },
    materialMasks: [],
    resolveBackgroundBlob: async () => { throw new Error("不要"); },
    resolveAssetBlob: async () => { throw new Error("不要"); },
    width: 200,
    height: 200
  };
  const element = {
    id: "colored", type: "text", text: "象牙質は硬い", zIndex: 1,
    bounds: { x: .1, y: .1, width: .8, height: .2 }, rotation: 0,
    style: { fontSizeRatio: .05, lineHeight: 1.25, textAlign: "left", color: "#111111" },
    textColors: { length: 6, runs: [{ start: 0, end: 3, color: "#ef4444" }] }
  };
  await renderNotePageToCanvas({ ...base, content: { elements: [element], noteMasks: [] } });
  assert.deepEqual(harness.texts.map(item => [item.value, item.color]), [["象牙質", "#ef4444"], ["は硬い", "#111111"]]);
  assert.equal(harness.texts[1].x - harness.texts[0].x, 30, "続きは前の部分の幅だけ右から描く（1文字10px）");
  harness.texts.length = 0;
  await renderNotePageToCanvas({ ...base, content: { elements: [{ ...element, style: { ...element.style, textAlign: "right" } }], noteMasks: [] } });
  assert.equal(harness.texts[0].x, 160 - 60, "右揃えは枠の右端（枠内の座標160）から行全体（6文字60px）の幅で置く");
  harness.texts.length = 0;
  // A text a build without colors changed keeps its one color.
  await renderNotePageToCanvas({ ...base, content: { elements: [{ ...element, text: "象牙質は硬いです" }], noteMasks: [] } });
  assert.deepEqual(harness.texts.map(item => item.color), ["#111111"]);
});
