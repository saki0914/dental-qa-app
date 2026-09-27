export const NOTE_TOOL_DEFAULTS = Object.freeze({
  penWidth: 25,
  penColor: "#111111",
  penOpacity: 100,
  highlighterWidth: 36,
  highlighterColor: "#fff200",
  highlighterOpacity: 30,
  eraserMode: "object",
  eraserSize: 30,
  toolbarDock: "bottom",
  sidebarVisible: true,
  pencilMode: false,
  straightenEnabled: true,
  quickSwitchAction: "eraser"
});

const DOCKS = new Set(["top", "right", "bottom", "left"]);
const ERASERS = new Set(["object", "pixel"]);
const QUICK_ACTIONS = new Set(["eraser", "previous", "select", "select-all", "colors"]);
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
    eraserMode: ERASERS.has(value.eraserMode) ? value.eraserMode : NOTE_TOOL_DEFAULTS.eraserMode,
    eraserSize: clamp(value.eraserSize, 1, 100, NOTE_TOOL_DEFAULTS.eraserSize),
    toolbarDock: DOCKS.has(value.toolbarDock) ? value.toolbarDock : NOTE_TOOL_DEFAULTS.toolbarDock,
    sidebarVisible: value.sidebarVisible !== false,
    pencilMode: value.pencilMode === true,
    straightenEnabled: value.straightenEnabled !== false,
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
