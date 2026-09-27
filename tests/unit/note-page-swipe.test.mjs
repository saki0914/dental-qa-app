import test from "node:test";
import assert from "node:assert/strict";
import { resolvePageSwipe } from "../../js/core/note-page-swipe.js";

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
