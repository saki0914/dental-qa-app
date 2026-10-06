// A touch this wide (CSS px) or wider is taken for a resting hand. Safari on
// iPad reports a contact's width and height as twice the UITouch major radius
// (WebKit PointerEventIOS.cpp), so an ordinary fingertip is already about
// 40 px wide there and a thumb pressed flat about 80 px. Up to revision 10 the
// limit was 34 px, which turned almost every finger on iPad into a "palm":
// two-finger taps, finger pans and finger taps on masks did nothing.
export const NOTE_PALM_CONTACT_PX = 100;
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

// iPadOS Scribble watches Apple Pencil contacts that the page does not claim
// and can swallow whole strokes before any pointer event is sent (WebKit bug
// 217430): while writing, often every second quick stroke never produces a
// pointerdown. Preventing the default of stylus touch events claims them for
// the page. Fingers keep their native behaviour, native controls keep their
// click, and text input keeps Scribble so handwriting into a text box works.
const NATIVE_TOUCH_TARGET_SELECTOR = [
  "input",
  "textarea",
  "select",
  "button",
  "a[href]",
  "summary",
  "[contenteditable]:not([contenteditable=\"false\"])"
].join(",");

export function shouldClaimStylusTouch({
  touches = [],
  target = null,
  hasContent = false,
  textInputActive = false
} = {}) {
  if (!hasContent || textInputActive) return false;
  if (target?.closest?.(NATIVE_TOUCH_TARGET_SELECTOR)) return false;
  return Array.from(touches || []).some(touch => touch?.touchType === "stylus");
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

  // The Pencil is on the screen, or left it moments ago: a touch now is the
  // writing hand.
  function isPenRecentlyActive() {
    return penActive || now() - penEndedAt < cooldownMs;
  }

  function shouldIgnoreTouch(event, { pencilMode = false, touchCount = 1 } = {}) {
    if (event.pointerType !== "touch") return false;
    if (touchCount >= 2) return false;
    return pencilMode || isPenRecentlyActive() || isPalmCandidate(event);
  }

  return {
    notePointerDown,
    notePointerEnd,
    shouldIgnoreTouch,
    isPalmCandidate,
    isPenRecentlyActive,
    isPenActive: () => penActive,
    activePenPointerId: () => activePenPointerId
  };
}
