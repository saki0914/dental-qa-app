export const NOTE_EDITOR_STARTUP_STATES = Object.freeze([
  "initializing",
  "checking-emulator",
  "authenticating",
  "acquiring-editor-lock",
  "loading-note-metadata",
  "loading-pages",
  "loading-content",
  "reconciling-local-draft",
  "loading-assets",
  "ready",
  "recoverable-error",
  "fatal-error"
]);

export const NOTE_SAVE_PRESENTATION = Object.freeze({
  idle: { icon: "✓", shortLabel: "待機中", label: "待機中" },
  editing: { icon: "•", shortLabel: "編集中", label: "編集中" },
  "dirty-local": { icon: "▣", shortLabel: "端末保存", label: "この端末内に保存済み" },
  "local-saved": { icon: "▣", shortLabel: "端末保存", label: "この端末内に保存済み" },
  saving: { icon: "◌", shortLabel: "保存中", label: "クラウドへ保存中" },
  saved: { icon: "✓", shortLabel: "保存済み", label: "保存済み" },
  offline: { icon: "▣", shortLabel: "オフライン", label: "オフライン。この端末内に保存済み" },
  "offline-local": { icon: "▣", shortLabel: "オフライン", label: "オフライン。この端末内に保存済み" },
  error: { icon: "!", shortLabel: "保存エラー", label: "クラウドへ保存できませんでした。この端末内には保存されています" },
  "recoverable-error": { icon: "!", shortLabel: "保存エラー", label: "クラウドへ保存できませんでした。この端末内には保存されています" },
  "local-storage-error": { icon: "!", shortLabel: "端末エラー", label: "端末内への保存に失敗しました。編集内容は画面内にだけ残っています" },
  conflict: { icon: "⇄", shortLabel: "競合あり", label: "このページに競合があります" }
});

const TAB_STORAGE_PREFIX = "dentalQaNoteEditorTab:";

export function resolveNoteEditorTabId({
  uid,
  routeEditorTabId = "",
  storage = globalThis.sessionStorage,
  createId
}) {
  if (!uid || typeof createId !== "function") throw new TypeError("編集タブIDの初期化情報が不足しています。");
  const key = `${TAB_STORAGE_PREFIX}${uid}`;
  const routeValue = String(routeEditorTabId || "").trim();
  const storedValue = String(storage?.getItem?.(key) || "").trim();
  // A newly opened editor receives a fresh route token. sessionStorage can be
  // cloned from its opener on Safari, so a different route token wins once.
  // Reloading the same tab then reuses the value stored in sessionStorage.
  // Every editor opened by the application has a unique URL token. When a
  // URL without one is entered directly, generate a new value instead of
  // trusting sessionStorage because Safari may clone it into a new tab.
  const value = routeValue || createId();
  storage?.setItem?.(key, value);
  return { key, value, matchedStoredValue: Boolean(storedValue && storedValue === value) };
}

export function rebaseRecoveredNoteContent(content, {
  noteId,
  pageId,
  sourceNoteId,
  createId
}) {
  if (!noteId || !pageId || !sourceNoteId || typeof createId !== "function") {
    throw new TypeError("復元コピーの再基底化情報が不足しています。");
  }
  const value = structuredClone(content || {});
  const elements = Array.isArray(value.elements) ? value.elements : [];
  const noteMasks = Array.isArray(value.noteMasks) ? value.noteMasks : [];
  const rebased = {
    ...value,
    schemaVersion: 1,
    noteId,
    pageId,
    revision: 0,
    savedAt: "",
    elements: elements.map(element => ({
      ...element,
      id: createId(),
      ...(element?.type === "image" ? { assetNoteId: element.assetNoteId || sourceNoteId } : {})
    })),
    noteMasks: noteMasks.map(mask => ({ ...mask, id: createId() }))
  };
  [
    "clientInstanceId",
    "editorTabId",
    "writerSessionId",
    "clientMutationId",
    "baseRevision",
    "expectedRevision",
    "mutationId",
    "mutationCreatedAt"
  ].forEach(field => { delete rebased[field]; });
  return rebased;
}

export function saveStatePresentation(state) {
  return NOTE_SAVE_PRESENTATION[state] || NOTE_SAVE_PRESENTATION.idle;
}

export function shouldRecoverLocalNoteState({ readOnly = false, preferCloud = false } = {}) {
  return readOnly !== true && preferCloud !== true;
}

export function reorderNoteMasks(noteMasks = [], selectedIds = [], edge = "front") {
  const selected = new Set((selectedIds || []).map(String));
  const masks = Array.isArray(noteMasks) ? noteMasks : [];
  const moving = masks.filter(mask => selected.has(String(mask?.id || "")));
  const rest = masks.filter(mask => !selected.has(String(mask?.id || "")));
  return edge === "back" ? [...moving, ...rest] : [...rest, ...moving];
}

export function createNoteEditorDiagnosticSnapshot(value = {}) {
  const allowed = [
    "capturedAt", "noteId", "pageId", "noteType", "editorTabId",
    "writerSessionId", "clientMutationId", "expectedRevision", "cloudRevision",
    "localDraftRevision", "saveState", "lockOwner", "lockAgeMs",
    "pendingSaves", "pendingAssets", "conflicts", "lastSaveSucceededAt",
    "lastError", "emulator", "urlParameters", "userAgent", "viewport",
    "zoom", "pageRect", "startupState", "drawing"
  ];
  return allowed.reduce((result, key) => {
    if (value[key] !== undefined) result[key] = structuredClone(value[key]);
    return result;
  }, {});
}

const SAFE_DIAGNOSTIC_URL_PARAMETERS = new Set([
  "firebaseEmulator",
  "emulatorHost",
  "noteEditor",
  "create",
  "creationSessionId",
  "noteId",
  "editorTabId",
  "study"
]);

export function sanitizeDiagnosticUrlParameters(entries = []) {
  return Object.fromEntries([...entries]
    .filter(([key]) => SAFE_DIAGNOSTIC_URL_PARAMETERS.has(String(key)))
    .map(([key, value]) => [String(key), String(value)]));
}

export function selectNoteFeatureUser({ dedicatedEditor = false, user = null, interactionReady = false } = {}) {
  return user && (dedicatedEditor || interactionReady) ? user : null;
}
