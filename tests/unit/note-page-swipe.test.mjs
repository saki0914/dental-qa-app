import test from "node:test";
import assert from "node:assert/strict";
import { pageSwipeReleaseVelocity, pageSwipeVisualOffset, resolvePageSwipe, resolvePageSwipeIntent } from "../../js/core/note-page-swipe.js";

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

test("指の弧（斜めのずれ）は、水平に近い角度なら横スワイプとして扱う", () => {
  // 300 px left with 70 px of drift (about 13 degrees).
  assert.equal(resolvePageSwipe({ startX: 800, startY: 300, endX: 500, endY: 370, elapsedMs: 300, viewportWidth: 1035 }), "next");
  // Steeper than about 40 degrees is a scroll, not a page swipe.
  assert.equal(resolvePageSwipe({ startX: 800, startY: 300, endX: 560, endY: 520, elapsedMs: 300, viewportWidth: 1035 }), null);
});

test("ゆっくりしたドラッグは表示幅の15%を超えればページを送る", () => {
  const slow = { startX: 800, startY: 300, endY: 330, elapsedMs: 900, viewportWidth: 1035, releaseVelocityX: -0.05 };
  assert.equal(resolvePageSwipe({ ...slow, endX: 600 }), "next", "200 px（15% = 155 px以上）");
  assert.equal(resolvePageSwipe({ ...slow, endX: 680 }), null, "120 px（15%未満）で、離すときも速くない");
});

test("短くても離す瞬間に速ければ送り、戻す向きに離せば取り消す", () => {
  const drag = { startX: 800, startY: 300, endY: 304, elapsedMs: 600, viewportWidth: 1035 };
  assert.equal(resolvePageSwipe({ ...drag, endX: 740, releaseVelocityX: -0.6 }), "next", "60 pxのフリック");
  assert.equal(resolvePageSwipe({ ...drag, endX: 780, releaseVelocityX: -0.6 }), null, "20 pxは短すぎる");
  assert.equal(resolvePageSwipe({ ...drag, endX: 500, releaseVelocityX: 0.5 }), null, "300 px送ったあと戻す向きに離した");
  assert.equal(resolvePageSwipe({ ...drag, startX: 300, endX: 480, releaseVelocityX: 0.4 }), "previous");
});

test("離す瞬間の速さは最後の約100msの移動から求め、止めてから離すとほぼ0になる", () => {
  const moving = [{ x: 800, t: 0 }, { x: 760, t: 40 }, { x: 700, t: 80 }, { x: 620, t: 120 }, { x: 540, t: 160 }];
  assert.equal(pageSwipeReleaseVelocity(moving), (540 - 700) / 80);
  const rested = [...moving, { x: 540, t: 460 }];
  assert.equal(pageSwipeReleaseVelocity(rested), 0);
  assert.equal(pageSwipeReleaseVelocity([{ x: 1, t: 0 }]), null);
  assert.equal(pageSwipeReleaseVelocity([{ x: 0, t: 0 }, { x: 10, t: 1 }]), 10 / 16, "1 ms間隔でも速さを誇張しない");
});
