import assert from "node:assert/strict";
import test from "node:test";
import { clampPageZoom, createPageZoomController, getTwoPointCenter, getTwoPointDistance } from "../../js/core/page-zoom-controller.js";

test("画像暗記とノートで共通の0.8〜5倍ズーム範囲を使う", () => {
  assert.equal(clampPageZoom(.2), .8);
  assert.equal(clampPageZoom(2.5), 2.5);
  assert.equal(clampPageZoom(8), 5);
});

test("2点の距離と中心を共通計算する", () => {
  const points = [{ clientX: 10, clientY: 10 }, { clientX: 40, clientY: 50 }];
  assert.equal(getTwoPointDistance(points), 50);
  assert.deepEqual(getTwoPointCenter(points), { x: 25, y: 30 });
});

function pointerEvent(type, { pointerId, x, y, width = 8, height = 8 } = {}) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, {
    pointerId,
    pointerType: "touch",
    clientX: x,
    clientY: y,
    width,
    height
  });
  return event;
}

function zoomFixture() {
  const viewport = new EventTarget();
  Object.assign(viewport, {
    scrollLeft: 0,
    scrollTop: 0,
    clientWidth: 800,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 })
  });
  const styles = new Map();
  const content = {
    style: {
      transform: "",
      transformOrigin: "",
      setProperty: (name, value) => styles.set(name, value)
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 1100 })
  };
  return { viewport, content, styles };
}

test("native gesturestartもpagezoomstartとして編集側へ通知する", () => {
  const { viewport, content } = zoomFixture();
  let zoomStarts = 0;
  let zoomEnds = 0;
  viewport.addEventListener("pagezoomstart", () => { zoomStarts += 1; });
  viewport.addEventListener("pagezoomend", () => { zoomEnds += 1; });
  const controller = createPageZoomController({ viewport, content });
  const gesture = new Event("gesturestart", { bubbles: true, cancelable: true });
  Object.assign(gesture, { clientX: 300, clientY: 240, scale: 1 });
  viewport.dispatchEvent(gesture);
  assert.equal(gesture.defaultPrevented, true);
  assert.equal(zoomStarts, 1);
  assert.equal(controller.isPinchGestureActive, true);
  viewport.dispatchEvent(new Event("gestureend", { bubbles: true }));
  assert.equal(controller.isPinchGestureActive, false);
  assert.equal(zoomEnds, 1);
  controller.destroy();
});

test("Pencil入力中として拒否されたnative gestureはzoom所有権を取得しない", () => {
  const { viewport, content } = zoomFixture();
  let zoomStarts = 0;
  viewport.addEventListener("pagezoomstart", () => { zoomStarts += 1; });
  const controller = createPageZoomController({ viewport, content, shouldTrackTouch: () => false });
  const gesture = new Event("gesturestart", { bubbles: true, cancelable: true });
  Object.assign(gesture, { clientX: 300, clientY: 240, scale: 1 });
  viewport.dispatchEvent(gesture);
  assert.equal(gesture.defaultPrevented, true);
  assert.equal(zoomStarts, 0);
  assert.equal(controller.isPinchGestureActive, false);
  controller.destroy();
});

test("2本指ピンチ状態を編集側へ公開し、掌候補は追跡しない", () => {
  const { viewport, content, styles } = zoomFixture();
  let zoomStarts = 0;
  viewport.addEventListener("pagezoomstart", () => { zoomStarts += 1; });
  const controller = createPageZoomController({
    viewport,
    content,
    shouldTrackTouch: event => Math.max(event.width, event.height) < 30
  });

  viewport.dispatchEvent(pointerEvent("pointerdown", { pointerId: 1, x: 200, y: 200, width: 44 }));
  assert.equal(controller.touchCount, 0);
  viewport.dispatchEvent(pointerEvent("pointerdown", { pointerId: 2, x: 220, y: 220 }));
  assert.equal(controller.touchCount, 1);
  assert.equal(controller.isPinching, false);
  viewport.dispatchEvent(pointerEvent("pointerdown", { pointerId: 3, x: 520, y: 420 }));
  assert.equal(controller.touchCount, 2);
  assert.equal(controller.isPinching, true);
  assert.equal(controller.isPinchGestureActive, true);
  assert.equal(zoomStarts, 1);
  viewport.dispatchEvent(pointerEvent("pointermove", { pointerId: 3, x: 620, y: 480 }));
  assert.notEqual(styles.get("--page-zoom"), "1");
  controller.reset();
  assert.equal(controller.zoom, 1);
  assert.equal(styles.get("--page-zoom"), "1");
  assert.equal(viewport.scrollLeft, 0);
  assert.equal(viewport.scrollTop, 0);
  viewport.dispatchEvent(pointerEvent("pointerup", { pointerId: 3, x: 620, y: 480 }));
  assert.equal(controller.isPinching, false);
  assert.equal(controller.touchCount, 1);
  assert.equal(controller.isPinchGestureActive, true);
  viewport.dispatchEvent(pointerEvent("pointerup", { pointerId: 2, x: 220, y: 220 }));
  assert.equal(controller.isPinchGestureActive, false);
  controller.destroy();
});

