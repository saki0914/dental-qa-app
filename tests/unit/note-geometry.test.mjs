import assert from "node:assert/strict";
import test from "node:test";
import {
  clientPointToNormalized,
  normalizedBoundsFromPoints,
  splitStrokeByEraser,
  translateElement
} from "../../js/core/note-geometry.js";

test("ページ実表示領域を基準に0〜1座標へ変換する", () => {
  assert.deepEqual(clientPointToNormalized(150, 250, { left: 50, top: 50, width: 200, height: 400 }), { x: .5, y: .5 });
});

test("ドラッグ方向に依存せず正規化矩形を作る", () => {
  assert.deepEqual(normalizedBoundsFromPoints({ x: .8, y: .7 }, { x: .2, y: .3 }), { x: .2, y: .3, width: .6000000000000001, height: .39999999999999997 });
});

test("ストロークをピクセル消しゴム位置で複数ストロークへ分割する", () => {
  let sequence = 0;
  const parts = splitStrokeByEraser({ id: "old", type: "stroke", points: [
    { x: .1, y: .1 }, { x: .2, y: .1 }, { x: .3, y: .1 }, { x: .4, y: .1 },
    { x: .5, y: .1 }, { x: .6, y: .1 }, { x: .7, y: .1 }
  ] }, [{ x: .4, y: .1 }], .06, () => `new-${++sequence}`);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].points[0].x, .1);
  assert.ok(parts[0].points.at(-1).x < .35);
  assert.ok(parts[1].points[0].x > .45);
  assert.equal(parts[1].points.at(-1).x, .7);
  assert.deepEqual(parts.map(part => part.id), ["new-1", "new-2"]);
});

test("ピクセル消しゴムは疎な線分の中央を横切っても保存ストロークを分割する", () => {
  const stroke = {
    id: "old",
    type: "stroke",
    points: [{ x: .2, y: .5 }, { x: .8, y: .5 }],
    style: { color: "#123456", widthRatio: .01, opacity: .75 }
  };
  const parts = splitStrokeByEraser(stroke, [{ x: .5, y: .5 }], .1, () => "sampled");

  assert.equal(parts.length, 2);
  assert.ok(parts[0].points.at(-1).x < .4);
  assert.ok(parts[1].points[0].x > .6);
  assert.deepEqual(parts.map(part => part.style), [stroke.style, stroke.style]);
});

test("移動後もオブジェクトをページ内へ収める", () => {
  const moved = translateElement({ bounds: { x: .8, y: .8, width: .2, height: .2 } }, .5, .5);
  assert.equal(moved.bounds.x, .8);
  assert.equal(moved.bounds.y, .8);
});
