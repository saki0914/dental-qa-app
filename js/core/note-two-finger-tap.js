// A tap with two fingers (both down at about the same time, lifted quickly,
// without moving or spreading): the note editor's stand-in for the Apple
// Pencil double tap, which Safari does not report to web pages.
export const TWO_FINGER_TAP_DEFAULTS = Object.freeze({
  // The second finger lands this soon after the first.
  maximumStartGapMs: 250,
  // From the first finger down to the last finger up.
  maximumDurationMs: 400,
  // How far each finger may move.
  maximumMovePx: 14,
  // How much the distance between the fingers may change (a pinch changes it).
  maximumSpreadChangePx: 24
});

const timeOf = (event, now) => Number(event?.timeStamp) || now();

export function createTwoFingerTapRecognizer({
  settings = TWO_FINGER_TAP_DEFAULTS,
  now = () => globalThis.performance.now()
} = {}) {
  // { pointers: Map(pointerId -> { x0, y0, x, y, up }), startedAt, spread, failed }
  let tap = null;

  const spreadOf = pointers => {
    const [a, b] = [...pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  function fail() {
    if (tap) tap.failed = true;
  }

  function down(event) {
    const at = timeOf(event, now);
    if (event?.pointerType !== "touch") {
      // A Pencil (or mouse) contact means the hand is writing, not tapping.
      fail();
      return;
    }
    const point = { x0: event.clientX, y0: event.clientY, x: event.clientX, y: event.clientY, up: false };
    if (!tap || [...tap.pointers.values()].every(pointer => pointer.up)) {
      tap = { pointers: new Map([[event.pointerId, point]]), startedAt: at, spread: 0, failed: false };
      return;
    }
    tap.pointers.set(event.pointerId, point);
    if (tap.pointers.size > 2 || at - tap.startedAt > settings.maximumStartGapMs ||
        [...tap.pointers.values()].some(pointer => pointer.up)) {
      fail();
      return;
    }
    tap.spread = spreadOf(tap.pointers);
  }

  function move(event) {
    const pointer = tap?.pointers.get(event?.pointerId);
    if (!pointer || pointer.up) return;
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    if (Math.hypot(pointer.x - pointer.x0, pointer.y - pointer.y0) > settings.maximumMovePx) fail();
    if (tap.pointers.size === 2 && Math.abs(spreadOf(tap.pointers) - tap.spread) > settings.maximumSpreadChangePx) fail();
  }

  // True when this lift ends a two-finger tap.
  function up(event) {
    const pointer = tap?.pointers.get(event?.pointerId);
    if (!pointer) return false;
    if (event.type === "pointercancel") fail();
    else move(event);
    pointer.up = true;
    if (timeOf(event, now) - tap.startedAt > settings.maximumDurationMs) fail();
    if (![...tap.pointers.values()].every(item => item.up)) return false;
    const recognized = !tap.failed && tap.pointers.size === 2;
    tap = null;
    return recognized;
  }

  return {
    down,
    move,
    up,
    cancel() { tap = null; },
    get tracking() { return Boolean(tap); }
  };
}
