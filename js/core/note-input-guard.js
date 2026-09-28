export const NOTE_PALM_CONTACT_PX = 34;
export const NOTE_PEN_TOUCH_COOLDOWN_MS = 350;

export function isDrawingInputCaptureEnabled({
  hasContent = false,
  studyMode = false,
  markupMode = false,
  readOnlyEditor = false,
  tool = ""
} = {}) {
  return Boolean(hasContent) && !studyMode && markupMode && !readOnlyEditor && ["pen", "highlighter"].includes(tool);
}

export function registerInputDebugPointerdownCapture({
  enabled = false,
  targets = [],
  listener,
  signal
} = {}) {
  if (!enabled || typeof listener !== "function") return () => {};
  const registered = targets.filter(target => typeof target?.addEventListener === "function");
  const options = signal ? { capture: true, signal } : { capture: true };
  registered.forEach(target => target.addEventListener("pointerdown", listener, options));
  return () => registered.forEach(target => target.removeEventListener?.("pointerdown", listener, { capture: true }));
}

export function createNoteInputGuard({
  now = () => performance.now(),
  palmContactPx = NOTE_PALM_CONTACT_PX,
  cooldownMs = NOTE_PEN_TOUCH_COOLDOWN_MS
} = {}) {
  let penActive = false;
  let activePenPointerId = null;
  let penEndedAt = -Infinity;

  function notePointerDown(event) {
    if (event.pointerType === "pen") {
      penActive = true;
      activePenPointerId = event.pointerId ?? null;
    }
  }

  function notePointerEnd(event) {
    if (event.pointerType === "pen") {
      const pointerId = event.pointerId ?? null;
      if (activePenPointerId !== null && pointerId !== activePenPointerId) return false;
      penActive = false;
      activePenPointerId = null;
      penEndedAt = now();
      return true;
    }
    return false;
  }

  function isPalmCandidate(event) {
    return event.pointerType === "touch" && Math.max(Number(event.width || 0), Number(event.height || 0)) >= palmContactPx;
  }

  function shouldIgnoreTouch(event, { pencilMode = false, touchCount = 1 } = {}) {
    if (event.pointerType !== "touch") return false;
    if (touchCount >= 2) return false;
    return pencilMode || penActive || now() - penEndedAt < cooldownMs || isPalmCandidate(event);
  }

  return {
    notePointerDown,
    notePointerEnd,
    shouldIgnoreTouch,
    isPalmCandidate,
    isPenActive: () => penActive,
    activePenPointerId: () => activePenPointerId
  };
}
