import assert from "node:assert/strict";
import test from "node:test";
import {
  STROKE_MIN_POINT_SPACING_PX,
  drawStrokeOnCanvas,
  prepareStrokePointsForCommit,
  smoothStrokePoints,
  strokeCurveCommands,
  strokePathData,
  strokeSegments,
  strokeSvgNodes
} from "../../js/core/note-stroke.js";

// 1000 x 1000 CSS pxで表示されたページ: 正規化座標0.001が1pxになる。
const PAGE_PX = { pixelWidth: 1000, pixelHeight: 1000 };
const px = value => value / 1000;

function jitteredLine({ count, spacingPx, amplitudePx }) {
  return Array.from({ length: count }, (_, index) => ({
    x: px(100 + index * spacingPx),
    y: px(200 + (index % 2 ? amplitudePx : -amplitudePx) * (index > 0 && index < count - 1 ? 1 : 0)),
    pressure: .4 + (index % 3) * .1234567
  }));
}

test("旧形式でpressureEnabledのストロークは互換表示のため点ごとの筆圧を反映できる", () => {
  const segments = strokeSegments([
    { x: 0, y: 0, pressure: .1 },
    { x: .5, y: .5, pressure: .5 },
    { x: 1, y: 1, pressure: 1 }
  ], .01, true);
  assert.equal(segments.length, 2);
  assert.ok(segments[0].width < segments[1].width);
});

test("旧strokeとhighlighter相当はpressure値があっても固定幅を維持する", () => {
  const segments = strokeSegments([
    { x: 0, y: 0, pressure: .1 },
    { x: .5, y: .5, pressure: 1 },
    { x: 1, y: 1, pressure: .2 }
  ], .01, false);
  assert.deepEqual(segments.map(segment => segment.width), [.01, .01]);
});

test("1点ストロークは選択線幅の丸い点として保持する", () => {
  const segments = strokeSegments([{ x: .4, y: .6, pressure: .2 }], .025, false);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].dot, true);
  assert.equal(segments[0].width, .025);
  assert.deepEqual(segments[0].start, segments[0].end);
});

test("横長ページのSVG strokeは実ページmetricsで座標と幅を生成する", () => {
  const nodes = strokeSvgNodes((name, attributes) => ({ name, attributes }), [
    { x: .2, y: .3 }, { x: .8, y: .7 }
  ], .01, { scaleX: 2000, scaleY: 1000 });
  assert.deepEqual(nodes, [{
    name: "line",
    attributes: {
      x1: 400, y1: 300, x2: 1600, y2: 700,
      "stroke-width": 20,
      "stroke-linecap": "round"
    }
  }]);
});

test("1点strokeのドラフトと確定SVGはdot分岐の中心座標と半径が一致する", () => {
  const factory = (name, attributes) => ({ name, attributes });
  const points = [{ x: .32, y: .68 }];
  const geometry = node => ({
    name: node.name,
    cx: node.attributes.cx,
    cy: node.attributes.cy,
    r: node.attributes.r
  });
  const [draft] = strokeSvgNodes(factory, points, .012, {
    scaleX: 1800,
    scaleY: 900,
    attributes: { class: "note-draft-dot", stroke: "#2563eb", "stroke-opacity": .7 }
  });
  const [settled] = strokeSvgNodes(factory, points, .012, {
    scaleX: 1800,
    scaleY: 900,
    attributes: { class: "note-element", stroke: "#2563eb", "stroke-opacity": .7 }
  });

  assert.deepEqual(geometry(draft), geometry(settled));
  assert.deepEqual(geometry(draft), { name: "circle", cx: 576, cy: 612, r: 10.8 });
});

test("確定strokeは画面上の細かな揺れを平滑化し、始点と終点を動かさない", () => {
  const points = jitteredLine({ count: 60, spacingPx: .5, amplitudePx: .5 });
  const committed = prepareStrokePointsForCommit(points, PAGE_PX);
  assert.deepEqual([committed[0].x, committed[0].y], [points[0].x, points[0].y]);
  assert.deepEqual([committed.at(-1).x, committed.at(-1).y], [points.at(-1).x, points.at(-1).y]);
  const interior = committed.slice(1, -1);
  assert.ok(interior.length > 0);
  const maxOffsetPx = Math.max(...interior.map(point => Math.abs(point.y * 1000 - 200)));
  assert.ok(maxOffsetPx < .15, `揺れ幅が十分に減っていません: ${maxOffsetPx}px`);
});

test("速く書いた間隔の広い点と角は平滑化で形を変えない", () => {
  const corner = [
    { x: px(100), y: px(100) }, { x: px(110), y: px(100) }, { x: px(120), y: px(100) },
    { x: px(120), y: px(110) }, { x: px(120), y: px(120) }
  ];
  const smoothed = smoothStrokePoints(corner, PAGE_PX);
  smoothed.forEach((point, index) => {
    assert.ok(Math.abs(point.x - corner[index].x) < 1e-12 && Math.abs(point.y - corner[index].y) < 1e-12);
  });
});

