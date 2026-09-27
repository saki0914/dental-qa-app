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
