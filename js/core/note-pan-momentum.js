// Inertial scrolling for a finger (or Pencil) pan of the note page, as the
// image memory screen's native scrolling has: the page keeps moving after the
// finger lifts and slows down evenly.
export const NOTE_PAN_MOMENTUM_DEFAULTS = Object.freeze({
  // The release velocity is measured over the last part of the drag.
  sampleMs: 100,
  // Slower releases stop where the finger left the page.
  minimumVelocity: 0.12,
  stopVelocity: 0.015,
  // The speed kept per millisecond (UIScrollView's normal deceleration).
  deceleration: 0.998,
  maximumVelocity: 8,
  // The longest frame gap applied at once (a stalled frame must not jump).
  maximumFrameMs: 48
});

// The finger's velocity (px/ms, positive to the right and down) when it
// lifts: from the oldest position ({ x, y, t }) of the last `sampleMs` to the
// last one. A finger that rested before lifting gives a speed near zero.
export function panReleaseVelocity(samples, { settings = NOTE_PAN_MOMENTUM_DEFAULTS } = {}) {
  if (!Array.isArray(samples) || samples.length < 2) return { x: 0, y: 0 };
  const lastIndex = samples.length - 1;
  const last = samples[lastIndex];
  let firstIndex = lastIndex;
  while (firstIndex > 0 && Number(last.t) - Number(samples[firstIndex - 1].t) <= settings.sampleMs) firstIndex -= 1;
  if (firstIndex === lastIndex) firstIndex -= 1;
  const first = samples[firstIndex];
  // Two events a millisecond apart would give an arbitrary speed.
  const elapsed = Math.max(16, Number(last.t) - Number(first.t));
  const clamp = value => Math.max(-settings.maximumVelocity, Math.min(settings.maximumVelocity, value));
  return {
    x: clamp((Number(last.x) - Number(first.x)) / elapsed),
    y: clamp((Number(last.y) - Number(first.y)) / elapsed)
  };
}

// The distance moved in `elapsedMs` by a velocity that decays by
// `deceleration` per millisecond, and the velocity after it.
export function momentumStep(velocity, elapsedMs, { settings = NOTE_PAN_MOMENTUM_DEFAULTS } = {}) {
  const decay = settings.deceleration ** elapsedMs;
  const factor = (decay - 1) / Math.log(settings.deceleration);
  return {
    dx: velocity.x * factor,
    dy: velocity.y * factor,
    velocity: { x: velocity.x * decay, y: velocity.y * decay }
  };
}

// Moves `viewport` (scrollLeft / scrollTop) on after a pan. `start(velocity)`
// takes the finger's release velocity; the content moves with the finger, so
// the scroll position moves the other way. An edge stops that direction.
export function createPanMomentum({
  viewport,
  requestFrame = callback => globalThis.requestAnimationFrame(callback),
  cancelFrame = handle => globalThis.cancelAnimationFrame(handle),
  now = () => globalThis.performance.now(),
  settings = NOTE_PAN_MOMENTUM_DEFAULTS
}) {
  let state = null;

  function stop() {
    if (state?.frame) cancelFrame(state.frame);
    state = null;
  }

  function step(timestamp) {
    const current = state;
    if (!current) return;
    current.frame = 0;
    const at = Number.isFinite(timestamp) ? timestamp : now();
    const elapsed = Math.max(0, Math.min(settings.maximumFrameMs, at - current.lastAt));
    current.lastAt = at;
    const { dx, dy, velocity } = momentumStep(current.velocity, elapsed, { settings });
    current.velocity = velocity;
    // Fractions are kept here: the browser rounds the scroll position.
    current.left += dx;
    current.top += dy;
    viewport.scrollLeft = current.left;
    viewport.scrollTop = current.top;
    if (Math.abs(viewport.scrollLeft - current.left) > 1) {
      current.left = viewport.scrollLeft;
      current.velocity.x = 0;
    }
    if (Math.abs(viewport.scrollTop - current.top) > 1) {
      current.top = viewport.scrollTop;
      current.velocity.y = 0;
    }
    if (Math.hypot(current.velocity.x, current.velocity.y) < settings.stopVelocity) {
      state = null;
      return;
    }
    current.frame = requestFrame(step);
  }

  function start(fingerVelocity) {
    stop();
    const velocity = { x: -Number(fingerVelocity?.x || 0), y: -Number(fingerVelocity?.y || 0) };
    if (!(Math.hypot(velocity.x, velocity.y) >= settings.minimumVelocity)) return false;
    state = {
      velocity,
      left: viewport.scrollLeft,
      top: viewport.scrollTop,
      lastAt: now(),
      frame: 0
    };
    state.frame = requestFrame(step);
    return true;
  }

  return {
    start,
    stop,
    get active() { return Boolean(state); }
  };
}
