import test from "node:test";
import assert from "node:assert/strict";
import { pageSwipeVisualOffset, resolvePageSwipe, resolvePageSwipeIntent } from "../../js/core/note-page-swipe.js";

const base = { startX: 300, startY: 200, endY: 210, elapsedMs: 180 };

test("horizontal finger swipes resolve to adjacent pages near fit zoom", () => {
  assert.equal(resolvePageSwipe({ ...base, endX: 160 }), "next");
  assert.equal(resolvePageSwipe({ ...base, startX: 160, endX: 300 }), "previous");
});

test("vertical drift, small movement, and blocked editing states never switch pages", () => {
  assert.equal(resolvePageSwipe({ ...base, endX: 280 }), null);
  assert.equal(resolvePageSwipe({ ...base, endX: 160, endY: 320 }), null);
  assert.equal(resolvePageSwipe({ ...base, endX: 160, blocked: true }), null);
});

test("zoomed pages require an edge and additional overscroll", () => {
  assert.equal(resolvePageSwipe({ ...base, endX: 160, zoom: 2, atRightEdge: false }), null);
  assert.equal(resolvePageSwipe({ ...base, endX: 130, zoom: 2, atRightEdge: true }), "next");
  assert.equal(resolvePageSwipe({ ...base, endX: 130, fingerDraw: true, startedAtEdge: false }), null);
  assert.equal(resolvePageSwipe({ ...base, endX: 130, fingerDraw: true, startedAtEdge: true }), "next");
});

test("finger drawing uses a short direction lock before reserving a center swipe", () => {
  const gesture = { startX: 300, startY: 200, fingerDraw: true };
  assert.equal(resolvePageSwipeIntent({ ...gesture, endX: 292, endY: 202 }), "pending");
  assert.equal(resolvePageSwipeIntent({ ...gesture, endX: 270, endY: 205 }), "swipe");
  assert.equal(resolvePageSwipeIntent({ ...gesture, endX: 292, endY: 230 }), "content");
  assert.equal(resolvePageSwipe({ ...base, endX: 130, fingerDraw: true, directionLock: "swipe" }), "next");
});

test("edge gestures reserve page swipe immediately", () => {
  assert.equal(resolvePageSwipeIntent({
    startX: 4, startY: 200, endX: 4, endY: 200, fingerDraw: true, startedAtEdge: true
  }), "swipe");
});

test("隣接ページがない方向では指追従量へ抵抗を加える", () => {
  assert.equal(pageSwipeVisualOffset(-100, { hasAdjacentPage: true }), -100);
  assert.equal(pageSwipeVisualOffset(-100, { hasAdjacentPage: false }), -24);
});

test("通常速度のフリックは幅比未満でも速度しきい値でページ切替できる", () => {
  assert.equal(resolvePageSwipe({
    startX: 700, startY: 300, endX: 590, endY: 304,
    elapsedMs: 100, viewportWidth: 800, directionLock: "swipe"
  }), "next");
  assert.equal(resolvePageSwipe({
    startX: 700, startY: 300, endX: 590, endY: 304,
    elapsedMs: 1000, viewportWidth: 800, directionLock: "swipe"
  }), null);
});
