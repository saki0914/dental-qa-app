import assert from "node:assert/strict";
import test from "node:test";

import { recognizeStrokeShape, shapeStrokePoints } from "../../js/core/note-shape-snap.js";
import { strokeCurveCommands } from "../../js/core/note-stroke.js";

// A4 as shown on an iPad held upright (CSS px).
const SCREEN = { pixelWidth: 850, pixelHeight: 1202 };

// Repeatable hand jitter.
function jitter(seed = 7) {
  let state = seed >>> 0;
  return amplitude => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const unit = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    return (unit * 2 - 1) * amplitude;
  };
}

// Points of a stroke written through `corners` (px), every ~3 px, with jitter.
function handDrawn(corners, { amplitude = 1.5, seed = 7, spacing = 3 } = {}) {
  const noise = jitter(seed);
  const points = [];
  for (let index = 1; index < corners.length; index += 1) {
    const from = corners[index - 1];
    const to = corners[index];
    const steps = Math.max(1, Math.round(Math.hypot(to.x - from.x, to.y - from.y) / spacing));
    for (let step = index === 1 ? 0 : 1; step <= steps; step += 1) {
      const t = step / steps;
      points.push({ x: from.x + (to.x - from.x) * t + noise(amplitude), y: from.y + (to.y - from.y) * t + noise(amplitude) });
    }
  }
  return points;
}

function handDrawnEllipse({ cx, cy, rx, ry, tilt = 0, from = -Math.PI / 2, sweep = 2 * Math.PI, amplitude = 1.5, wobble = 0, seed = 11 }) {
  const noise = jitter(seed);
  const points = [];
  const steps = Math.round((Math.abs(sweep) * (rx + ry) / 2) / 3);
  for (let step = 0; step <= steps; step += 1) {
    const t = from + sweep * step / steps;
    const scale = 1 + wobble * Math.sin(3 * t + 0.7);
    const u = rx * scale * Math.cos(t);
    const v = ry * scale * Math.sin(t);
    points.push({
      x: cx + u * Math.cos(tilt) - v * Math.sin(tilt) + noise(amplitude),
      y: cy + u * Math.sin(tilt) + v * Math.cos(tilt) + noise(amplitude)
    });
  }
  return points;
}

