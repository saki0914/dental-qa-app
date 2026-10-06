export const NOTE_PAGE_SWIPE_DEFAULTS = Object.freeze({
  // A drag released without a flick turns the page once it has moved this far
  // (or this share of the viewport width, when that is longer).
  minimumDistance: 56,
  pageWidthRatio: 0.15,
  // A flick: the finger still moves this fast (px/ms) in the drag direction
  // when it lifts, after moving at least `flickMinimumDistance`.
  flickVelocity: 0.3,
  flickMinimumDistance: 36,
  // The release velocity is measured over the last part of the drag.
  velocitySampleMs: 100,
  // A drag steeper than this (|dy| / |dx|, about 40 degrees) is not a page
  // swipe. Fingers arc, so the drift is a ratio, not a fixed distance.
  maximumSlope: 0.84,
  edgeOverscrollDistance: 44,
  directionLockDistance: 14,
  horizontalDominance: 1.25,
  boundaryResistance: 0.24
});

export function pageSwipeVisualOffset(deltaX, { hasAdjacentPage = true, settings = NOTE_PAGE_SWIPE_DEFAULTS } = {}) {
  const value = Number(deltaX) || 0;
  return hasAdjacentPage ? value : value * settings.boundaryResistance;
}

export function resolvePageSwipeIntent({
  startX,
  startY,
  endX,
  endY,
  fingerDraw = false,
  startedAtEdge = false,
  settings = NOTE_PAGE_SWIPE_DEFAULTS
}) {
  // A finger that draws turns the page from the page's edge at once. A finger
  // that does not draw goes by its direction everywhere, so that it can move
  // the page up and down near the edge too.
  if (startedAtEdge && fingerDraw) return "swipe";
  const dx = Math.abs(Number(endX) - Number(startX));
  const dy = Math.abs(Number(endY) - Number(startY));
  if (Math.hypot(dx, dy) < settings.directionLockDistance) return "pending";
  if (dx >= dy * settings.horizontalDominance) return "swipe";
  if (fingerDraw || dy >= dx) return "content";
  return "pending";
}

// Horizontal velocity (px/ms, signed) of the finger when it lifts: from the
// oldest position ({ x, t }) of the last `velocitySampleMs` to the last one.
// When the finger rested before lifting, no position falls in that window and
// the previous position is used, which gives a speed near zero. Null without
// two positions.
export function pageSwipeReleaseVelocity(samples, { settings = NOTE_PAGE_SWIPE_DEFAULTS } = {}) {
  if (!Array.isArray(samples) || samples.length < 2) return null;
  const lastIndex = samples.length - 1;
  const last = samples[lastIndex];
  let firstIndex = lastIndex;
  while (firstIndex > 0 && last.t - samples[firstIndex - 1].t <= settings.velocitySampleMs) firstIndex -= 1;
  if (firstIndex === lastIndex) firstIndex -= 1;
  const first = samples[firstIndex];
  // Two events a millisecond apart would give an arbitrary speed.
  const elapsed = Math.max(16, Number(last.t) - Number(first.t));
  return (Number(last.x) - Number(first.x)) / elapsed;
}

export function resolvePageSwipe({
  startX,
  startY,
  endX,
  endY,
  elapsedMs,
  releaseVelocityX = null,
  zoom = 1,
  atLeftEdge = false,
  atRightEdge = false,
  fingerDraw = false,
  startedAtEdge = false,
  directionLock = "",
  viewportWidth = 0,
  blocked = false,
  settings = NOTE_PAGE_SWIPE_DEFAULTS
}) {
  if (blocked) return null;
  const dx = Number(endX) - Number(startX);
  const dy = Number(endY) - Number(startY);
  const distance = Math.abs(dx);
  if (!(distance > 0) || Math.abs(dy) > distance * settings.maximumSlope) return null;
  // Without samples, the average speed of the whole drag stands in.
  const velocity = Number.isFinite(releaseVelocityX)
    ? releaseVelocityX
    : dx / Math.max(1, Number(elapsedMs) || 1);
  const direction = Math.sign(dx);
  // Released while moving back toward the start: the swipe is cancelled.
  if (Math.sign(velocity) === -direction && Math.abs(velocity) >= settings.flickVelocity) return null;
  const flick = distance >= settings.flickMinimumDistance &&
    Math.sign(velocity) === direction && Math.abs(velocity) >= settings.flickVelocity;
  const distanceThreshold = Math.max(
    settings.minimumDistance,
    Number(viewportWidth) > 0 ? Number(viewportWidth) * settings.pageWidthRatio : 0
  );
  if (distance < distanceThreshold && !flick) return null;
  if (fingerDraw && !startedAtEdge && directionLock !== "swipe") return null;
  if (zoom > 1.05) {
    if (dx < 0 && !atRightEdge) return null;
    if (dx > 0 && !atLeftEdge) return null;
    if (distance < settings.minimumDistance + settings.edgeOverscrollDistance) return null;
  }
  return dx < 0 ? "next" : "previous";
}
