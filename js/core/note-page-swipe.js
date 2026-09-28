export const NOTE_PAGE_SWIPE_DEFAULTS = Object.freeze({
  minimumDistance: 72,
  maximumVerticalDrift: 48,
  velocityThreshold: 0.28,
  edgeOverscrollDistance: 44,
  directionLockDistance: 14,
  horizontalDominance: 1.25,
  pageWidthRatio: 0.22,
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
  if (startedAtEdge) return "swipe";
  const dx = Math.abs(Number(endX) - Number(startX));
  const dy = Math.abs(Number(endY) - Number(startY));
  if (Math.hypot(dx, dy) < settings.directionLockDistance) return "pending";
  if (dx >= dy * settings.horizontalDominance) return "swipe";
  if (fingerDraw || dy >= dx) return "content";
  return "pending";
}

export function resolvePageSwipe({
  startX,
  startY,
  endX,
  endY,
  elapsedMs,
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
  const velocity = distance / Math.max(1, Number(elapsedMs) || 1);
  if (Math.abs(dy) > settings.maximumVerticalDrift || Math.abs(dy) >= distance) return null;
  const distanceThreshold = Math.max(
    settings.minimumDistance,
    Number(viewportWidth) > 0 ? Number(viewportWidth) * settings.pageWidthRatio : 0
  );
  if (distance < distanceThreshold && velocity < settings.velocityThreshold) return null;
  if (fingerDraw && !startedAtEdge && directionLock !== "swipe") return null;
  if (zoom > 1.05) {
    if (dx < 0 && !atRightEdge) return null;
    if (dx > 0 && !atLeftEdge) return null;
    if (distance < settings.minimumDistance + settings.edgeOverscrollDistance) return null;
  }
  return dx < 0 ? "next" : "previous";
}