const toShares = points => points.map(point => ({ x: point.x / SCREEN.pixelWidth, y: point.y / SCREEN.pixelHeight, pressure: .5 }));
const recognize = points => recognizeStrokeShape(toShares(points), SCREEN);
const near = (actual, expected, tolerance, message) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} / ${expected}`);
const toPixels = point => ({ x: point.x * SCREEN.pixelWidth, y: point.y * SCREEN.pixelHeight });

test("ほぼまっすぐな線は直線（これまでどおり）。少し曲がった線も直線にする", () => {
  const line = recognize(handDrawn([{ x: 100, y: 300 }, { x: 260, y: 318 }, { x: 420, y: 296 }], { amplitude: 2 }));
  assert.equal(line?.kind, "line");
  const points = shapeStrokePoints(line);
  assert.equal(points.length, 2);
  near(toPixels(points[0]).x, 100, 3, "始点はそのまま");
  // The stroke of the existing check: three samples, a gentle bend.
  const rough = recognize([{ x: 170, y: 577 }, { x: 306, y: 625 }, { x: 476, y: 565 }]);
  assert.equal(rough?.kind, "line", "ゆるい折れは直線");
  // After the hold the end follows the pen.
  const moved = shapeStrokePoints(rough, { x: 527 / SCREEN.pixelWidth, y: 601 / SCREEN.pixelHeight });
  assert.equal(moved.length, 2);
  near(toPixels(moved[1]).x, 527, .01, "終点はペンの位置");
});

test("L字は角のはっきりした折れ線になり、縦・横に近い辺はまっすぐ縦・横にそろう", () => {
  // Down, then right, slightly tilted, with a softly rounded corner.
  const stroke = handDrawn([{ x: 200, y: 200 }, { x: 204, y: 380 }, { x: 208, y: 395 }, { x: 222, y: 400 }, { x: 400, y: 404 }], { amplitude: 1.5 });
  const shape = recognize(stroke);
  assert.equal(shape?.kind, "polyline");
  assert.equal(shape.vertices.length, 3);
  const [start, corner, end] = shape.vertices;
  assert.equal(start.x, corner.x, "縦の辺は真縦");
  assert.equal(corner.y, end.y, "横の辺は真横");
  near(corner.x, 205, 6, "角の位置（横）");
  near(corner.y, 401, 6, "角の位置（縦）");
  // Corners are given twice: the curve through midpoints stays straight.
  const points = shapeStrokePoints(shape);
  assert.equal(points.length, 4);
  assert.deepEqual(points[1], points[2]);
  const commands = strokeCurveCommands(points, SCREEN.pixelWidth, SCREEN.pixelHeight);
  for (const command of commands.filter(item => item.type === "Q")) {
    const previous = commands[commands.indexOf(command) - 1];
    const cross = (command.cx - previous.x) * (command.y - previous.y) - (command.cy - previous.y) * (command.x - previous.x);
    assert.ok(Math.abs(cross) < 1e-6, "角は丸めない");
  }
  // The end follows the pen and stays horizontal when it nearly is.
  const moved = shapeStrokePoints(shape, { x: 470 / SCREEN.pixelWidth, y: (corner.y + 6) / SCREEN.pixelHeight });
  near(toPixels(moved.at(-1)).y, corner.y, .02, "横に近ければ真横");
  near(toPixels(moved.at(-1)).x, 470, .02, "終点はペンの位置");
});

test("ジグザグ（Z）は3辺の折れ線、斜めの辺は傾きのまま", () => {
  const shape = recognize(handDrawn([{ x: 100, y: 100 }, { x: 300, y: 104 }, { x: 110, y: 290 }, { x: 310, y: 296 }]));
  assert.equal(shape?.kind, "polyline");
  assert.equal(shape.vertices.length, 4);
  const [, second, third] = shape.vertices;
  assert.ok(Math.abs(second.x - third.x) > 150, "斜めの辺は縦にしない");
});

test("丸く描いて閉じた線は真円（少し隙間・はみ出しがあっても）", () => {
  for (const [sweep, wobble] of [[2 * Math.PI * .93, .03], [2 * Math.PI * 1.08, .05], [2 * Math.PI, .06]]) {
    const shape = recognize(handDrawnEllipse({ cx: 400, cy: 500, rx: 110, ry: 102, sweep, wobble, amplitude: 2 }));
    assert.equal(shape?.kind, "circle", `sweep ${sweep.toFixed(2)}`);
    near(shape.radiusX, 106, 8, "半径");
    near(shape.center.x, 400, 8, "中心");
    near(shape.center.y, 500, 8, "中心");
    const points = shapeStrokePoints(shape).map(toPixels);
    assert.ok(points.length >= 37, "なめらかに描ける点の数");
    for (const point of points) near(Math.hypot(point.x - shape.center.x, point.y - shape.center.y), shape.radiusX, .05, "円周上");
    near(points[0].x, points.at(-1).x, 1e-6, "閉じている");
  }
});

test("横長・縦長の丸は楕円で、ほぼ水平・垂直なら傾けない。大きく傾いた楕円は傾いたまま", () => {
  const wide = recognize(handDrawnEllipse({ cx: 400, cy: 400, rx: 160, ry: 80, tilt: 8 * Math.PI / 180 }));
  assert.equal(wide?.kind, "ellipse");
  assert.equal(wide.angle, 0, "横長は水平に");
  near(wide.radiusX, 160, 12, "長い半径");
  near(wide.radiusY, 80, 8, "短い半径");
  const tall = recognize(handDrawnEllipse({ cx: 400, cy: 500, rx: 70, ry: 150 }));
  assert.equal(tall?.kind, "ellipse");
  near(Math.abs(tall.angle), Math.PI / 2, 1e-9, "縦長は垂直に");
  const tilted = recognize(handDrawnEllipse({ cx: 400, cy: 500, rx: 150, ry: 70, tilt: 35 * Math.PI / 180 }));
  assert.equal(tilted?.kind, "ellipse");
  near(tilted.angle / (Math.PI / 180), 35, 5, "傾きはそのまま");
});

test("四角・三角は角のはっきりした多角形になり、縦・横の辺はまっすぐになる", () => {
  const rectangle = recognize(handDrawn([{ x: 200, y: 200 }, { x: 420, y: 205 }, { x: 424, y: 340 }, { x: 196, y: 336 }, { x: 201, y: 208 }], { amplitude: 1.5 }));
  assert.equal(rectangle?.kind, "polygon");
  assert.equal(rectangle.vertices.length, 4);
  const xs = new Set(rectangle.vertices.map(vertex => vertex.x.toFixed(6)));
  const ys = new Set(rectangle.vertices.map(vertex => vertex.y.toFixed(6)));
  assert.equal(xs.size, 2, "真四角（辺は縦・横）");
  assert.equal(ys.size, 2);
  const points = shapeStrokePoints(rectangle);
  assert.equal(points.length, 8, "4つの角（始点以外は2回ずつ）と閉じる点");
  assert.deepEqual(points[0], points.at(-1));
  const triangle = recognize(handDrawn([{ x: 300, y: 200 }, { x: 420, y: 400 }, { x: 180, y: 402 }, { x: 296, y: 206 }]));
  assert.equal(triangle?.kind, "polygon");
  assert.equal(triangle.vertices.length, 3);
});

test("文字のような曲線・波線・半円・小さすぎる線は、書いたまま変えない", () => {
  // An S curve.
  const sCurve = [];
  for (let step = 0; step <= 80; step += 1) {
    const t = step / 80;
    sCurve.push({ x: 300 + 60 * Math.sin(t * 2 * Math.PI), y: 200 + 200 * t });
  }
  assert.equal(recognize(sCurve), null, "S字");
  const wave = [];
  for (let step = 0; step <= 120; step += 1) wave.push({ x: 100 + step * 3, y: 300 + 12 * Math.sin(step / 6) });
  assert.equal(recognize(wave), null, "波線");
  assert.equal(recognize(handDrawnEllipse({ cx: 300, cy: 300, rx: 100, ry: 100, from: Math.PI / 2, sweep: Math.PI })), null, "半円");
  // し (down, then a curve up to the right).
  const shi = [];
  for (let step = 0; step <= 40; step += 1) shi.push({ x: 300, y: 150 + step * 4 });
  for (let step = 1; step <= 40; step += 1) {
    const t = step / 40 * Math.PI / 2;
    shi.push({ x: 300 + 80 * (1 - Math.cos(t)) + 0, y: 310 + 50 * Math.sin(t) - 0 });
  }
  for (let step = 1; step <= 20; step += 1) shi.push({ x: 380 + step * 3, y: 360 - step * 4 });
  assert.notEqual(recognize(shi)?.kind, "circle");
  assert.equal(recognize([{ x: 100, y: 100 }, { x: 101, y: 101 }]), null, "小さすぎる");
});

test("同じ所を往復しただけの線は図形にしない", () => {
  assert.equal(recognize(handDrawn([{ x: 100, y: 300 }, { x: 400, y: 304 }, { x: 102, y: 298 }])), null);
});
