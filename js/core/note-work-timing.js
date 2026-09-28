// Page-wide work after handwriting (history snapshot, local draft, cloud save,
// thumbnail) clones, serializes or redraws the whole page. On a written page
// each of those steps takes tens of milliseconds. A Pencil touch that arrives
// while such a task runs is answered late; iPadOS then hands the stroke to
// Scribble and strokes go missing until the page is idle again.
//
// The work is therefore held while the user writes and runs in real pauses.
// Only a long unbroken writing streak forces the local draft, right after a
// pen lift, when the next stroke is least likely to start.
export const NOTE_WORK_TIMING = Object.freeze({
  strokeFlushQuietMs: 1000,
  strokeFlushAfterLiftMs: 24,
  strokeFlushMaxPendingMs: 10_000,
  strokeFlushMaxPendingStrokes: 40,
  cloudSaveQuietMs: 2000,
  cloudSaveMaxHoldMs: 30_000,
  thumbnailQuietMs: 2500
});

const elapsed = (now, since) => Math.max(0, Number(now) - Number(since || 0));

function quietRemaining({ now, gestureActive, lastInputAt, quietMs }) {
  if (gestureActive) return quietMs;
  return Math.max(0, quietMs - elapsed(now, lastInputAt));
}

// Milliseconds until queued strokes should be flushed (0 = now).
export function strokeFlushDelay({
  now,
  gestureActive = false,
  lastInputAt = 0,
  pendingSince = now,
  pendingStrokes = 0,
  afterLift = false,
  timing = NOTE_WORK_TIMING
}) {
  const overdue = elapsed(now, pendingSince) >= timing.strokeFlushMaxPendingMs ||
    Number(pendingStrokes) >= timing.strokeFlushMaxPendingStrokes;
  if (overdue && !gestureActive) return afterLift ? timing.strokeFlushAfterLiftMs : 0;
  return quietRemaining({ now, gestureActive, lastInputAt, quietMs: timing.strokeFlushQuietMs });
}

// Milliseconds a scheduled cloud save should still wait (0 = start now).
export function cloudSaveHoldDelay({
  now,
  gestureActive = false,
  lastInputAt = 0,
  heldMs = 0,
  timing = NOTE_WORK_TIMING
}) {
  if (!gestureActive && Number(heldMs) >= timing.cloudSaveMaxHoldMs) return 0;
  return quietRemaining({ now, gestureActive, lastInputAt, quietMs: timing.cloudSaveQuietMs });
}

// Milliseconds until the edited page's thumbnail may be redrawn (0 = now).
export function thumbnailRefreshDelay({
  now,
  gestureActive = false,
  strokesPending = false,
  lastInputAt = 0,
  timing = NOTE_WORK_TIMING
}) {
  if (strokesPending) return timing.thumbnailQuietMs;
  return quietRemaining({ now, gestureActive, lastInputAt, quietMs: timing.thumbnailQuietMs });
}