test("pointer pinch中に遅れてnative gestureが来てもズームを二重適用しない", () => {
  const { viewport, content, styles } = zoomFixture();
  let zoomStarts = 0;
  let zoomEnds = 0;
  viewport.addEventListener("pagezoomstart", () => { zoomStarts += 1; });
  viewport.addEventListener("pagezoomend", () => { zoomEnds += 1; });
  const controller = createPageZoomController({ viewport, content });

  viewport.dispatchEvent(pointerEvent("pointerdown", { pointerId: 11, x: 200, y: 200 }));
  viewport.dispatchEvent(pointerEvent("pointerdown", { pointerId: 12, x: 400, y: 200 }));
  assert.equal(controller.pinchSource, "pointer");
  assert.equal(zoomStarts, 1);

  const nativeStart = new Event("gesturestart", { bubbles: true, cancelable: true });
  Object.assign(nativeStart, { clientX: 300, clientY: 200, scale: 1 });
  viewport.dispatchEvent(nativeStart);
  const nativeChange = new Event("gesturechange", { bubbles: true, cancelable: true });
  Object.assign(nativeChange, { clientX: 300, clientY: 200, scale: 4 });
  viewport.dispatchEvent(nativeChange);
  viewport.dispatchEvent(new Event("gestureend", { bubbles: true }));
  assert.equal(nativeStart.defaultPrevented, true);
  assert.equal(nativeChange.defaultPrevented, true);
  assert.equal(controller.pinchSource, "pointer");
  assert.equal(styles.get("--page-zoom"), undefined);
  assert.equal(zoomStarts, 1);
  assert.equal(zoomEnds, 0);

  viewport.dispatchEvent(pointerEvent("pointermove", { pointerId: 12, x: 500, y: 200 }));
  assert.equal(styles.get("--page-zoom"), "1.5");
  viewport.dispatchEvent(pointerEvent("pointerup", { pointerId: 12, x: 500, y: 200 }));
  viewport.dispatchEvent(pointerEvent("pointerup", { pointerId: 11, x: 200, y: 200 }));
  assert.equal(controller.pinchSource, null);
  assert.equal(zoomEnds, 1);
  controller.destroy();
});

test("native gestureが所有中はpointer追跡でpinch状態を上書きしない", () => {
  const { viewport, content, styles } = zoomFixture();
  const controller = createPageZoomController({ viewport, content });
  const nativeStart = new Event("gesturestart", { bubbles: true, cancelable: true });
  Object.assign(nativeStart, { clientX: 300, clientY: 200, scale: 1 });
  viewport.dispatchEvent(nativeStart);
  viewport.dispatchEvent(pointerEvent("pointerdown", { pointerId: 21, x: 200, y: 200 }));
  viewport.dispatchEvent(pointerEvent("pointerdown", { pointerId: 22, x: 400, y: 200 }));
  viewport.dispatchEvent(pointerEvent("pointermove", { pointerId: 22, x: 600, y: 200 }));
  assert.equal(controller.pinchSource, "native");
  assert.equal(styles.get("--page-zoom"), undefined);

  const nativeChange = new Event("gesturechange", { bubbles: true, cancelable: true });
  Object.assign(nativeChange, { clientX: 300, clientY: 200, scale: 2 });
  viewport.dispatchEvent(nativeChange);
  assert.equal(styles.get("--page-zoom"), "2");
  viewport.dispatchEvent(new Event("gestureend", { bubbles: true }));
  assert.equal(controller.pinchSource, null);
  controller.destroy();
});

