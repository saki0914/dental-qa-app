import assert from "node:assert/strict";
import test from "node:test";
import { strokeSegments, strokeSvgNodes } from "../../js/core/note-stroke.js";

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
