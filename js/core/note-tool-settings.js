export const NOTE_TOOL_DEFAULTS = Object.freeze({
  penWidth: 25,
  penColor: "#111111",
  penOpacity: 100,
  highlighterWidth: 36,
  highlighterColor: "#fff200",
  highlighterOpacity: 30,
  shapeType: "line",
  shapeStrokeWidth: 25,
  shapeStrokeColor: "#111111",
  shapeStrokeOpacity: 100,
  shapeLineStyle: "solid",
  shapeFillColor: "#ff0000",
  shapeFillOpacity: 0,
  textFontFamily: "system-sans",
  textFontSize: 25,
  textBold: false,
  textItalic: false,
  textAlign: "left",
  textLineHeight: 1.25,
  textColor: "#111111",
  textOpacity: 100,
  eraserMode: "object",
  eraserSize: 30,
  toolbarDock: "bottom",
  sidebarVisible: true,
  toolbarAutoHide: false,
  pencilMode: false,
  fingerDraw: true,
  straightenEnabled: true,
  pageNavigation: "swipe",
  quickSwitchAction: "eraser"
});

const DOCKS = new Set(["top", "right", "bottom", "left"]);
const ERASERS = new Set(["object", "pixel"]);
const QUICK_ACTIONS = new Set(["eraser", "previous", "select", "select-all", "colors"]);
const PAGE_NAVIGATION = new Set(["swipe", "buttons"]);
const SHAPES = new Set(["line", "arrow", "rectangle", "rounded-rectangle", "ellipse", "triangle", "star"]);
const LINE_STYLES = new Set(["solid", "dashed", "dotted"]);
const FONT_FAMILIES = new Set(["system-sans", "system-serif", "monospace"]);
const TEXT_ALIGNS = new Set(["left", "center", "right"]);
const LINE_HEIGHTS = new Set([1, 1.25, 1.5, 2]);
const clamp = (value, min, max, fallback) => Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Number(value))) : fallback;
const color = (value, fallback) => /^#[0-9a-f]{6}$/i.test(String(value || "")) ? String(value).toLowerCase() : fallback;

export function normalizeNoteToolSettings(value = {}) {
  return {
    penWidth: clamp(value.penWidth, 1, 100, NOTE_TOOL_DEFAULTS.penWidth),
    penColor: color(value.penColor, NOTE_TOOL_DEFAULTS.penColor),
    penOpacity: clamp(value.penOpacity, 5, 100, NOTE_TOOL_DEFAULTS.penOpacity),
    highlighterWidth: clamp(value.highlighterWidth, 1, 100, NOTE_TOOL_DEFAULTS.highlighterWidth),
    highlighterColor: color(value.highlighterColor, NOTE_TOOL_DEFAULTS.highlighterColor),
    highlighterOpacity: clamp(value.highlighterOpacity, 5, 100, NOTE_TOOL_DEFAULTS.highlighterOpacity),
    shapeType: SHAPES.has(value.shapeType) ? value.shapeType : NOTE_TOOL_DEFAULTS.shapeType,
    shapeStrokeWidth: clamp(value.shapeStrokeWidth, 1, 100, NOTE_TOOL_DEFAULTS.shapeStrokeWidth),
    shapeStrokeColor: color(value.shapeStrokeColor, NOTE_TOOL_DEFAULTS.shapeStrokeColor),
    shapeStrokeOpacity: clamp(value.shapeStrokeOpacity, 5, 100, NOTE_TOOL_DEFAULTS.shapeStrokeOpacity),
    shapeLineStyle: LINE_STYLES.has(value.shapeLineStyle) ? value.shapeLineStyle : NOTE_TOOL_DEFAULTS.shapeLineStyle,
    shapeFillColor: color(value.shapeFillColor, NOTE_TOOL_DEFAULTS.shapeFillColor),
    shapeFillOpacity: clamp(value.shapeFillOpacity, 0, 100, NOTE_TOOL_DEFAULTS.shapeFillOpacity),
    textFontFamily: FONT_FAMILIES.has(value.textFontFamily) ? value.textFontFamily : NOTE_TOOL_DEFAULTS.textFontFamily,
    textFontSize: clamp(value.textFontSize, 10, 80, NOTE_TOOL_DEFAULTS.textFontSize),
    textBold: value.textBold === true,
    textItalic: value.textItalic === true,
    textAlign: TEXT_ALIGNS.has(value.textAlign) ? value.textAlign : NOTE_TOOL_DEFAULTS.textAlign,
    textLineHeight: LINE_HEIGHTS.has(Number(value.textLineHeight)) ? Number(value.textLineHeight) : NOTE_TOOL_DEFAULTS.textLineHeight,
    textColor: color(value.textColor, NOTE_TOOL_DEFAULTS.textColor),
    textOpacity: clamp(value.textOpacity, 5, 100, NOTE_TOOL_DEFAULTS.textOpacity),
    eraserMode: ERASERS.has(value.eraserMode) ? value.eraserMode : NOTE_TOOL_DEFAULTS.eraserMode,
    eraserSize: clamp(value.eraserSize, 1, 100, NOTE_TOOL_DEFAULTS.eraserSize),
    toolbarDock: DOCKS.has(value.toolbarDock) ? value.toolbarDock : NOTE_TOOL_DEFAULTS.toolbarDock,
    sidebarVisible: value.sidebarVisible !== false,
    toolbarAutoHide: value.toolbarAutoHide === true,
    pencilMode: value.pencilMode === true,
    fingerDraw: value.fingerDraw !== false,
    straightenEnabled: value.straightenEnabled !== false,
    pageNavigation: PAGE_NAVIGATION.has(value.pageNavigation) ? value.pageNavigation : NOTE_TOOL_DEFAULTS.pageNavigation,
    quickSwitchAction: QUICK_ACTIONS.has(value.quickSwitchAction) ? value.quickSwitchAction : NOTE_TOOL_DEFAULTS.quickSwitchAction
  };
}

export function createNoteToolSettingsStore({ uid, storage = globalThis.localStorage }) {
  if (!uid) throw new TypeError("設定保存にはユーザーIDが必要です。");
  const key = `dentalQaNoteToolSettings:${uid}`;
  function load() {
    try { return normalizeNoteToolSettings(JSON.parse(storage?.getItem?.(key) || "{}")); }
    catch { return normalizeNoteToolSettings(); }
  }
  function save(value) {
    const normalized = normalizeNoteToolSettings(value);
    storage?.setItem?.(key, JSON.stringify(normalized));
    return normalized;
  }
  return { key, load, save };
}
