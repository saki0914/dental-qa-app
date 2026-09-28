const finite = value => Number.isFinite(Number(value));
// Event timestamps distinguish residual events from a new physical contact.
// A wall-clock denial window would also reject rapid strokes when WebKit
// reuses the same Pencil pointerId, so production recovery has no such delay.
export const NOTE_STROKE_RECOVERY_COOLDOWN_MS = 0;

function sampleKey(point, timestamp = 0) {
  return `${Number(point.x).toFixed(7)}:${Number(point.y).toFixed(7)}:${Math.round(Number(timestamp) * 10)}`;
}

export function createStrokeSession({
  id,
  pointerId,
  pointerType,
  tool,
  firstPoint,
  startedAt = performance.now(),
  recoveredFromEvent = ""
}) {
  const point = { ...firstPoint, pressure: Number(firstPoint?.pressure ?? .5) };
  return {
    strokeSessionId: id,
    pointerId,
    pointerType,
    tool,
    startedAt,
    recoveredFromEvent,
    pointerdownObserved: !recoveredFromEvent,
    points: [point],
    pendingPoints: [],
    acceptedSamples: new Set([sampleKey(point, startedAt)]),
    lastAcceptedSampleAt: Number(startedAt || 0),
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

export function strokeSessionOwnsPointer(session, event) {
  return Boolean(session?.strokeSessionId) && session.pointerId === event?.pointerId &&
    session.pointerType === event?.pointerType;
}

export function recoverableStrokeMove(event) {
  if (event?.pointerType !== "pen" || event.type !== "pointermove") return false;
  if ((Number(event.buttons || 0) & 1) === 1) return true;
  return Number(event.pressure || 0) > 0;
}

export function createStrokeRecoveryCooldown({
  now = () => performance.now(),
  cooldownMs = NOTE_STROKE_RECOVERY_COOLDOWN_MS
} = {}) {
  const settledPointers = new Map();

  function notePointerEnd(pointerId, eventTimeStamp = 0) {
    if (pointerId === undefined || pointerId === null) return;
    settledPointers.set(pointerId, {
      eventTimeStamp: Number(eventTimeStamp || 0),
      deniedUntil: now() + cooldownMs
    });
  }

  function notePointerdown(pointerId) {
    settledPointers.delete(pointerId);
  }

  function blocks(event) {
    const settled = settledPointers.get(event?.pointerId);
    if (!settled) return false;
    const eventAt = Number(event?.timeStamp || 0);
    if (eventAt > 0 && settled.eventTimeStamp > 0 && eventAt <= settled.eventTimeStamp) return true;
    if (now() < settled.deniedUntil) return true;
    settledPointers.delete(event?.pointerId);
    return false;
  }

  return { notePointerEnd, notePointerdown, blocks };
}

export function delayedPointerdownJoinsRecoveredSession(session, event) {
  if (event?.type !== "pointerdown" || !session?.recoveredFromEvent || !strokeSessionOwnsPointer(session, event)) return false;
  session.pointerdownObserved = true;
  return true;
}

export function appendPointerSamples(session, event, toPoint) {
  if (!session || !event || typeof toPoint !== "function") return 0;
  const coalesced = event.getCoalescedEvents?.();
  const samples = coalesced?.length ? [...coalesced] : [];
  if (!samples.includes(event)) samples.push(event);
  samples.sort((a, b) => Number(a.timeStamp || 0) - Number(b.timeStamp || 0));
  let accepted = 0;
  for (const sample of samples) {
    const sampleTime = Number(sample.timeStamp || 0);
    if (sampleTime > 0 && Number(session.lastAcceptedSampleAt || 0) > 0 &&
      sampleTime < Number(session.lastAcceptedSampleAt) - .001) continue;
    const point = toPoint(sample);
    if (!finite(point?.x) || !finite(point?.y)) continue;
    const normalized = {
      ...point,
      pressure: Math.min(1, Math.max(0, Number(sample.pressure || point.pressure || .5)))
    };
    const previous = session.pendingPoints.at(-1) || session.points.at(-1);
    if (previous && Math.abs(Number(previous.x) - Number(normalized.x)) < 1e-7 &&
      Math.abs(Number(previous.y) - Number(normalized.y)) < 1e-7) continue;
    const key = sampleKey(normalized, sample.timeStamp);
    if (session.acceptedSamples.has(key)) continue;
    session.acceptedSamples.add(key);
    session.pendingPoints.push(normalized);
    if (sampleTime > 0) session.lastAcceptedSampleAt = Math.max(Number(session.lastAcceptedSampleAt || 0), sampleTime);
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

export function flushStrokePoints(session, { ensureRenderable: _ensureRenderable = false } = {}) {
  if (!session) return [];
  if (session.pendingPoints?.length) {
    session.points.push(...session.pendingPoints);
    session.pendingPoints.length = 0;
  }
  return session.points;
}

export function copyStrokePointsForCommit(points) {
  if (!Array.isArray(points)) return [];
  return points.map(point => ({ ...point }));
}