test("確定strokeは1px未満の点を間引き、座標と筆圧を丸めて保存量を減らす", () => {
  const points = Array.from({ length: 101 }, (_, index) => ({
    x: px(100 + index * .2) + 1e-9 * index,
    y: px(300) + 1e-9 * index,
    pressure: .333333333
  }));
  const committed = prepareStrokePointsForCommit(points, PAGE_PX);
  assert.ok(committed.length <= Math.ceil(20 / STROKE_MIN_POINT_SPACING_PX) + 2, `点数: ${committed.length}`);
  assert.deepEqual([committed[0].x, committed.at(-1).x], [.1, .12]);
  for (const point of committed) {
    assert.equal(point.x, Math.round(point.x * 1e5) / 1e5);
    assert.equal(point.y, Math.round(point.y * 1e5) / 1e5);
    assert.equal(point.pressure, .33);
  }
  for (let index = 1; index < committed.length - 1; index += 1) {
    const gapPx = Math.hypot(committed[index].x - committed[index - 1].x, committed[index].y - committed[index - 1].y) * 1000;
    assert.ok(gapPx >= STROKE_MIN_POINT_SPACING_PX - .02, `間隔: ${gapPx}px`);
  }
  assert.ok(JSON.stringify(committed).length < JSON.stringify(points).length / 4);
});

test("ズーム表示で書いたstrokeは表示ピクセル基準で平滑化・間引きする", () => {
  const points = jitteredLine({ count: 40, spacingPx: .5, amplitudePx: .5 });
  const atPageSize = prepareStrokePointsForCommit(points, PAGE_PX);
  // 同じ正規化座標でも4倍拡大表示なら1点あたりの画面距離は4倍になり、間引かれない。
  const zoomed = prepareStrokePointsForCommit(points, { pixelWidth: 4000, pixelHeight: 4000 });
  assert.ok(zoomed.length > atPageSize.length);
});

test("2点以下のstrokeと直線化strokeは丸めるだけで点数を変えない", () => {
  assert.deepEqual(prepareStrokePointsForCommit([{ x: .123456789, y: .5, pressure: .5 }], PAGE_PX), [
    { x: .12346, y: .5, pressure: .5 }
  ]);
  assert.deepEqual(prepareStrokePointsForCommit([
    { x: .1, y: .2, pressure: .5 },
    { x: .700000001, y: .8, pressure: .6 }
  ], PAGE_PX), [
    { x: .1, y: .2, pressure: .5 },
    { x: .7, y: .8, pressure: .6 }
  ]);
  assert.deepEqual(prepareStrokePointsForCommit([{ x: Number.NaN, y: .1 }, null], PAGE_PX), []);
});

test("確定ストロークはgestureの点配列と各点を共有しない", () => {
  const gesturePoints = [
    { x: .1, y: .2, pressure: .4 },
    { x: .4, y: .5, pressure: .5 },
    { x: .7, y: .8, pressure: .6 }
  ];
  const committedPoints = prepareStrokePointsForCommit(gesturePoints, PAGE_PX);
  const snapshot = structuredClone(committedPoints);

  gesturePoints.push({ x: .9, y: .9, pressure: .5 });
  gesturePoints[0].x = .5;
  gesturePoints[1].y = .1;

  assert.deepEqual(committedPoints, snapshot);
  assert.notEqual(committedPoints[0], gesturePoints[0]);
});

test("SVG pathは連続する点の中点を結ぶ二次曲線で描き、2点は直線のまま", () => {
  assert.equal(strokePathData([{ x: .1, y: .2 }, { x: .3, y: .4 }], 1000, 500), "M 100 100 L 300 200");
  assert.equal(
    strokePathData([{ x: .1, y: .1 }, { x: .2, y: .3 }, { x: .4, y: .3 }, { x: .5, y: .1 }], 1000, 1000),
    "M 100 100 L 150 200 Q 200 300 300 300 Q 400 300 450 200 L 500 100"
  );
  assert.deepEqual(strokeCurveCommands([{ x: .5, y: .5 }], 10, 10), [{ type: "M", x: 5, y: 5 }]);
  assert.deepEqual(strokeCurveCommands([], 10, 10), []);
});

test("Canvasでは固定幅strokeを1本の曲線pathで、筆圧strokeは区間ごとに描く", () => {
  const calls = [];
  const context = {
    strokeStyle: "#000",
    fillStyle: "#000",
    lineWidth: 1,
    beginPath: () => calls.push("beginPath"),
    moveTo: () => calls.push("moveTo"),
    lineTo: () => calls.push("lineTo"),
    quadraticCurveTo: () => calls.push("quadraticCurveTo"),
    arc: () => calls.push("arc"),
    fill: () => calls.push("fill"),
    stroke: () => calls.push("stroke")
  };
  const points = [{ x: .1, y: .1 }, { x: .2, y: .3 }, { x: .4, y: .3 }, { x: .5, y: .1 }];
  drawStrokeOnCanvas(context, points, .01, 1000, 1000);
  assert.deepEqual(calls, ["beginPath", "moveTo", "lineTo", "quadraticCurveTo", "quadraticCurveTo", "lineTo", "stroke"]);
  assert.equal(context.lineWidth, 10);

  calls.length = 0;
  drawStrokeOnCanvas(context, points, .01, 1000, 1000, { pressureEnabled: true });
  assert.equal(calls.filter(call => call === "stroke").length, points.length - 1);
});
