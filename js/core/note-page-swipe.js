export const NOTE_PAGE_SWIPE_DEFAULTS = Object.freeze({
  minimumDistance: 72,
  maximumVerticalDrift: 48,
  velocityThreshold: 0.28,
  edgeOverscrollDistance: 44
});

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
  blocked = false,
  settings = NOTE_PAGE_SWIPE_DEFAULTS
}) {
  if (blocked) return null;
  const dx = Number(endX) - Number(startX);
  const dy = Number(endY) - Number(startY);
  const distance = Math.abs(dx);
  const velocity = distance / Math.max(1, Number(elapsedMs) || 1);
  if (Math.abs(dy) > settings.maximumVerticalDrift || Math.abs(dy) >= distance) return null;
  if (distance < settings.minimumDistance && velocity < settings.velocityThreshold) return null;
  if (fingerDraw && !startedAtEdge) return null;
  if (zoom > 1.05) {
    if (dx < 0 && !atRightEdge) return null;
    if (dx > 0 && !atLeftEdge) return null;
    if (distance < settings.minimumDistance + settings.edgeOverscrollDistance) return null;
  }
  return dx < 0 ? "next" : "previous";
}
