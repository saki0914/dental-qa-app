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

test("2本指ピンチ状態を編集側へ公開し、掌候補は追跡しない", () => {
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
  viewport.dispatchEvent(pointerEvent("pointerup", { pointerId: 3, x: 620, y: 480 }));
  assert.equal(controller.isPinching, false);
  assert.equal(controller.touchCount, 1);
  assert.equal(controller.isPinchGestureActive, true);
  viewport.dispatchEvent(pointerEvent("pointerup", { pointerId: 2, x: 220, y: 220 }));
  assert.equal(controller.isPinchGestureActive, false);
  controller.destroy();
});
