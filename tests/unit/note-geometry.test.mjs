import assert from "node:assert/strict";
import test from "node:test";
import {
  clientPointToNormalized,
  cropImageFromHandle,
  lassoContainsElement,
  lineEndpoints,
  normalizeLineElement,
  normalizeNoteLineElements,
  normalizedBoundsFromPoints,
  resetImageCrop,
  resizeElements,
  splitStrokeByEraser,
  translateElement
} from "../../js/core/note-geometry.js";

test("lassoが矩形の左辺だけを横切る場合も要素を選択する", () => {
  const lasso = [
    { x: .35, y: .45 },
    { x: .45, y: .45 },
    { x: .45, y: .55 },
    { x: .35, y: .55 }
  ];
  const element = {
    id: "rectangle",
    type: "shape",
    shapeType: "rectangle",
    bounds: { x: .4, y: .4, width: .2, height: .2 },
    rotation: 0
  };

  assert.equal(lassoContainsElement(lasso, element), true);
});

test("ページ実表示領域を基準に0〜1座標へ変換する", () => {
  assert.deepEqual(clientPointToNormalized(150, 250, { left: 50, top: 50, width: 200, height: 400 }), { x: .5, y: .5 });
});

test("ズーム・画面向き・サイドバー・パレット位置でページrectが変わっても座標誤差を2 CSS px以内に保つ", () => {
  const zooms = [.8, 1, 2, 5];
  const layouts = [
    { left: 18, top: 96, width: 620, height: 877 },
    { left: 214, top: 64, width: 877, height: 620 },
    { left: 96, top: 18, width: 620, height: 877 },
    { left: 18, top: 64, width: 877, height: 620 }
  ];
  for (const zoom of zooms) {
    for (const layout of layouts) {
      const rect = { ...layout, width: layout.width * zoom, height: layout.height * zoom };
      const expected = { x: .371, y: .629 };
      const clientX = rect.left + rect.width * expected.x;
      const clientY = rect.top + rect.height * expected.y;
      const actual = clientPointToNormalized(clientX, clientY, rect);
      assert.ok(Math.abs((actual.x - expected.x) * rect.width) <= 2);
      assert.ok(Math.abs((actual.y - expected.y) * rect.height) <= 2);
    }
  }
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

test("lineとarrowはstart/endを正本にし旧bounds/rotationでも同じ向きを再構成する", () => {
  const pageSize = { width: 1240, height: 1754 };
  const cases = [
    [{ x: .1, y: .2 }, { x: .8, y: .9 }],
    [{ x: .8, y: .9 }, { x: .1, y: .2 }],
    [{ x: .2, y: .9 }, { x: .2, y: .1 }],
    [{ x: .2, y: .1 }, { x: .2, y: .9 }],
    [{ x: .1, y: .5 }, { x: .9, y: .5 }],
    [{ x: .9, y: .5 }, { x: .1, y: .5 }],
    [{ x: .9, y: .2 }, { x: .1, y: .8 }],
    [{ x: .4, y: .4 }, { x: .4, y: .4 }]
  ];
  for (const [start, end] of cases) {
    const normalized = normalizeLineElement({ id: "line", type: "shape", shapeType: "arrow", start, end }, pageSize);
    assert.deepEqual(normalized.start, start);
    assert.deepEqual(normalized.end, end);
    assert.equal("points" in normalized, false);
    const legacy = lineEndpoints({ bounds: normalized.bounds, rotation: normalized.rotation }, pageSize);
    assert.ok(Math.hypot(legacy[0].x - start.x, legacy[0].y - start.y) < 1e-9);
    assert.ok(Math.hypot(legacy[1].x - end.x, legacy[1].y - end.y) < 1e-9);
  }
});

test("読み込んだ旧points形式lineをstart/end正本へ正規化する", () => {
  const normalized = normalizeNoteLineElements({
    schemaVersion: 1,
    elements: [{
      id: "legacy-line",
      type: "shape",
      shapeType: "line",
      points: [{ x: .2, y: .3 }, { x: .7, y: .8 }]
    }],
    noteMasks: []
  });
  assert.deepEqual(normalized.elements[0].start, { x: .2, y: .3 });
  assert.deepEqual(normalized.elements[0].end, { x: .7, y: .8 });
  assert.equal("points" in normalized.elements[0], false);
});

test("line移動はstart/endと旧互換fieldを同時に更新する", () => {
  const line = normalizeLineElement({
    id: "line", type: "shape", shapeType: "line",
    start: { x: .1, y: .2 }, end: { x: .3, y: .4 }
  });
  const moved = translateElement(line, .2, .1);
  assert.ok(Math.hypot(moved.start.x - .3, moved.start.y - .3) < 1e-9);
  assert.ok(Math.hypot(moved.end.x - .5, moved.end.y - .5) < 1e-9);
  const legacy = lineEndpoints({ bounds: moved.bounds, rotation: moved.rotation });
  assert.ok(Math.hypot(legacy[0].x - moved.start.x, legacy[0].y - moved.start.y) < 1e-9);
  assert.ok(Math.hypot(legacy[1].x - moved.end.x, legacy[1].y - moved.end.y) < 1e-9);
});

test("ゼロ長lineは移動量0でページ端からずれない", () => {
  const line = normalizeLineElement({
    id: "line", type: "shape", shapeType: "line",
    start: { x: 1, y: 1 }, end: { x: 1, y: 1 }
  });
  const moved = translateElement(line, 0, 0);
  assert.deepEqual(moved.start, { x: 1, y: 1 });
  assert.deepEqual(moved.end, { x: 1, y: 1 });
});

test("複数選択resizeは要素型別に変換し回転済み要素だけ等方へフォールバックする", () => {
  const source = { x: .1, y: .1, width: .4, height: .4 };
  const target = { x: .1, y: .1, width: .8, height: .2 };
  const resized = resizeElements([
    normalizeLineElement({
      id: "line", type: "shape", shapeType: "arrow",
      start: { x: .1, y: .1 }, end: { x: .5, y: .5 }
    }),
    { id: "stroke", type: "stroke", points: [{ x: .2, y: .2 }, { x: .4, y: .4 }] },
    { id: "rotated", type: "shape", shapeType: "rectangle", bounds: { x: .2, y: .2, width: .2, height: .1 }, rotation: 30 },
    { id: "quarter", type: "shape", shapeType: "rectangle", bounds: { x: .2, y: .2, width: .2, height: .1 }, rotation: 90 },
    { id: "text", type: "text", bounds: { x: .2, y: .2, width: .2, height: .1 }, rotation: 0, style: { fontSizeRatio: .02 } }
  ], source, target);

  assert.deepEqual([resized[0].start, resized[0].end], [{ x: .1, y: .1 }, { x: .9, y: .30000000000000004 }]);
  assert.deepEqual(resized[1].points, [{ x: .30000000000000004, y: .15000000000000002 }, { x: .7000000000000001, y: .25 }]);
  assert.equal(resized[2].bounds.width, .1);
  assert.equal(resized[2].bounds.height, .05);
  assert.equal(resized[3].bounds.width, .1);
  assert.equal(resized[3].bounds.height, .2);
  assert.equal(resized[4].style.fontSizeRatio, .01);
});

test("cropハンドルはboundsも連動し、回転前ローカル軸のズーム倍率を保つ", () => {
  const image = {
    id: "image", type: "image", rotation: 0,
    bounds: { x: .2, y: .2, width: .4, height: .4 },
    crop: { x: 0, y: 0, width: 1, height: 1 }
  };
  const cropped = cropImageFromHandle(image, "w", { x: .3, y: .4 });
  assert.ok(Math.abs(cropped.crop.x - .25) < 1e-9);
  assert.deepEqual({ y: cropped.crop.y, width: cropped.crop.width, height: cropped.crop.height }, { y: 0, width: .75, height: 1 });
  assert.ok(Math.abs(cropped.bounds.x - .3) < 1e-9);
  assert.ok(Math.abs(cropped.bounds.width - .3) < 1e-9);
  assert.ok(Math.abs(cropped.bounds.width / cropped.crop.width - image.bounds.width / image.crop.width) < 1e-9);

  const rotated = cropImageFromHandle({ ...image, rotation: 90 }, "e", { x: .4, y: .5 }, { width: 1000, height: 1000 });
  assert.ok(Math.abs(rotated.crop.width - .75) < 1e-9);
  assert.ok(Math.abs(rotated.bounds.width / rotated.crop.width - image.bounds.width / image.crop.width) < 1e-9);
  assert.ok(rotated.bounds.y < image.bounds.y);
});

test("cropリセットは現在の中心とズーム倍率を保って全体表示に戻す", () => {
  const reset = resetImageCrop({
    id: "image", type: "image", rotation: 30,
    bounds: { x: .3, y: .35, width: .3, height: .2 },
    crop: { x: .25, y: .25, width: .5, height: .5 }
  });

  assert.deepEqual(reset.crop, { x: 0, y: 0, width: 1, height: 1 });
  assert.ok(Math.abs(reset.bounds.x - .15) < 1e-9);
  assert.ok(Math.abs(reset.bounds.y - .25) < 1e-9);
  assert.ok(Math.abs(reset.bounds.width - .6) < 1e-9);
  assert.ok(Math.abs(reset.bounds.height - .4) < 1e-9);
  assert.ok(Math.abs((reset.bounds.x + reset.bounds.width / 2) - .45) < 1e-9);
  assert.ok(Math.abs((reset.bounds.y + reset.bounds.height / 2) - .45) < 1e-9);
});

test("cropリセットで拡張したboundsはページ内へclampする", () => {
  const reset = resetImageCrop({
    id: "image", type: "image",
    bounds: { x: .85, y: .8, width: .1, height: .15 },
    crop: { x: .8, y: .7, width: .1, height: .25 }
  });

  assert.deepEqual(reset.crop, { x: 0, y: 0, width: 1, height: 1 });
  assert.deepEqual(reset.bounds, { x: 0, y: .4, width: 1, height: .6 });
});
