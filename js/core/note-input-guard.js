export const NOTE_PALM_CONTACT_PX = 34;
export const NOTE_PEN_TOUCH_COOLDOWN_MS = 350;

export function createNoteInputGuard({
  now = () => performance.now(),
  palmContactPx = NOTE_PALM_CONTACT_PX,
  cooldownMs = NOTE_PEN_TOUCH_COOLDOWN_MS
} = {}) {
  let penActive = false;
  let penEndedAt = -Infinity;

  function notePointerDown(event) {
    if (event.pointerType === "pen") penActive = true;
  }

  function notePointerEnd(event) {
    if (event.pointerType === "pen") {
      penActive = false;
      penEndedAt = now();
    }
  }

  function isPalmCandidate(event) {
    return event.pointerType === "touch" && Math.max(Number(event.width || 0), Number(event.height || 0)) >= palmContactPx;
  }

  function shouldIgnoreTouch(event, { pencilMode = false, touchCount = 1 } = {}) {
    if (event.pointerType !== "touch") return false;
    if (touchCount >= 2) return false;
    return pencilMode || penActive || now() - penEndedAt < cooldownMs || isPalmCandidate(event);
  }

  return { notePointerDown, notePointerEnd, shouldIgnoreTouch, isPalmCandidate, isPenActive: () => penActive };
}
