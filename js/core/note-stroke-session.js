const finite = value => Number.isFinite(Number(value));

function sampleKey(point, timestamp = 0) {
  return `${Number(point.x).toFixed(7)}:${Number(point.y).toFixed(7)}:${Math.round(Number(timestamp) * 10)}`;
}

export function createStrokeSession({
  id,
  pointerId,
  pointerType,
  tool,
  firstPoint,
  startedAt = performance.now()
}) {
  const point = { ...firstPoint, pressure: Number(firstPoint?.pressure ?? .5) };
  return {
    strokeSessionId: id,
    pointerId,
    pointerType,
    tool,
    startedAt,
    points: [point],
    pendingPoints: [],
    acceptedSamples: new Set([sampleKey(point, startedAt)]),
    coalescedPointCount: 0,
    eventCount: 1,
    lastEventAt: startedAt,
    lastEventGapMs: 0,
    maxEventGapMs: 0,
    previewFrame: 0,
    isFinalizing: false,
    straightenTimer: null
  };
}

export function appendPointerSamples(session, event, toPoint) {
  if (!session || !event || typeof toPoint !== "function") return 0;
  const coalesced = event.getCoalescedEvents?.();
  const samples = coalesced?.length ? [...coalesced] : [];
  if (!samples.includes(event)) samples.push(event);
  samples.sort((a, b) => Number(a.timeStamp || 0) - Number(b.timeStamp || 0));
  let accepted = 0;
  for (const sample of samples) {
    const point = toPoint(sample);
    if (!finite(point?.x) || !finite(point?.y)) continue;
    const normalized = {
      ...point,
      pressure: Math.min(1, Math.max(0, Number(sample.pressure || point.pressure || .5)))
    };
    const key = sampleKey(normalized, sample.timeStamp);
    if (session.acceptedSamples.has(key)) continue;
    session.acceptedSamples.add(key);
    session.pendingPoints.push(normalized);
    accepted += 1;
  }
  const now = Number(event.timeStamp || performance.now());
  const gap = Math.max(0, now - Number(session.lastEventAt || now));
  session.lastEventGapMs = gap;
  session.maxEventGapMs = Math.max(Number(session.maxEventGapMs || 0), gap);
  session.lastEventAt = now;
  session.eventCount = Number(session.eventCount || 0) + 1;
  session.coalescedPointCount = Number(session.coalescedPointCount || 0) + Math.max(0, samples.length - 1);
  return accepted;
}

export function flushStrokePoints(session, { ensureRenderable = false } = {}) {
  if (!session) return [];
  if (session.pendingPoints?.length) {
    session.points.push(...session.pendingPoints);
    session.pendingPoints.length = 0;
  }
  if (ensureRenderable && session.points.length === 1) {
    const first = session.points[0];
    session.points.push({ ...first, x: Math.min(1, first.x + .00001) });
  }
  return session.points;
}

export function copyStrokePointsForCommit(points) {
  if (!Array.isArray(points)) return [];
  return points.map(point => ({ ...point }));
}
