import assert from "node:assert/strict";
import test from "node:test";

import { MASK_UNDERLINE_COLOR, hasMaskUnderline, maskUnderlineRect, maskUnderlineThickness } from "../../js/core/note-mask-underline.js";
import { renderNotePageToCanvas } from "../../js/core/note-renderer.js";

test("赤い下線はマスクの下端のすぐ下に沿い、移動・サイズ変更したマスクの位置から求める", () => {
  const mask = { x: .1, y: .2, width: .3, height: .05, underline: true };
  const line = maskUnderlineRect(mask, 1000, 2000);
  assert.equal(line.x, 100);
  assert.equal(line.width, 300);
  assert.ok(Math.abs(line.y - 500) < 1e-9, "マスクの下端のすぐ下");
  assert.equal(line.height, maskUnderlineThickness(mask, 1000, 2000));
  const atBottom = maskUnderlineRect({ x: 0, y: .9, width: .5, height: .1 }, 1000, 2000);
  assert.ok(Math.abs(atBottom.y + atBottom.height - 2000) < 1e-9, "ページの下端では内側に引く");
  const moved = maskUnderlineRect({ ...mask, x: .5, width: .4 }, 1000, 2000);
  assert.deepEqual([moved.x, moved.width], [500, 400]);
  assert.equal(hasMaskUnderline(mask), true);
  assert.equal(hasMaskUnderline({ ...mask, underline: false }), false);
  assert.equal(hasMaskUnderline({ x: 0 }), false, "以前のマスクには下線がない");
  assert.equal(MASK_UNDERLINE_COLOR, "#dc2626");
});

test("下線の太さはページ幅の割合で、短いマスクでは文字に合わせて細くする", () => {
  assert.ok(Math.abs(maskUnderlineThickness({ height: .1 }, 2200, 3111) - 2200 * .0022) < 1e-9);
  assert.ok(Math.abs(maskUnderlineThickness({ height: .005 }, 2480, 3508) - .005 * 3508 * .12) < 1e-9);
  assert.equal(maskUnderlineThickness({ height: .0001 }, 100, 100), 1, "1px未満にしない");
});

function canvasHarness() {
  const fills = [];
  const context = {
    fillStyle: "#000000", strokeStyle: "#000000", globalAlpha: 1, lineWidth: 1,
    save() {}, restore() {}, beginPath() {}, rect() {}, stroke() {}, setLineDash() {},
    fillRect(...args) { fills.push({ color: this.fillStyle, args }); }
  };
  return { canvas: { width: 0, height: 0, getContext: () => context }, fills };
}

test("下線はマスクより先に描き、マスクなしPDFでは下線だけが残る", async t => {
  const previousDocument = globalThis.document;
  const harness = canvasHarness();
  globalThis.document = { createElement: () => harness.canvas };
  t.after(() => { globalThis.document = previousDocument; });
  const base = {
    page: { background: { type: "blank" } },
    content: {
      elements: [],
      noteMasks: [
        { id: "a", x: .1, y: .1, width: .2, height: .1, weak: false, underline: true },
        { id: "b", x: .5, y: .5, width: .2, height: .1, weak: true }
      ]
    },
    resolveBackgroundBlob: async () => { throw new Error("不要"); },
    resolveAssetBlob: async () => { throw new Error("不要"); },
    width: 100,
    height: 120
  };
  await renderNotePageToCanvas({ ...base, maskMode: "none" });
  assert.deepEqual(harness.fills.map(fill => fill.color), ["#ffffff", "#dc2626"], "AI共有用: マスクなし・下線あり");
  const [x, y, width] = harness.fills[1].args;
  assert.deepEqual([x, width], [10, 20]);
  assert.ok(Math.abs(y - 24) < 1e-9, "マスクの下端のすぐ下に沿う");
  harness.fills.length = 0;
  await renderNotePageToCanvas({ ...base, maskMode: "all" });
  assert.deepEqual(harness.fills.map(fill => fill.color), ["#ffffff", "#111827", "#b91c1c"], "閉じたマスクの下線は描かない");
  harness.fills.length = 0;
  await renderNotePageToCanvas({ ...base, maskMode: "screen", revealedMaskIds: new Set(["note:a"]) });
  assert.deepEqual(harness.fills.map(fill => fill.color), ["#ffffff", "#dc2626", "#b91c1c"], "画面どおり: 開いたマスクの下線だけを描く");
  harness.fills.length = 0;
  await renderNotePageToCanvas({ ...base, maskMode: "none", drawUnderlines: false });
  assert.deepEqual(harness.fills.map(fill => fill.color), ["#ffffff"], "まとめページの画像には元ページの下線を焼き付けない");
});
