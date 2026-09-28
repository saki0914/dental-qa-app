import assert from "node:assert/strict";
import test from "node:test";
import { LEGACY_NOTE_PAGE_SIZE, notePageMetrics } from "../../js/core/note-page-metrics.js";

test("ページmetricsは実ページ比率をSVG viewBoxと全座標軸へ一貫して適用する", () => {
  const metrics = notePageMetrics({ width: 2000, height: 1000 });
  assert.equal(metrics.viewBox, "0 0 2000 1000");
  assert.equal(metrics.x(.25), 500);
  assert.equal(metrics.y(.25), 250);
  assert.equal(metrics.widthRatio(.01), 20);
  assert.equal(metrics.heightRatio(.01), 10);
});

test("size欠落時は旧1000×1414保存形式と同じ座標面へフォールバックする", () => {
  const metrics = notePageMetrics();
  assert.deepEqual({ width: metrics.width, height: metrics.height }, LEGACY_NOTE_PAGE_SIZE);
  assert.equal(metrics.viewBox, "0 0 1000 1414");
});

test("既存A4保存済みノートはmetrics切替後も位置・線幅・文字サイズの表示比率を維持する", () => {
  const legacy = notePageMetrics(LEGACY_NOTE_PAGE_SIZE);
  const a4 = notePageMetrics({ width: 1240, height: 1754 });
  const savedPoint = { x: .371, y: .629 };
  const savedStrokeWidth = .006;
  const savedFontSize = .025;

  assert.equal(legacy.x(savedPoint.x) / legacy.width, a4.x(savedPoint.x) / a4.width);
  assert.equal(legacy.y(savedPoint.y) / legacy.height, a4.y(savedPoint.y) / a4.height);
  assert.equal(legacy.widthRatio(savedStrokeWidth) / legacy.width, a4.widthRatio(savedStrokeWidth) / a4.width);
  assert.equal(legacy.heightRatio(savedFontSize) / legacy.height, a4.heightRatio(savedFontSize) / a4.height);
  assert.ok(Math.abs(legacy.width / legacy.height - a4.width / a4.height) < .001);
});
