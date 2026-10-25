export const NOTE_STRAIGHTEN_HOLD_MS = 650;
export const NOTE_STRAIGHTEN_MOVE_PX = 8;
export const NOTE_STRAIGHTEN_MIN_RATIO = 0.025;

// Whether a stroke held still at its end (for NOTE_STRAIGHTEN_HOLD_MS, within
// NOTE_STRAIGHTEN_MOVE_PX) is made into a shape (note-shape-snap.js decides
// which). The stroke has to reach across at least NOTE_STRAIGHTEN_MIN_RATIO of
// the page: a closed shape ends where it started (revision 17).
export function canStraightenStroke({ points, elapsedMs, movementPx, enabled = true }) {
  if (!enabled || elapsedMs < NOTE_STRAIGHTEN_HOLD_MS || movementPx > NOTE_STRAIGHTEN_MOVE_PX || !Array.isArray(points) || points.length < 2) return false;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    const x = Number(point?.x);
    const y = Number(point?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return Math.hypot(maxX - minX, maxY - minY) >= NOTE_STRAIGHTEN_MIN_RATIO;
}

export function straightenedPoints(points, end = points?.at?.(-1)) {
  if (!Array.isArray(points) || !points.length || !end) return [];
  const start = points[0];
  return [
    { ...start, pressure: Number(start.pressure || .5) },
    { ...end, pressure: Number(end.pressure || .5) }
  ];
}
