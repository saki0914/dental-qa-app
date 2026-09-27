export const NOTE_TRANSIENT_UI_TYPES = Object.freeze([
  "closed",
  "pen-settings",
  "highlighter-settings",
  "eraser-settings",
  "shape-settings",
  "text-settings",
  "input-settings",
  "color-palette",
  "image-source-menu",
  "selection-context-menu",
  "crop-editor",
  "more-menu",
  "save-status-popover",
  "local-environment-popover",
  "paste-fallback"
]);

const TYPES = new Set(NOTE_TRANSIENT_UI_TYPES);
const SETTINGS_BY_TOOL = Object.freeze({
  pen: "pen-settings",
  highlighter: "highlighter-settings",
  "eraser-object": "eraser-settings",
  "eraser-pixel": "eraser-settings",
  shape: "shape-settings",
  text: "text-settings"
});

export function createClosedTransientUi() {
  return { type: "closed", ownerTool: null, targetElementIds: [], anchor: null };
}

export function openTransientUi(type, {
  ownerTool = null,
  targetElementIds = [],
  anchor = null
} = {}) {
  if (!TYPES.has(type) || type === "closed") return createClosedTransientUi();
  return {
    type,
    ownerTool: ownerTool ? String(ownerTool) : null,
    targetElementIds: [...new Set((targetElementIds || []).map(String).filter(Boolean))],
    anchor: anchor && Number.isFinite(anchor.x) && Number.isFinite(anchor.y)
      ? { x: Number(anchor.x), y: Number(anchor.y) }
      : null
  };
}

export function settingsTransientType(tool) {
  return SETTINGS_BY_TOOL[String(tool || "")] || null;
}

export function transientUiIsSettings(state) {
  return String(state?.type || "").endsWith("-settings");
}

export function transientUiCanTransition(currentState, requestedType, {
  cropActive = false
} = {}) {
  if (!cropActive || currentState?.type !== "crop-editor") return true;
  return requestedType === "crop-editor";
}

export function transientPanelMaxHeight(viewportHeight, { compactLayout = false } = {}) {
  const height = Math.max(0, Number(viewportHeight) || 0);
  if (compactLayout) return Math.max(0, Math.min(560, height * .52, height - 170));
  return Math.max(220, Math.min(560, height - 96));
}

export function reconcileCropSession(cropSession, elements = []) {
  if (!cropSession) return { cropSession: null, shouldCloseTransientUi: false };
  const targetExists = (elements || []).some(element =>
    element?.id === cropSession.elementId && element?.type === "image"
  );
  return targetExists
    ? { cropSession, shouldCloseTransientUi: false }
    : { cropSession: null, shouldCloseTransientUi: true };
}

export function toolKeepsSelection(tool) {
  return tool === "select" || tool === "mask";
}

export function cancelledStrokeCanBeCommitted({
  type,
  pointerType,
  reason = "pointercancel",
  points = [],
  minPoints = 2,
  minLength = 0.001
} = {}) {
  if (!["pen", "highlighter"].includes(type)) return false;
  if (pointerType !== "pen") return false;
  if (["pagezoomstart", "tool-change", "page-change", "close"].includes(reason)) return false;
  if (!Array.isArray(points) || points.length < minPoints) return false;
  let length = 0;
  for (let index = 1; index < points.length; index += 1) {
    length += Math.hypot(
      Number(points[index].x || 0) - Number(points[index - 1].x || 0),
      Number(points[index].y || 0) - Number(points[index - 1].y || 0)
    );
  }
  return length >= minLength;
}
