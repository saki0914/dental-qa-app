// A tap with two fingers (both down at about the same time, lifted quickly,
// without moving or spreading): the note editor's stand-in for the Apple
// Pencil double tap, which Safari does not report to web pages. Two such taps
// in a row (a two-finger double tap) count as one.
export const TWO_FINGER_TAP_DEFAULTS = Object.freeze({
  // The second finger lands this soon after the first.
  maximumStartGapMs: 250,
  // From the first finger down to the last finger up.
  maximumDurationMs: 500,
  // How far each finger may move.
  maximumMovePx: 14,
  // How much the distance between the fingers may change (a pinch changes it).
  maximumSpreadChangePx: 24,
  // A two-finger tap that starts this soon after the last one ended repeats
  // it (the second tap of a double tap).
  repeatGapMs: 450
});

const timeOf = (event, now) => Number(event?.timeStamp) || now();

export function createTwoFingerTapRecognizer({
  settings = TWO_FINGER_TAP_DEFAULTS,
  now = () => globalThis.performance.now()
} = {}) {
  // { pointers: Map(pointerId -> { x0, y0, x, y, up }), startedAt, spread, failed, repeat }
  let tap = null;
  let lastTapEndedAt = -Infinity;

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
      tap = {
        pointers: new Map([[event.pointerId, point]]),
        startedAt: at,
        spread: 0,
        failed: false,
        repeat: at - lastTapEndedAt <= (settings.repeatGapMs ?? TWO_FINGER_TAP_DEFAULTS.repeatGapMs)
      };
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

  // When this lift ends a two-finger tap: { repeat }, where repeat is true for
  // the second tap of a two-finger double tap. Otherwise null.
  function up(event) {
    const pointer = tap?.pointers.get(event?.pointerId);
    if (!pointer) return null;
    if (event.type === "pointercancel") fail();
    else move(event);
    pointer.up = true;
    const at = timeOf(event, now);
    if (at - tap.startedAt > settings.maximumDurationMs) fail();
    if (![...tap.pointers.values()].every(item => item.up)) return null;
    const finished = tap;
    tap = null;
    if (finished.failed || finished.pointers.size !== 2) return null;
    lastTapEndedAt = at;
    return { repeat: finished.repeat };
  }

  return {
    down,
    move,
    up,
    cancel() { tap = null; },
    get tracking() { return Boolean(tap); }
  };
}