// A viewport whose content is laid out at (offsetLeft, offsetTop) of the scroll
// area, as the note page is: centered, below the viewport padding. The content
// rect follows the scroll offset and the zoom transform (origin top left).
function offsetZoomFixture({ offsetLeft = 165, offsetTop = 96, width = 850, height = 1202 } = {}) {
  const viewportRect = { left: 159, top: 62, width: 1035, height: 728 };
  const viewport = new EventTarget();
  const styles = new Map();
  let zoom = 1;
  let scrollLeft = 0;
  let scrollTop = 0;
  const maxScroll = () => ({
    left: Math.max(0, offsetLeft + width * zoom + 30 - viewportRect.width),
    top: Math.max(0, offsetTop + height * zoom + 30 - viewportRect.height)
  });
  Object.defineProperties(viewport, {
    scrollLeft: { get: () => scrollLeft, set: value => { scrollLeft = Math.min(maxScroll().left, Math.max(0, value)); } },
    scrollTop: { get: () => scrollTop, set: value => { scrollTop = Math.min(maxScroll().top, Math.max(0, value)); } }
  });
  Object.assign(viewport, {
    clientWidth: viewportRect.width,
    getBoundingClientRect: () => ({ ...viewportRect })
  });
  const content = {
    style: {
      transform: "",
      transformOrigin: "",
      setProperty: (name, value) => {
        styles.set(name, value);
        if (name === "--page-zoom") zoom = Number(value);
      }
    },
    getBoundingClientRect: () => ({
      left: viewportRect.left + offsetLeft - scrollLeft,
      top: viewportRect.top + offsetTop - scrollTop,
      width: width * zoom,
      height: height * zoom
    })
  };
  // The content point under a client point.
  const contentPointAt = (clientX, clientY) => {
    const rect = content.getBoundingClientRect();
    return { x: (clientX - rect.left) / zoom, y: (clientY - rect.top) / zoom };
  };
  return { viewport, content, styles, contentPointAt };
}

test("ピンチの中心にあったページ上の点は、ページが中央寄せで余白の下にあっても指の中心に残る", () => {
  const { viewport, content, contentPointAt } = offsetZoomFixture();
  const controller = createPageZoomController({ viewport, content });
  const focus = { x: 600, y: 400 };
  const before = contentPointAt(focus.x, focus.y);
  viewport.dispatchEvent(pointerEvent("pointerdown", { pointerId: 1, x: focus.x - 40, y: focus.y }));
  viewport.dispatchEvent(pointerEvent("pointerdown", { pointerId: 2, x: focus.x + 40, y: focus.y }));
  viewport.dispatchEvent(pointerEvent("pointermove", { pointerId: 1, x: focus.x - 110, y: focus.y }));
  viewport.dispatchEvent(pointerEvent("pointermove", { pointerId: 2, x: focus.x + 110, y: focus.y }));
  controller.flushScheduledZoom();
  assert.equal(controller.zoom, 2.75);
  const after = contentPointAt(focus.x, focus.y);
  assert.ok(Math.abs(after.x - before.x) < 0.01 && Math.abs(after.y - before.y) < 0.01, JSON.stringify({ before, after }));

  // Moving both fingers pans the page with them.
  viewport.dispatchEvent(pointerEvent("pointermove", { pointerId: 1, x: focus.x - 150, y: focus.y - 30 }));
  viewport.dispatchEvent(pointerEvent("pointermove", { pointerId: 2, x: focus.x + 70, y: focus.y - 30 }));
  controller.flushScheduledZoom();
  const panned = contentPointAt(focus.x - 40, focus.y - 30);
  assert.ok(Math.abs(panned.x - before.x) < 0.01 && Math.abs(panned.y - before.y) < 0.01, JSON.stringify({ before, panned }));
  viewport.dispatchEvent(pointerEvent("pointerup", { pointerId: 1, x: focus.x - 150, y: focus.y - 30 }));
  viewport.dispatchEvent(pointerEvent("pointerup", { pointerId: 2, x: focus.x + 70, y: focus.y - 30 }));

  // Ctrl + wheel (trackpad pinch) keeps the point under the pointer too.
  const wheelPoint = { x: 500, y: 300 };
  const wheelBefore = contentPointAt(wheelPoint.x, wheelPoint.y);
  const wheel = new Event("wheel", { cancelable: true });
  Object.assign(wheel, { ctrlKey: true, deltaY: 200, clientX: wheelPoint.x, clientY: wheelPoint.y });
  viewport.dispatchEvent(wheel);
  const wheelAfter = contentPointAt(wheelPoint.x, wheelPoint.y);
  assert.ok(controller.zoom < 2.75);
  assert.ok(Math.abs(wheelAfter.x - wheelBefore.x) < 0.01 && Math.abs(wheelAfter.y - wheelBefore.y) < 0.01, JSON.stringify({ wheelBefore, wheelAfter }));
  controller.destroy();
});
