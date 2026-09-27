export const NOTE_STRAIGHTEN_HOLD_MS = 650;
export const NOTE_STRAIGHTEN_MOVE_PX = 8;
export const NOTE_STRAIGHTEN_MIN_RATIO = 0.025;

export function canStraightenStroke({ points, elapsedMs, movementPx, enabled = true }) {
  if (!enabled || elapsedMs < NOTE_STRAIGHTEN_HOLD_MS || movementPx > NOTE_STRAIGHTEN_MOVE_PX || !Array.isArray(points) || points.length < 2) return false;
  const first = points[0];
  const last = points.at(-1);
  return Math.hypot(last.x - first.x, last.y - first.y) >= NOTE_STRAIGHTEN_MIN_RATIO;
}

export function straightenedPoints(points, end = points?.at?.(-1)) {
  if (!Array.isArray(points) || !points.length || !end) return [];
  const start = points[0];
  return [
    { ...start, pressure: Number(start.pressure || .5) },
    { ...end, pressure: Number(end.pressure || .5) }
  ];
}
