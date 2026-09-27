import { convertPdfToImageFiles } from "../core/pdf-converter.js";
import {
  MAX_NOTE_IMAGE_BYTES,
  MAX_NOTE_IMAGE_HEIGHT,
  MAX_NOTE_IMAGE_WIDTH,
  decodeImageDimensions,
  validateImageBlob
} from "../core/file-validator.js";
import {
  angleFromCenter,
  clamp,
  clientPointToNormalized,
  cropImageFromHandle,
  distanceToSegment,
  elementBounds,
  lassoContainsElement,
  lineEndpoints,
  normalizeLineElement,
  normalizeNoteLineElements,
  normalizedBoundsFromPoints,
  resetImageCrop,
  resizeBoundsFromHandle,
  resizeElements,
  rotateElements,
  selectionBounds,
  splitStrokeByEraser,
  translateElement
} from "../core/note-geometry.js";
import { randomId } from "../core/id.js";
import { chooseClipboardImage, imageFileFromPasteEvent, isTextEditingTarget, readClipboardImage } from "../core/note-clipboard.js";
import { createNoteBackgroundSignature } from "../core/note-background.js";
import { resolveNoteConflicts } from "../core/note-conflict-resolution.js";
import { createNoteHistory } from "../core/note-history.js";
import { appendPointerSamples, copyStrokePointsForCommit, createStrokeSession, flushStrokePoints } from "../core/note-stroke-session.js";
import { createNoteEditorLease, getOrCreateNoteClientInstanceId } from "../core/note-editor-lock.js";
import {
  createNoteEditorDiagnosticSnapshot,
  rebaseRecoveredNoteContent,
  resolveNoteEditorTabId,
  reorderNoteMasks,
  sanitizeDiagnosticUrlParameters,
  saveStatePresentation,
  shouldRecoverLocalNoteState
} from "../core/note-editor-state.js";
import { createNoteInputGuard } from "../core/note-input-guard.js";
import { createNoteLocalStore, noteLocalKey } from "../core/note-local-store.js";
import { getMaterialPageMasks, maskVisibilityKey } from "../core/note-mask-adapter.js";
import {
  getMaterialDefaultNoteId,
  isMaterialArchiving
} from "../core/note-material-mutation.js";
import { createNoteSaveCoordinator } from "../core/note-save-coordinator.js";
import { canStraightenStroke, straightenedPoints, NOTE_STRAIGHTEN_HOLD_MS, NOTE_STRAIGHTEN_MOVE_PX } from "../core/note-straightener.js";
import { createNoteToolSettingsStore, normalizeNoteToolSettings } from "../core/note-tool-settings.js";
import {
  loadSessionBoundBackgroundBlob,
  loadSessionBoundMaterialDimensions
} from "../core/note-session-loading.js";
import { strokeSvgNodes } from "../core/note-stroke.js";
import { ensureTextElementHeight, layoutTextBox } from "../core/note-text-layout.js";
import { resolvePageSwipe } from "../core/note-page-swipe.js";
import { createNoteThumbnailSignature } from "../core/note-thumbnail.js";
import {
  cancelledStrokeCanBeCommitted,
  createClosedTransientUi,
  openTransientUi as createTransientUi,
  reconcileCropSession,
  settingsTransientType,
  toolKeepsSelection,
  transientPanelMaxHeight,
  transientUiCanTransition,
  transientUiIsSettings
} from "../core/note-transient-ui.js";
import { noteCanvasToJpeg, renderNotePageToCanvas } from "../core/note-renderer.js";
import { createPageZoomController } from "../core/page-zoom-controller.js";
import {
  PDF_EXPORT_PRESETS,
  createPdfFilename,
  downloadPdfBlob,
  exportNotePdf,
  parsePdfPageRange,
  pdfScreenHiddenMaskIds,
  sanitizePdfFilename,
  sharePdfBlob
} from "../core/note-pdf-export.js";
import { NoteConflictError, createNoteStore } from "../services/note-store.js";

const A4_SIZE = Object.freeze({ width: 1240, height: 1754 });
const DEFAULT_BACKGROUND = Object.freeze({
  type: "blank",
  paperColor: "#FFFFFF",
  ruleType: "none",
  ruleSpacingRatio: 0.035,
  ruleColor: "#D9DEE7",
  ruleOpacity: 0.7,
  ruleWidthRatio: 0.001
});
const TOOL_LABELS = {
  pan: "移動", select: "選択", pen: "ペン", highlighter: "ハイライト",
  "eraser-object": "消しゴム", "eraser-pixel": "ピクセル消しゴム", shape: "図形",
  text: "テキスト", image: "画像", mask: "暗記マスク", study: "暗記モード"
};

const clone = value => structuredClone(value);
const stableLegacyMutationId = value => {
  let hash = 2166136261;
  for (const character of String(value || "")) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `legacy-${(hash >>> 0).toString(16).padStart(8, "0")}`;
};
const emptyContent = (noteId, pageId, revision = 0) => ({
  schemaVersion: 1, noteId, pageId, revision, elements: [], noteMasks: [], savedAt: ""
});
const blankPage = (type = "blank", order = 1) => ({
  pageId: randomId(),
  order,
  pageType: "blank",
  size: { ...A4_SIZE },
  background: {
    ...DEFAULT_BACKGROUND,
    type: type === "ruled" ? "ruled" : "blank",
    ruleType: type === "ruled" ? "ruled" : "none"
  }
});
const pageFromBackground = (background, order = 1) => ({
  pageId: randomId(),
  order,
  pageType: "blank",
  size: { ...A4_SIZE },
  background: clone(background)
});
const noteTypeLabel = note => note.type === "pdf-imported" ? "PDFノート" : note.type === "material-linked" ? "教材連携ノート" : "白紙・罫線ノート";
const formatBytes = bytes => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.ceil(bytes / 1024)}KB`;
const svgNamespace = "http://www.w3.org/2000/svg";

function setBoundsStyle(node, bounds) {
  node.style.left = `${bounds.x * 100}%`;
  node.style.top = `${bounds.y * 100}%`;
  node.style.width = `${bounds.width * 100}%`;
  node.style.height = `${bounds.height * 100}%`;
}

function elementZIndex(elements) {
  return Math.max(0, ...elements.map(element => Number(element.zIndex || 0))) + 10;
}

export function createStudyNotes(dependencies) {
  const {
    getCurrentUser,
    getDb,
    getStorage,
    getMaterials = () => [],
    ensureMaterialDefaultNoteId = null,
    activateSection = () => {}
  } = dependencies;
  const byId = id => document.getElementById(id);
  const routeParams = new URLSearchParams(globalThis.location?.search || "");
  const dedicatedEditorRoute = routeParams.get("noteEditor") === "1";
  const dedicatedEditorCreateMode = dedicatedEditorRoute ? routeParams.get("create") || "" : "";
  const dedicatedEditorNoteId = dedicatedEditorRoute ? routeParams.get("noteId") || "" : "";
  const dedicatedEditor = Boolean(dedicatedEditorRoute && (dedicatedEditorNoteId || dedicatedEditorCreateMode));
  if (dedicatedEditor) {
    document.documentElement.classList.add("note-editor-dedicated");
    document.body.classList.add("note-editor-dedicated");
    if (dedicatedEditorCreateMode) {
      document.documentElement.classList.add("note-editor-create");
      document.body.classList.add("note-editor-create");
    }
  }
  const ui = {
    noteModeBtn: byId("noteModeBtn"), noteView: byId("noteView"), listView: byId("noteListView"),
    createView: byId("noteCreateView"), editorView: byId("noteEditorView"), list: byId("noteList"),
    listStatus: byId("noteListStatus"), newNoteBtn: byId("newNoteBtn"), cancelCreate: byId("cancelNoteCreateBtn"),
    newTitle: byId("newNoteTitle"), pdfInput: byId("notePdfInput"), materialPicker: byId("noteMaterialPicker"),
    createProgress: byId("noteCreateProgress"), createProgressLabel: byId("noteCreateProgressLabel"),
    createProgressBar: byId("noteCreateProgressBar"), cancelCreateProgress: byId("cancelNoteProgressBtn"),
    closeNote: byId("closeNoteBtn"), title: byId("noteTitleInput"), pageCounter: byId("notePageCounter"), pagesButton: byId("notePagesBtn"),
    editorHeader: byId("noteEditorView")?.querySelector(".note-editor-header"), localSlot: byId("noteEditorLocalSlot"),
    undo: byId("noteUndoBtn"), redo: byId("noteRedoBtn"), studyToggle: byId("toggleNoteStudyBtn"),
    saveStatus: byId("noteSaveStatus"), pageSidebar: byId("notePageSidebar"), pageList: byId("notePageList"),
    saveStatusIcon: byId("noteSaveStatusIcon"), saveStatusButtonText: byId("noteSaveStatusButtonText"), saveStatusLive: byId("noteSaveStatusLive"),
    saveStatusText: byId("noteSaveStatusText"), saveStatusDetail: byId("noteSaveStatusDetail"),
    savePopover: byId("noteSavePopover"), continueEditing: byId("noteContinueEditingBtn"),
    editorNotice: byId("noteEditorNotice"),
    moreMenu: byId("noteMoreMenu"),
    restoreLocalDraft: byId("noteRestoreLocalDraftBtn"),
    saveDiagnostics: byId("noteSaveDiagnosticsBtn"), saveList: byId("noteSaveListBtn"), markupDone: byId("noteMarkupDoneBtn"),
    retrySave: byId("noteRetrySaveBtn"),
    startup: byId("noteEditorStartup"), startupTitle: byId("noteEditorStartupTitle"),
    startupDetail: byId("noteEditorStartupDetail"), startupSlow: byId("noteEditorStartupSlow"),
    startupActions: byId("noteEditorStartupActions"),
    editorLayout: byId("noteEditorView")?.querySelector(".note-editor-layout"),
    lockBanner: byId("noteEditorLockBanner"), lockMessage: byId("noteEditorLockMessage"),
    lockReadOnly: byId("noteEditorReadOnlyBtn"), lockTakeover: byId("noteEditorTakeoverBtn"), lockReturn: byId("noteEditorReturnBtn"),
    conflictBanner: byId("notePageConflictBanner"),
    viewport: byId("noteViewport"), stage: byId("notePageStage"),
    drawingInput: byId("notePageStage")?.querySelector('[data-layer="drawing-input"]'), studyControls: byId("noteStudyControls"),
    eraserCursor: byId("notePixelEraserCursor"), maskSelectMode: byId("noteMaskSelectModeBtn"),
    maskCounts: byId("noteMaskCounts"), selectionActions: byId("noteSelectionActions"), selectionActionsTitle: byId("noteSelectionActionsTitle"),
    toolbar: byId("noteEditorView")?.querySelector(".note-toolbar"), settings: byId("noteToolSettings"),
    settingSections: [...document.querySelectorAll("#noteToolSettings [data-setting-tools]")],
    color: byId("noteColorInput"), width: byId("noteWidthInput"), opacity: byId("noteOpacityInput"),
    eraserMode: byId("noteEraserMode"), shapeType: byId("noteShapeType"), fingerDraw: byId("noteFingerDraw"),
    eraserSize: byId("noteEraserSize"), pencilMode: byId("notePencilMode"), straightenEnabled: byId("noteStraightenEnabled"),
    toolbarDock: byId("noteToolbarDock"), quickSwitchAction: byId("noteQuickSwitchAction"),
    pageNavigation: byId("notePageNavigation"),
    quickSwitch: byId("noteQuickSwitchBtn"), toolbarDrag: byId("noteToolbarDragHandle"), toolbarCollapse: byId("noteToolbarCollapseBtn"),
    eraserBadge: byId("noteEraserBadge"), settingsTitle: byId("noteToolSettingsTitle"),
    settingsDone: byId("noteToolSettingsDoneBtn"), toolbarAutoHide: byId("noteToolbarAutoHide"),
    inputSettings: byId("noteInputSettingsBtn"), maskVisibility: byId("noteMaskVisibilityBtn"),
    colorPresets: byId("noteColorPresets"), widthPresets: byId("noteWidthPresets"),
    widthValue: byId("noteWidthValue"), opacityValue: byId("noteOpacityValue"),
    eraserPresets: byId("noteEraserPresets"), eraserSizeValue: byId("noteEraserSizeValue"),
    lineStyle: byId("noteLineStyle"), fillColor: byId("noteFillColor"), fillOpacity: byId("noteFillOpacity"), fillOpacityValue: byId("noteFillOpacityValue"),
    shapeStrokeColor: byId("noteShapeStrokeColor"), shapeStrokeWidth: byId("noteShapeStrokeWidth"),
    shapeStrokeWidthValue: byId("noteShapeStrokeWidthValue"), shapeStrokeOpacity: byId("noteShapeStrokeOpacity"),
    shapeStrokeOpacityValue: byId("noteShapeStrokeOpacityValue"),
    fontFamily: byId("noteFontFamily"), fontSize: byId("noteFontSize"), fontBold: byId("noteFontBold"),
    fontSizeValue: byId("noteFontSizeValue"), fontItalic: byId("noteFontItalic"), textAlign: byId("noteTextAlign"), lineHeight: byId("noteLineHeight"),
    textColor: byId("noteTextColor"), textOpacity: byId("noteTextOpacity"), textOpacityValue: byId("noteTextOpacityValue"),
    currentColor: byId("noteCurrentColor"), styleBtn: byId("noteStyleBtn"), backgroundBtn: byId("noteBackgroundBtn"),
    imageSourceMenu: byId("noteImageSourceMenu"), imageSourceDone: byId("noteImageSourceDone"),
    imageClipboard: document.querySelector('#noteImageSourceMenu [data-image-source="clipboard"]'),
    imagePhoto: document.querySelector('#noteImageSourceMenu [data-image-source="photo"]'),
    imageFile: document.querySelector('#noteImageSourceMenu [data-image-source="file"]'),
    photoInput: byId("noteImagePhotoInput"), fileInput: byId("noteImageFileInput"), pasteFallback: byId("notePasteFallback"),
    localEnvironmentBanner: byId("localEnvironmentBanner"), localEnvironmentToggle: byId("localEnvironmentToggle"),
    localEnvironmentDetails: byId("localEnvironmentDetails"), localEnvironmentDone: byId("localEnvironmentDone"),
    exportDialog: byId("noteExportDialog"), exportPurpose: byId("noteExportPurpose"), exportRangeMode: byId("noteExportRangeMode"),
    exportRange: byId("noteExportRange"), exportQuality: byId("noteExportQuality"), exportFilename: byId("noteExportFilename"),
    exportPageNumbers: byId("noteExportPageNumbers"), exportProgress: byId("noteExportProgress"), exportStatus: byId("noteExportStatus"),
    createPdf: byId("createNotePdfBtn"), downloadPdf: byId("downloadNotePdfBtn"), sharePdf: byId("shareNotePdfBtn"),
    cancelPdf: byId("cancelNotePdfBtn")
  };
  if (dedicatedEditor && ui.localSlot && ui.localEnvironmentBanner) {
    ui.localSlot.append(ui.localEnvironmentBanner);
  }
  const localStore = createNoteLocalStore();
  const noteStore = createNoteStore({
    getDb,
    getStorage,
    getUser: getCurrentUser,
    queueCleanup: entry => queueCleanupRecord(entry)
  });
  const history = createNoteHistory({ limit: 100 });

  let notes = [];
  let orphanedDrafts = [];
  let currentNote = null;
  let pages = [];
  let currentPageIndex = 0;
  let currentContent = null;
  let currentTool = "pen";
  let selectedIds = [];
  let activeGesture = null;
  let pendingStrokeWork = null;
  let pendingStrokeTimer = 0;
  let pendingThumbnailTimer = 0;
  let swipeGesture = null;
  let pageSwitching = false;
  let maskMultiSelect = false;
  let eraserCursorFrame = 0;
  let transientUi = createClosedTransientUi();
  let syncingTransientUi = false;
  let renderToken = 0;
  let backgroundRenderToken = 0;
  let renderedBackgroundSignature = "";
  let objectUrls = [];
  let zoomController = null;
  let createController = null;
  let exportController = null;
  let generatedPdf = null;
  let lastTap = null;
  let pasteOffset = 0;
  let studyMode = false;
  let revealedMaskIds = new Set();
  let editingHiddenMaskIds = new Set();
  let assetCache = new Map();
  let contentCache = new Map();
  let hasSeenPen = false;
  let toolSettingsStore = null;
  let toolSettings = normalizeNoteToolSettings();
  let previousTool = "pen";
  let editorLease = null;
  let readOnlyEditor = !dedicatedEditor;
  let explicitReadOnlyMode = false;
  let clientInstanceId = "";
  let editorTabId = routeParams.get("editorTabId") || randomId();
  let conflictPageIds = new Set();
  const activeTouchPointerIds = new Set();
  let routeOpened = false;
  const inputGuard = createNoteInputGuard();
  const pendingAssetRecoveryPromises = new Map();
  const pendingRecoveryPromises = new Map();
  const pendingRecoverySweeps = new Map();
  const pendingLocalSavePromises = new Map();
  let userSessionGeneration = 0;
  let cropSession = null;
  const thumbnailTokens = new Map();
  let startupState = dedicatedEditor ? "initializing" : "ready";
  let startupSlowTimer = null;
  let lastStartupError = null;
  let lastSaveError = null;
  let lastSaveSucceededAt = "";
  let currentSaveState = "saved";
  const drawingDiagnostics = {
    pointerdown: 0,
    pointerup: 0,
    pointercancel: 0,
    lostpointercapture: 0,
    sessionsCreated: 0,
    strokesCommitted: 0,
    strokesDiscarded: 0,
    discardedReasons: {},
    coalescedPoints: 0,
    eventIntervals: [],
    straightenTimerFires: 0,
    longestMainThreadGapMs: 0
  };
  let markupMode = true;
  let localRecoverySuppressed = false;
  let textEditorSession = null;
  let editorNoticeTimer = null;

  function captureUserSession() {
    const uid = getCurrentUser()?.uid;
    return uid ? { uid, generation: userSessionGeneration } : null;
  }

  function assertUserSession(session) {
    if (!session || getCurrentUser()?.uid !== session.uid || userSessionGeneration !== session.generation) {
      const error = new Error("ログインユーザーが切り替わったため、ノート復旧処理を中断しました。");
      error.name = "NoteSessionChangedError";
      throw error;
    }
    return session;
  }

  function setEditorStartupState(state, { detail = "", error = null } = {}) {
    startupState = state;
    lastStartupError = error || (state.endsWith("error") ? lastStartupError : null);
    if (!dedicatedEditor || !ui.startup) return;
    clearTimeout(startupSlowTimer);
    ui.startup.dataset.state = state;
    const ready = state === "ready";
    ui.startup.classList.toggle("hidden", ready);
    ui.startupActions.classList.toggle("hidden", !state.endsWith("error"));
    const hasAuthenticatedUser = Boolean(captureUserSession());
    ui.startupActions.querySelectorAll('[data-startup-action="local"], [data-startup-action="cloud"], [data-startup-action="readonly"]')
      .forEach(button => button.classList.toggle("hidden", !hasAuthenticatedUser));
    ui.startupSlow.classList.add("hidden");
    const labels = {
      initializing: ["ノートを読み込んでいます", "初期化中"],
      "checking-emulator": ["ノートを読み込んでいます", "Firebase Emulatorを確認中"],
      authenticating: ["ノートを読み込んでいます", "ログイン状態を確認中"],
      "acquiring-editor-lock": ["ノートを読み込んでいます", "編集セッションを確認中"],
      "loading-note-metadata": ["ノートを読み込んでいます", "ノート情報を読み込み中"],
      "loading-pages": ["ノートを読み込んでいます", "ページデータを読み込み中"],
      "loading-content": ["ノートを読み込んでいます", "ページ内容を読み込み中"],
      "reconciling-local-draft": ["ノートを読み込んでいます", "端末内の下書きを照合中"],
      "loading-assets": ["ノートを読み込んでいます", "画像を読み込み中"],
      "recoverable-error": ["ノートを開けませんでした", "端末内の下書きを保持しています"],
      "fatal-error": ["ノートを開けませんでした", "安全に編集を開始できませんでした"]
    };
    const [title, phase] = labels[state] || labels.initializing;
    ui.startupTitle.textContent = title;
    ui.startupDetail.textContent = detail || `現在の処理：${phase}`;
    if (!ready && !state.endsWith("error")) {
      startupSlowTimer = setTimeout(() => ui.startupSlow.classList.remove("hidden"), 8_000);
    }
  }

  function setSaveState(state, { detail = "", error = null } = {}) {
    const presentation = saveStatePresentation(state);
    currentSaveState = state;
    if (error) lastSaveError = error;
    if (state === "saved") {
      lastSaveSucceededAt = new Date().toISOString();
      lastSaveError = null;
    }
    ui.saveStatus.dataset.state = state;
    ui.saveStatusIcon.textContent = presentation.icon;
    ui.saveStatusButtonText.textContent = presentation.shortLabel || presentation.label;
    ui.saveStatus.setAttribute("aria-label", presentation.label);
    ui.saveStatus.title = presentation.label;
    ui.saveStatusLive.textContent = presentation.label;
    ui.saveStatusText.textContent = presentation.label;
    ui.saveStatusDetail.textContent = detail || (
      state === "local-storage-error"
        ? "端末内下書きの保存にも失敗しました。画面を閉じず、空き容量とSafariの設定を確認して再試行してください。"
        : ["error", "recoverable-error", "offline", "offline-local"].includes(state)
        ? "編集内容はこの端末内に保持されています。"
        : state === "conflict"
          ? "このページだけ競合解決が必要です。ノート一覧へ戻ることもできます。"
          : "保存状態の詳細です。"
    );
    ui.retrySave.classList.toggle("hidden", !["error", "recoverable-error", "offline", "offline-local", "local-storage-error"].includes(state));
    ui.continueEditing.classList.toggle("hidden", !["error", "recoverable-error", "offline", "offline-local", "local-storage-error"].includes(state));
  }

  function closeSavePopover() {
    if (transientUi.type === "save-status-popover") closeTransientUi();
  }

  function setLocalDraftRecoveryAvailable(available) {
    ui.restoreLocalDraft?.classList.toggle("hidden", !dedicatedEditor || !available);
  }

  function toggleSavePopover(force) {
    const open = force ?? transientUi.type !== "save-status-popover";
    if (open) setTransientUi("save-status-popover");
    else closeTransientUi();
  }

  function noteListUrl() {
    const url = new URL(globalThis.location.href);
    ["noteEditor", "noteId", "editorTabId", "study", "create", "creationSessionId"].forEach(name => url.searchParams.delete(name));
    return url;
  }

  async function editorDiagnostics() {
    const uid = getCurrentUser()?.uid || "";
    const page = pages[currentPageIndex] || null;
    const key = uid && currentNote?.id && page?.pageId
      ? noteLocalKey(uid, currentNote.id, page.pageId)
      : "";
    const [draft, pendingSaves, pendingAssets, conflicts] = uid ? await Promise.all([
      key ? localStore.get("pageDrafts", key) : null,
      localStore.listForUser("pendingSaves", uid),
      localStore.listForUser("pendingAssets", uid),
      localStore.listForUser("conflicts", uid)
    ]) : [null, [], [], []];
    const lease = editorLease?.read?.() || null;
    const rect = ui.stage?.getBoundingClientRect?.();
    const identityValue = editorLease?.getIdentity?.() || {};
    return createNoteEditorDiagnosticSnapshot({
      capturedAt: new Date().toISOString(),
      noteId: currentNote?.id || dedicatedEditorNoteId || "",
      pageId: page?.pageId || "",
      noteType: currentNote?.type || "",
      editorTabId,
      writerSessionId: identityValue.writerSessionId || "",
      clientMutationId: page?.lastClientMutationId || "",
      expectedRevision: Number(page?.contentRevision || 0),
      cloudRevision: Number(page?.contentRevision || 0),
      localDraftRevision: Number(draft?.content?.revision ?? draft?.expectedRevision ?? 0),
      saveState: currentSaveState,
      lockOwner: lease ? { editorTabId: lease.editorTabId || "", writerSessionId: lease.writerSessionId || "" } : null,
      lockAgeMs: lease?.updatedAt ? Math.max(0, Date.now() - Number(lease.updatedAt)) : null,
      pendingSaves: pendingSaves.filter(item => !currentNote || item.noteId === currentNote.id).length,
      pendingAssets: pendingAssets.filter(item => !currentNote || item.noteId === currentNote.id).length,
      conflicts: conflicts.filter(item => !currentNote || item.noteId === currentNote.id).length,
      lastSaveSucceededAt,
      lastError: String(lastSaveError?.message || lastStartupError?.message || lastSaveError || lastStartupError || ""),
      emulator: {
        requested: routeParams.get("firebaseEmulator") === "1",
        host: routeParams.get("emulatorHost") || globalThis.location?.hostname || ""
      },
      urlParameters: sanitizeDiagnosticUrlParameters(routeParams.entries()),
      userAgent: globalThis.navigator?.userAgent || "",
      viewport: { width: globalThis.innerWidth || 0, height: globalThis.innerHeight || 0 },
      zoom: zoomController?.zoom || 1,
      pageRect: rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null,
      startupState,
      drawing: {
        ...drawingDiagnostics,
        eventIntervals: undefined,
        averageEventIntervalMs: drawingDiagnostics.eventIntervals.length
          ? drawingDiagnostics.eventIntervals.reduce((sum, value) => sum + value, 0) / drawingDiagnostics.eventIntervals.length
          : 0
      }
    });
  }

  async function copyDiagnostics() {
    const text = JSON.stringify(await editorDiagnostics(), null, 2);
    if (navigator.clipboard?.writeText && globalThis.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    document.execCommand?.("copy");
    textarea.remove();
  }

  async function downloadDiagnostics() {
    const blob = new Blob([JSON.stringify(await editorDiagnostics(), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `note-editor-diagnostic-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function initializeEditorPreferences(session = captureUserSession()) {
    if (!session) return;
    if (!clientInstanceId) clientInstanceId = getOrCreateNoteClientInstanceId(globalThis.localStorage, session.uid);
    if (dedicatedEditor) {
      editorTabId = resolveNoteEditorTabId({
        uid: session.uid,
        routeEditorTabId: routeParams.get("editorTabId") || "",
        storage: globalThis.sessionStorage,
        createId: randomId
      }).value;
    }
    if (!toolSettingsStore || !toolSettingsStore.key.includes(`:${session.uid}`)) {
      toolSettingsStore = createNoteToolSettingsStore({ uid: session.uid });
      toolSettings = toolSettingsStore.load();
    }
    applyToolSettingsToUi();
    if (dedicatedEditor && routeParams.get("editorTabId") !== editorTabId) {
      const url = new URL(globalThis.location.href);
      url.searchParams.set("editorTabId", editorTabId);
      globalThis.history?.replaceState?.(null, "", url);
    }
  }

  function selectedToolSettings() {
    if (currentTool === "highlighter") return {
      color: toolSettings.highlighterColor,
      width: toolSettings.highlighterWidth,
      opacity: toolSettings.highlighterOpacity
    };
    if (currentTool.startsWith("eraser")) return {
      color: toolSettings.penColor,
      width: toolSettings.eraserSize,
      opacity: 100
    };
    if (currentTool === "shape") return {
      color: toolSettings.shapeStrokeColor,
      width: toolSettings.shapeStrokeWidth,
      opacity: toolSettings.shapeStrokeOpacity
    };
    if (currentTool === "text") return {
      color: toolSettings.textColor,
      width: toolSettings.textFontSize,
      opacity: toolSettings.textOpacity
    };
    return { color: toolSettings.penColor, width: toolSettings.penWidth, opacity: toolSettings.penOpacity };
  }

  function syncTransientUi() {
    const type = transientUi.type;
    const settingsOpen = transientUiIsSettings(transientUi);
    syncingTransientUi = true;
    try {
      ui.settings.classList.toggle("hidden", !settingsOpen);
      ui.settings.setAttribute("aria-hidden", String(!settingsOpen));
      ui.imageSourceMenu?.classList.toggle("hidden", type !== "image-source-menu");
      ui.savePopover?.classList.toggle("hidden", type !== "save-status-popover");
      ui.saveStatus?.setAttribute("aria-expanded", String(type === "save-status-popover"));
      ui.localEnvironmentDetails?.classList.toggle("hidden", type !== "local-environment-popover");
      ui.localEnvironmentToggle?.setAttribute("aria-expanded", String(type === "local-environment-popover"));
      ui.pasteFallback?.classList.toggle("hidden", type !== "paste-fallback");
      if (ui.moreMenu) ui.moreMenu.open = type === "more-menu";
      ui.toolbar?.querySelectorAll("[data-note-tool]").forEach(button => {
        const buttonType = settingsTransientType(button.dataset.noteTool === "eraser-object" ? currentTool : button.dataset.noteTool);
        button.setAttribute("aria-expanded", String(settingsOpen && buttonType === type));
      });
      ui.inputSettings?.setAttribute("aria-expanded", String(type === "input-settings"));
      renderSelectionActionsVisibility();
    } finally {
      syncingTransientUi = false;
    }
  }

  function showEditorNotice(message) {
    if (!ui.editorNotice) return;
    clearTimeout(editorNoticeTimer);
    ui.editorNotice.textContent = String(message || "");
    ui.editorNotice.classList.remove("hidden");
    editorNoticeTimer = setTimeout(() => {
      ui.editorNotice.classList.add("hidden");
      ui.editorNotice.textContent = "";
    }, 4_000);
  }

  function setTransientUi(type = "closed", options = {}) {
    if (!transientUiCanTransition(transientUi, type, { cropActive: Boolean(cropSession) })) {
      syncTransientUi();
      showEditorNotice("トリミング編集中です。適用またはキャンセルしてから操作してください。");
      return false;
    }
    const previousType = transientUi.type;
    transientUi = type === "closed" ? createClosedTransientUi() : createTransientUi(type, options);
    const nextType = transientUi.type;
    syncTransientUi();
    requestAnimationFrame(() => {
      if (transientUi.type !== nextType) return;
      positionTransientUi();
      if (nextType === "save-status-popover" && previousType !== "save-status-popover") {
        ui.savePopover?.querySelector("button:not(.hidden):not(:disabled)")?.focus({ preventScroll: true });
      } else if (previousType === "save-status-popover" && nextType !== "save-status-popover") {
        ui.saveStatus?.focus({ preventScroll: true });
      }
    });
    return true;
  }

  function closeTransientUi() {
    return setTransientUi("closed");
  }

  function positionTransientUi() {
    if (transientUiIsSettings(transientUi)) positionTransientPanel(ui.settings);
    else if (transientUi.type === "image-source-menu") positionTransientPanel(ui.imageSourceMenu);
    else if (transientUi.type === "save-status-popover") positionSavePopover();
    else if (transientUi.type === "crop-editor") positionCropActions();
  }

  function positionSavePopover() {
    if (!ui.savePopover || ui.savePopover.classList.contains("hidden")) return true;
    const viewport = globalThis.visualViewport;
    const view = {
      left: Number(viewport?.offsetLeft || 0),
      top: Number(viewport?.offsetTop || 0),
      width: Number(viewport?.width || globalThis.innerWidth || 0),
      height: Number(viewport?.height || globalThis.innerHeight || 0)
    };
    const margin = 12;
    const availableWidth = view.width - margin * 2;
    const availableHeight = view.height - margin * 2;
    if (availableWidth <= 0 || availableHeight <= 0) {
      closeTransientUi();
      return false;
    }
    ui.savePopover.style.maxInlineSize = `${Math.floor(availableWidth)}px`;
    ui.savePopover.style.maxBlockSize = `${Math.floor(availableHeight)}px`;
    const anchor = ui.saveStatus.getBoundingClientRect();
    const popover = ui.savePopover.getBoundingClientRect();
    if (popover.width > availableWidth + 1 || popover.height > availableHeight + 1) {
      closeTransientUi();
      return false;
    }
    const gap = 6;
    const minLeft = view.left + margin;
    const maxLeft = view.left + view.width - popover.width - margin;
    const left = Math.min(Math.max(anchor.right - popover.width, minLeft), Math.max(minLeft, maxLeft));
    const minTop = view.top + margin;
    const maxTop = view.top + view.height - popover.height - margin;
    const below = anchor.bottom + gap;
    const above = anchor.top - popover.height - gap;
    const preferredTop = below <= maxTop ? below : above;
    const top = Math.min(Math.max(preferredTop, minTop), Math.max(minTop, maxTop));
    ui.savePopover.style.left = `${Math.round(left)}px`;
    ui.savePopover.style.top = `${Math.round(top)}px`;
    return true;
  }

  function renderSelectionActionsVisibility() {
    if (!ui.selectionActions) return;
    const hasSelection = Boolean(currentContent) && (currentTool === "select"
      ? selectedElements().length > 0
      : currentTool === "mask" && selectedMasks().length > 0);
    ui.selectionActions.classList.toggle("hidden", !hasSelection || studyMode || transientUi.type !== "selection-context-menu");
    if (hasSelection && ui.selectionActionsTitle) {
      const elements = selectedElements();
      ui.selectionActionsTitle.textContent = currentTool === "mask"
        ? `${selectedMasks().length}個選択中`
        : elements.length === 1 && elements[0].type === "image"
          ? "画像を編集"
          : "選択項目を編集";
    }
    const maskActions = new Set(["duplicate", "front", "back", "weak", "weak-on", "weak-off", "delete", "select-page-masks", "clear-selection"]);
    ui.selectionActions.querySelectorAll("button[data-selection-action]").forEach(button => {
      button.classList.toggle("hidden", currentTool === "mask" && !maskActions.has(button.dataset.selectionAction));
    });
  }

  function showSelectionContext() {
    const ids = currentTool === "mask" ? selectedMasks().map(mask => mask.id) : selectedElements().map(element => element.id);
    if (ids.length) setTransientUi("selection-context-menu", { ownerTool: currentTool, targetElementIds: ids });
    else if (transientUi.type === "selection-context-menu") closeTransientUi();
    else renderSelectionActionsVisibility();
  }

  function applyToolbarDock(dock = toolSettings.toolbarDock) {
    const value = ["top", "right", "bottom", "left"].includes(dock) ? dock : "bottom";
    toolSettings.toolbarDock = value;
    ui.toolbar.dataset.dock = value;
    ui.toolbar.classList.remove("dock-top", "dock-right", "dock-bottom", "dock-left");
    ui.toolbar.classList.add(`dock-${value}`);
    ui.settings.classList.remove("dock-top", "dock-right", "dock-bottom", "dock-left");
    ui.settings.classList.add(`dock-${value}`);
    ui.imageSourceMenu?.classList.remove("dock-top", "dock-right", "dock-bottom", "dock-left");
    ui.imageSourceMenu?.classList.add(`dock-${value}`);
    ui.editorView.dataset.toolbarDock = value;
    if (ui.toolbarDock) ui.toolbarDock.value = value;
  }

  function renderToolPresets() {
    const isHighlighter = currentTool === "highlighter";
    const colors = isHighlighter
      ? ["#fff200", "#8cff66", "#6ce5ff", "#ff8bc8", "#ffad5a", "#b89cff", "#ffffff", "#ffd6e7"]
      : ["#111111", "#ef4444", "#2563eb", "#16a34a", "#eab308", "#f97316", "#9333ea", "#ffffff"];
    const selected = selectedToolSettings();
    ui.colorPresets?.replaceChildren(...colors.map(value => {
      const button = document.createElement("button");
      button.type = "button"; button.style.background = value; button.dataset.color = value;
      button.classList.toggle("active", value.toLowerCase() === selected.color.toLowerCase());
      button.setAttribute("aria-label", `${value}を選択`); button.title = `${value}を選択`;
      return button;
    }));
    const widths = currentTool === "highlighter"
      ? [["細い", 18], ["標準", 36], ["太い", 58], ["極太", 82]]
      : currentTool.startsWith("eraser")
        ? [["小", 14], ["中", 30], ["大", 60]]
        : [["極細", 8], ["細い", 16], ["標準", 25], ["太い", 45], ["極太", 72]];
    ui.widthPresets?.replaceChildren(...widths.map(([label, value]) => {
      const button = document.createElement("button"); button.type = "button";
      button.textContent = label; button.dataset.width = String(value);
      button.classList.toggle("active", Number(selected.width) === value);
      return button;
    }));
    ui.eraserPresets?.replaceChildren(...[["小", 14], ["中", 30], ["大", 60]].map(([label, value]) => {
      const button = document.createElement("button"); button.type = "button";
      button.textContent = label; button.dataset.width = String(value);
      button.classList.toggle("active", Number(toolSettings.eraserSize) === value);
      return button;
    }));
  }

  function applyToolSettingsToUi() {
    const selected = selectedToolSettings();
    ui.color.value = selected.color;
    ui.width.value = String(selected.width);
    ui.opacity.value = String(selected.opacity);
    ui.currentColor.style.background = selected.color;
    if (ui.widthValue) ui.widthValue.value = String(Math.round(selected.width));
    if (ui.opacityValue) ui.opacityValue.value = `${Math.round(selected.opacity)}%`;
    ui.eraserMode.value = toolSettings.eraserMode;
    if (ui.eraserSize) ui.eraserSize.value = String(toolSettings.eraserSize);
    if (ui.eraserSizeValue) ui.eraserSizeValue.value = String(Math.round(toolSettings.eraserSize));
    ui.shapeType.value = toolSettings.shapeType;
    ui.shapeStrokeColor.value = toolSettings.shapeStrokeColor;
    ui.shapeStrokeWidth.value = String(toolSettings.shapeStrokeWidth);
    ui.shapeStrokeOpacity.value = String(toolSettings.shapeStrokeOpacity);
    ui.shapeStrokeWidthValue.value = String(Math.round(toolSettings.shapeStrokeWidth));
    ui.shapeStrokeOpacityValue.value = `${Math.round(toolSettings.shapeStrokeOpacity)}%`;
    ui.lineStyle.value = toolSettings.shapeLineStyle;
    ui.fillColor.value = toolSettings.shapeFillColor;
    ui.fillOpacity.value = String(toolSettings.shapeFillOpacity);
    ui.fillOpacityValue.value = `${Math.round(toolSettings.shapeFillOpacity)}%`;
    ui.fontFamily.value = toolSettings.textFontFamily;
    ui.fontSize.value = String(toolSettings.textFontSize);
    ui.fontSizeValue.value = String(Math.round(toolSettings.textFontSize));
    ui.textColor.value = toolSettings.textColor;
    ui.textOpacity.value = String(toolSettings.textOpacity);
    ui.textOpacityValue.value = `${Math.round(toolSettings.textOpacity)}%`;
    ui.fontBold.checked = toolSettings.textBold;
    ui.fontItalic.checked = toolSettings.textItalic;
    ui.textAlign.value = toolSettings.textAlign;
    ui.lineHeight.value = String(toolSettings.textLineHeight);
    if (ui.pencilMode) ui.pencilMode.checked = toolSettings.pencilMode;
    if (ui.fingerDraw) ui.fingerDraw.checked = toolSettings.fingerDraw;
    if (ui.straightenEnabled) ui.straightenEnabled.checked = toolSettings.straightenEnabled;
    if (ui.quickSwitchAction) ui.quickSwitchAction.value = toolSettings.quickSwitchAction;
    if (ui.pageNavigation) ui.pageNavigation.value = toolSettings.pageNavigation;
    if (ui.toolbarAutoHide) ui.toolbarAutoHide.checked = toolSettings.toolbarAutoHide;
    if (ui.eraserBadge) ui.eraserBadge.textContent = toolSettings.eraserMode === "pixel" ? "P" : "O";
    syncMaskVisibilityControl();
    ui.editorLayout?.classList.toggle("sidebar-hidden", toolSettings.sidebarVisible === false);
    ui.pageSidebar.classList.toggle("open", toolSettings.sidebarVisible !== false);
    ui.pagesButton.setAttribute("aria-expanded", String(toolSettings.sidebarVisible !== false));
    ui.pagesButton.setAttribute("aria-label", toolSettings.sidebarVisible === false ? "ページ一覧を表示" : "ページ一覧を隠す");
    applyToolbarDock();
    renderToolPresets();
    renderSelectionActionsVisibility();
  }

  function persistToolSettings(patch = {}) {
    toolSettings = toolSettingsStore?.save({ ...toolSettings, ...patch }) || normalizeNoteToolSettings({ ...toolSettings, ...patch });
    applyToolSettingsToUi();
  }

  function setEditorReadOnly(value, message = "") {
    readOnlyEditor = value === true;
    ui.editorView.classList.toggle("is-readonly", readOnlyEditor);
    ui.title.readOnly = readOnlyEditor;
    ui.editorView.querySelectorAll([
      "[data-page-action]",
      ".note-page-row-actions button",
      '[data-note-action="rename"]',
      '[data-note-action="duplicate"]',
      '[data-note-action="delete"]'
    ].join(",")).forEach(button => { button.disabled = readOnlyEditor; });
    ui.backgroundBtn.disabled = readOnlyEditor || conflictPageIds.has(pages[currentPageIndex]?.pageId);
    ui.lockBanner.classList.toggle("hidden", !message);
    if (message) ui.lockMessage.textContent = message;
    syncDrawingInputLayer();
  }

  function hasWriterOwnership() {
    return !dedicatedEditor || editorLease?.isWriter() === true;
  }

  function isEditableNow(page = pages[currentPageIndex]) {
    return Boolean(
      currentNote &&
      currentContent &&
      !studyMode &&
      markupMode &&
      !readOnlyEditor &&
      hasWriterOwnership() &&
      !conflictPageIds.has(page?.pageId)
    );
  }

  function canMutateCurrentNote(note = currentNote, { page = null, allowConflict = true } = {}) {
    if (!note) return false;
    if (!dedicatedEditor || currentNote?.id !== note.id) return true;
    if (readOnlyEditor || !hasWriterOwnership()) {
      setEditorReadOnly(true, "このタブは読み取り専用です。編集を引き継ぐと操作できます。");
      return false;
    }
    if (!allowConflict && conflictPageIds.has((page || pages[currentPageIndex])?.pageId)) {
      explainBlockedEdit(page || pages[currentPageIndex]);
      return false;
    }
    return true;
  }

  function explainBlockedEdit(page = pages[currentPageIndex]) {
    if (conflictPageIds.has(page?.pageId)) {
      ui.conflictBanner.classList.remove("hidden");
      return;
    }
    if (readOnlyEditor) {
      setEditorReadOnly(true, "このタブは読み取り専用です。編集を引き継ぐと操作できます。");
    }
  }

  async function establishEditorLease(noteId, session, { forceReadOnly = false } = {}) {
    editorLease?.dispose();
    editorLease = null;
    if (!dedicatedEditor) {
      setEditorReadOnly(true, "ノート一覧画面は保存を行いません。編集は専用タブで開いてください。");
      return { acquired: false };
    }
    initializeEditorPreferences(session);
    editorLease = createNoteEditorLease({
      uid: session.uid,
      noteId,
      editorTabId,
      clientInstanceId,
      onOwnershipLost: () => setEditorReadOnly(true, "編集権が別のタブへ移りました。このタブは読み取り専用です。")
    });
    if (forceReadOnly) {
      setEditorReadOnly(true, "読み取り専用で開いています。編集内容は保存されません。");
      return { acquired: false, readOnly: true };
    }
    const previous = editorLease.read();
    if (previous && Number(previous.expiresAt || 0) <= Date.now() && previous.editorTabId !== editorTabId) {
      setEditorReadOnly(true, "以前の編集セッションが終了していないようです。このタブで編集を再開するか、読み取り専用で開いてください。");
      return { acquired: false, stale: true, lease: previous };
    }
    const result = await editorLease.claim();
    if (result.acquired) setEditorReadOnly(false);
    else setEditorReadOnly(true, "このノートは別のタブで編集中です。");
    return result;
  }

  function editorUrl(noteId, { study = false } = {}) {
    const url = new URL(globalThis.location.href);
    url.searchParams.set("noteEditor", "1");
    url.searchParams.set("noteId", noteId);
    url.searchParams.set("editorTabId", randomId());
    url.searchParams.delete("create");
    url.searchParams.delete("creationSessionId");
    if (study) url.searchParams.set("study", "1"); else url.searchParams.delete("study");
    return url;
  }

  function pdfCreationUrl() {
    const url = new URL(globalThis.location.href);
    url.searchParams.set("noteEditor", "1");
    url.searchParams.set("create", "pdf");
    url.searchParams.set("creationSessionId", randomId());
    ["noteId", "editorTabId", "study"].forEach(name => url.searchParams.delete(name));
    return url;
  }

  function openPdfCreationSurface() {
    const url = pdfCreationUrl().toString();
    const opened = globalThis.open?.(url, "_blank");
    if (opened) {
      try { opened.opener = null; } catch {}
      return opened;
    }
    showEditorNotice("新しいタブを開けませんでした。この画面でPDFノート作成を続けます。");
    globalThis.location.assign(url);
    return null;
  }

  function reserveEditorTab() {
    const opened = globalThis.open?.("about:blank", "_blank");
    if (!opened) throw new Error("ノート編集タブを開けませんでした。ポップアップを許可して再試行してください。");
    try {
      opened.document.title = "ノートを準備しています";
      opened.document.body.textContent = "ノートを準備しています…";
      opened.opener = null;
    } catch {}
    return opened;
  }

  function openEditorTab(noteId, options = {}, reservedWindow = null) {
    const opened = reservedWindow || globalThis.open?.(editorUrl(noteId, options).toString(), "_blank");
    if (!opened) throw new Error("ノート編集タブを開けませんでした。ポップアップを許可して再試行してください。");
    if (reservedWindow) opened.location.replace(editorUrl(noteId, options).toString());
    try { opened.opener = null; } catch {}
    return opened;
  }

  const recoveryKey = (session, noteId = "all") => `${session.uid}|${session.generation}|${noteId}`;

  const saveCoordinator = createNoteSaveCoordinator({
    localStore,
    debounceMs: 850,
    isSessionCurrent: identity => (
      getCurrentUser()?.uid === identity.uid &&
      userSessionGeneration === identity.sessionGeneration &&
      (!identity.writerSessionId || editorLease?.isWriter() === true)
    ),
    persist: async (identity, content, isActive) => {
      const page = currentNote?.id === identity.noteId
        ? pages.find(item => item.pageId === identity.pageId)
        : null;
      // The coordinator owns the serial save baseline.  `page.contentRevision`
      // is presentation state and can legitimately lag while a newer edit is
      // queued behind an in-flight save.
      const expectedRevision = Number(identity.expectedRevision);
      if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
        throw new Error("保存対象ページのリビジョンが見つかりません。");
      }
      const result = await noteStore.enqueuePageContentSave({
        noteId: identity.noteId,
        pageId: identity.pageId,
        expectedRevision,
        expectedUid: identity.uid,
        clientInstanceId: identity.clientInstanceId,
        editorTabId: identity.editorTabId,
        writerSessionId: identity.writerSessionId,
        clientMutationId: identity.clientMutationId,
        mutationCreatedAt: identity.mutationCreatedAt,
        baseRevision: identity.baseRevision
      }, content);
      // A successful older generation must still advance the page baseline;
      // otherwise the next queued generation reuses a stale revision and
      // conflicts with its own predecessor.
      if (page && result.revision >= Number(page.contentRevision || 0)) {
        page.contentRevision = result.revision;
        page.contentPath = result.contentPath;
        page.contentHash = result.contentHash;
        page.lastClientMutationId = identity.clientMutationId;
      }
      content.revision = result.revision;
      if (!isActive()) return result;
      if (currentNote?.id === identity.noteId) {
        if (pages[currentPageIndex]?.pageId === identity.pageId && currentContent) {
          currentContent.revision = result.revision;
          contentCache.set(identity.pageId, clone(currentContent));
        } else {
          const cached = contentCache.get(identity.pageId);
          contentCache.set(identity.pageId, { ...clone(cached || content), revision: result.revision });
        }
      }
      return result;
    },
    onStatus: (status, identity, detail, conflictRecord) => {
      if (!currentNote || identity.noteId !== currentNote.id || identity.pageId !== pages[currentPageIndex]?.pageId) return;
      const normalizedStatus = status === "error"
        ? "recoverable-error"
        : status === "offline"
          ? "offline-local"
          : status === "local-error"
            ? "local-storage-error"
            : status;
      setSaveState(normalizedStatus, { error: detail instanceof Error ? detail : null });
      if (status === "conflict") {
        currentNote.hasConflict = true;
        conflictPageIds.add(identity.pageId);
        ui.backgroundBtn.disabled = pages[currentPageIndex]?.pageId === identity.pageId;
        ui.conflictBanner.classList.toggle("hidden", pages[currentPageIndex]?.pageId !== identity.pageId);
        renderPageList();
        const applyConflict = conflict => {
          if (!conflict || currentNote?.id !== identity.noteId) return;
          currentNote.conflicts = [
            ...(currentNote.conflicts || []).filter(item => item.key !== conflict.key),
            conflict
          ];
        };
        if (conflictRecord) applyConflict(conflictRecord);
        else void loadConflictRecord(identity.noteId, identity.pageId, identity.uid)
          .then(applyConflict)
          .catch(error => console.error("競合情報を画面へ反映できませんでした。", error));
      }
      if (detail instanceof Error) console.error(detail);
    }
  });

  function identity(page = pages[currentPageIndex]) {
    const editorIdentity = editorLease?.getIdentity?.() || {};
    return {
      uid: getCurrentUser()?.uid,
      noteId: currentNote?.id,
      pageId: page?.pageId,
      expectedRevision: Number(page?.contentRevision || 0),
      sessionGeneration: userSessionGeneration,
      clientInstanceId,
      editorTabId,
      writerSessionId: editorIdentity.writerSessionId || ""
    };
  }

  function localSaveKey(saveIdentity) {
    return noteLocalKey(saveIdentity.uid, saveIdentity.noteId, saveIdentity.pageId);
  }

  function scheduleLocalSave(saveIdentity, content) {
    const key = localSaveKey(saveIdentity);
    const task = saveCoordinator.schedule(saveIdentity, content);
    pendingLocalSavePromises.set(key, task);
    const clear = () => {
      if (pendingLocalSavePromises.get(key) === task) pendingLocalSavePromises.delete(key);
    };
    task.then(clear, clear);
    return task;
  }

  async function waitForLocalSave(saveIdentity) {
    await pendingLocalSavePromises.get(localSaveKey(saveIdentity));
  }

  async function loadConflictRecord(noteId, pageId, uid = getCurrentUser()?.uid) {
    if (!uid || !noteId || !pageId) return null;
    const conflict = await localStore.get("conflicts", noteLocalKey(uid, noteId, pageId));
    return conflict?.uid === uid && conflict.noteId === noteId && conflict.pageId === pageId
      ? conflict
      : null;
  }

  async function queueCleanupRecord({ uid = getCurrentUser()?.uid, noteId = "", path, kind = "storage", error }) {
    if (!uid || !path) throw new TypeError("クリーンアップ記録にはuidとpathが必要です。");
    const timestamp = new Date().toISOString();
    const key = `${uid}|cleanup|${randomId()}`;
    try {
      await localStore.put("pendingCleanups", {
        key, uid, noteId, path, kind,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastTriedAt: timestamp,
        retryCount: 0,
        error: String(error?.message || error || "cleanup failed")
      });
    } catch (queueError) {
      console.warn("クリーンアップ再試行キューへ記録できませんでした。", queueError);
      throw queueError;
    }
  }

  async function recoverPendingCleanups(session = captureUserSession()) {
    if (!session || navigator.onLine === false) return;
    assertUserSession(session);
    const pending = await localStore.listForUser("pendingCleanups", session.uid);
    assertUserSession(session);
    for (const item of pending) {
      if (item.nextRetryAt && new Date(item.nextRetryAt).getTime() > Date.now()) continue;
      try {
        assertUserSession(session);
        await noteStore.cleanupStoragePath(item.path, { noteId: item.noteId, expectedUid: session.uid });
        assertUserSession(session);
        await localStore.deleteIfUnchanged("pendingCleanups", item.key, item.updatedAt || item.createdAt);
        assertUserSession(session);
      } catch (error) {
        if (error?.name === "NoteSessionChangedError") throw error;
        const retryCount = Number(item.retryCount || 0) + 1;
        assertUserSession(session);
        await localStore.put("pendingCleanups", {
          ...item,
          retryCount,
          lastTriedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          error: String(error?.message || error),
          nextRetryAt: new Date(Date.now() + Math.min(3_600_000, 1000 * 2 ** Math.min(10, retryCount))).toISOString()
        });
        assertUserSession(session);
      }
    }
  }

  async function flushWithDecision(page = pages[currentPageIndex], actionLabel = "操作") {
    if (!isEditableNow(page)) return true;
    while (true) {
      try {
        await saveCoordinator.flush(identity(page));
        return true;
      } catch (error) {
        console.error(error);
        const choice = prompt(
          `${actionLabel}の前にクラウド保存できませんでした。端末内の下書きは保持されています。\n` +
          "retry（再試行）/ continue（端末内保持して続行）/ cancel（操作をキャンセル）",
          "retry"
        )?.trim().toLowerCase();
        if (choice === "retry") continue;
        if (choice === "continue") return true;
        return false;
      }
    }
  }

  async function flushAllWithDecision(actionLabel = "操作") {
    while (true) {
      const results = await saveCoordinator.flushAll();
      if (!results.some(result => result instanceof Error)) return true;
      const choice = prompt(
        `${actionLabel}の前に一部のページをクラウド保存できませんでした。端末内の下書きは保持されています。\n` +
        "retry（再試行）/ continue（端末内保持して続行）/ cancel（操作をキャンセル）",
        "retry"
      )?.trim().toLowerCase();
      if (choice === "retry") continue;
      return choice === "continue";
    }
  }

  function releaseObjectUrls() {
    objectUrls.forEach(url => URL.revokeObjectURL(url));
    objectUrls = [];
  }

  function resetPageRender() {
    renderToken += 1;
    backgroundRenderToken += 1;
    renderedBackgroundSignature = "";
    releaseObjectUrls();
    removeCropActions();
    [...ui.stage.children].forEach(node => {
      if (node !== ui.drawingInput && node !== ui.eraserCursor) node.remove();
    });
    syncDrawingInputLayer();
  }

  function show(view) {
    if (view !== "editor") {
      cancelActiveInteraction("close");
      cancelCropEditor({ restore: true });
      closeTransientUi();
      selectedIds = [];
    }
    ui.listView.classList.toggle("hidden", view !== "list");
    ui.createView.classList.toggle("hidden", view !== "create");
    ui.editorView.classList.toggle("hidden", view !== "editor");
  }

  function setListStatus(message) {
    ui.listStatus.textContent = message;
  }

  async function refreshNotes() {
    const session = captureUserSession();
    if (!session) {
      if (dedicatedEditor) setEditorStartupState("authenticating", { detail: "現在の処理：ログイン状態を確認中" });
      return;
    }
    initializeEditorPreferences(session);
    if (dedicatedEditor && !routeOpened) setEditorStartupState("loading-note-metadata");
    setListStatus("ノートを読み込んでいます...");
    try {
      const loadedNotes = await noteStore.listNotes({ expectedUid: session.uid });
      assertUserSession(session);
      const [conflicts, pendingSaves, pendingAssets, pageDrafts] = await Promise.all([
        localStore.listForUser("conflicts", session.uid),
        localStore.listForUser("pendingSaves", session.uid),
        localStore.listForUser("pendingAssets", session.uid),
        localStore.listForUser("pageDrafts", session.uid)
      ]);
      assertUserSession(session);
      notes = loadedNotes;
      const liveNoteIds = new Set(notes.map(note => note.id));
      const draftsByKey = new Map(pageDrafts.map(draft => [draft.key, draft]));
      orphanedDrafts = [...pendingSaves.reduce((groups, pending) => {
        if (liveNoteIds.has(pending.noteId)) return groups;
        const draft = draftsByKey.get(pending.key);
        if (!draft?.content) return groups;
        if (!groups.has(pending.noteId)) groups.set(pending.noteId, { noteId: pending.noteId, items: [] });
        groups.get(pending.noteId).items.push({ pending, draft });
        return groups;
      }, new Map()).values()];
      notes.forEach(note => {
        note.conflicts = conflicts.filter(conflict => conflict.noteId === note.id);
        note.hasConflict = note.conflicts.length > 0;
        note.pendingSaveCount = pendingSaves.filter(item => item.noteId === note.id).length;
        note.pendingAssetCount = pendingAssets.filter(item => item.noteId === note.id).length;
        note.unsyncedCount = new Set([
          ...pendingSaves.filter(item => item.noteId === note.id).map(item => item.pageId),
          ...pendingAssets.filter(item => item.noteId === note.id).map(item => item.pageId)
        ]).size;
      });
      renderNoteList();
      const unsyncedCount = notes.reduce((sum, note) => sum + Number(note.unsyncedCount || 0), 0);
      setListStatus(notes.length
        ? `${notes.length}件のノートがあります。${unsyncedCount ? ` 端末内に未同期の変更が${unsyncedCount}ページあります。` : ""}${orphanedDrafts.length ? ` 一覧にないノートの下書きが${orphanedDrafts.length}件あります。` : ""}`
        : orphanedDrafts.length ? `一覧にないノートの下書きが${orphanedDrafts.length}件あります。復元できます。` : "ノートはまだありません。");
      if (dedicatedEditorCreateMode === "pdf" && !routeOpened) {
        routeOpened = true;
        ui.newTitle.value = "新しいPDFノート";
        show("create");
      } else if (dedicatedEditor && !routeOpened) {
        await openNote(dedicatedEditorNoteId, { study: routeParams.get("study") === "1", inline: true });
        routeOpened = true;
      }
      if ((!readOnlyEditor || !dedicatedEditor) && !localRecoverySuppressed) {
        void recoverAllPendingWork(session).catch(error => {
          if (error?.name !== "NoteSessionChangedError") console.warn("未送信ノートの自動再送を継続できませんでした。", error);
        });
      }
    } catch (error) {
      if (error?.name === "NoteSessionChangedError") return;
      console.error(error);
      setListStatus(`ノートを読み込めませんでした。${error.message || error}`);
      if (dedicatedEditor) {
        routeOpened = false;
        editorLease?.dispose();
        editorLease = null;
        const recoverable = Boolean(getCurrentUser()?.uid);
        setEditorStartupState(recoverable ? "recoverable-error" : "fatal-error", {
          detail: `ノートを開けませんでした：${error.message || error}`,
          error
        });
      }
    }
  }

  function renderNoteList() {
    ui.list.querySelectorAll("img[data-thumbnail-url]").forEach(image => {
      URL.revokeObjectURL(image.dataset.thumbnailUrl);
    });
    ui.list.replaceChildren();
    orphanedDrafts.forEach(group => {
      const card = document.createElement("article");
      card.className = "note-card note-recovery-card";
      const title = document.createElement("h4");
      title.textContent = "一覧にないノートの未保存下書き";
      const meta = document.createElement("div");
      meta.className = "note-card-meta";
      meta.textContent = `${group.items.length}ページ分を端末内に保持しています。削除・作成失敗したノートの内容を新しいノートとして復元できます。`;
      const actions = document.createElement("div");
      actions.className = "note-card-actions";
      const restore = document.createElement("button");
      restore.type = "button";
      restore.textContent = "新規ノートとして復元";
      restore.addEventListener("click", () => {
        let reservedWindow;
        try { reservedWindow = reserveEditorTab(); }
        catch (error) { reportError(error); return; }
        if (!confirm(`${group.items.length}ページ分の端末内下書きを、新しいノートとして復元しますか？`)) {
          reservedWindow.close?.();
          return;
        }
        restoreOrphanedDrafts(group, reservedWindow).catch(error => {
          reservedWindow?.close?.();
          reportError(error);
        });
      });
      actions.append(restore);
      card.append(title, meta, actions);
      ui.list.append(card);
    });
    notes.forEach(note => {
      const card = document.createElement("article");
      card.className = "note-card";
      const preview = document.createElement("div"); preview.className = "note-card-preview loading"; preview.textContent = noteTypeLabel(note);
      const title = document.createElement("h4"); title.textContent = note.title || "無題ノート";
      const meta = document.createElement("div"); meta.className = "note-card-meta";
      const materialMaskCount = note.type === "material-linked"
        ? getMaterials().find(material => material.id === note.sourceMaterialId)?.masks?.length || 0
        : 0;
      const updatedAt = note.updatedAt?.toDate?.() || (note.updatedAt ? new Date(note.updatedAt) : null);
      const updatedLabel = updatedAt instanceof Date && Number.isFinite(updatedAt.getTime())
        ? updatedAt.toLocaleString("ja-JP")
        : "日時不明";
      const saveState = note.hasConflict ? "競合あり" : note.unsyncedCount ? "端末内へ保存済み" : "保存済み";
      meta.textContent = `${noteTypeLabel(note)} / ${note.pageCount || 0}ページ / ノートマスク ${note.noteMaskCount || 0}件${note.type === "material-linked" ? ` / 教材マスク ${materialMaskCount}件` : ""} / 最終編集 ${updatedLabel} / ${saveState}${note.pendingSaveCount ? ` / 下書き再送待ち ${note.pendingSaveCount}件` : ""}${note.pendingAssetCount ? ` / 画像再送待ち ${note.pendingAssetCount}件` : ""}`;
      const actions = document.createElement("div"); actions.className = "note-card-actions";
      [
        ["編集", () => openEditorTab(note.id)],
        ["暗記", () => openEditorTab(note.id, { study: true })],
        ["PDF", () => openExportFromList(note.id)],
        ["名前変更", () => renameNote(note)],
        ["複製", () => duplicateNote(note.id)],
        ...(note.hasConflict ? [["競合を解決", () => resolveConflict(note)]] : []),
        ["削除", () => deleteNote(note)]
      ].forEach(([label, action]) => {
        const button = document.createElement("button"); button.type = "button"; button.textContent = label;
        button.addEventListener("click", () => Promise.resolve(action()).catch(reportError)); actions.append(button);
      });
      card.append(preview, title, meta, actions); ui.list.append(card);
      preview.tabIndex = 0;
      preview.setAttribute("role", "button");
      preview.setAttribute("aria-label", `${note.title || "無題ノート"}を編集`);
      preview.addEventListener("click", () => openEditorTab(note.id));
      preview.addEventListener("keydown", event => {
        if (["Enter", " "].includes(event.key)) { event.preventDefault(); openEditorTab(note.id); }
      });
      void hydrateNoteCardThumbnail(note, preview).catch(error => {
        preview.classList.remove("loading");
        preview.classList.add("fallback");
        preview.textContent = noteTypeLabel(note);
        console.warn(`「${note.title || "無題ノート"}」のサムネイルを作成できませんでした。`, error);
      });
    });
  }

  async function hydrateNoteCardThumbnail(note, preview) {
    const session = captureUserSession();
    if (!session || !preview?.isConnected) return;
    const tokenKey = `card:${note.id}`;
    const token = Number(thumbnailTokens.get(tokenKey) || 0) + 1;
    thumbnailTokens.set(tokenKey, token);
    const notePages = await noteStore.listPages(note.id, { expectedUid: session.uid });
    assertUserSession(session);
    const page = notePages[0];
    if (!page) throw new Error("先頭ページがありません。");
    const draftKey = noteLocalKey(session.uid, note.id, page.pageId);
    const draft = await localStore.get("pageDrafts", draftKey);
    const content = normalizeNoteLineElements(
      draft?.uid === session.uid && draft.content
        ? draft.content
        : await noteStore.loadPageContent(note.id, page, { expectedUid: session.uid }),
      page.size
    );
    assertUserSession(session);
    const material = page.background?.type === "material-page"
      ? getMaterials().find(item => item.id === page.background.materialId)
      : null;
    const materialMasks = getMaterialPageMasks(material, page.background?.materialPage);
    const signature = createNoteThumbnailSignature({
      noteId: note.id,
      firstPageId: page.pageId,
      page,
      content,
      materialMasks,
      maskMode: "all"
    });
    const cacheKey = noteLocalKey(session.uid, note.id, page.pageId, "note-card-thumbnail");
    const cached = await localStore.get("thumbnails", cacheKey);
    let blob = cached?.signature === signature && cached.blob instanceof Blob && cached.blob.size > 0
      ? cached.blob
      : null;
    if (!blob) {
      const pendingAssets = await localStore.listForUser("pendingAssets", session.uid);
      pendingAssets.filter(item => item.noteId === note.id && item.blob instanceof Blob)
        .forEach(item => assetCache.set(`${note.id}|${item.assetId}`, item.blob));
      const sourceWidth = Number(page.size?.width || A4_SIZE.width);
      const sourceHeight = Number(page.size?.height || A4_SIZE.height);
      const width = 220;
      const height = Math.max(1, Math.round(width * sourceHeight / sourceWidth));
      const canvas = await renderNotePageToCanvas({
        page,
        content,
        materialMasks,
        resolveBackgroundBlob,
        resolveAssetBlob: (assetId, sourceNoteId) => resolveAssetBlob(assetId, sourceNoteId || note.id),
        width,
        height,
        maskMode: "all"
      });
      blob = await noteCanvasToJpeg(canvas, .72);
      canvas.width = 1;
      canvas.height = 1;
      await localStore.put("thumbnails", {
        key: cacheKey,
        uid: session.uid,
        noteId: note.id,
        pageId: page.pageId,
        signature,
        blob,
        updatedAt: new Date().toISOString()
      });
    }
    assertUserSession(session);
    if (!preview.isConnected || thumbnailTokens.get(tokenKey) !== token) return;
    const url = URL.createObjectURL(blob);
    const image = document.createElement("img");
    image.alt = `${note.title || "無題ノート"}の先頭ページ`;
    image.src = url;
    image.dataset.thumbnailUrl = url;
    preview.replaceChildren(image);
    preview.classList.remove("loading", "fallback");
  }

  function reportError(error) {
    console.error(error);
    alert(error?.message || error || "処理に失敗しました。");
  }

  async function compensateCreationFailure(noteId, options, primaryError) {
    try {
      const compensation = await noteStore.abortCreatingNote(noteId, { ...options, error: primaryError });
      if (compensation.errors.length) {
        primaryError.creationCleanupErrors = [
          ...(primaryError.creationCleanupErrors || []),
          ...compensation.errors
        ];
      }
      return compensation;
    } catch (cleanupError) {
      primaryError.creationCleanupErrors = [
        ...(primaryError.creationCleanupErrors || []),
        cleanupError
      ];
      console.error("ノート作成失敗時の補償処理を完了できませんでした。", cleanupError);
      return null;
    }
  }

  async function createStandalone(kind, reservedWindow = null) {
    const session = captureUserSession();
    assertUserSession(session);
    const title = ui.newTitle.value.trim() || "新しい学習ノート";
    const page = blankPage(kind);
    const noteId = await noteStore.createNote({
      title, type: "standalone", defaultBackground: page.background, pages: [page], expectedUid: session.uid
    });
    assertUserSession(session);
    await refreshNotes();
    assertUserSession(session);
    openEditorTab(noteId, {}, reservedWindow);
  }

  function renderMaterialPicker() {
    ui.materialPicker.replaceChildren();
    const materials = getMaterials();
    if (!materials.length) {
      ui.materialPicker.textContent = "画像教材がありません。先に教材管理から追加してください。";
    }
    materials.forEach(material => {
      const button = document.createElement("button"); button.type = "button";
      const archiving = isMaterialArchiving(material);
      button.textContent = `${material.title || "無題教材"}（${material.pages?.length || 0}枚）${archiving ? " — 差し替え・削除処理中" : ""}`;
      button.disabled = archiving;
      button.addEventListener("click", () => {
        let reservedWindow;
        try { reservedWindow = reserveEditorTab(); }
        catch (error) { reportError(error); return; }
        openMaterialNote(material.id, reservedWindow).catch(error => { reservedWindow.close?.(); reportError(error); });
      });
      ui.materialPicker.append(button);
    });
    ui.materialPicker.classList.remove("hidden");
  }

  async function openMaterialNote(materialId, reservedWindow = null) {
    if (!reservedWindow && !dedicatedEditor) reservedWindow = reserveEditorTab();
    const session = captureUserSession();
    assertUserSession(session);
    const material = getMaterials().find(item => item.id === materialId);
    if (!material) throw new Error("教材が見つかりません。");
    if (isMaterialArchiving(material)) {
      throw new Error("教材の差し替え・削除処理中のため、連携ノートを開けません。");
    }
    await refreshNotes();
    assertUserSession(session);
    const legacyActiveNote = notes.find(item =>
      item.type === "material-linked" && item.sourceMaterialId === materialId && !item.deletedAt
    );
    let defaultNoteId = getMaterialDefaultNoteId(material);
    if (!defaultNoteId) {
      defaultNoteId = ensureMaterialDefaultNoteId
        ? await ensureMaterialDefaultNoteId(materialId, legacyActiveNote?.id)
        : legacyActiveNote?.id || randomId();
    }
    let note = notes.find(item => item.id === defaultNoteId && !item.deletedAt);
    if (!note) {
      const existingDefault = await noteStore.getNote(defaultNoteId, { expectedUid: session.uid });
      assertUserSession(session);
      if (existingDefault && (!existingDefault.status || existingDefault.status === "ready")) {
        if (existingDefault.deletedAt) await noteStore.restoreNote(defaultNoteId, session.uid);
        assertUserSession(session);
        note = { id: defaultNoteId };
      }
    }
    if (!note) {
      const noteId = defaultNoteId;
      const notePages = [];
      for (let index = 0; index < (material.pages || []).length; index += 1) {
        const source = material.pages[index];
        let width = Number(source.width || 0);
        let height = Number(source.height || 0);
        if (!(width > 0 && height > 0)) {
          const dimensions = await loadSessionBoundMaterialDimensions({
            source,
            session,
            assertUserSession,
            getStorageBlob: (path, options) => noteStore.getStorageBlob(path, options),
            decodeImageDimensions
          });
          assertUserSession(session);
          if (dimensions) {
            ({ naturalWidth: width, naturalHeight: height } = dimensions);
          }
        }
        notePages.push({
          pageId: `material-page-${String(index + 1).padStart(4, "0")}`,
          order: index + 1,
          pageType: "material-page",
          size: { width: width > 0 ? width : 2200, height: height > 0 ? height : 3111 },
          background: { type: "material-page", materialId, materialPage: Number(source.page || index + 1) }
        });
      }
      if (!notePages.length) throw new Error("教材に画像ページがありません。");
      await noteStore.createNote({
        noteId,
        title: `${material.title || "画像教材"} ノート`, type: "material-linked", sourceMaterialId: materialId,
        isDefaultMaterialNote: true,
        defaultBackground: { ...DEFAULT_BACKGROUND }, pages: notePages, reuseExisting: true, expectedUid: session.uid
      });
      assertUserSession(session);
      note = { id: noteId };
      await refreshNotes();
    }
    activateSection("note");
    openEditorTab(note.id, {}, reservedWindow);
  }

  async function createPdfNote(file, reservedWindow = null) {
    if (!file) return;
    const session = captureUserSession();
    assertUserSession(session);
    const title = ui.newTitle.value.trim() || file.name.replace(/\.pdf$/i, "") || "PDFノート";
    const noteId = randomId();
    const uploaded = [];
    const notePages = [];
    createController = new AbortController();
    ui.createProgress.classList.remove("hidden");
    ui.createProgressBar.value = 0;
    await noteStore.createCreatingNote(noteId, { title, type: "pdf-imported", defaultBackground: { ...DEFAULT_BACKGROUND } }, session.uid);
    assertUserSession(session);
    try {
      await convertPdfToImageFiles(file, (current, total) => {
        const percent = Math.round(current / total * 100);
        ui.createProgressBar.value = percent;
        ui.createProgressLabel.textContent = `PDFを読み込んでいます ${current} / ${total}ページ（${percent}%）`;
      }, {
        signal: createController.signal,
        onPage: async ({ file: pageFile, pageNumber, width, height }) => {
          assertUserSession(session);
          const pageId = randomId();
          const imagePath = await noteStore.uploadSourcePage(noteId, pageId, pageFile, session.uid);
          assertUserSession(session);
          uploaded.push(imagePath);
          notePages.push({
            pageId, order: pageNumber, pageType: "pdf-source-page", size: { width, height },
            background: { type: "pdf-source-page", imagePath, sourcePageNumber: pageNumber }
          });
        }
      });
      assertUserSession(session);
      if (!notePages.length) throw new Error("PDFにページがありません。");
      await noteStore.finalizeCreatingNote(noteId, notePages, session.uid);
      assertUserSession(session);
      await refreshNotes();
      if (dedicatedEditorCreateMode === "pdf") {
        globalThis.location.replace(editorUrl(noteId).toString());
      } else {
        openEditorTab(noteId, {}, reservedWindow);
      }
    } catch (error) {
      await compensateCreationFailure(noteId, {
        pageIds: notePages.map(page => page.pageId),
        storagePaths: uploaded,
        phase: error?.name === "AbortError" ? "cancelled" : "pdf-import",
        expectedUid: session.uid
      }, error);
      reservedWindow?.close?.();
      if (error?.name !== "AbortError") throw new Error(`PDFノートは作成されていません。${error.message || error}`);
      setListStatus("PDFノートの作成をキャンセルしました。");
    } finally {
      createController = null;
      ui.createProgress.classList.add("hidden");
      ui.pdfInput.value = "";
    }
  }

  async function pageContent(page, { preferCloud = false } = {}) {
    const session = captureUserSession();
    assertUserSession(session);
    const cached = preferCloud ? null : contentCache.get(page.pageId);
    if (cached) return clone(cached);
    const local = preferCloud ? null : await localStore.get("pageDrafts", noteLocalKey(session.uid, currentNote.id, page.pageId));
    assertUserSession(session);
    const content = normalizeNoteLineElements(
      local?.uid === session.uid ? local.content : await noteStore.loadPageContent(currentNote.id, page, { expectedUid: session.uid }),
      page.size
    );
    assertUserSession(session);
    contentCache.set(page.pageId, clone(content));
    return content;
  }

  function preloadAdjacentPages() {
    [currentPageIndex - 1, currentPageIndex + 1]
      .filter(index => index >= 0 && index < pages.length)
      .forEach(index => {
        const page = pages[index];
        void pageContent(page)
          .then(() => ["pdf-source-page", "material-page"].includes(page.background?.type) ? resolveBackgroundBlob(page) : null)
          .catch(error => console.debug("隣接ページの先読みを完了できませんでした。", error));
      });
  }

  async function openNote(noteId, { study = false, inline = false, preferCloud = false, forceReadOnly = false } = {}) {
    if (!dedicatedEditor && !inline) {
      openEditorTab(noteId, { study });
      return;
    }
    const session = captureUserSession();
    assertUserSession(session);
    cancelActiveInteraction("close");
    cancelCropEditor({ restore: true });
    closeTransientUi();
    setLocalDraftRecoveryAvailable(false);
    setEditorStartupState("loading-note-metadata");
    if (currentNote && !await flushWithDecision(pages[currentPageIndex], "別のノートを開く操作")) return;
    localRecoverySuppressed = preferCloud;
    explicitReadOnlyMode = forceReadOnly === true;
    assertUserSession(session);
    currentNote = await noteStore.getNote(noteId, { expectedUid: session.uid });
    assertUserSession(session);
    if (!currentNote || currentNote.deletedAt) throw new Error("ノートが見つかりません。");
    setEditorStartupState("loading-pages");
    pages = await noteStore.listPages(noteId, { expectedUid: session.uid });
    assertUserSession(session);
    if (!pages.length) throw new Error("ノートにページがありません。");
    setEditorStartupState("acquiring-editor-lock");
    await establishEditorLease(noteId, session, { forceReadOnly });
    currentPageIndex = 0;
    applyToolSettingsToUi();
    contentCache = new Map(); assetCache = new Map(); selectedIds = [];
    revealedMaskIds = new Set(); editingHiddenMaskIds = new Set();
    // Choosing the cloud version must only read cloud state. Local drafts and
    // assets remain durable in IndexedDB until the user explicitly retries or
    // creates a recovered copy from the save-status popover.
    if (shouldRecoverLocalNoteState({ readOnly: readOnlyEditor, preferCloud })) {
      setEditorStartupState("loading-assets");
      await recoverPendingAssets(noteId);
      setEditorStartupState("reconciling-local-draft");
      await recoverPendingSaves(noteId, pages);
    }
    pages = await noteStore.listPages(noteId, { expectedUid: session.uid });
    assertUserSession(session);
    const localConflicts = await localStore.listForUser("conflicts", session.uid);
    assertUserSession(session);
    conflictPageIds = new Set(localConflicts.filter(conflict => conflict.noteId === noteId).map(conflict => conflict.pageId));
    currentNote.conflicts = localConflicts.filter(conflict => conflict.noteId === noteId);
    currentNote.hasConflict = conflictPageIds.size > 0;
    history.clear();
    ui.title.value = currentNote.title || "無題ノート";
    show("editor");
    setEditorStartupState("loading-content");
    await loadCurrentPage({ preferCloud });
    const [pendingForNote, pendingAssetsForNote] = await Promise.all([
      localStore.listForUser("pendingSaves", session.uid),
      localStore.listForUser("pendingAssets", session.uid)
    ]).then(([pendingSaves, pendingAssets]) => [
      pendingSaves.filter(item => item.noteId === noteId),
      pendingAssets.filter(item => item.noteId === noteId)
    ]);
    setLocalDraftRecoveryAvailable(pendingForNote.length > 0 || pendingAssetsForNote.length > 0);
    if (pendingForNote.length || pendingAssetsForNote.length) {
      const pendingDetail = [
        pendingForNote.length ? `下書き再送待ち ${pendingForNote.length}件` : "",
        pendingAssetsForNote.length ? `画像再送待ち ${pendingAssetsForNote.length}件` : ""
      ].filter(Boolean).join(" / ");
      setSaveState(navigator.onLine === false ? "offline-local" : "recoverable-error", { detail: pendingDetail });
    } else {
      setSaveState("saved");
    }
    if (currentNote.hasConflict) {
      setSaveState("conflict");
    }
    ui.conflictBanner.classList.toggle("hidden", !conflictPageIds.has(pages[currentPageIndex]?.pageId));
    setMarkupMode(true);
    setStudyMode(study);
    setEditorStartupState("ready");
  }

  async function loadCurrentPage(options = {}) {
    const page = pages[currentPageIndex];
    if (!page) return;
    selectedIds = [];
    cancelActiveInteraction("page-change");
    cancelCropEditor({ restore: true });
    closeTransientUi();
    currentContent = await pageContent(page, options);
    ui.conflictBanner.classList.toggle("hidden", !conflictPageIds.has(page.pageId));
    renderPageList();
    renderPage();
    preloadAdjacentPages();
  }

  function renderPageList() {
    releaseThumbnailUrls();
    ui.pageList.replaceChildren();
    pages.forEach((page, index) => {
      const item = document.createElement("li"); item.classList.toggle("active", index === currentPageIndex);
      const open = document.createElement("button"); open.type = "button"; open.className = "note-page-thumbnail";
      open.dataset.pageId = page.pageId;
      open.setAttribute("aria-label", `${index + 1}ページを開く`);
      open.textContent = `${index + 1}\n${page.pageType === "pdf-source-page" ? "PDF" : page.pageType === "material-page" ? "教材" : page.background?.type === "ruled" ? "罫線" : "白紙"}`;
      open.addEventListener("click", () => switchPage(index).catch(reportError));
      const actions = document.createElement("div"); actions.className = "note-page-row-actions";
      [["↑", "up"], ["↓", "down"], ["複製", "duplicate"], ["削除", "delete"]].forEach(([label, action]) => {
        const button = document.createElement("button"); button.type = "button"; button.textContent = label; button.title = `${index + 1}ページ ${label}`;
        button.disabled = readOnlyEditor || !hasWriterOwnership() || conflictPageIds.has(page.pageId);
        button.addEventListener("click", () => pageAction(action, index).catch(reportError)); actions.append(button);
      });
      item.append(open, actions); ui.pageList.append(item);
      void hydratePageThumbnail(page, open).catch(error => {
        open.classList.remove("loading");
        open.classList.add("fallback");
        console.warn(`${index + 1}ページのサムネイルを作成できませんでした。`, error);
      });
    });
    ui.pageCounter.textContent = `${currentPageIndex + 1} / ${pages.length}`;
  }

  function releaseThumbnailUrls() {
    ui.pageList.querySelectorAll("img[data-thumbnail-url]").forEach(image => {
      URL.revokeObjectURL(image.dataset.thumbnailUrl);
    });
  }

  function showPageThumbnail(button, blob, pageNumber) {
    if (!button?.isConnected) return;
    const previous = button.querySelector("img[data-thumbnail-url]");
    if (previous?.dataset.thumbnailUrl) URL.revokeObjectURL(previous.dataset.thumbnailUrl);
    const url = URL.createObjectURL(blob);
    const image = document.createElement("img");
    image.alt = `${pageNumber}ページのサムネイル`;
    image.src = url;
    image.dataset.thumbnailUrl = url;
    button.replaceChildren(image);
    button.classList.remove("loading", "fallback");
  }

  async function hydratePageThumbnail(page, button, { force = false } = {}) {
    const uid = getCurrentUser()?.uid;
    const noteId = currentNote?.id;
    if (!uid || !noteId || !page || !button) return;
    const token = Number(thumbnailTokens.get(page.pageId) || 0) + 1;
    thumbnailTokens.set(page.pageId, token);
    button.classList.add("loading");
    const pageNumber = pages.findIndex(item => item.pageId === page.pageId) + 1;
    const content = page.pageId === pages[currentPageIndex]?.pageId && currentContent
      ? clone(currentContent)
      : await pageContent(page);
    const materialMasks = getMaterialPageMasks(
      page.background?.type === "material-page"
        ? getMaterials().find(material => material.id === page.background.materialId)
        : null,
      page.background?.materialPage
    );
    const signature = createNoteThumbnailSignature({
      noteId,
      firstPageId: pages[0]?.pageId,
      page,
      content,
      materialMasks,
      maskMode: "all"
    });
    const key = noteLocalKey(uid, noteId, page.pageId, "thumbnail");
    const cached = force ? null : await localStore.get("thumbnails", key);
    if (cached?.signature === signature && cached.blob instanceof Blob && cached.blob.size > 0) {
      if (thumbnailTokens.get(page.pageId) === token && currentNote?.id === noteId && button.dataset.pageId === page.pageId) {
        showPageThumbnail(button, cached.blob, pageNumber);
      }
      return;
    }
    const sourceWidth = Number(page.size?.width || A4_SIZE.width);
    const sourceHeight = Number(page.size?.height || A4_SIZE.height);
    const width = 180;
    const height = Math.max(1, Math.round(width * sourceHeight / sourceWidth));
    const canvas = await renderNotePageToCanvas({
      page,
      content,
      materialMasks,
      resolveBackgroundBlob,
      resolveAssetBlob: (assetId, sourceNoteId) => resolveAssetBlob(assetId, sourceNoteId || noteId),
      width,
      height,
      maskMode: "all"
    });
    const blob = await noteCanvasToJpeg(canvas, .72);
    canvas.width = 1;
    canvas.height = 1;
    if (thumbnailTokens.get(page.pageId) !== token) return;
    const updatedAt = new Date().toISOString();
    await localStore.put("thumbnails", { key, uid, noteId, pageId: page.pageId, signature, blob, updatedAt });
    if (currentNote?.id === noteId && button.dataset.pageId === page.pageId) {
      showPageThumbnail(button, blob, pageNumber);
    }
  }

  function refreshCurrentPageThumbnail() {
    const page = pages[currentPageIndex];
    const button = page && [...ui.pageList.querySelectorAll("[data-page-id]")]
      .find(candidate => candidate.dataset.pageId === page.pageId);
    if (page && button) void hydratePageThumbnail(page, button, { force: true }).catch(error => {
      button.classList.remove("loading");
      button.classList.add("fallback");
      console.warn("編集中ページのサムネイルを更新できませんでした。", error);
    });
  }

  async function switchPage(index, { localOnly = false, direction = "" } = {}) {
    if (pageSwitching || index < 0 || index >= pages.length || index === currentPageIndex) return;
    const sourcePage = pages[currentPageIndex];
    pageSwitching = true;
    try {
    if (textEditorSession && !textEditorSession.finish()) return;
    await flushPendingStrokeWork({ render: false, throwOnError: localOnly });
    cancelActiveInteraction("page-change");
    cancelCropEditor({ restore: true });
    closeTransientUi();
    selectedIds = [];
    if (localOnly) {
      try {
        await waitForLocalSave(identity(sourcePage));
      } catch (error) {
        reportError(error);
        return;
      }
    } else if (!await flushWithDecision(sourcePage, "ページ切替")) return;
    contentCache.set(sourcePage.pageId, clone(currentContent));
    currentPageIndex = index;
    history.clear();
    await loadCurrentPage();
    if (direction) {
      ui.stage.classList.remove("page-slide-next", "page-slide-previous");
      void ui.stage.offsetWidth;
      ui.stage.classList.add(`page-slide-${direction}`);
      setTimeout(() => ui.stage.classList.remove(`page-slide-${direction}`), 230);
    }
    } finally {
      pageSwitching = false;
    }
  }

  function currentMaterial() {
    const page = pages[currentPageIndex];
    return page?.background?.type === "material-page"
      ? getMaterials().find(material => material.id === page.background.materialId)
      : null;
  }

  function materialSourcePage(page) {
    const material = getMaterials().find(item => item.id === page.background?.materialId);
    const pageNumber = Number(page.background?.materialPage || 1);
    return material?.pages?.find(item => Number(item.page) === pageNumber) || material?.pages?.[pageNumber - 1] || null;
  }

  async function resolveBackgroundBlob(page) {
    const session = captureUserSession();
    const blob = await loadSessionBoundBackgroundBlob({
      page,
      session,
      assertUserSession,
      getStorageBlob: (path, options) => noteStore.getStorageBlob(path, options),
      getMaterialSourcePage: materialSourcePage
    });
    assertUserSession(session);
    return blob;
  }

  async function resolveAssetBlob(assetId, sourceNoteId = currentNote.id) {
    const session = captureUserSession();
    assertUserSession(session);
    const key = `${sourceNoteId}|${assetId}`;
    if (assetCache.has(key)) return assetCache.get(key);
    try {
      const metadata = await noteStore.getAsset(sourceNoteId, assetId, { expectedUid: session.uid });
      assertUserSession(session);
      if (metadata?.storagePath) {
        const blob = await noteStore.getStorageBlob(metadata.storagePath, { expectedUid: session.uid });
        assertUserSession(session);
        assetCache.set(key, blob);
        return blob;
      }
    } catch (error) {
      if (error?.name === "NoteSessionChangedError") throw error;
    }
    const pending = (await localStore.listForUser("pendingAssets", session.uid))
      .filter(item => item.noteId === sourceNoteId && item.assetId === assetId && item.blob instanceof Blob && item.blob.size > 0)
      .sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")))[0];
    assertUserSession(session);
    if (!pending) throw new Error(`貼り付け画像 ${assetId} をクラウドまたは端末内下書きから取得できません。`);
    assetCache.set(key, pending.blob);
    return pending.blob;
  }

  async function recoverPendingAssets(noteId, session = captureUserSession()) {
    if (!session) return;
    assertUserSession(session);
    const key = recoveryKey(session, noteId);
    if (pendingAssetRecoveryPromises.has(key)) return pendingAssetRecoveryPromises.get(key);
    const recovery = (async () => {
      const pending = (await localStore.listForUser("pendingAssets", session.uid)).filter(item => item.noteId === noteId);
      assertUserSession(session);
      for (const item of pending) {
        assertUserSession(session);
        assetCache.set(`${noteId}|${item.assetId}`, item.blob);
        if (navigator.onLine === false) continue;
        try {
          assertUserSession(session);
          await noteStore.uploadAsset(noteId, item.blob, { assetId: item.assetId, expectedUid: session.uid });
          assertUserSession(session);
          await localStore.deleteIfUnchanged("pendingAssets", item.key, item.updatedAt || item.createdAt);
          assertUserSession(session);
        } catch (error) {
          if (error?.name === "NoteSessionChangedError") throw error;
          console.warn("未送信画像は端末内に保持しています。", error);
        }
      }
    })().finally(() => {
      if (pendingAssetRecoveryPromises.get(key) === recovery) pendingAssetRecoveryPromises.delete(key);
    });
    pendingAssetRecoveryPromises.set(key, recovery);
    return recovery;
  }

  function getRecoveryExpectedRevision(pending, draft) {
    const expectedRevision = Number(
      pending?.expectedRevision ?? draft?.expectedRevision ?? draft?.content?.revision
    );
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw new NoteConflictError("ローカル下書きの基準リビジョンを確認できないため、自動再送を停止しました。", null);
    }
    return expectedRevision;
  }

  async function persistRecoveredDraft({ noteId, page, draft, pending, key, expectedRevision, session }) {
    assertUserSession(session);
    const cloudRevision = Number(page.contentRevision || 0);
    const mutationId = pending?.mutationId || draft?.mutationId || stableLegacyMutationId(
      `${key}|${pending?.updatedAt || pending?.createdAt || draft?.updatedAt || draft?.createdAt || expectedRevision}`
    );
    if (cloudRevision === expectedRevision + 1 && page.lastClientMutationId === mutationId) {
      const restored = normalizeNoteLineElements(draft.content, page.size);
      restored.revision = cloudRevision;
      if (currentNote?.id === noteId) contentCache.set(page.pageId, restored);
      await localStore.deleteSavePairIfUnchanged(key, { draft, pending });
      return {
        revision: cloudRevision,
        contentPath: page.contentPath,
        contentHash: page.contentHash,
        idempotent: true
      };
    }
    if (cloudRevision !== expectedRevision) {
      throw new NoteConflictError("別の端末でこのページが更新されています。", cloudRevision);
    }
    const normalizedContent = normalizeNoteLineElements(draft.content, page.size);
    const mutationCreatedAt = pending?.updatedAt || pending?.createdAt || draft?.updatedAt || draft?.createdAt || "";
    const saved = await saveCoordinator.recover({
      uid: session.uid,
      noteId,
      pageId: page.pageId,
      expectedRevision,
      sessionGeneration: session.generation,
      clientInstanceId: pending?.clientInstanceId || draft?.clientInstanceId || clientInstanceId,
      editorTabId: pending?.editorTabId || draft?.editorTabId || "",
      writerSessionId: pending?.writerSessionId || draft?.writerSessionId || ""
    }, normalizedContent, { mutationId, updatedAt: mutationCreatedAt });
    assertUserSession(session);
    if (saved?.skipped) return saved;
    // Older local drafts did not carry a mutationId. The coordinator cannot
    // compare-delete those records by its generated mutation, so remove the
    // exact records we just recovered. A newer draft is preserved by the
    // compare-and-delete guard.
    await localStore.deleteSavePairIfUnchanged(key, { draft, pending });
    assertUserSession(session);
    if (saved.revision >= Number(page.contentRevision || 0)) {
      Object.assign(page, {
        contentRevision: saved.revision,
        contentPath: saved.contentPath,
        contentHash: saved.contentHash,
        lastClientMutationId: mutationId
      });
    }
    const restored = { ...normalizedContent, revision: saved.revision };
    if (currentNote?.id === noteId) contentCache.set(page.pageId, restored);
    return saved;
  }

  async function recordRecoveredDraftFailure({ error, uid, noteId, pageId, draft, key }) {
    if (error?.name !== "NoteConflictError") return;
    const conflict = {
      key, uid, noteId, pageId,
      expectedRevision: Number(draft.expectedRevision ?? draft.content?.revision),
      clientInstanceId: draft.clientInstanceId || "",
      editorTabId: draft.editorTabId || "",
      writerSessionId: draft.writerSessionId || "",
      clientMutationId: draft.mutationId || "",
      content: clone(draft.content), error: error.message,
      updatedAt: new Date().toISOString()
    };
    await localStore.put("conflicts", conflict);
    if (currentNote?.id === noteId) {
      currentNote.hasConflict = true;
      conflictPageIds.add(pageId);
      currentNote.conflicts = [
        ...(currentNote.conflicts || []).filter(item => item.key !== key),
        conflict
      ];
    }
  }

  async function recoverPendingSaves(noteId, notePages = pages, session = captureUserSession()) {
    if (!session) return;
    assertUserSession(session);
    if (navigator.onLine === false) return;
    const recoveryKeyForNote = recoveryKey(session, noteId);
    if (pendingRecoveryPromises.has(recoveryKeyForNote)) return pendingRecoveryPromises.get(recoveryKeyForNote);
    const recovery = (async () => {
      const [pendingSaves, pendingAssets, conflicts] = await Promise.all([
        localStore.listForUser("pendingSaves", session.uid),
        localStore.listForUser("pendingAssets", session.uid),
        localStore.listForUser("conflicts", session.uid)
      ]);
      assertUserSession(session);
      const blockedPages = new Set([
        ...pendingAssets.filter(item => item.noteId === noteId).map(item => item.pageId),
        ...conflicts.filter(item => item.noteId === noteId).map(item => item.pageId)
      ]);
      for (const pending of pendingSaves.filter(item => item.noteId === noteId)) {
        assertUserSession(session);
        if (blockedPages.has(pending.pageId)) continue;
        const page = notePages.find(item => item.pageId === pending.pageId);
        const key = noteLocalKey(session.uid, noteId, pending.pageId);
        const draft = await localStore.get("pageDrafts", key);
        assertUserSession(session);
        if (!page || draft?.uid !== session.uid || !draft.content) continue;
        try {
          const expectedRevision = getRecoveryExpectedRevision(pending, draft);
          assertUserSession(session);
          await persistRecoveredDraft({ noteId, page, draft, pending, key, expectedRevision, session });
          assertUserSession(session);
        } catch (error) {
          if (error?.name === "NoteSessionChangedError") throw error;
          assertUserSession(session);
          await recordRecoveredDraftFailure({
            error,
            uid: session.uid,
            noteId,
            pageId: pending.pageId,
            draft,
            key
          });
          assertUserSession(session);
          console.warn("未送信のページ下書きは端末内に保持しています。", error);
        }
      }
    })().finally(() => {
      if (pendingRecoveryPromises.get(recoveryKeyForNote) === recovery) pendingRecoveryPromises.delete(recoveryKeyForNote);
    });
    pendingRecoveryPromises.set(recoveryKeyForNote, recovery);
    return recovery;
  }

  async function recoverAllPendingWork(session = captureUserSession()) {
    if (!session || navigator.onLine === false) return;
    assertUserSession(session);
    const sweepKey = recoveryKey(session);
    if (pendingRecoverySweeps.has(sweepKey)) return pendingRecoverySweeps.get(sweepKey);
    const sweep = (async () => {
      try {
        const recovered = await noteStore.cleanupStuckCreatingNotes({ expectedUid: session.uid });
        assertUserSession(session);
        if (recovered.length) console.warn(`${recovered.length}件の未完了ノートを補償処理しました。`);
      } catch (error) {
        if (error?.name === "NoteSessionChangedError") throw error;
        console.warn("未完了ノートの補償処理を継続できませんでした。", error);
      }
      assertUserSession(session);
      await recoverPendingCleanups(session);
      assertUserSession(session);
      const [pendingSaves, pendingAssets] = await Promise.all([
        localStore.listForUser("pendingSaves", session.uid),
        localStore.listForUser("pendingAssets", session.uid)
      ]);
      assertUserSession(session);
      const noteIds = [...new Set(
        [...pendingSaves, ...pendingAssets].map(item => item.noteId).filter(Boolean)
      )];
      for (const noteId of noteIds) {
        assertUserSession(session);
        const notePages = await noteStore.listPages(noteId, { expectedUid: session.uid });
        assertUserSession(session);
        await recoverPendingAssets(noteId, session);
        assertUserSession(session);
        await recoverPendingSaves(noteId, notePages, session);
        assertUserSession(session);
      }
      if (getCurrentUser()?.uid === session.uid && userSessionGeneration === session.generation) {
        const [conflicts, remainingSaves, remainingAssets] = await Promise.all([
          localStore.listForUser("conflicts", session.uid),
          localStore.listForUser("pendingSaves", session.uid),
          localStore.listForUser("pendingAssets", session.uid)
        ]);
        assertUserSession(session);
        notes.forEach(note => {
          note.conflicts = conflicts.filter(conflict => conflict.noteId === note.id);
          note.hasConflict = note.conflicts.length > 0;
          note.pendingSaveCount = remainingSaves.filter(item => item.noteId === note.id).length;
          note.pendingAssetCount = remainingAssets.filter(item => item.noteId === note.id).length;
          note.unsyncedCount = new Set([
            ...remainingSaves.filter(item => item.noteId === note.id).map(item => item.pageId),
            ...remainingAssets.filter(item => item.noteId === note.id).map(item => item.pageId)
          ]).size;
        });
        const remainingKeys = new Set(remainingSaves.map(item => item.key));
        orphanedDrafts = orphanedDrafts
          .map(group => ({
            ...group,
            items: group.items.filter(item => remainingKeys.has(item.pending.key))
          }))
          .filter(group => group.items.length);
        renderNoteList();
      }
    })().finally(() => {
      if (pendingRecoverySweeps.get(sweepKey) === sweep) pendingRecoverySweeps.delete(sweepKey);
    });
    pendingRecoverySweeps.set(sweepKey, sweep);
    return sweep;
  }

  function createSvgElement(name, attributes = {}) {
    const node = document.createElementNS(svgNamespace, name);
    Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value)));
    return node;
  }

  function pathData(points) {
    return (points || []).map((point, index) => `${index ? "L" : "M"} ${point.x * 1000} ${point.y * 1414}`).join(" ");
  }

  function shapeNode(element, arrowMarkerId = "", pageSize = A4_SIZE) {
    const style = element.style || {};
    const attrs = {
      fill: Number(style.fillOpacity || 0) > 0 ? style.fillColor || "#111111" : "none",
      "fill-opacity": style.fillOpacity || 0,
      stroke: style.strokeColor || "#111111",
      "stroke-opacity": style.strokeOpacity ?? 1,
      "stroke-width": Math.max(1, Number(style.strokeWidthRatio || 0.002) * 1000),
      "stroke-dasharray": style.lineStyle === "dashed" ? "14 9" : style.lineStyle === "dotted" ? "2 8" : ""
    };
    if (["line", "arrow"].includes(element.shapeType)) {
      const [start, end] = lineEndpoints(element, pageSize);
      const group = createSvgElement("g", { class: "note-element", "data-element-id": element.id });
      group.append(createSvgElement("line", {
        x1: start.x * 1000, y1: start.y * 1414,
        x2: end.x * 1000, y2: end.y * 1414,
        stroke: "transparent", "stroke-width": 28,
        "pointer-events": "stroke", class: "note-element-hit"
      }));
      const shape = createSvgElement("line", {
        x1: start.x * 1000, y1: start.y * 1414,
        x2: end.x * 1000, y2: end.y * 1414,
        ...attrs, fill: "none"
      });
      if (element.shapeType === "arrow" && arrowMarkerId) shape.setAttribute("marker-end", `url(#${arrowMarkerId})`);
      group.append(shape);
      return group;
    }
    const group = createSvgElement("g", {
      transform: `translate(${element.bounds.x * 1000} ${element.bounds.y * 1414}) rotate(${element.rotation || 0} ${element.bounds.width * 500} ${element.bounds.height * 707})`,
      class: "note-element",
      "data-element-id": element.id
    });
    const w = element.bounds.width * 1000;
    const h = element.bounds.height * 1414;
    group.append(createSvgElement("rect", {
      x: 0, y: 0, width: w, height: h,
      fill: "transparent", stroke: "none",
      "pointer-events": "all", class: "note-element-hit"
    }));
    let shape;
    if (element.shapeType === "ellipse") shape = createSvgElement("ellipse", { cx: w / 2, cy: h / 2, rx: w / 2, ry: h / 2, ...attrs });
    else if (element.shapeType === "triangle") shape = createSvgElement("polygon", { points: `${w / 2},0 ${w},${h} 0,${h}`, ...attrs });
    else if (element.shapeType === "star") {
      const points = Array.from({ length: 10 }, (_, index) => {
        const radius = index % 2 ? Math.min(w, h) * 0.22 : Math.min(w, h) * 0.5;
        const angle = -Math.PI / 2 + index * Math.PI / 5;
        return `${w / 2 + Math.cos(angle) * radius},${h / 2 + Math.sin(angle) * radius}`;
      }).join(" ");
      shape = createSvgElement("polygon", { points, ...attrs });
    } else shape = createSvgElement("rect", { x: 0, y: 0, width: w, height: h, rx: element.shapeType === "rounded-rectangle" ? Math.min(w, h) * .12 : 0, ...attrs });
    group.append(shape);
    return group;
  }

  function textNode(element) {
    const style = element.style || {};
    const fontSize = Number(style.fontSizeRatio || .025) * 1414;
    const family = style.fontFamily === "system-serif" ? "serif" : style.fontFamily === "monospace" ? "monospace" : "sans-serif";
    const measurement = document.createElement("canvas").getContext("2d");
    measurement.font = `${style.fontStyle || "normal"} ${style.fontWeight || "normal"} ${fontSize}px ${family}`;
    const align = style.textAlign || "left";
    const anchorX = align === "center"
      ? (element.bounds.x + element.bounds.width / 2) * 1000
      : align === "right" ? (element.bounds.x + element.bounds.width) * 1000 : element.bounds.x * 1000;
    const lineHeight = fontSize * Number(style.lineHeight || 1.25);
    const layout = layoutTextBox(element.text, {
      maxWidth: element.bounds.width * 1000,
      lineHeight,
      measureText: value => measurement.measureText(value).width
    });
    const effectiveHeight = Math.max(element.bounds.height, layout.requiredHeight / 1414);
    const node = createSvgElement("text", {
      x: anchorX,
      y: element.bounds.y * 1414,
      fill: style.color || "#111111",
      opacity: style.opacity ?? 1,
      "font-size": fontSize,
      "font-family": family,
      "font-weight": style.fontWeight || "normal",
      "font-style": style.fontStyle || "normal",
      "text-anchor": align === "center" ? "middle" : align === "right" ? "end" : "start",
      class: "note-element",
      "data-element-id": element.id,
      transform: `rotate(${element.rotation || 0} ${(element.bounds.x + element.bounds.width / 2) * 1000} ${(element.bounds.y + effectiveHeight / 2) * 1414})`
    });
    layout.lines.forEach((line, index) => {
      const span = createSvgElement("tspan", { x: anchorX, dy: index ? lineHeight : fontSize });
      span.textContent = line || " "; node.append(span);
    });
    return node;
  }

  function normalizeTextElementHeight(element) {
    if (element?.type !== "text") return element;
    const style = element.style || {};
    const fontSize = Math.max(8, Number(style.fontSizeRatio || .025) * 1414);
    const family = style.fontFamily === "system-serif" ? "serif" : style.fontFamily === "monospace" ? "monospace" : "sans-serif";
    const measurement = document.createElement("canvas").getContext("2d");
    measurement.font = `${style.fontStyle || "normal"} ${style.fontWeight || "normal"} ${fontSize}px ${family}`;
    return ensureTextElementHeight(element, {
      pageHeight: 1414,
      measureText: value => measurement.measureText(value).width
    });
  }

  function appendTransformHandle(overlay, handle, label) {
    const node = document.createElement("button");
    node.type = "button";
    node.className = `note-transform-handle handle-${handle}`;
    node.dataset.transformHandle = handle;
    node.setAttribute("aria-label", label);
    overlay.append(node);
    return node;
  }

  function removeCropActions() {
    document.querySelectorAll(".note-crop-actions[data-crop-overlay]").forEach(node => node.remove());
  }

  function cropSafeArea(actions) {
    const style = getComputedStyle(actions);
    const inset = side => Math.max(0, Number.parseFloat(style.getPropertyValue(`--note-safe-area-${side}`)) || 0);
    return { top: inset("top"), right: inset("right"), bottom: inset("bottom"), left: inset("left") };
  }

  function positionCropActions() {
    const overlay = ui.stage.querySelector(".note-crop-overlay");
    const actions = document.querySelector(".note-crop-actions[data-crop-overlay]");
    if (!overlay || !actions || !cropSession) return false;
    const viewport = globalThis.visualViewport;
    const view = {
      left: Number(viewport?.offsetLeft || 0),
      top: Number(viewport?.offsetTop || 0),
      width: Number(viewport?.width || globalThis.innerWidth || 0),
      height: Number(viewport?.height || globalThis.innerHeight || 0)
    };
    const safeArea = cropSafeArea(actions);
    const margin = 12;
    const minLeft = view.left + Math.max(margin, safeArea.left);
    const minTop = view.top + Math.max(margin, safeArea.top);
    const boundaryRight = view.left + view.width - Math.max(margin, safeArea.right);
    const boundaryBottom = view.top + view.height - Math.max(margin, safeArea.bottom);
    const availableWidth = Math.max(0, boundaryRight - minLeft);
    const availableHeight = Math.max(0, boundaryBottom - minTop);
    actions.style.maxInlineSize = `${Math.floor(availableWidth)}px`;
    actions.style.maxBlockSize = `${Math.floor(availableHeight)}px`;
    const overlayRect = overlay.getBoundingClientRect();
    const actionsRect = actions.getBoundingClientRect();
    const maxLeft = Math.max(minLeft, boundaryRight - actionsRect.width);
    const maxTop = Math.max(minTop, boundaryBottom - actionsRect.height);
    const gap = 8;
    const below = overlayRect.bottom + gap;
    const above = overlayRect.top - actionsRect.height - gap;
    const preferredTop = below <= maxTop ? below : above;
    const left = Math.min(Math.max(overlayRect.left + overlayRect.width / 2 - actionsRect.width / 2, minLeft), maxLeft);
    const top = Math.min(Math.max(preferredTop, minTop), maxTop);
    actions.style.left = `${Math.round(left)}px`;
    actions.style.top = `${Math.round(top)}px`;
    return availableWidth > 0 && availableHeight > 0;
  }

  function handleCropAction(action) {
    if (!action || !cropSession) return;
    const image = currentContent.elements.find(element => element.id === cropSession.elementId);
    if (action === "reset" && image) {
      Object.assign(image, resetImageCrop(image));
      cropSession.draft = { crop: clone(image.crop), bounds: clone(image.bounds) };
      renderPage();
      return;
    }
    const before = cropSession.before;
    if (action === "cancel") currentContent = clone(before);
    cropSession = null;
    showSelectionContext();
    if (action === "apply") commitChange(before, "画像トリミング");
    else renderPage();
  }

  function renderCropOverlay() {
    removeCropActions();
    if (!cropSession) return;
    const reconciled = reconcileCropSession(cropSession, currentContent.elements);
    cropSession = reconciled.cropSession;
    if (reconciled.shouldCloseTransientUi) {
      closeTransientUi();
      return;
    }
    const image = currentContent.elements.find(element => element.id === cropSession.elementId && element.type === "image");
    const overlay = document.createElement("div");
    overlay.className = "note-crop-overlay";
    overlay.dataset.cropOverlay = "true";
    setBoundsStyle(overlay, image.bounds);
    overlay.style.transform = `rotate(${image.rotation || 0}deg)`;
    ["nw", "n", "ne", "e", "se", "s", "sw", "w"].forEach(handle =>
      appendTransformHandle(overlay, `crop-${handle}`, `トリミング ${handle}`)
    );
    const actions = document.createElement("div");
    actions.className = "note-crop-actions";
    actions.dataset.cropOverlay = "true";
    actions.setAttribute("role", "toolbar");
    actions.setAttribute("aria-label", "画像トリミング操作");
    [
      ["適用", "apply", "現在のトリミングを適用して編集を終了します"],
      ["キャンセル", "cancel", "編集前の画像へ戻してトリミングを終了します"],
      ["全体表示", "reset", "現在の拡大率を保って画像全体へ戻し、編集を続けます"]
    ].forEach(([label, action, description]) => {
      const button = document.createElement("button");
      button.type = "button"; button.textContent = label; button.dataset.cropAction = action;
      button.title = description; button.setAttribute("aria-label", description);
      actions.append(button);
    });
    actions.addEventListener("click", event => handleCropAction(event.target?.closest?.("[data-crop-action]")?.dataset.cropAction));
    ui.stage.append(overlay);
    document.body.append(actions);
    positionCropActions();
  }

  function renderSelectionOverlay() {
    if (studyMode || cropSession) {
      renderCropOverlay();
      return;
    }
    const items = currentTool === "mask" ? selectedMasks() : selectedElements().filter(element => !element.locked);
    if (!items.length) return;
    const page = pages[currentPageIndex];
    const bounds = selectionBounds(items, page?.size);
    if (!bounds) return;
    const overlay = document.createElement("div");
    overlay.className = "note-transform-overlay";
    overlay.dataset.selectionOverlay = "true";
    setBoundsStyle(overlay, bounds);
    const constrained = currentTool !== "mask" && items.some(element =>
      element.aspectLocked === true || Math.abs(Number(element.rotation || 0) % 90) > 0.001
    );
    if (constrained) {
      overlay.dataset.resizeConstraint = "per-element-uniform";
      overlay.title = "縦横比固定・回転済み要素は比率を保ってサイズ変更します";
    }
    const handles = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
    handles.forEach(handle => appendTransformHandle(overlay, `resize-${handle}`, `選択範囲を${handle}方向へサイズ変更`));
    if (!selectedMasks().length) appendTransformHandle(overlay, "rotate", "選択範囲を回転");
    if (items.length === 1 && items[0].type === "shape" && ["line", "arrow"].includes(items[0].shapeType)) {
      lineEndpoints(items[0], page?.size).forEach((point, index) => {
        const handle = appendTransformHandle(overlay, index ? "line-end" : "line-start", index ? "直線の終点" : "直線の始点");
        handle.style.left = `${(point.x - bounds.x) / bounds.width * 100}%`;
        handle.style.top = `${(point.y - bounds.y) / bounds.height * 100}%`;
      });
    }
    ui.stage.append(overlay);
  }

  function clearInteractiveLayers() {
    removeCropActions();
    const selectors = [".note-elements-layer", '[data-layer="masks"]', "[data-selection-overlay]", "[data-crop-overlay]", "[data-note-draft]"];
    ui.stage.querySelectorAll(selectors.join(",")).forEach(node => {
      node.querySelectorAll?.("img[data-note-object-url]").forEach(image => {
        URL.revokeObjectURL(image.dataset.noteObjectUrl);
        objectUrls = objectUrls.filter(url => url !== image.dataset.noteObjectUrl);
      });
      node.remove();
    });
  }

  function syncDrawingInputLayer() {
    const layer = ui.drawingInput;
    if (!layer) return;
    const enabled = Boolean(currentContent) && !studyMode && markupMode && !readOnlyEditor && ["pen", "highlighter"].includes(currentTool);
    layer.classList.toggle("active", enabled);
    ui.stage.classList.toggle("is-drawing-input", enabled);
    ui.editorView.classList.toggle("drawing-input-active", enabled);
  }

  function bindDrawingInputLayer() {
    const layer = ui.drawingInput;
    if (!layer) throw new Error("描画入力レイヤーを初期化できませんでした。");
    const forwardDrawingPointer = handler => event => {
      // Touch stays on the viewport/stage path so single-finger pan and
      // two-finger pinch keep working. Pencil and mouse use one stable layer.
      if (event.pointerType === "touch") return;
      event.stopPropagation();
      handler(event);
    };
    layer.addEventListener("pointerdown", forwardDrawingPointer(beginPointer));
    layer.addEventListener("pointermove", forwardDrawingPointer(movePointer));
    layer.addEventListener("pointerup", forwardDrawingPointer(endPointer));
    layer.addEventListener("pointercancel", forwardDrawingPointer(endPointer));
    layer.addEventListener("lostpointercapture", event => {
      if (event.pointerType === "touch") return;
      event.stopPropagation();
      drawingDiagnostics.lostpointercapture += 1;
      if (activeGesture?.pointerId === event.pointerId) finishPointerGesture("lostpointercapture", event);
    });
    syncDrawingInputLayer();
  }

  async function renderPage() {
    if (!currentContent || !pages[currentPageIndex]) return;
    const token = ++renderToken;
    const page = pages[currentPageIndex];
    const backgroundSignature = createNoteBackgroundSignature(page, currentNote?.id);
    const keepBackground = renderedBackgroundSignature === backgroundSignature &&
      Boolean(ui.stage.querySelector(".note-paper-layer"));
    if (keepBackground) clearInteractiveLayers();
    else {
      const backgroundToken = ++backgroundRenderToken;
      renderedBackgroundSignature = backgroundSignature;
      releaseObjectUrls();
      [...ui.stage.children].forEach(node => {
        if (node !== ui.drawingInput && node !== ui.eraserCursor) node.remove();
      });
      const paper = document.createElement("div");
      paper.className = `note-layer note-paper-layer ${page.background?.type === "ruled" ? "ruled" : ""}`;
      paper.style.setProperty("--paper-color", page.background?.paperColor || "#fff");
      paper.style.setProperty("--rule-spacing", `${Number(page.background?.ruleSpacingRatio || .035) * 100}%`);
      paper.style.setProperty("--rule-color", page.background?.ruleColor || "#d9dee7");
      paper.style.setProperty("--rule-opacity", String(page.background?.ruleOpacity ?? .7));
      paper.style.setProperty("--rule-width", `${Math.max(1, Number(page.background?.ruleWidthRatio || .001) * 1000)}px`);
      ui.stage.append(paper);

      if (["pdf-source-page", "material-page"].includes(page.background?.type)) {
        try {
          const blob = await resolveBackgroundBlob(page);
          if (backgroundToken !== backgroundRenderToken || backgroundSignature !== renderedBackgroundSignature) return;
          const url = URL.createObjectURL(blob); objectUrls.push(url);
          const image = document.createElement("img"); image.className = "note-background-image"; image.alt = "ノート背景"; image.src = url;
          ui.stage.append(image);
        } catch (error) {
          if (backgroundToken !== backgroundRenderToken || backgroundSignature !== renderedBackgroundSignature) return;
          const message = document.createElement("div"); message.className = "note-layer note-background-error"; message.textContent = `背景画像を表示できません: ${error.message}`;
          ui.stage.append(message);
        }
      }
    }
    if (token !== renderToken) return;
    ui.stage.style.aspectRatio = `${page.size?.width || A4_SIZE.width} / ${page.size?.height || A4_SIZE.height}`;
    ui.stage.classList.toggle("study-mode", studyMode);

    const elementLayer = document.createElement("div");
    elementLayer.className = "note-layer note-elements-layer";
    elementLayer.dataset.layer = "elements";
    elementLayer.style.zIndex = "10";
    const ordered = [...currentContent.elements].sort((a, b) => Number(a.zIndex || 0) - Number(b.zIndex || 0));
    for (const [stackIndex, element] of ordered.entries()) {
      const layerZIndex = String(stackIndex + 1);
      if (element.type === "image") {
        const wrap = document.createElement("div");
        wrap.className = `note-image-element note-element ${element.locked ? "locked" : ""} ${selectedIds.includes(element.id) ? "note-selected" : ""}`;
        wrap.dataset.elementId = element.id; setBoundsStyle(wrap, element.bounds);
        wrap.style.transform = `rotate(${element.rotation || 0}deg)`; wrap.style.opacity = String(element.opacity ?? 1); wrap.style.zIndex = layerZIndex;
        const image = document.createElement("img"); image.alt = "貼り付け画像";
        const crop = element.crop || { x: 0, y: 0, width: 1, height: 1 };
        image.style.position = "absolute"; image.style.width = `${100 / crop.width}%`; image.style.height = `${100 / crop.height}%`;
        image.style.left = `${-crop.x / crop.width * 100}%`; image.style.top = `${-crop.y / crop.height * 100}%`;
        resolveAssetBlob(element.assetId, element.assetNoteId || currentNote.id).then(blob => {
          if (token !== renderToken) return;
          const url = URL.createObjectURL(blob); objectUrls.push(url); image.src = url; image.dataset.noteObjectUrl = url;
        }).catch(error => { wrap.title = error.message; });
        wrap.append(image); elementLayer.append(wrap);
        continue;
      }

      const svg = createSvgElement("svg", { viewBox: "0 0 1000 1414", preserveAspectRatio: "none", class: "note-layer note-svg-layer note-element-layer" });
      svg.style.zIndex = layerZIndex;
      if (["highlighter", "stroke"].includes(element.type)) {
        if (element.type === "stroke" && element.pressureEnabled === true) {
          strokeSvgNodes(createSvgElement, element.points, Number(element.style?.widthRatio || .0025), {
            pressureEnabled: true,
            attributes: {
              fill: "none", stroke: element.style?.color || "#111111",
              "stroke-opacity": element.style?.opacity ?? 1,
              class: `note-element ${selectedIds.includes(element.id) ? "note-selected" : ""}`,
              "data-element-id": element.id
            }
          }).forEach(node => svg.append(node));
        } else {
          svg.append(createSvgElement("path", {
            d: pathData(element.points), fill: "none", stroke: element.style?.color || "#111111",
            "stroke-width": Math.max(1, Number(element.style?.widthRatio || .0025) * 1000),
            "stroke-opacity": element.style?.opacity ?? (element.type === "highlighter" ? .3 : 1),
            "stroke-linecap": "round", "stroke-linejoin": "round",
            class: `note-element ${selectedIds.includes(element.id) ? "note-selected" : ""}`,
            "data-element-id": element.id
          }));
        }
      } else if (element.type === "shape") {
        const markerId = `noteArrowHead-${String(element.id).replace(/[^a-zA-Z0-9_-]/g, "")}`;
        if (element.shapeType === "arrow") {
          const defs = createSvgElement("defs");
          const marker = createSvgElement("marker", { id: markerId, markerWidth: 10, markerHeight: 10, refX: 8, refY: 3, orient: "auto", markerUnits: "strokeWidth" });
          marker.append(createSvgElement("path", { d: "M0,0 L0,6 L9,3 z", fill: "context-stroke" })); defs.append(marker); svg.append(defs);
        }
        const node = shapeNode(element, markerId, page.size); if (selectedIds.includes(element.id)) node.classList.add("note-selected"); svg.append(node);
      } else if (element.type === "text") {
        const node = textNode(element); if (selectedIds.includes(element.id)) node.classList.add("note-selected"); svg.append(node);
      } else {
        continue;
      }
      elementLayer.append(svg);
    }
    ui.stage.append(elementLayer);

    const maskLayer = document.createElement("div"); maskLayer.className = "note-layer"; maskLayer.dataset.layer = "masks"; maskLayer.style.zIndex = "20";
    const materialMasks = getMaterialPageMasks(currentMaterial(), page.background?.materialPage);
    [
      ...materialMasks.map(mask => ({ mask, source: "material" })),
      ...(currentContent.noteMasks || []).map(mask => ({ mask, source: "note" }))
    ].forEach(({ mask, source }) => {
      const node = document.createElement("div");
      const visibilityKey = maskVisibilityKey(mask, source);
      const revealed = studyMode && revealedMaskIds.has(visibilityKey);
      const editingHidden = !studyMode && editingHiddenMaskIds.has(visibilityKey);
      node.className = `note-mask ${mask.weak ? "weak" : ""} ${revealed ? "revealed" : ""} ${editingHidden ? "editing-hidden" : ""} ${!mask.readOnly && currentTool === "mask" ? "editable" : ""} ${selectedIds.includes(mask.id) ? "note-selected" : ""}`;
      node.dataset.maskId = mask.id;
      node.dataset.maskVisibilityKey = visibilityKey;
      node.dataset.readOnly = String(mask.readOnly === true);
      setBoundsStyle(node, mask);
      node.title = mask.readOnly ? "既存教材マスク（教材管理で編集）" : "ノート専用マスク";
      maskLayer.append(node);
    });
    ui.stage.append(maskLayer);
    syncMaskVisibilityControl();
    syncDrawingInputLayer();
    renderSelectionOverlay();
    renderSelectionActionsVisibility();
    const maskRotationDisabled = selectedMasks().length > 0;
    ui.selectionActions.querySelectorAll('[data-selection-action="rotate-left"], [data-selection-action="rotate-right"], [data-selection-action="rotate"]').forEach(button => {
      button.disabled = maskRotationDisabled;
      button.title = maskRotationDisabled ? "マスクを含む選択範囲は回転できません" : "";
    });
    ui.undo.disabled = !history.canUndo(); ui.redo.disabled = !history.canRedo();
    ui.backgroundBtn.disabled = readOnlyEditor || !hasWriterOwnership() || conflictPageIds.has(page.pageId);
    ui.pageCounter.textContent = `${currentPageIndex + 1} / ${pages.length}`;
    ui.maskCounts.textContent = `教材 ${materialMasks.length} / ノート ${currentContent.noteMasks.length}`;
    syncSelectedTextControls();
    if (!zoomController) zoomController = createPageZoomController({
      viewport: ui.viewport,
      content: ui.stage,
      shouldTrackTouch: event => !inputGuard.isPenActive() && !inputGuard.isPalmCandidate(event)
    });
  }

  function commitChange(before, label) {
    if (!isEditableNow()) {
      currentContent = clone(before);
      renderPage();
      explainBlockedEdit();
      return;
    }
    const after = clone(currentContent);
    if (!history.push(historySnapshot(before), historySnapshot(after), label)) return;
    contentCache.set(pages[currentPageIndex].pageId, clone(after));
    void scheduleLocalSave(identity(), after).catch(reportError);
    renderPage();
    refreshCurrentPageThumbnail();
  }

  function historySnapshot(content = currentContent) {
    return {
      content: clone(content),
      defaultBackground: clone(currentNote?.defaultBackground || DEFAULT_BACKGROUND),
      pageMetadata: pages.map(page => ({
        pageId: page.pageId,
        pageType: page.pageType,
        background: clone(page.background)
      }))
    };
  }

  async function applyHistorySnapshot(snapshot) {
    if (!snapshot?.content || !isEditableNow()) { explainBlockedEdit(); return; }
    const session = captureUserSession();
    assertUserSession(session);
    const metadataUpdates = [];
    snapshot.pageMetadata?.forEach(saved => {
      const page = pages.find(item => item.pageId === saved.pageId);
      if (!page) return;
      const changed = page.pageType !== saved.pageType || JSON.stringify(page.background) !== JSON.stringify(saved.background);
      page.pageType = saved.pageType;
      page.background = clone(saved.background);
      if (changed) metadataUpdates.push(noteStore.updatePage(currentNote.id, page.pageId, {
        pageType: page.pageType,
        background: page.background
      }, session.uid));
    });
    const defaultChanged = JSON.stringify(currentNote.defaultBackground) !== JSON.stringify(snapshot.defaultBackground);
    currentNote.defaultBackground = clone(snapshot.defaultBackground);
    if (defaultChanged) metadataUpdates.push(noteStore.updateNote(currentNote.id, {
      defaultBackground: currentNote.defaultBackground
    }, session.uid));
    currentContent = clone(snapshot.content);
    contentCache.set(pages[currentPageIndex].pageId, clone(currentContent));
    await Promise.all([
      scheduleLocalSave(identity(), currentContent),
      ...metadataUpdates
    ]);
    renderPageList();
    renderPage();
  }

  function releaseActivePointer(pointerId = activeGesture?.pointerId, captureTarget = activeGesture?.captureTarget || ui.stage) {
    if (pointerId === undefined || pointerId === null) return;
    try {
      if (captureTarget?.hasPointerCapture?.(pointerId)) captureTarget.releasePointerCapture(pointerId);
    } catch (error) {
      console.debug("pointer captureを解放できませんでした。", error);
    }
  }

  function captureActivePointer(event) {
    if (!activeGesture) return;
    // The full-page drawing layer owns capture only for Pencil. Touch must keep
    // bubbling to the viewport so a second contact can start pinch zoom.
    if (event.pointerType !== "pen" && event.target === ui.drawingInput) return;
    const target = event.currentTarget?.setPointerCapture ? event.currentTarget : ui.stage;
    activeGesture.captureTarget = target;
    if (!event.isTrusted) return;
    try { target.setPointerCapture?.(event.pointerId); }
    catch (error) { console.debug("pointer captureを開始できませんでした。", error); }
  }

  function cancelCropEditor({ restore = true } = {}) {
    removeCropActions();
    if (!cropSession) return;
    if (restore && cropSession.before) currentContent = clone(cropSession.before);
    cropSession = null;
  }

  function cancelActiveInteraction(reason = "tool-change", { render = false } = {}) {
    if (activeGesture) finishPointerGesture(reason);
    else ui.stage.querySelectorAll("[data-note-draft]").forEach(node => node.remove());
    globalThis.getSelection?.()?.removeAllRanges?.();
    if (render && currentContent) renderPage();
  }

  function setTool(tool, { keepSettings = false } = {}) {
    if (tool === "eraser-object") tool = ui.eraserMode.value === "pixel" ? "eraser-pixel" : "eraser-object";
    const nextTool = TOOL_LABELS[tool] ? tool : "pen";
    const changed = nextTool !== currentTool;
    if (cropSession && changed) return;
    if (changed) {
      if (textEditorSession && !textEditorSession.finish()) return;
      previousTool = currentTool;
      cancelActiveInteraction("tool-change");
      if (pendingStrokeWork) {
        void flushPendingStrokeWork({ render: false });
        currentContent = clone(currentContent);
      }
      if (!keepSettings) closeTransientUi();
      if (!toolKeepsSelection(nextTool)) selectedIds = [];
    }
    currentTool = nextTool;
    if (currentTool !== "eraser-pixel") hidePixelEraserCursor();
    if (currentTool !== "mask") {
      maskMultiSelect = false;
      ui.maskSelectMode?.setAttribute("aria-pressed", "false");
    }
    [...ui.toolbar.querySelectorAll("[data-note-tool]")].forEach(button => button.classList.toggle("active", button.dataset.noteTool === tool || (button.dataset.noteTool === "eraser-object" && tool === "eraser-pixel")));
    ui.stage.dataset.tool = currentTool;
    ui.stage.setAttribute("aria-label", `編集ページ: ${TOOL_LABELS[currentTool]}`);
    selectedIds = currentTool === "mask" ? selectedIds.filter(id => currentContent.noteMasks.some(mask => mask.id === id)) : selectedIds.filter(id => currentContent.elements.some(element => element.id === id));
    applyToolSettingsToUi();
    renderPage();
    if (tool === "image") showImageMenu();
    else if (toolKeepsSelection(currentTool) && selectedIds.length) showSelectionContext();
  }

  function gesturePoint(event, pageRect = activeGesture?.pageRect) {
    return clientPointToNormalized(event.clientX, event.clientY, pageRect || ui.stage.getBoundingClientRect());
  }

  function historySnapshotReference(content) {
    return {
      content,
      defaultBackground: clone(currentNote?.defaultBackground || DEFAULT_BACKGROUND),
      pageMetadata: pages.map(page => ({
        pageId: page.pageId,
        pageType: page.pageType,
        background: clone(page.background)
      }))
    };
  }

  async function flushPendingStrokeWork({ render = true, throwOnError = false } = {}) {
    clearTimeout(pendingStrokeTimer);
    pendingStrokeTimer = 0;
    const work = pendingStrokeWork;
    pendingStrokeWork = null;
    if (!work) return;
    for (const entry of work.historyEntries || []) {
      history.pushImmutable(
        historySnapshotReference(clone(entry.before)),
        historySnapshotReference(clone(entry.after)),
        entry.label
      );
    }
    ui.undo.disabled = !history.canUndo();
    if (render && currentNote?.id === work.identity.noteId && pages[currentPageIndex]?.pageId === work.identity.pageId) {
      await renderPage();
    }
    try {
      await scheduleLocalSave(work.identity, work.content);
    } catch (error) {
      if (throwOnError) {
        if (!pendingStrokeWork) pendingStrokeWork = work;
        throw error;
      }
      reportError(error);
    }
    clearTimeout(pendingThumbnailTimer);
    pendingThumbnailTimer = setTimeout(() => {
      if (currentNote?.id === work.identity.noteId && pages[currentPageIndex]?.pageId === work.identity.pageId) {
        refreshCurrentPageThumbnail();
      }
    }, 650);
  }

  function queueStrokeWork(before, after, label) {
    const pageId = pages[currentPageIndex].pageId;
    contentCache.set(pageId, after);
    if (!pendingStrokeWork) pendingStrokeWork = { identity: identity(), content: after, historyEntries: [] };
    pendingStrokeWork.content = after;
    pendingStrokeWork.historyEntries.push({ before, after, label });
    clearTimeout(pendingStrokeTimer);
    pendingStrokeTimer = setTimeout(() => { void flushPendingStrokeWork(); }, 140);
    ui.undo.disabled = false;
  }

  function scheduleStrokePreview(gesture) {
    if (!gesture || gesture.previewFrame) return;
    gesture.previewFrame = requestAnimationFrame(() => {
      gesture.previewFrame = 0;
      flushStrokePoints(gesture);
      if (activeGesture === gesture || gesture.isFinalizing) drawDraftPath(gesture.points, gesture.type, gesture);
    });
  }

  function flushGestureSamples(gesture, event, { ensureRenderable = false } = {}) {
    if (!gesture || !["pen", "highlighter", "eraser-pixel"].includes(gesture.type)) return;
    if (event && event.pointerId === gesture.pointerId) {
      appendPointerSamples(gesture, event, sample => gesturePoint(sample, gesture.pageRect));
    }
    if (gesture.previewFrame) cancelAnimationFrame(gesture.previewFrame);
    gesture.previewFrame = 0;
    flushStrokePoints(gesture, { ensureRenderable });
    drawingDiagnostics.coalescedPoints += Number(gesture.coalescedPointCount || 0) - Number(gesture.reportedCoalescedPoints || 0);
    gesture.reportedCoalescedPoints = Number(gesture.coalescedPointCount || 0);
    drawingDiagnostics.longestMainThreadGapMs = Math.max(drawingDiagnostics.longestMainThreadGapMs, Number(gesture.maxEventGapMs || 0));
  }

  function removeGesturePreview(gesture) {
    if (gesture?.previewFrame) cancelAnimationFrame(gesture.previewFrame);
    gesture.previewFrame = 0;
    gesture?.previewNode?.remove?.();
    gesture.previewNode = null;
    gesture.previewPath = null;
  }

  function hidePixelEraserCursor() {
    if (eraserCursorFrame) cancelAnimationFrame(eraserCursorFrame);
    eraserCursorFrame = 0;
    ui.eraserCursor?.classList.add("hidden");
  }

  function updatePixelEraserCursor(event) {
    if (!ui.eraserCursor || currentTool !== "eraser-pixel" || event?.pointerType === "touch") {
      hidePixelEraserCursor();
      return;
    }
    const point = gesturePoint(event, activeGesture?.pageRect);
    const pageRect = activeGesture?.pageRect || ui.stage.getBoundingClientRect();
    const diameter = Math.max(8, Number(toolSettings.eraserSize) / 1000 * 5 * pageRect.width);
    if (eraserCursorFrame) cancelAnimationFrame(eraserCursorFrame);
    eraserCursorFrame = requestAnimationFrame(() => {
      eraserCursorFrame = 0;
      const zoom = Math.max(.001, zoomController?.zoom || 1);
      ui.eraserCursor.style.width = `${diameter / zoom}px`;
      ui.eraserCursor.style.height = `${diameter / zoom}px`;
      ui.eraserCursor.style.left = `${point.x * 100}%`;
      ui.eraserCursor.style.top = `${point.y * 100}%`;
      ui.eraserCursor.classList.remove("hidden");
    });
  }

  function targetElementId(event) {
    return event.target?.closest?.("[data-element-id]")?.dataset.elementId || "";
  }

  function hitTestElementId(point) {
    if (!point || !currentContent?.elements?.length) return "";
    const pageSize = pages[currentPageIndex]?.size;
    return [...currentContent.elements]
      .map((element, index) => ({ element, index }))
      .sort((a, b) => Number(b.element.zIndex || 0) - Number(a.element.zIndex || 0) || b.index - a.index)
      .find(({ element }) => {
        const tolerance = Math.max(.006, Number(element.style?.widthRatio || 0) * 1.5);
        if (["stroke", "highlighter"].includes(element.type)) {
          const points = element.points || [];
          return points.length === 1
            ? Math.hypot(points[0].x - point.x, points[0].y - point.y) <= tolerance
            : points.slice(1).some((end, index) => distanceToSegment(point, points[index], end) <= tolerance);
        }
        if (element.type === "shape" && ["line", "arrow"].includes(element.shapeType)) {
          const [start, end] = lineEndpoints(element, pageSize);
          return distanceToSegment(point, start, end) <= tolerance;
        }
        const bounds = elementBounds(element, pageSize);
        return point.x >= bounds.x - tolerance && point.x <= bounds.x + bounds.width + tolerance &&
          point.y >= bounds.y - tolerance && point.y <= bounds.y + bounds.height + tolerance;
      })?.element?.id || "";
  }

  function targetMaskId(event) {
    const node = event.target?.closest?.("[data-mask-id]");
    return node?.dataset.readOnly === "true" ? "" : node?.dataset.maskId || "";
  }

  function targetMaskVisibilityKey(event) {
    return event.target?.closest?.("[data-mask-visibility-key]")?.dataset.maskVisibilityKey || "";
  }

  function targetTransformHandle(event) {
    return event.target?.closest?.("[data-transform-handle]")?.dataset.transformHandle || "";
  }

  function currentPageMasks() {
    if (!currentContent || !pages[currentPageIndex]) return [];
    const page = pages[currentPageIndex];
    return [
      ...getMaterialPageMasks(currentMaterial(), page.background?.materialPage),
      ...(currentContent.noteMasks || [])
    ];
  }

  function syncMaskVisibilityControl() {
    if (!ui.maskVisibility) return;
    const hasEditingHiddenMask = currentPageMasks().some(mask => editingHiddenMaskIds.has(maskVisibilityKey(mask)));
    ui.maskVisibility.setAttribute("aria-pressed", String(!hasEditingHiddenMask));
    ui.maskVisibility.setAttribute("aria-label", hasEditingHiddenMask ? "編集時の暗記マスクを表示" : "編集時の暗記マスクを非表示");
    ui.maskVisibility.title = hasEditingHiddenMask ? "編集時の暗記マスクを表示" : "編集時の暗記マスクを非表示";
  }

  function replaceSelectedElements(transformed) {
    const replacements = new Map(transformed.map(element => [element.id, element]));
    currentContent.elements = currentContent.elements.map(element => replacements.get(element.id) || element);
  }

  function resizeSelectedMasks(originals, sourceBounds, targetBounds) {
    const scaleX = targetBounds.width / sourceBounds.width;
    const scaleY = targetBounds.height / sourceBounds.height;
    const replacements = new Map(originals.map(mask => [mask.id, {
      ...clone(mask),
      x: targetBounds.x + (mask.x - sourceBounds.x) * scaleX,
      y: targetBounds.y + (mask.y - sourceBounds.y) * scaleY,
      width: mask.width * scaleX,
      height: mask.height * scaleY
    }]));
    currentContent.noteMasks = currentContent.noteMasks.map(mask => replacements.get(mask.id) || mask);
  }

  function objectEraserHit(element, point, radius) {
    if (["stroke", "highlighter"].includes(element.type)) {
      const points = element.points || [];
      if (points.length === 1) return Math.hypot(points[0].x - point.x, points[0].y - point.y) <= radius;
      return points.slice(1).some((end, index) => distanceToSegment(point, points[index], end) <= radius);
    }
    if (element.type === "shape" && ["line", "arrow"].includes(element.shapeType)) {
      const [start, end] = lineEndpoints(element, pages[currentPageIndex]?.size);
      return distanceToSegment(point, start, end) <= radius;
    }
    if (!["shape", "text"].includes(element.type) || !element.bounds) return false;
    const bounds = element.bounds;
    return point.x >= bounds.x - radius && point.x <= bounds.x + bounds.width + radius &&
      point.y >= bounds.y - radius && point.y <= bounds.y + bounds.height + radius;
  }

  function eraseObjectsAt(point, gesture) {
    const radius = Number(toolSettings.eraserSize) / 1000 * 2.5;
    const beforeCount = currentContent.elements.length;
    currentContent.elements = currentContent.elements.filter(element => !objectEraserHit(element, point, radius));
    if (currentContent.elements.length !== beforeCount) {
      gesture.changed = true;
      renderPage();
    }
  }

  function clearStraightenTimer(gesture) {
    if (gesture?.straightenTimer) clearTimeout(gesture.straightenTimer);
    if (gesture) gesture.straightenTimer = null;
  }

  function armStraightenTimer(gesture, event) {
    if (!gesture || !["pen", "highlighter"].includes(gesture.type) || !toolSettings.straightenEnabled) return;
    const nextClient = { x: event.clientX, y: event.clientY };
    if (!gesture.holdClient || Math.hypot(nextClient.x - gesture.holdClient.x, nextClient.y - gesture.holdClient.y) > NOTE_STRAIGHTEN_MOVE_PX) {
      gesture.holdClient = nextClient;
      gesture.holdStartedAt = performance.now();
      clearStraightenTimer(gesture);
      gesture.straightenTimer = setTimeout(() => {
        if (activeGesture !== gesture || gesture.straightened) return;
        flushStrokePoints(gesture);
        const points = clone(gesture.points);
        if (!canStraightenStroke({
          points,
          elapsedMs: performance.now() - gesture.holdStartedAt,
          movementPx: 0,
          enabled: toolSettings.straightenEnabled
        })) return;
        gesture.freehandPoints = points;
        gesture.straightened = true;
        gesture.points = straightenedPoints(points);
        drawingDiagnostics.straightenTimerFires += 1;
        drawDraftPath(gesture.points, gesture.type, gesture);
      }, NOTE_STRAIGHTEN_HOLD_MS);
    }
  }

  function applyPendingStraightening(gesture) {
    if (!gesture || gesture.straightened || !["pen", "highlighter"].includes(gesture.type) || !toolSettings.straightenEnabled) return;
    const points = clone(gesture.points || []);
    if (!canStraightenStroke({
      points,
      elapsedMs: performance.now() - Number(gesture.holdStartedAt || performance.now()),
      movementPx: 0,
      enabled: true
    })) return;
    gesture.freehandPoints = points;
    gesture.straightened = true;
    gesture.points = straightenedPoints(points);
  }

  function finalizeInterruptedDrawingStroke(event) {
    const gesture = activeGesture;
    if (!gesture || !["pen", "highlighter"].includes(gesture.type)) return false;
    if (event.pointerType !== gesture.pointerType) return false;
    return finishPointerGesture("interrupted-drawing", event, { interrupted: true });
  }

  function beginPointer(event) {
    if (isTextEditingTarget(event.target)) return;
    const requestedHandle = targetTransformHandle(event);
    const cropControl = requestedHandle.startsWith("crop-") || event.target?.closest?.("[data-crop-action]");
    if (cropSession && !cropControl) {
      event.preventDefault();
      return;
    }
    if (!cropControl) closeTransientUi();
    globalThis.getSelection?.()?.removeAllRanges?.();
    if (toolSettings.toolbarAutoHide && ["pen", "highlighter"].includes(currentTool)) {
      ui.toolbar.classList.add("collapsed");
    }
    if (!currentContent || event.button > 0) return;
    if (["pen", "highlighter"].includes(currentTool)) {
      clearTimeout(pendingStrokeTimer);
      pendingStrokeTimer = 0;
    }
    if (event.target?.closest?.("[data-crop-action]")) return;
    if (!studyMode && !isEditableNow()) { explainBlockedEdit(); return; }
    const touchCount = event.pointerType === "touch" ? activeTouchPointerIds.size : 0;
    if (activeGesture) {
      // A second touch belongs to the viewport pinch controller. It must bubble
      // through the Pencil capture layer without settling the first touch here.
      if (event.pointerType === "touch" && touchCount >= 2) return;
      if (!finalizeInterruptedDrawingStroke(event)) {
        event.preventDefault();
        return;
      }
    }
    if (event.pointerType === "touch" && (zoomController?.isPinchGestureActive || zoomController?.isPinching || touchCount >= 2)) {
      event.preventDefault();
      return;
    }
    if (event.pointerType === "touch" && inputGuard.isPalmCandidate(event)) return;
    inputGuard.notePointerDown(event);
    if (event.pointerType === "pen") {
      hasSeenPen = true;
      if (["pen", "highlighter"].includes(currentTool)) ui.editorView.classList.add("pen-contact-active");
      if (!toolSettings.pencilMode || toolSettings.fingerDraw) {
        persistToolSettings({ pencilMode: true, fingerDraw: false });
      }
    }
    const pageRect = ui.stage.getBoundingClientRect();
    const point = gesturePoint(event, pageRect);
    lastTap = point;
    const elementId = targetElementId(event) || (["select", "text"].includes(currentTool) ? hitTestElementId(point) : "");
    const maskId = targetMaskId(event);
    const maskVisibilityId = targetMaskVisibilityKey(event);
    const transformHandle = requestedHandle;

    if (studyMode) {
      if (maskVisibilityId) {
        revealedMaskIds.has(maskVisibilityId) ? revealedMaskIds.delete(maskVisibilityId) : revealedMaskIds.add(maskVisibilityId);
        renderPage();
      }
      return;
    }
    if (transformHandle) {
      if (transformHandle.startsWith("crop-")) {
        const image = currentContent.elements.find(element => element.id === cropSession?.elementId);
        if (!image) return;
        activeGesture = {
          type: "crop-resize", pointerId: event.pointerId, pointerType: event.pointerType,
          handle: transformHandle.slice(5), imageId: image.id,
          original: clone(image), before: clone(currentContent)
        };
      } else if (transformHandle === "line-start" || transformHandle === "line-end") {
        const line = selectedElements()[0];
        if (!line) return;
        activeGesture = {
          type: "line-endpoint", pointerId: event.pointerId, pointerType: event.pointerType,
          endpoint: transformHandle === "line-start" ? 0 : 1,
          original: clone(line), before: clone(currentContent)
        };
      } else {
        if (transformHandle === "rotate" && selectedMasks().length) return;
        const items = currentTool === "mask" ? selectedMasks() : selectedElements().filter(element => !element.locked);
        const bounds = selectionBounds(items, pages[currentPageIndex]?.size);
        if (!bounds) return;
        activeGesture = {
          type: transformHandle === "rotate" ? "rotate-selection" : "resize-selection",
          pointerId: event.pointerId, pointerType: event.pointerType,
          handle: transformHandle.replace("resize-", ""),
          start: point,
          startAngle: angleFromCenter(point, { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }, pages[currentPageIndex]?.size),
          bounds,
          original: clone(items),
          target: currentTool === "mask" ? "masks" : "elements",
          before: clone(currentContent)
        };
      }
      captureActivePointer(event);
      event.preventDefault();
      return;
    }
    const guardedTouch = inputGuard.shouldIgnoreTouch(event, { pencilMode: toolSettings.pencilMode, touchCount });
    const reservedForPageSwipe = event.pointerType === "touch" && swipeGesture?.pointerId === event.pointerId &&
      (!toolSettings.fingerDraw || swipeGesture.startedAtEdge);
    const drawWithTouch = event.pointerType !== "touch" || (!reservedForPageSwipe && !guardedTouch && (toolSettings.fingerDraw || !hasSeenPen));
    if (["pen", "highlighter", "shape", "text", "mask", "eraser-object", "eraser-pixel"].includes(currentTool) && !drawWithTouch) {
      activeGesture = { type: "pan", pointerId: event.pointerId, pointerType: event.pointerType, clientX: event.clientX, clientY: event.clientY, scrollLeft: ui.viewport.scrollLeft, scrollTop: ui.viewport.scrollTop };
    } else if (currentTool === "pan") {
      activeGesture = { type: "pan", pointerId: event.pointerId, pointerType: event.pointerType, clientX: event.clientX, clientY: event.clientY, scrollLeft: ui.viewport.scrollLeft, scrollTop: ui.viewport.scrollTop };
    } else if (currentTool === "text" && elementId) {
      openTextEditor(point, elementId);
      return;
    } else if (currentTool === "eraser-object") {
      activeGesture = { type: "eraser-object", pointerId: event.pointerId, pointerType: event.pointerType, changed: false, before: clone(currentContent) };
      eraseObjectsAt(point, activeGesture);
    } else if (currentTool === "select" && elementId) {
      const target = currentContent.elements.find(element => element.id === elementId);
      if (target?.locked) return;
      if (!event.shiftKey && !selectedIds.includes(elementId)) selectedIds = [elementId];
      else if (event.shiftKey && !selectedIds.includes(elementId)) selectedIds.push(elementId);
      activeGesture = { type: "move-elements", pointerId: event.pointerId, pointerType: event.pointerType, start: point, original: clone(currentContent.elements), before: clone(currentContent) };
      showSelectionContext();
      renderPage();
    } else if (currentTool === "mask" && maskId) {
      const mask = currentContent.noteMasks.find(item => item.id === maskId);
      if (!mask) return;
      if (maskMultiSelect) {
        selectedIds = selectedIds.includes(maskId)
          ? selectedIds.filter(id => id !== maskId)
          : [...selectedIds, maskId];
        if (selectedIds.length) showSelectionContext(); else closeTransientUi();
        renderPage();
        event.preventDefault();
        return;
      }
      selectedIds = [maskId];
      activeGesture = { type: "move-mask", pointerId: event.pointerId, pointerType: event.pointerType, start: point, original: clone(mask), before: clone(currentContent) };
      showSelectionContext();
      renderPage();
    } else if (currentTool === "text") {
      activeGesture = { type: "text", pointerId: event.pointerId, pointerType: event.pointerType, start: point, end: point, before: clone(currentContent) };
      if (!openTextEditor(point, "", null, { deferFocus: true })) {
        activeGesture = null;
        return;
      }
    } else if (["pen", "highlighter"].includes(currentTool)) {
      drawingDiagnostics.pointerdown += 1;
      activeGesture = {
        ...createStrokeSession({
          id: randomId(),
          pointerId: event.pointerId,
          pointerType: event.pointerType,
          tool: currentTool,
          firstPoint: { ...point, pressure: Number(event.pressure || .5) },
          startedAt: Number(event.timeStamp || performance.now())
        }),
        type: currentTool,
        start: point,
        end: point,
        before: currentContent,
        pageRect
      };
      drawingDiagnostics.sessionsCreated += 1;
      drawDraftPath(activeGesture.points, activeGesture.type, activeGesture);
    } else {
      activeGesture = { type: currentTool === "select" ? "lasso" : currentTool, pointerId: event.pointerId, pointerType: event.pointerType, start: point, points: [{ ...point, pressure: Number(event.pressure || .5) }], end: point, additive: event.shiftKey, before: clone(currentContent) };
      activeGesture.pageRect = pageRect;
      if (currentTool === "eraser-pixel") activeGesture.radius = Number(toolSettings.eraserSize) / 1000 * 2.5;
      if (currentTool === "select") drawLasso([point]);
    }
    captureActivePointer(event);
    if (currentTool === "eraser-pixel") updatePixelEraserCursor(event);
    armStraightenTimer(activeGesture, event);
    event.preventDefault();
  }

  function movePointer(event) {
    if (!activeGesture || activeGesture.pointerId !== event.pointerId) return;
    if (activeGesture.type === "pan") {
      ui.viewport.scrollLeft = activeGesture.scrollLeft - (event.clientX - activeGesture.clientX);
      ui.viewport.scrollTop = activeGesture.scrollTop - (event.clientY - activeGesture.clientY);
      return;
    }
    const point = gesturePoint(event, activeGesture.pageRect);
    activeGesture.end = point;
    if (activeGesture.type === "resize-selection") {
      const targetBounds = resizeBoundsFromHandle(activeGesture.bounds, activeGesture.handle, point);
      if (activeGesture.target === "masks") resizeSelectedMasks(activeGesture.original, activeGesture.bounds, targetBounds);
      else replaceSelectedElements(resizeElements(activeGesture.original, activeGesture.bounds, targetBounds, pages[currentPageIndex]?.size));
      renderPage();
    } else if (activeGesture.type === "rotate-selection") {
      const center = {
        x: activeGesture.bounds.x + activeGesture.bounds.width / 2,
        y: activeGesture.bounds.y + activeGesture.bounds.height / 2
      };
      const angle = angleFromCenter(point, center, pages[currentPageIndex]?.size) - activeGesture.startAngle;
      replaceSelectedElements(rotateElements(activeGesture.original, center, angle, pages[currentPageIndex]?.size));
      renderPage();
    } else if (activeGesture.type === "line-endpoint") {
      const points = lineEndpoints(activeGesture.original, pages[currentPageIndex]?.size);
      points[activeGesture.endpoint] = point;
      const updated = normalizeLineElement({
        ...clone(activeGesture.original),
        start: points[0],
        end: points[1]
      }, pages[currentPageIndex]?.size);
      replaceSelectedElements([updated]);
      renderPage();
    } else if (activeGesture.type === "crop-resize") {
      const image = currentContent.elements.find(element => element.id === activeGesture.imageId);
      if (!image) return;
      const updated = cropImageFromHandle(
        activeGesture.original,
        activeGesture.handle,
        point,
        pages[currentPageIndex]?.size
      );
      Object.assign(image, updated);
      cropSession.draft = { crop: clone(image.crop), bounds: clone(image.bounds) };
      renderPage();
    } else if (["pen", "highlighter"].includes(activeGesture.type)) {
      if (activeGesture.straightened) {
        activeGesture.points = straightenedPoints(activeGesture.freehandPoints, point);
        drawDraftPath(activeGesture.points, activeGesture.type, activeGesture);
      } else {
        appendPointerSamples(activeGesture, event, sample => gesturePoint(sample, activeGesture.pageRect));
        const gap = Number(activeGesture.lastEventGapMs || 0);
        if (gap) {
          drawingDiagnostics.eventIntervals.push(gap);
          if (drawingDiagnostics.eventIntervals.length > 500) {
            drawingDiagnostics.eventIntervals.splice(0, drawingDiagnostics.eventIntervals.length - 500);
          }
        }
        armStraightenTimer(activeGesture, event);
        scheduleStrokePreview(activeGesture);
      }
    } else if (activeGesture.type === "eraser-pixel") {
      const coalesced = event.getCoalescedEvents?.();
      const events = coalesced?.length ? coalesced : [event];
      events.forEach(item => activeGesture.points.push({ ...gesturePoint(item, activeGesture.pageRect), pressure: Number(item.pressure || .5) }));
      updatePixelEraserCursor(event);
    } else if (activeGesture.type === "eraser-object") {
      eraseObjectsAt(point, activeGesture);
    } else if (activeGesture.type === "move-elements") {
      const dx = point.x - activeGesture.start.x;
      const dy = point.y - activeGesture.start.y;
      currentContent.elements = activeGesture.original.map(element => selectedIds.includes(element.id)
        ? translateElement(element, dx, dy, pages[currentPageIndex]?.size)
        : element);
      renderPage();
    } else if (activeGesture.type === "move-mask") {
      const dx = point.x - activeGesture.start.x;
      const dy = point.y - activeGesture.start.y;
      const mask = currentContent.noteMasks.find(item => item.id === activeGesture.original.id);
      mask.x = clamp(activeGesture.original.x + dx, 0, 1 - mask.width);
      mask.y = clamp(activeGesture.original.y + dy, 0, 1 - mask.height);
      renderPage();
    } else if (activeGesture.type === "lasso") {
      activeGesture.points.push(point);
      drawLasso(activeGesture.points);
    } else if (activeGesture.type === "text") {
      textEditorSession?.setBounds(normalizedBoundsFromPoints(activeGesture.start, point, .01));
    } else if (["shape", "mask"].includes(activeGesture.type)) {
      drawSelectionRect(activeGesture.start, point);
    }
    event.preventDefault();
  }

  function commitDrawGesture(gesture) {
    if (gesture?.committed || !["pen", "highlighter"].includes(gesture?.type) || !Array.isArray(gesture.points) || gesture.points.length <= 1) return false;
    gesture.committed = true;
    const isHighlighter = gesture.type === "highlighter";
    const element = {
      id: randomId(), type: isHighlighter ? "highlighter" : "stroke", points: copyStrokePointsForCommit(gesture.points),
      pressureEnabled: false,
      straightened: gesture.straightened === true,
      style: {
        color: isHighlighter ? toolSettings.highlighterColor : toolSettings.penColor,
        widthRatio: Number(isHighlighter ? toolSettings.highlighterWidth : toolSettings.penWidth) / 10000 * (isHighlighter ? 10 : 1),
        opacity: Number(isHighlighter ? toolSettings.highlighterOpacity : toolSettings.penOpacity) / 100
      },
      zIndex: elementZIndex(currentContent.elements), createdAt: new Date().toISOString()
    };
    currentContent = { ...currentContent, elements: [...currentContent.elements, element] };
    gesture.previewNode?.setAttribute("data-note-draft", "settled");
    queueStrokeWork(gesture.before, currentContent, isHighlighter ? "ハイライト追加" : "ペン追加");
    drawingDiagnostics.strokesCommitted += 1;
    return true;
  }

  function finishPointerGesture(reason = "pointercancel", event = null, { interrupted = false } = {}) {
    const gesture = activeGesture;
    if (!gesture || gesture.settling) return false;
    if (!interrupted && event?.pointerId !== undefined && gesture.pointerId !== event.pointerId) return false;
    gesture.settling = true;
    gesture.isFinalizing = true;
    if (gesture.pointerType === "pen") {
      inputGuard.notePointerEnd({ pointerType: "pen" });
    }
    ui.editorView.classList.remove("pen-contact-active");
    clearStraightenTimer(gesture);
    const drawingGesture = ["pen", "highlighter"].includes(gesture.type);
    if (drawingGesture && gesture.straightened) {
      if (event && event.pointerId === gesture.pointerId) {
        const terminal = gesturePoint(event, gesture.pageRect);
        gesture.points = straightenedPoints(gesture.freehandPoints || gesture.points, terminal);
      }
      if (gesture.previewFrame) cancelAnimationFrame(gesture.previewFrame);
      gesture.previewFrame = 0;
      drawDraftPath(gesture.points, gesture.type, gesture);
    } else if (drawingGesture) {
      flushGestureSamples(gesture, event, { ensureRenderable: true });
    }
    const shouldCommitDrawing = drawingGesture && (reason === "pointerup" || interrupted
      ? Array.isArray(gesture.points) && gesture.points.length > 1
      : cancelledStrokeCanBeCommitted({
        type: gesture.type,
        pointerType: gesture.pointerType || event?.pointerType,
        reason,
        points: gesture.points
      }));

    let committed = false;
    if (shouldCommitDrawing) {
      // A stroke has one settlement path: stop its timer, apply any eligible
      // straightening, commit once, and only then clear the active owner.
      applyPendingStraightening(gesture);
      committed = commitDrawGesture(gesture);
    } else if (gesture.type === "text") {
      textEditorSession?.finish({ cancel: true });
    } else {
      if (gesture.type === "pan") {
        ui.viewport.scrollLeft = gesture.scrollLeft;
        ui.viewport.scrollTop = gesture.scrollTop;
      }
      if (gesture.before) currentContent = clone(gesture.before);
    }

    if (activeGesture === gesture) activeGesture = null;
    releaseActivePointer(gesture.pointerId, gesture.captureTarget);
    if (!committed) {
      removeGesturePreview(gesture);
      if (drawingGesture) {
        drawingDiagnostics.strokesDiscarded += 1;
        drawingDiagnostics.discardedReasons[reason] = Number(drawingDiagnostics.discardedReasons[reason] || 0) + 1;
      }
    }
    if (!committed && gesture.type !== "text" && currentContent) renderPage();
    return true;
  }

  function endPointer(event) {
    inputGuard.notePointerEnd(event);
    const ownsActiveGesture = activeGesture?.pointerId === event.pointerId;
    if (event.pointerType === "pen" && ownsActiveGesture) ui.editorView.classList.remove("pen-contact-active");
    if (!ownsActiveGesture) return;
    if (["pen", "highlighter"].includes(activeGesture.type)) {
      if (event.type === "pointerup") drawingDiagnostics.pointerup += 1;
      if (event.type === "pointercancel") drawingDiagnostics.pointercancel += 1;
    }
    if (activeGesture.type === "eraser-pixel") hidePixelEraserCursor();
    if (event.type === "pointercancel") {
      finishPointerGesture("pointercancel", event);
      return;
    }
    if (["pen", "highlighter"].includes(activeGesture.type)) {
      finishPointerGesture("pointerup", event);
      return;
    }
    const gesture = activeGesture;
    clearStraightenTimer(gesture);
    activeGesture = null;
    releaseActivePointer(gesture.pointerId, gesture.captureTarget);
    removeGesturePreview(gesture);
    if (gesture.type === "pan") return;
    if (["resize-selection", "rotate-selection", "line-endpoint"].includes(gesture.type)) {
      showSelectionContext();
      commitChange(gesture.before, gesture.type === "line-endpoint" ? "直線端点移動" : gesture.type === "rotate-selection" ? "選択回転" : "選択サイズ変更");
      return;
    }
    if (gesture.type === "crop-resize") return;
    if (gesture.type === "eraser-object") {
      if (gesture.changed) commitChange(gesture.before, "オブジェクト消去");
      return;
    }
    if (gesture.type === "move-elements" || gesture.type === "move-mask") {
      commitChange(gesture.before, gesture.type === "move-mask" ? "マスク移動" : "オブジェクト移動");
      return;
    }
    const end = gesture.end || gesture.start;
    if (gesture.type === "eraser-pixel") {
      currentContent.elements = currentContent.elements.flatMap(element => {
        if (!["stroke", "highlighter"].includes(element.type)) return [element];
        return splitStrokeByEraser(element, gesture.points, gesture.radius);
      });
      commitChange(gesture.before, "ピクセル消去");
    } else if (gesture.type === "text") {
      const bounds = normalizedBoundsFromPoints(gesture.start, end, .01);
      const dragged = Math.abs(end.x - gesture.start.x) > .01 || Math.abs(end.y - gesture.start.y) > .01;
      if (dragged) textEditorSession?.setBounds(bounds);
      textEditorSession?.activate();
    } else if (gesture.type === "shape") {
      const bounds = normalizedBoundsFromPoints(gesture.start, end, .01);
      const shape = {
        id: randomId(), type: "shape", shapeType: toolSettings.shapeType, bounds, rotation: 0,
        style: {
          strokeColor: toolSettings.shapeStrokeColor,
          strokeWidthRatio: Number(toolSettings.shapeStrokeWidth) / 10000,
          strokeOpacity: Number(toolSettings.shapeStrokeOpacity) / 100,
          fillColor: toolSettings.shapeFillColor,
          fillOpacity: Number(toolSettings.shapeFillOpacity) / 100,
          lineStyle: toolSettings.shapeLineStyle
        },
        zIndex: elementZIndex(currentContent.elements)
      };
      currentContent.elements.push(["line", "arrow"].includes(shape.shapeType)
        ? normalizeLineElement({ ...shape, start: gesture.start, end }, pages[currentPageIndex]?.size)
        : shape);
      commitChange(gesture.before, "図形追加");
    } else if (gesture.type === "mask") {
      const bounds = normalizedBoundsFromPoints(gesture.start, end, .01);
      const mask = { id: randomId(), ...bounds, weak: false };
      currentContent.noteMasks.push(mask); selectedIds = [mask.id];
      showSelectionContext();
      commitChange(gesture.before, "暗記マスク追加");
    } else if (gesture.type === "lasso") {
      const hits = currentContent.elements
        .filter(element => lassoContainsElement(gesture.points, element, pages[currentPageIndex]?.size))
        .map(element => element.id);
      selectedIds = gesture.additive ? [...new Set([...selectedIds, ...hits])] : hits;
      showSelectionContext();
      renderPage();
    }
  }

  function drawDraftPath(points, type, gesture = activeGesture) {
    if (!gesture) return;
    const isHighlighter = type === "highlighter";
    if (!gesture.previewNode?.isConnected) {
      const svg = createSvgElement("svg", { viewBox: "0 0 1000 1414", preserveAspectRatio: "none", class: "note-layer", "data-note-draft": gesture.strokeSessionId || "active" });
      svg.style.zIndex = "30";
      gesture.previewPath = createSvgElement("path", {
        class: "note-draft-path", stroke: isHighlighter ? toolSettings.highlighterColor : toolSettings.penColor,
        "stroke-width": Math.max(1, Number(isHighlighter ? toolSettings.highlighterWidth : toolSettings.penWidth) / 10 * (isHighlighter ? 10 : 1)),
        "stroke-opacity": Number(isHighlighter ? toolSettings.highlighterOpacity : toolSettings.penOpacity) / 100
      });
      svg.append(gesture.previewPath);
      ui.stage.append(svg);
      gesture.previewNode = svg;
    }
    gesture.previewPath.setAttribute("d", pathData(points));
  }

  function drawSelectionRect(start, end) {
    ui.stage.querySelectorAll("[data-note-draft]").forEach(node => node.remove());
    const node = document.createElement("div"); node.dataset.noteDraft = "true"; node.className = "note-selection-rect";
    setBoundsStyle(node, normalizedBoundsFromPoints(start, end)); ui.stage.append(node);
  }

  function drawLasso(points) {
    ui.stage.querySelectorAll("[data-note-draft]").forEach(node => node.remove());
    const svg = createSvgElement("svg", { viewBox: "0 0 1000 1414", preserveAspectRatio: "none", class: "note-layer", "data-note-draft": "true" });
    svg.style.zIndex = "30";
    svg.append(createSvgElement("path", { d: `${pathData(points)} Z`, class: "note-lasso-path" }));
    ui.stage.append(svg);
  }

  function openTextEditor(point, existingId = "", requestedBounds = null, { deferFocus = false } = {}) {
    if (textEditorSession && !textEditorSession.finish()) return;
    const existing = currentContent.elements.find(element => element.id === existingId && element.type === "text");
    const before = clone(currentContent);
    const fallback = requestedBounds || { x: point.x, y: point.y, width: .35, height: .12 };
    const width = clamp(Number(existing?.bounds?.width || fallback.width), .08, 1);
    const height = clamp(Number(existing?.bounds?.height || fallback.height), .04, 1);
    let bounds = clone(existing?.bounds || {
      ...fallback,
      x: clamp(Number(fallback.x), 0, 1 - width),
      y: clamp(Number(fallback.y), 0, 1 - height),
      width,
      height
    });
    const style = existing?.style || {
      fontFamily: toolSettings.textFontFamily,
      fontSizeRatio: Number(toolSettings.textFontSize) / 1000,
      fontWeight: toolSettings.textBold ? "bold" : "normal",
      fontStyle: toolSettings.textItalic ? "italic" : "normal",
      textAlign: toolSettings.textAlign,
      lineHeight: Number(toolSettings.textLineHeight || 1.25),
      color: toolSettings.textColor,
      opacity: Number(toolSettings.textOpacity) / 100
    };
    const editor = document.createElement("textarea");
    editor.className = "note-text-editor";
    editor.classList.toggle("is-sizing", deferFocus);
    editor.dataset.noteTextEditor = "true";
    editor.setAttribute("aria-label", existing ? "テキストを編集" : "テキストを入力");
    setBoundsStyle(editor, bounds);
    editor.value = existing?.text || "";
    editor.style.fontFamily = style.fontFamily === "system-serif" ? "serif" : style.fontFamily === "monospace" ? "monospace" : "sans-serif";
    editor.style.fontWeight = style.fontWeight || "normal";
    editor.style.fontStyle = style.fontStyle || "normal";
    editor.style.setProperty("--note-text-editor-font-size", `${Math.max(16, Number(style.fontSizeRatio || .025) * (ui.stage.clientHeight || 640))}px`);
    editor.style.setProperty("--note-text-editor-line-height", String(style.lineHeight || 1.25));
    editor.style.setProperty("--note-text-editor-align", style.textAlign || "left");
    editor.style.setProperty("--note-text-editor-color", style.color || "#111111");
    editor.style.setProperty("--note-text-editor-opacity", String(style.opacity ?? 1));
    ui.stage.append(editor);

    let composing = false;
    let pendingFinish = false;
    let finished = false;
    let cancelled = false;
    const updateAutomaticHeight = () => {
      if (finished || !editor.isConnected) return;
      editor.style.height = "auto";
      const minimum = Math.max(60, editor.scrollHeight + 4);
      const stageHeight = Math.max(1, ui.stage.clientHeight || 1);
      const normalizedHeight = clamp(minimum / stageHeight, .04, Math.max(.04, 1 - bounds.y));
      bounds = { ...bounds, height: Math.max(bounds.height, normalizedHeight) };
      setBoundsStyle(editor, bounds);
    };
    const setEditorBounds = nextBounds => {
      if (finished || existing || !nextBounds) return;
      const nextWidth = clamp(Number(nextBounds.width), .01, 1);
      const nextHeight = clamp(Number(nextBounds.height), .01, 1);
      bounds = {
        x: clamp(Number(nextBounds.x), 0, 1 - nextWidth),
        y: clamp(Number(nextBounds.y), 0, 1 - nextHeight),
        width: nextWidth,
        height: nextHeight
      };
      setBoundsStyle(editor, bounds);
    };
    const keepVisible = () => {
      if (!editor.isConnected) return;
      const visual = globalThis.visualViewport;
      const visibleBottom = (visual?.offsetTop || 0) + (visual?.height || globalThis.innerHeight || 0);
      const rect = editor.getBoundingClientRect();
      if (rect.bottom > visibleBottom - 12) ui.viewport.scrollTop += rect.bottom - visibleBottom + 20;
      if (rect.top < (visual?.offsetTop || 0) + 70) ui.viewport.scrollTop -= (visual?.offsetTop || 0) + 82 - rect.top;
    };
    const finish = ({ cancel = false, force = false } = {}) => {
      if (finished) return true;
      if (composing && !force) { pendingFinish = true; cancelled ||= cancel; return false; }
      finished = true;
      cancelled ||= cancel;
      globalThis.visualViewport?.removeEventListener?.("resize", keepVisible);
      globalThis.visualViewport?.removeEventListener?.("scroll", keepVisible);
      const value = cancelled ? "" : editor.value.trimEnd();
      editor.remove();
      textEditorSession = null;
      if (!value) { renderPage(); return true; }
      if (existing) {
        existing.text = value;
        existing.autoHeight = true;
        existing.bounds = normalizeTextElementHeight({ ...existing, text: value, bounds }).bounds;
      } else currentContent.elements.push(normalizeTextElementHeight({
        id: randomId(), type: "text", bounds, rotation: 0, text: value, autoHeight: true,
        style: clone(style),
        zIndex: elementZIndex(currentContent.elements)
      }));
      commitChange(before, existing ? "テキスト編集" : "テキスト追加");
      return true;
    };
    const activate = () => {
      if (finished || !editor.isConnected) return false;
      editor.classList.remove("is-sizing");
      editor.focus({ preventScroll: true });
      editor.setSelectionRange(editor.value.length, editor.value.length);
      requestAnimationFrame(keepVisible);
      return true;
    };
    textEditorSession = {
      editor,
      finish,
      setBounds: setEditorBounds,
      activate,
      get isComposing() { return composing; }
    };
    editor.addEventListener("compositionstart", () => { composing = true; });
    editor.addEventListener("compositionend", () => {
      composing = false;
      updateAutomaticHeight();
      if (pendingFinish) queueMicrotask(() => finish({ cancel: cancelled }));
    });
    editor.addEventListener("input", updateAutomaticHeight);
    editor.addEventListener("paste", () => requestAnimationFrame(updateAutomaticHeight));
    editor.addEventListener("blur", () => { if (!composing) finish(); else pendingFinish = true; });
    editor.addEventListener("keydown", event => {
      if (event.key === "Escape" && !composing) { event.preventDefault(); finish({ cancel: true }); }
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !composing) { event.preventDefault(); finish(); }
    });
    globalThis.visualViewport?.addEventListener?.("resize", keepVisible);
    globalThis.visualViewport?.addEventListener?.("scroll", keepVisible);
    updateAutomaticHeight();
    if (!deferFocus) activate();
    return textEditorSession;
  }

  function showImageMenu() {
    setTransientUi("image-source-menu", { ownerTool: "image" });
    requestAnimationFrame(() => positionTransientPanel(ui.imageSourceMenu));
  }

  function showPasteFallback() {
    setTransientUi("paste-fallback", { ownerTool: "image" });
    ui.pasteFallback.textContent = "ここを長押しして「ペースト」を選択してください"; ui.pasteFallback.focus();
  }

  async function pasteFromClipboard() {
    if (!isEditableNow()) { explainBlockedEdit(); return; }
    const blob = await readClipboardImage();
    await addImageBlob(blob);
  }

  async function prepareImage(blob) {
    if (blob.type === "image/svg+xml") throw new Error("SVG画像は安全のため貼り付けできません。");
    const dimensions = await decodeImageDimensions(blob);
    const width = dimensions.naturalWidth;
    const height = dimensions.naturalHeight;
    const tooLarge = blob.size > MAX_NOTE_IMAGE_BYTES || dimensions.oversized;
    if (!tooLarge) {
      validateImageBlob(blob);
      const durableBlob = new Blob([await blob.arrayBuffer()], { type: blob.type });
      validateImageBlob(durableBlob);
      return { blob: durableBlob, width, height };
    }
    if (!confirm("この画像はサイズが大きいため、縮小して貼り付けますか？\nキャンセルすると画像は追加されません。")) throw new Error("画像の貼り付けをキャンセルしました。");
    const scale = Math.min(1, MAX_NOTE_IMAGE_WIDTH / width, MAX_NOTE_IMAGE_HEIGHT / height, Math.sqrt(40_000_000 / (width * height)));
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas"); canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close?.();
    const resized = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("画像縮小に失敗しました。")), "image/jpeg", .92));
    validateImageBlob(resized); return { blob: resized, width: canvas.width, height: canvas.height };
  }

  async function addImageBlob(inputBlob) {
    if (!isEditableNow()) { explainBlockedEdit(); return; }
    const session = captureUserSession();
    assertUserSession(session);
    const initialContext = {
      uid: session.uid,
      noteId: currentNote.id,
      page: pages[currentPageIndex],
      content: currentContent,
      tap: lastTap ? { ...lastTap } : null
    };
    const prepared = await prepareImage(inputBlob);
    assertUserSession(session);
    if (
      !isEditableNow(initialContext.page) ||
      getCurrentUser()?.uid !== initialContext.uid ||
      currentNote?.id !== initialContext.noteId ||
      pages[currentPageIndex]?.pageId !== initialContext.page?.pageId ||
      currentContent !== initialContext.content
    ) {
      throw new Error("画像の準備中にページが切り替わったため、画像は追加していません。もう一度操作してください。");
    }
    const target = {
      ...initialContext,
      pageId: initialContext.page.pageId,
      expectedRevision: Number(initialContext.page.contentRevision || 0)
    };
    const assetId = randomId();
    const pendingKey = noteLocalKey(target.uid, target.noteId, target.pageId, assetId);
    const pendingAssetCreatedAt = new Date().toISOString();
    try {
      await localStore.put("pendingAssets", { key: pendingKey, uid: target.uid, noteId: target.noteId, pageId: target.pageId, assetId, blob: prepared.blob, createdAt: pendingAssetCreatedAt, updatedAt: pendingAssetCreatedAt });
    } catch (error) {
      setSaveState("local-storage-error", { detail: "画像を端末内へ保存できなかったため、追加を中止しました。", error });
      throw error;
    }
    assertUserSession(session);
    assetCache.set(`${target.noteId}|${assetId}`, prepared.blob);
    const aspect = prepared.width / prepared.height;
    let width = Math.min(.7, .7 * Math.min(1, aspect));
    let height = width / aspect * ((target.page.size?.width || 1) / (target.page.size?.height || 1));
    if (height > .7) { height = .7; width = height * aspect * ((target.page.size?.height || 1) / (target.page.size?.width || 1)); }
    const center = target.tap || { x: .5, y: .5 };
    const offset = (pasteOffset++ % 5) * .02;
    const bounds = { x: clamp(center.x - width / 2 + offset, 0, 1 - width), y: clamp(center.y - height / 2 + offset, 0, 1 - height), width, height };
    const before = clone(target.content);
    const element = { id: randomId(), type: "image", assetId, bounds, crop: { x: 0, y: 0, width: 1, height: 1 }, rotation: 0, opacity: 1, locked: false, aspectLocked: true, zIndex: elementZIndex(target.content.elements) };
    target.content.elements.push(element); selectedIds = [element.id];
    history.push(historySnapshot(before), historySnapshot(target.content), "画像貼り付け");
    contentCache.set(target.pageId, clone(target.content));
    const draftKey = noteLocalKey(target.uid, target.noteId, target.pageId);
    const draftUpdatedAt = new Date().toISOString();
    const mutationId = randomId();
    const editorIdentity = editorLease?.getIdentity?.() || {};
    const saveIdentity = {
      uid: target.uid,
      noteId: target.noteId,
      pageId: target.pageId,
      expectedRevision: target.expectedRevision,
      sessionGeneration: session.generation,
      clientInstanceId,
      editorTabId,
      writerSessionId: editorIdentity.writerSessionId || ""
    };
    try {
      await localStore.putSavePair(
        { key: draftKey, ...saveIdentity, content: clone(target.content), mutationId, updatedAt: draftUpdatedAt },
        { key: draftKey, ...saveIdentity, mutationId, updatedAt: draftUpdatedAt }
      );
    } catch (error) {
      setSaveState("local-storage-error", {
        detail: "画像とページ内容を端末内へ保存できませんでした。編集内容は画面内にだけ残っています。",
        error
      });
      renderPage();
      throw error;
    }
    assertUserSession(session);
    if (currentNote?.id === target.noteId && pages[currentPageIndex]?.pageId === target.pageId) {
      setSaveState("dirty-local", { detail: "貼り付け画像とページ内容をこの端末内に保持しています。" });
      setTool("select"); renderPage(); refreshCurrentPageThumbnail();
    }
    try {
      assertUserSession(session);
      await noteStore.uploadAsset(target.noteId, prepared.blob, { assetId, expectedUid: session.uid });
      assertUserSession(session);
      await localStore.deleteIfUnchanged("pendingAssets", pendingKey, pendingAssetCreatedAt);
      assertUserSession(session);
      await scheduleLocalSave(saveIdentity, target.content);
      assertUserSession(session);
    } catch (error) {
      if (error?.name === "NoteSessionChangedError") throw error;
      if (currentNote?.id === target.noteId) {
        setSaveState("recoverable-error", { detail: "画像はこの端末内に保持されています。", error });
      }
      throw error;
    }
  }

  async function pageAction(action, index) {
    if (!currentNote) return;
    if (!prepareEditorAction("ページ操作")) return;
    const actionPage = pages[index] || pages[currentPageIndex];
    if (!canMutateCurrentNote(currentNote, { page: actionPage, allowConflict: false })) return;
    const session = captureUserSession();
    assertUserSession(session);
    if (action === "up" || action === "down") {
      const target = action === "up" ? index - 1 : index + 1;
      if (target < 0 || target >= pages.length) return;
      if (!await flushWithDecision(pages[currentPageIndex], "ページ並べ替え")) return;
      if (!canMutateCurrentNote(currentNote, { page: actionPage, allowConflict: false })) return;
      assertUserSession(session);
      const previousPages = [...pages];
      const currentPageId = pages[currentPageIndex]?.pageId;
      [pages[index], pages[target]] = [pages[target], pages[index]];
      try {
        currentNote.orderRevision = await noteStore.updatePageOrder(currentNote.id, pages, Number(currentNote.orderRevision || 0), session.uid);
      } catch (error) {
        pages = previousPages;
        currentPageIndex = Math.max(0, pages.findIndex(page => page.pageId === currentPageId));
        renderPageList();
        throw error;
      }
      currentPageIndex = Math.max(0, pages.findIndex(page => page.pageId === currentPageId));
      renderPageList();
      return;
    }
    if (action === "duplicate") {
      const sourcePage = pages[index];
      const sourceContent = index === currentPageIndex ? clone(currentContent) : await pageContent(sourcePage);
      assertUserSession(session);
      if (!canMutateCurrentNote(currentNote, { page: sourcePage, allowConflict: false })) return;
      const duplicate = { ...clone(sourcePage), pageId: randomId(), order: pages.length + 1, contentRevision: 0, contentPath: "", contentHash: "" };
      currentNote.orderRevision = await noteStore.createPage(currentNote.id, duplicate, pages.length + 1, currentNote.orderRevision, session.uid);
      pages.push(duplicate);
      const duplicatedContent = { ...clone(sourceContent), noteId: currentNote.id, pageId: duplicate.pageId, revision: 0, elements: sourceContent.elements.map(element => ({ ...element, id: randomId(), assetNoteId: element.type === "image" ? (element.assetNoteId || currentNote.id) : element.assetNoteId })), noteMasks: sourceContent.noteMasks.map(mask => ({ ...mask, id: randomId() })) };
      const saved = await noteStore.enqueuePageContentSave({ noteId: currentNote.id, pageId: duplicate.pageId, expectedRevision: 0, expectedUid: session.uid }, duplicatedContent);
      Object.assign(duplicate, { contentRevision: saved.revision, contentPath: saved.contentPath, contentHash: saved.contentHash });
      contentCache.set(duplicate.pageId, { ...duplicatedContent, revision: saved.revision });
      currentNote.pageCount = pages.length;
      renderPageList(); return;
    }
    if (action === "delete") {
      if (pages.length <= 1) throw new Error("ノートには1ページ以上必要です。");
      if (!confirm(`${index + 1}ページを削除しますか？ページ内容は論理削除されます。`)) return;
      const page = pages[index];
      if (!await flushWithDecision(page, "ページ削除")) return;
      assertUserSession(session);
      if (!canMutateCurrentNote(currentNote, { page, allowConflict: false })) return;
      const remainingPages = pages.filter((_, pageIndex) => pageIndex !== index);
      currentNote.orderRevision = await noteStore.deletePage(
        currentNote.id,
        page.pageId,
        remainingPages,
        currentNote.orderRevision,
        session.uid
      );
      pages = remainingPages; contentCache.delete(page.pageId);
      currentPageIndex = Math.min(currentPageIndex, pages.length - 1);
      currentNote.pageCount = pages.length;
      await loadCurrentPage();
    }
  }

  async function addPage(kind) {
    if (!prepareEditorAction("ページ追加")) return;
    if (!canMutateCurrentNote(currentNote, { page: pages[currentPageIndex], allowConflict: false })) return;
    const session = captureUserSession();
    assertUserSession(session);
    if (!await flushWithDecision(pages[currentPageIndex], "ページ追加")) return;
    assertUserSession(session);
    if (!canMutateCurrentNote(currentNote, { page: pages[currentPageIndex], allowConflict: false })) return;
    const page = kind === "default"
      ? pageFromBackground(currentNote.defaultBackground || DEFAULT_BACKGROUND, pages.length + 1)
      : blankPage(kind, pages.length + 1);
    currentNote.orderRevision = await noteStore.createPage(currentNote.id, page, pages.length + 1, currentNote.orderRevision, session.uid);
    pages.push(page); currentNote.pageCount = pages.length; currentPageIndex = pages.length - 1;
    currentContent = emptyContent(currentNote.id, page.pageId); contentCache.set(page.pageId, clone(currentContent));
    history.clear(); renderPageList(); renderPage();
  }

  function prepareEditorAction(label) {
    if (activeGesture) {
      showEditorNotice(`${label}は現在の操作を終えてから実行してください。`);
      return false;
    }
    if (textEditorSession && !textEditorSession.finish()) {
      showEditorNotice(`${label}は文字変換を確定してから実行してください。`);
      return false;
    }
    return true;
  }

  async function changeBackground() {
    if (!canMutateCurrentNote(currentNote, { page: pages[currentPageIndex], allowConflict: false })) return;
    if (!prepareEditorAction("背景変更")) return;
    if (!closeTransientUi()) return;
    const session = captureUserSession();
    assertUserSession(session);
    const page = pages[currentPageIndex];
    const scope = prompt("適用範囲を入力してください: current（現在）/ all（全ページ）/ future（今後の初期設定）", "current")?.trim().toLowerCase();
    if (!scope || !["current", "all", "future"].includes(scope)) return;
    if (scope === "current" && page.pageType !== "blank") {
      alert("PDF・教材の背景ページは固定です。白紙または罫線ページを追加して設定してください。");
      return;
    }
    const base = scope === "future" ? currentNote.defaultBackground : page.background;
    const choice = prompt("背景を選択してください: blank / ruled", base?.type || "blank")?.trim().toLowerCase();
    if (!choice || !["blank", "ruled"].includes(choice)) return;
    const before = historySnapshot();
    const background = {
      ...DEFAULT_BACKGROUND,
      ...base,
      type: choice,
      ruleType: choice === "ruled" ? "ruled" : "none"
    };
    const paperColor = prompt("用紙背景色（#RRGGBB）", background.paperColor || "#FFFFFF")?.trim();
    if (paperColor && /^#[0-9a-f]{6}$/i.test(paperColor)) background.paperColor = paperColor;
    if (choice === "ruled") {
      const spacingInput = prompt("罫線間隔: narrow / standard / wide / 0.01〜0.2", String(background.ruleSpacingRatio || .035))?.trim().toLowerCase();
      const spacingPresets = { narrow: .025, standard: .035, wide: .05 };
      const spacing = spacingPresets[spacingInput] ?? Number(spacingInput);
      if (!Number.isFinite(spacing) || spacing < .01 || spacing > .2) throw new Error("罫線間隔はnarrow、standard、wide、または0.01〜0.2で指定してください。");
      background.ruleSpacingRatio = spacing;
      const ruleColor = prompt("罫線色（#RRGGBB）", background.ruleColor || "#D9DEE7")?.trim();
      if (ruleColor && /^#[0-9a-f]{6}$/i.test(ruleColor)) background.ruleColor = ruleColor;
      const opacity = Number(prompt("罫線透明度（0〜100）", String(Math.round((background.ruleOpacity ?? .7) * 100))));
      const widthRatio = Number(prompt("罫線太さ（ページ幅比 0.0001〜0.01）", String(background.ruleWidthRatio || .001)));
      if (!Number.isFinite(opacity) || opacity < 0 || opacity > 100) throw new Error("罫線透明度は0〜100で指定してください。");
      if (!Number.isFinite(widthRatio) || widthRatio < .0001 || widthRatio > .01) throw new Error("罫線太さは0.0001〜0.01で指定してください。");
      background.ruleOpacity = opacity / 100;
      background.ruleWidthRatio = widthRatio;
    }
    const targets = scope === "current" ? [page] : scope === "all" ? pages.filter(item => item.pageType === "blank") : [];
    if (!canMutateCurrentNote(currentNote, { page, allowConflict: false })) return;
    targets.forEach(target => { target.background = clone(background); });
    if (scope !== "current") currentNote.defaultBackground = clone(background);
    await Promise.all([
      ...targets.map(target => noteStore.updatePage(currentNote.id, target.pageId, { background: target.background }, session.uid)),
      ...(scope !== "current" ? [noteStore.updateNote(currentNote.id, { defaultBackground: currentNote.defaultBackground }, session.uid)] : [])
    ]);
    history.push(before, historySnapshot(), "背景変更");
    renderPageList();
    renderPage();
  }

  function selectedElements() { return currentContent.elements.filter(element => selectedIds.includes(element.id)); }
  function selectedMasks() { return currentContent.noteMasks.filter(mask => selectedIds.includes(mask.id)); }
  let internalClipboard = [];

  function syncSelectedTextControls() {
    const text = selectedElements().find(element => element.type === "text");
    if (!text) return;
    const style = text.style || {};
    ui.fontFamily.value = style.fontFamily || "system-sans";
    ui.fontSize.value = String(Math.round(Number(style.fontSizeRatio || .025) * 1000));
    ui.fontBold.checked = style.fontWeight === "bold";
    ui.fontItalic.checked = style.fontStyle === "italic";
    ui.textAlign.value = style.textAlign || "left";
    ui.lineHeight.value = String(style.lineHeight || 1.25);
    ui.textColor.value = style.color || "#111111";
    ui.textOpacity.value = String(Math.round(Number(style.opacity ?? 1) * 100));
    if (ui.fontSizeValue) ui.fontSizeValue.value = String(Math.round(Number(ui.fontSize.value)));
    if (ui.textOpacityValue) ui.textOpacityValue.value = `${Math.round(Number(ui.textOpacity.value))}%`;
  }

  function applySelectedTextStyle() {
    const texts = selectedElements().filter(element => element.type === "text");
    if (!texts.length || currentTool !== "select") return;
    const before = clone(currentContent);
    texts.forEach(element => {
      element.style = {
        ...(element.style || {}),
        fontFamily: ui.fontFamily.value,
        fontSizeRatio: Number(ui.fontSize.value) / 1000,
        fontWeight: ui.fontBold.checked ? "bold" : "normal",
        fontStyle: ui.fontItalic.checked ? "italic" : "normal",
        textAlign: ui.textAlign.value,
        lineHeight: Number(ui.lineHeight.value || 1.25),
        color: ui.textColor.value,
        opacity: Number(ui.textOpacity.value) / 100
      };
      const normalized = normalizeTextElementHeight(element);
      element.bounds = normalized.bounds;
      element.autoHeight = normalized.autoHeight;
    });
    commitChange(before, "テキスト書式変更");
  }

  function selectionAction(action) {
    if (!isEditableNow()) { explainBlockedEdit(); return; }
    if (action === "select-page-masks") {
      selectedIds = currentContent.noteMasks.map(mask => mask.id);
      maskMultiSelect = true;
      ui.maskSelectMode?.setAttribute("aria-pressed", "true");
      showSelectionContext();
      renderPage();
      return;
    }
    if (action === "clear-selection") {
      selectedIds = [];
      closeTransientUi();
      renderPage();
      return;
    }
    const elements = selectedElements();
    const masks = selectedMasks();
    if (!elements.length && !masks.length) return;
    const before = clone(currentContent);
    if (action === "delete") {
      if (masks.length > 1 && !confirm(`選択した${masks.length}個のマスクを削除しますか？`)) return;
      currentContent.elements = currentContent.elements.filter(element => !selectedIds.includes(element.id) || element.locked);
      currentContent.noteMasks = currentContent.noteMasks.filter(mask => !selectedIds.includes(mask.id));
      selectedIds.forEach(id => {
        const visibilityKey = maskVisibilityKey({ id }, "note");
        revealedMaskIds.delete(visibilityKey);
        editingHiddenMaskIds.delete(visibilityKey);
      });
      selectedIds = [];
    } else if (action === "duplicate") {
      const copies = elements.map(element => ({
        ...translateElement(clone(element), .02, .02, pages[currentPageIndex]?.size),
        id: randomId()
      }));
      const maskCopies = masks.map(mask => ({ ...mask, id: randomId(), x: clamp(mask.x + .02, 0, 1 - mask.width), y: clamp(mask.y + .02, 0, 1 - mask.height) }));
      currentContent.elements.push(...copies); currentContent.noteMasks.push(...maskCopies); selectedIds = [...copies, ...maskCopies].map(item => item.id);
    } else if (action === "front" || action === "back") {
      if (masks.length) {
        currentContent.noteMasks = reorderNoteMasks(currentContent.noteMasks, masks.map(mask => mask.id), action);
      } else {
        const z = action === "front" ? elementZIndex(currentContent.elements) : Math.min(0, ...currentContent.elements.map(element => Number(element.zIndex || 0))) - 10;
        elements.forEach((element, index) => { element.zIndex = z + index; });
      }
    } else if (action === "rotate-left" || action === "rotate-right") {
      if (masks.length) return;
      const bounds = selectionBounds(elements, pages[currentPageIndex]?.size);
      const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
      replaceSelectedElements(rotateElements(elements, center, action === "rotate-left" ? -90 : 90, pages[currentPageIndex]?.size));
    } else if (action === "rotate") {
      if (masks.length) return;
      const angle = Number(prompt("回転角度を入力してください（度）", String(elements[0]?.rotation || 0)));
      if (!Number.isFinite(angle)) return;
      elements.filter(element => ["image", "shape", "text"].includes(element.type)).forEach(element => { element.rotation = angle; });
    } else if (action === "aspect") {
      elements.filter(element => element.type === "image").forEach(element => { element.aspectLocked = element.aspectLocked === false; });
    } else if (action === "opacity") {
      const opacity = Number(prompt("透明度を0〜100で入力してください", String(Math.round((elements[0]?.opacity ?? elements[0]?.style?.opacity ?? 1) * 100))));
      if (!Number.isFinite(opacity) || opacity < 0 || opacity > 100) throw new Error("透明度は0〜100で入力してください。");
      elements.forEach(element => {
        if (element.type === "image") element.opacity = opacity / 100;
        else element.style = { ...(element.style || {}), opacity: opacity / 100, strokeOpacity: opacity / 100 };
      });
    } else if (action === "lock") {
      elements.filter(element => element.type === "image").forEach(element => { element.locked = !element.locked; });
    } else if (action === "crop") {
      const image = elements.find(element => element.type === "image");
      if (!image) return;
      cropSession = { elementId: image.id, before, draft: clone(image.crop || { x: 0, y: 0, width: 1, height: 1 }) };
      setTransientUi("crop-editor", { ownerTool: "select", targetElementIds: [image.id] });
      renderPage();
      return;
    } else if (action === "resize") {
      const raw = prompt("選択オブジェクトの幅,高さをページ比率（%）で入力", "40,20");
      if (!raw) return;
      const [width, height] = raw.split(",").map(value => Number(value.trim()) / 100);
      if (!(width > 0 && height > 0 && width <= 1 && height <= 1)) throw new Error("サイズが正しくありません。");
      if (elements.length) {
        const source = selectionBounds(elements, pages[currentPageIndex]?.size);
        const target = {
          ...source,
          width: Math.min(width, 1 - source.x),
          height: Math.min(height, 1 - source.y)
        };
        replaceSelectedElements(resizeElements(elements, source, target, pages[currentPageIndex]?.size));
      }
      masks.forEach(mask => { mask.width = Math.min(width, 1 - mask.x); mask.height = Math.min(height, 1 - mask.y); });
    } else if (action === "weak") {
      masks.forEach(mask => { mask.weak = !mask.weak; });
    } else if (action === "weak-on" || action === "weak-off") {
      masks.forEach(mask => { mask.weak = action === "weak-on"; });
    }
    if (selectedIds.length) showSelectionContext();
    else closeTransientUi();
    commitChange(before, `選択: ${action}`);
  }

  function copySelection() {
    if (!isEditableNow()) { explainBlockedEdit(); return; }
    internalClipboard = [...selectedElements(), ...selectedMasks()].map(clone);
  }

  function pasteSelection() {
    if (!internalClipboard.length) return;
    if (!isEditableNow()) { explainBlockedEdit(); return; }
    const before = clone(currentContent); const ids = [];
    internalClipboard.forEach(item => {
      const copy = { ...clone(item), id: randomId() };
      if (copy.type) currentContent.elements.push(translateElement(copy, .025, .025, pages[currentPageIndex]?.size));
      else currentContent.noteMasks.push({ ...copy, x: clamp(copy.x + .025, 0, 1 - copy.width), y: clamp(copy.y + .025, 0, 1 - copy.height) });
      ids.push(copy.id);
    });
    selectedIds = ids; showSelectionContext(); commitChange(before, "アプリ内部貼り付け");
  }

  function undo() {
    if (!isEditableNow()) { explainBlockedEdit(); return; }
    if (pendingStrokeWork) { void flushPendingStrokeWork({ render: false }).then(undo); return; }
    const restored = history.undo(historySnapshot()); if (!restored) return;
    void applyHistorySnapshot(restored).catch(reportError);
  }

  function redo() {
    if (!isEditableNow()) { explainBlockedEdit(); return; }
    if (pendingStrokeWork) { void flushPendingStrokeWork({ render: false }).then(redo); return; }
    const restored = history.redo(historySnapshot()); if (!restored) return;
    void applyHistorySnapshot(restored).catch(reportError);
  }

  function setStudyMode(active) {
    if (!prepareEditorAction("暗記モードへの切り替え")) return;
    cancelActiveInteraction("tool-change");
    cancelCropEditor({ restore: true });
    closeTransientUi();
    studyMode = active === true;
    if (studyMode) { currentTool = "study"; selectedIds = []; }
    else setTool("pen");
    const modeLabel = studyMode ? "編集モードへ戻る" : "暗記モード";
    ui.studyToggle.setAttribute("aria-label", modeLabel);
    ui.studyToggle.title = modeLabel;
    ui.studyToggle.querySelector(".note-mode-icon-brain")?.classList.toggle("hidden", studyMode);
    ui.studyToggle.querySelector(".note-mode-icon-edit")?.classList.toggle("hidden", !studyMode);
    const accessibleLabel = ui.studyToggle.querySelector(".sr-only");
    if (accessibleLabel) accessibleLabel.textContent = modeLabel;
    ui.studyToggle.classList.toggle("active", studyMode);
    ui.studyControls.classList.toggle("hidden", !studyMode);
    ui.toolbar.classList.toggle("hidden", studyMode);
    renderPage();
  }

  async function renameNote(note = currentNote) {
    if (!canMutateCurrentNote(note)) return;
    const session = captureUserSession();
    assertUserSession(session);
    const title = prompt("ノート名", note.title || "無題ノート")?.trim();
    if (!title) return;
    if (!canMutateCurrentNote(note)) return;
    await noteStore.updateNote(note.id, { title }, session.uid); note.title = title;
    assertUserSession(session);
    if (currentNote?.id === note.id) ui.title.value = title;
    await refreshNotes();
  }

  async function deleteNote(note = currentNote) {
    if (!canMutateCurrentNote(note)) return;
    if (dedicatedEditor && currentNote?.id === note.id && conflictPageIds.size) {
      ui.conflictBanner.classList.remove("hidden");
      return;
    }
    const session = captureUserSession();
    assertUserSession(session);
    if (!confirm(`「${note.title || "無題ノート"}」を削除しますか？データは論理削除され、直ちには物理削除されません。`)) return;
    if (currentNote?.id === note.id && !await flushAllWithDecision("ノート削除")) return;
    assertUserSession(session);
    if (!canMutateCurrentNote(note)) return;
    await noteStore.deleteNote(note.id, session.uid);
    assertUserSession(session);
    if (currentNote?.id === note.id) { currentNote = null; pages = []; currentContent = null; show("list"); }
    await refreshNotes();
  }

  async function duplicateNote(noteId) {
    const guardedNote = currentNote?.id === noteId ? currentNote : null;
    if (guardedNote && !canMutateCurrentNote(guardedNote)) return null;
    const session = captureUserSession();
    assertUserSession(session);
    const sourceNote = await noteStore.getNote(noteId, { expectedUid: session.uid });
    assertUserSession(session);
    const sourcePages = await noteStore.listPages(noteId, { expectedUid: session.uid });
    assertUserSession(session);
    if (guardedNote && !canMutateCurrentNote(guardedNote)) return null;
    const newPages = sourcePages.map((page, index) => ({ ...clone(page), pageId: randomId(), order: index + 1, contentRevision: 0, contentPath: "", contentHash: "" }));
    const newId = await noteStore.createNote({
      title: `${sourceNote.title || "無題ノート"} のコピー`, type: sourceNote.type,
      sourceMaterialId: sourceNote.sourceMaterialId || null, defaultBackground: sourceNote.defaultBackground || DEFAULT_BACKGROUND,
      pages: newPages,
      deferReady: true,
      expectedUid: session.uid
    });
    const storagePaths = [];
    try {
      for (let index = 0; index < sourcePages.length; index += 1) {
        const sourceContent = currentNote?.id === noteId && pages[currentPageIndex]?.pageId === sourcePages[index].pageId ? clone(currentContent) : await noteStore.loadPageContent(noteId, sourcePages[index], { expectedUid: session.uid });
        assertUserSession(session);
        sourceContent.elements = sourceContent.elements.map(element => ({ ...element, id: randomId(), assetNoteId: element.type === "image" ? (element.assetNoteId || noteId) : element.assetNoteId }));
        sourceContent.noteMasks = sourceContent.noteMasks.map(mask => ({ ...mask, id: randomId() }));
        const saved = await noteStore.enqueuePageContentSave({ noteId: newId, pageId: newPages[index].pageId, expectedRevision: 0, expectedUid: session.uid }, sourceContent);
        storagePaths.push(saved.contentPath);
      }
      await noteStore.finalizeNoteCreation(newId, newPages.length, session.uid);
    } catch (error) {
      await compensateCreationFailure(newId, {
        pageIds: newPages.map(page => page.pageId),
        storagePaths,
        phase: "duplicate-content",
        expectedUid: session.uid
      }, error);
      throw error;
    }
    await refreshNotes();
    return newId;
  }

  async function createRecoveredDraftCopy(sourceNoteId, items, titleSuffix = "復元コピー") {
    const session = captureUserSession();
    assertUserSession(session);
    const sourceNote = await noteStore.getNote(sourceNoteId, { expectedUid: session.uid });
    assertUserSession(session);
    const sourcePages = await noteStore.listPages(sourceNoteId, { expectedUid: session.uid });
    assertUserSession(session);
    const recoverySourcePages = items.map((item, index) =>
      sourcePages.find(page => page.pageId === item.pageId) || blankPage("blank", index + 1));
    const copyPages = recoverySourcePages.map((sourcePage, index) => {
      return {
        pageId: randomId(),
        order: index + 1,
        pageType: sourcePage.pageType || "blank",
        size: clone(sourcePage.size || A4_SIZE),
        background: clone(sourcePage.background || sourceNote?.defaultBackground || DEFAULT_BACKGROUND)
      };
    });
    const copyId = await noteStore.createNote({
      title: `${sourceNote?.title || "未保存ノート"}（${titleSuffix}）`,
      type: "standalone",
      // Recovered notes must not retain a default background owned by the
      // deleted source note or material. Image-backed page backgrounds are
      // copied below into the recovered note's own Storage namespace.
      defaultBackground: DEFAULT_BACKGROUND,
      recoveredFromNoteId: sourceNoteId,
      recoveredAt: new Date().toISOString(),
      pages: copyPages,
      deferReady: true,
      expectedUid: session.uid
    });
    assertUserSession(session);
    const storagePaths = [];
    const copiedAssets = new Map();
    const usedPendingAssets = new Map();
    const localPendingAssets = (await localStore.listForUser("pendingAssets", session.uid))
      .filter(item => item.blob instanceof Blob && item.blob.size > 0)
      .sort((left, right) => String(right.updatedAt || right.createdAt || "").localeCompare(String(left.updatedAt || left.createdAt || "")));
    const pendingAssetByReference = new Map();
    localPendingAssets.forEach(item => {
      const key = `${item.noteId}|${item.assetId}`;
      if (!pendingAssetByReference.has(key)) pendingAssetByReference.set(key, item);
    });
    try {
      for (let index = 0; index < items.length; index += 1) {
        assertUserSession(session);
        const sourcePage = recoverySourcePages[index];
        if (["pdf-source-page", "material-page"].includes(sourcePage.background?.type)) {
          const backgroundBlob = await resolveBackgroundBlob(sourcePage);
          assertUserSession(session);
          const imagePath = await noteStore.uploadRecoveredBackground(
            copyId,
            copyPages[index].pageId,
            backgroundBlob,
            session.uid
          );
          assertUserSession(session);
          storagePaths.push(imagePath);
          copyPages[index].pageType = "pdf-source-page";
          copyPages[index].background = {
            type: "pdf-source-page",
            imagePath,
            sourcePageNumber: Number(sourcePage.background?.sourcePageNumber || sourcePage.background?.materialPage || index + 1)
          };
          await noteStore.updatePage(copyId, copyPages[index].pageId, {
            pageType: copyPages[index].pageType,
            background: copyPages[index].background
          }, session.uid);
          assertUserSession(session);
        }
        const normalizedContent = normalizeNoteLineElements(items[index].content, copyPages[index].size);
        const copyContent = rebaseRecoveredNoteContent(normalizedContent, {
          noteId: copyId,
          pageId: copyPages[index].pageId,
          sourceNoteId,
          createId: randomId
        });
        for (const element of copyContent.elements.filter(item => item.type === "image")) {
          if (!element.assetId) throw new Error("復元対象の貼り付け画像IDが見つかりません。");
          const sourceAssetNoteId = element.assetNoteId || sourceNoteId;
          const referenceKey = `${sourceAssetNoteId}|${element.assetId}`;
          let copied = copiedAssets.get(referenceKey);
          if (!copied) {
            const pendingAsset = pendingAssetByReference.get(referenceKey);
            const blob = pendingAsset?.blob || await resolveAssetBlob(element.assetId, sourceAssetNoteId);
            assertUserSession(session);
            const assetId = randomId();
            const uploaded = await noteStore.uploadAsset(copyId, blob, {
              assetId,
              expectedUid: session.uid
            });
            assertUserSession(session);
            storagePaths.push(uploaded.storagePath);
            copied = { assetId };
            copiedAssets.set(referenceKey, copied);
            if (pendingAsset) usedPendingAssets.set(pendingAsset.key, pendingAsset);
          }
          element.assetId = copied.assetId;
          delete element.assetNoteId;
        }
        const saved = await noteStore.enqueuePageContentSave({
          noteId: copyId,
          pageId: copyPages[index].pageId,
          expectedRevision: 0,
          expectedUid: session.uid
        }, copyContent);
        assertUserSession(session);
        storagePaths.push(saved.contentPath);
      }
      await noteStore.finalizeNoteCreation(copyId, copyPages.length, session.uid);
      assertUserSession(session);
    } catch (error) {
      await compensateCreationFailure(copyId, {
        pageIds: copyPages.map(page => page.pageId),
        storagePaths,
        phase: "recovered-draft-copy",
        expectedUid: session.uid
      }, error);
      throw error;
    }
    for (const item of items) {
      if (item.draft || item.pending) {
        await localStore.deleteSavePairIfUnchanged(item.key, {
          draft: item.draft,
          pending: item.pending
        });
        assertUserSession(session);
      }
      saveCoordinator.discard({
        uid: session.uid,
        noteId: sourceNoteId,
        pageId: item.pageId
      });
      contentCache.delete(item.pageId);
    }
    for (const pendingAsset of usedPendingAssets.values()) {
      await localStore.deleteIfUnchanged(
        "pendingAssets",
        pendingAsset.key,
        pendingAsset.updatedAt || pendingAsset.createdAt
      );
      assertUserSession(session);
    }
    return copyId;
  }

  async function restoreOrphanedDrafts(group, reservedWindow = null) {
    if (!group?.items?.length) return;
    const items = group.items.map(({ pending, draft }) => ({
      key: pending.key,
      pageId: pending.pageId,
      content: draft.content,
      draft,
      pending
    }));
    const copyId = await createRecoveredDraftCopy(group.noteId, items);
    const session = captureUserSession();
    if (session) {
      const conflicts = await localStore.listForUser("conflicts", session.uid);
      assertUserSession(session);
      for (const conflict of conflicts.filter(item => item.noteId === group.noteId)) {
        await localStore.deleteIfUnchanged("conflicts", conflict.key, conflict.updatedAt || conflict.createdAt);
        assertUserSession(session);
      }
    }
    await refreshNotes();
    if (!dedicatedEditor) openEditorTab(copyId, {}, reservedWindow);
    else await openNote(copyId, { inline: true });
  }

  async function resolveConflictRecord(noteId, conflict, useLocal) {
    const [draft, pending] = await Promise.all([
      localStore.get("pageDrafts", conflict.key),
      localStore.get("pendingSaves", conflict.key)
    ]);
    if (useLocal) {
      await createRecoveredDraftCopy(noteId, [{
        key: conflict.key,
        pageId: conflict.pageId,
        content: conflict.content,
        draft,
        pending
      }], "競合コピー");
    } else {
      await localStore.deleteSavePairIfUnchanged(conflict.key, { draft, pending });
    }
    saveCoordinator.discard({
      uid: conflict.uid,
      noteId: conflict.noteId,
      pageId: conflict.pageId
    });
    contentCache.delete(conflict.pageId);
    await localStore.deleteIfUnchanged("conflicts", conflict.key, conflict.updatedAt || conflict.createdAt);
  }

  async function resolveConflict(note) {
    const conflicts = [...(note.conflicts || [])];
    if (!conflicts.length) return;
    await resolveNoteConflicts(conflicts, {
      decide: (_conflict, { index, total }) => confirm(
        `競合ページ ${index + 1}/${total}のローカル版を競合コピーとして残しますか？\n` +
        "OK: このページの競合コピーを作成 / キャンセル: このページはクラウド版を採用"
      ),
      resolve: (conflict, useLocal) => resolveConflictRecord(note.id, conflict, useLocal)
    });
    await refreshNotes();
  }

  async function resolveCurrentPageConflict(useLocal) {
    const pageId = pages[currentPageIndex]?.pageId;
    const noteId = currentNote?.id;
    const uid = getCurrentUser()?.uid;
    if (!noteId || !pageId || !uid) return;
    const conflict = currentNote?.conflicts?.find(item => item.pageId === pageId) ||
      await loadConflictRecord(noteId, pageId, uid);
    if (!conflict) throw new Error("競合情報を読み込めませんでした。もう一度比較してください。");
    await resolveConflictRecord(noteId, conflict, useLocal);
    if (currentNote?.id !== noteId) return;
    currentNote.conflicts = (currentNote.conflicts || []).filter(item => item.key !== conflict.key);
    conflictPageIds.delete(pageId);
    pages = await noteStore.listPages(noteId, { expectedUid: uid });
    currentPageIndex = Math.max(0, pages.findIndex(page => page.pageId === pageId));
    currentContent = await pageContent(pages[currentPageIndex]);
    setEditorReadOnly(!editorLease?.isWriter());
    ui.conflictBanner.classList.add("hidden");
    renderPageList();
    renderPage();
  }

  function openExportDialog() {
    if (!currentNote) return;
    if (!prepareEditorAction("PDF書き出し")) return;
    if (!closeTransientUi()) return;
    generatedPdf = null;
    ui.exportPurpose.value = "ai"; ui.exportQuality.value = "standard"; ui.exportRangeMode.value = "all";
    ui.exportRange.classList.add("hidden");
    ui.exportPageNumbers.checked = currentNote.type === "standalone";
    ui.exportFilename.value = createPdfFilename(currentNote.title, "ai");
    ui.exportProgress.value = 0;
    updateExportPurposeHint();
    ui.downloadPdf.disabled = true;
    ui.cancelPdf.disabled = false;
    const shareSupported = Boolean(navigator.share && navigator.canShare);
    ui.sharePdf.disabled = true; ui.sharePdf.classList.toggle("hidden", !shareSupported);
    ui.exportDialog.showModal();
  }

  function updateExportPurposeHint() {
    if (!ui.exportStatus) return;
    if (ui.exportPurpose.value === "ai") {
      ui.exportStatus.textContent = "AI共有用では暗記マスクをPDFへ描画しません。";
    } else if (ui.exportPurpose.value === "study") {
      ui.exportStatus.textContent = "学習用ではすべての暗記マスクをPDFへ描画します。";
    } else {
      const hiddenMaskCount = (studyMode ? revealedMaskIds : editingHiddenMaskIds).size;
      ui.exportStatus.textContent = hiddenMaskCount
        ? `画面どおりでは、現在非表示の暗記マスク${hiddenMaskCount}件もその状態でPDFへ反映します。`
        : "画面どおりでは、現在の暗記マスク表示をPDFへ反映します。";
    }
  }

  async function openExportFromList(noteId) {
    await openNote(noteId, { inline: true }); openExportDialog();
  }

  function exportPageIndexes() {
    if (ui.exportRangeMode.value === "current") return [currentPageIndex];
    if (ui.exportRangeMode.value === "custom") return parsePdfPageRange(ui.exportRange.value, pages.length).map(page => page - 1);
    return pages.map((_, index) => index);
  }

  async function createPdfExport() {
    if (!currentNote) return;
    exportController = new AbortController();
    ui.createPdf.disabled = true; ui.downloadPdf.disabled = true; ui.sharePdf.disabled = true;
    ui.exportStatus.textContent = "PDFを作成しています 0 / 0ページ（0%）";
    try {
      const indexes = exportPageIndexes();
      generatedPdf = await exportNotePdf({
        note: currentNote,
        pages,
        pageIndexes: indexes,
        purpose: ui.exportPurpose.value,
        quality: ui.exportQuality.value,
        pageNumbers: ui.exportPageNumbers.checked,
        getPageContent: async page => {
          if (page.pageId === pages[currentPageIndex].pageId) return clone(currentContent);
          return pageContent(page);
        },
        getMaterialMasks: page => getMaterialPageMasks(
          page.background?.type === "material-page" ? getMaterials().find(material => material.id === page.background.materialId) : null,
          page.background?.materialPage
        ),
        resolveBackgroundBlob,
        resolveAssetBlob: (assetId, sourceNoteId) => resolveAssetBlob(assetId, sourceNoteId || currentNote.id),
        revealedMaskIds: pdfScreenHiddenMaskIds(ui.exportPurpose.value, {
          studyMode,
          revealedMaskIds,
          editingHiddenMaskIds
        }),
        signal: exportController.signal,
        onProgress: progress => {
          ui.exportProgress.value = progress.percent;
          ui.exportStatus.textContent = `PDFを作成しています ${progress.current} / ${progress.total}ページ（${progress.percent}%）`;
        },
        onStage: stage => {
          if (stage === "finalizing") {
            ui.cancelPdf.disabled = true;
            ui.exportStatus.textContent = "PDFファイルを仕上げています。この処理中はキャンセルできません。";
          }
        }
      });
      generatedPdf.filename = sanitizePdfFilename(ui.exportFilename.value.trim() || generatedPdf.filename);
      ui.exportFilename.value = generatedPdf.filename;
      ui.exportStatus.textContent = `作成したPDF: ${formatBytes(generatedPdf.byteSize)}` + (generatedPdf.byteSize > 25 * 1024 * 1024 ? "\nファイルサイズが大きいため、共有先によってはアップロードできない可能性があります。" : "");
      ui.downloadPdf.disabled = false;
      if (navigator.canShare) {
        const candidate = new File([generatedPdf.blob], generatedPdf.filename, { type: "application/pdf" });
        ui.sharePdf.disabled = !navigator.canShare({ files: [candidate] });
      }
    } catch (error) {
      if (error?.name === "AbortError") ui.exportStatus.textContent = "PDF作成をキャンセルしました。ノート内容は変更されていません。";
      else { ui.exportStatus.textContent = `PDF生成失敗: ${error.message || error}`; console.error(error); }
    } finally {
      exportController = null; ui.createPdf.disabled = false; ui.cancelPdf.disabled = false;
    }
  }

  async function confirmMaterialReplacement(material, nextPageCount) {
    const session = captureUserSession();
    assertUserSession(session);
    const linked = await noteStore.listNotesByMaterial(material.id, { includeDeleted: true, expectedUid: session.uid });
    assertUserSession(session);
    if (!linked.length) return { allowed: true, reset: false, materialIds: [material.id], linkedNoteCount: 0 };
    const currentCount = material.pages?.length || 0;
    if (currentCount === nextPageCount) {
      return {
        allowed: confirm("この教材には連携ノートがあります。\n差し替え後も同じページ番号にノート内容を重ねます。画像の配置や縦横比が変わると位置が合わない可能性があります。\n\n差し替えてノート内容を維持しますか？"),
        reset: false,
        materialIds: [material.id],
        linkedNoteCount: linked.length
      };
    }
    const allowed = confirm("この教材には連携ノートがあり、差し替え後のページ数が異なります。\n続行すると連携ノートを論理削除してリセットします。\n\n連携ノートをリセットして差し替えますか？");
    return { allowed, reset: allowed, materialIds: [material.id], linkedNoteCount: linked.length };
  }

  async function finalizeMaterialReplacement(decision) {
    if (!decision?.reset) return;
    await refreshNotes();
  }

  async function confirmMaterialDeletion(materials) {
    const session = captureUserSession();
    assertUserSession(session);
    const materialIds = materials.map(material => material.id);
    const linkedGroups = await Promise.all(materialIds.map(materialId =>
      noteStore.listNotesByMaterial(materialId, { includeDeleted: true, expectedUid: session.uid })
    ));
    assertUserSession(session);
    const linked = [...new Map(linkedGroups.flat().map(note => [note.id, note])).values()];
    if (!linked.length) return { allowed: true, materialIds, linkedNoteCount: 0 };
    const allowed = confirm(`選択した教材には${linked.length}件の連携ノートがあります。\n教材を削除すると背景画像を利用できなくなります。\n\n教材と連携ノートを削除しますか？`);
    return { allowed, materialIds, linkedNoteCount: linked.length };
  }

  async function archiveMaterialLinkedNotes(decision, operation) {
    if (!decision?.materialIds?.length) return { deletedCount: 0, batchCount: 0, noteIds: [] };
    const session = captureUserSession();
    assertUserSession(session);
    const flushResults = await saveCoordinator.flushAll();
    assertUserSession(session);
    const flushFailure = flushResults.find(result => result instanceof Error);
    if (flushFailure) {
      throw new Error(`未保存のノートがあるため教材処理を中止しました。再試行してください。${flushFailure.message || flushFailure}`);
    }
    const closeCurrentIfDeleted = noteIds => {
      if (!noteIds?.includes(currentNote?.id)) return;
      currentNote = null; pages = []; currentContent = null; selectedIds = []; history.clear();
      resetPageRender(); zoomController?.destroy(); zoomController = null;
      show("list");
    };
    try {
      const result = await noteStore.deleteMaterialLinkedNotes(decision.materialIds, operation, session.uid);
      decision.deletedNoteIds = result.noteIds;
      closeCurrentIfDeleted(result.noteIds);
      return result;
    } catch (error) {
      decision.deletedNoteIds = error.deletedNoteIds || [];
      closeCurrentIfDeleted(decision.deletedNoteIds);
      throw error;
    }
  }

  async function finalizeMaterialDeletion(decision) {
    if (!decision?.materialIds?.length) return;
    await refreshNotes();
  }

  function setMarkupMode(active) {
    if (active !== true && textEditorSession && !textEditorSession.finish()) return;
    markupMode = active === true;
    ui.editorView.classList.toggle("markup-inactive", !markupMode);
    ui.toolbar.classList.toggle("hidden", !markupMode);
    ui.markupDone.setAttribute("aria-label", markupMode ? "マークアップを完了" : "マークアップを開始");
    ui.markupDone.title = markupMode ? "マークアップを完了" : "マークアップを開始";
    ui.markupDone.textContent = markupMode ? "✓" : "✎";
    syncDrawingInputLayer();
    if (!markupMode) {
      cancelActiveInteraction("close");
      cancelCropEditor({ restore: true });
      closeTransientUi();
      selectedIds = [];
      renderPage();
    }
  }

  async function finishMarkup() {
    closeTransientUi();
    if (!markupMode) {
      setMarkupMode(true);
      return;
    }
    setMarkupMode(false);
    if (!currentNote || readOnlyEditor) return;
    const results = await saveCoordinator.flushAll();
    const failure = results.find(result => result instanceof Error);
    if (failure) setSaveState("recoverable-error", { error: failure });
  }

  async function restoreDedicatedLocalDraft() {
    const session = captureUserSession();
    assertUserSession(session);
    const [drafts, pending] = await Promise.all([
      localStore.listForUser("pageDrafts", session.uid),
      localStore.listForUser("pendingSaves", session.uid)
    ]);
    const pendingByKey = new Map(pending.filter(item => item.noteId === dedicatedEditorNoteId).map(item => [item.key, item]));
    const items = drafts
      .filter(item => item.noteId === dedicatedEditorNoteId && item.content)
      .map(draft => ({ key: draft.key, pageId: draft.pageId, content: draft.content, draft, pending: pendingByKey.get(draft.key) || null }));
    if (!items.length) throw new Error("このノートの端末内下書きが見つかりません。");
    setEditorStartupState("reconciling-local-draft", { detail: "端末内の下書きから独立した復元コピーを作成中" });
    const copyId = await createRecoveredDraftCopy(dedicatedEditorNoteId, items);
    const url = new URL(globalThis.location.href);
    url.searchParams.set("noteId", copyId);
    url.searchParams.set("editorTabId", editorTabId);
    globalThis.location.replace(url.toString());
  }

  async function retryDedicatedOpen(options = {}) {
    editorLease?.dispose();
    editorLease = null;
    saveCoordinator.reset();
    currentNote = null;
    pages = [];
    currentContent = null;
    contentCache.clear();
    assetCache.clear();
    selectedIds = [];
    resetPageRender();
    routeOpened = false;
    setEditorStartupState("loading-note-metadata");
    try {
      await openNote(dedicatedEditorNoteId, {
        study: routeParams.get("study") === "1",
        inline: true,
        ...options
      });
      routeOpened = true;
    } catch (error) {
      editorLease?.dispose();
      editorLease = null;
      setEditorStartupState("recoverable-error", {
        detail: `ノートを開けませんでした：${error.message || error}`,
        error
      });
    }
  }

  async function returnToNoteList() {
    if (textEditorSession && !textEditorSession.finish()) return;
    cancelActiveInteraction("close");
    cancelCropEditor({ restore: true });
    closeTransientUi();
    if (currentNote && !await flushAllWithDecision("ノート一覧へ戻る操作")) return;
    editorLease?.release();
    if (dedicatedEditor) {
      globalThis.location.assign(noteListUrl().toString());
      return;
    }
    await closeEditor();
  }

  async function closeEditor() {
    if (textEditorSession && !textEditorSession.finish()) return;
    cancelActiveInteraction("close");
    cancelCropEditor({ restore: true });
    closeTransientUi();
    if (currentNote && !await flushAllWithDecision("ノートを閉じる操作")) return;
    editorLease?.release();
    currentNote = null; pages = []; currentContent = null; selectedIds = []; history.clear();
    resetPageRender(); releaseThumbnailUrls(); thumbnailTokens.clear(); zoomController?.destroy(); zoomController = null;
    if (dedicatedEditor) {
      globalThis.location.assign(noteListUrl().toString());
      return;
    }
    show("list"); await refreshNotes();
  }

  function resetForUserChange() {
    textEditorSession?.finish({ cancel: true, force: true });
    cancelActiveInteraction("close");
    cancelCropEditor({ restore: false });
    closeTransientUi();
    userSessionGeneration += 1;
    createController?.abort(); exportController?.abort(); saveCoordinator.reset();
    pendingLocalSavePromises.clear();
    pendingAssetRecoveryPromises.clear(); pendingRecoveryPromises.clear(); pendingRecoverySweeps.clear();
    editorLease?.dispose(); editorLease = null;
    currentNote = null; pages = []; currentContent = null; notes = []; orphanedDrafts = []; contentCache.clear(); assetCache.clear();
    selectedIds = []; activeTouchPointerIds.clear(); swipeGesture = null; activeGesture = null;
    markupMode = true; localRecoverySuppressed = false; explicitReadOnlyMode = false;
    history.clear(); resetPageRender(); releaseThumbnailUrls(); thumbnailTokens.clear(); zoomController?.destroy(); zoomController = null;
    ui.list.replaceChildren(); show("list"); setListStatus("ログイン後にノートを読み込みます。");
    if (dedicatedEditor) {
      show("editor");
      setEditorStartupState("authenticating", { detail: "現在の処理：ログイン状態を確認中" });
    }
  }

  function positionTransientPanel(panel) {
    if (!panel || panel.classList.contains("hidden")) return;
    const viewport = globalThis.visualViewport;
    const view = {
      left: Number(viewport?.offsetLeft || 0),
      top: Number(viewport?.offsetTop || 0),
      width: Number(viewport?.width || globalThis.innerWidth || 0),
      height: Number(viewport?.height || globalThis.innerHeight || 0)
    };
    const compactLayout = matchMedia("(orientation: portrait), (max-width: 760px)").matches;
    panel.style.maxWidth = `${Math.max(280, Math.min(420, view.width - 32))}px`;
    panel.style.maxHeight = `${transientPanelMaxHeight(view.height, { compactLayout })}px`;
    if (compactLayout) {
      ["left", "right", "top", "bottom", "transform"].forEach(property => panel.style[property] = "");
      return;
    }
    const toolbar = ui.toolbar.getBoundingClientRect();
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    const margin = 16;
    const clampPosition = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));
    let left = toolbar.right + 12;
    let top = toolbar.top + toolbar.height / 2 - height / 2;
    if (toolSettings.toolbarDock === "right") left = toolbar.left - width - 12;
    if (toolSettings.toolbarDock === "top") {
      left = toolbar.left + toolbar.width / 2 - width / 2;
      top = toolbar.bottom + 12;
    }
    if (toolSettings.toolbarDock === "bottom") {
      left = toolbar.left + toolbar.width / 2 - width / 2;
      top = toolbar.top - height - 12;
    }
    panel.style.left = `${clampPosition(left, view.left + margin, view.left + view.width - width - margin)}px`;
    panel.style.top = `${clampPosition(top, view.top + 70, view.top + view.height - height - margin)}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    panel.style.transform = "none";
  }

  function showToolSettings(tool = currentTool) {
    if (tool === "eraser-object") tool = toolSettings.eraserMode === "pixel" ? "eraser-pixel" : "eraser-object";
    const selectedText = currentTool === "select" && selectedElements().some(element => element.type === "text");
    const panelTool = tool === "input" ? "input" : selectedText ? "text" : tool;
    const type = panelTool === "input" ? "input-settings" : settingsTransientType(panelTool);
    if (!type) return;
    if (TOOL_LABELS[tool] && tool !== "select") currentTool = tool;
    const titles = {
      pen: "ペン設定", highlighter: "蛍光ペン設定",
      "eraser-object": "消しゴム設定", "eraser-pixel": "消しゴム設定",
      shape: "図形設定", text: "テキスト設定", input: "入力設定"
    };
    ui.settingsTitle.textContent = titles[panelTool] || "ツール設定";
    ui.settingSections.forEach(section => {
      const tools = String(section.dataset.settingTools || "").split(/\s+/);
      section.classList.toggle("hidden", !tools.includes(panelTool));
    });
    applyToolSettingsToUi();
    if (selectedText) syncSelectedTextControls();
    setTransientUi(type, { ownerTool: panelTool });
    positionTransientPanel(ui.settings);
  }

  function closeToolSettings() {
    if (transientUiIsSettings(transientUi)) closeTransientUi();
  }

  function handleToolButton(tool) {
    const normalized = tool === "eraser-object" && toolSettings.eraserMode === "pixel" ? "eraser-pixel" : tool;
    if (currentTool === normalized && ["pen", "highlighter", "eraser-object", "eraser-pixel", "shape", "text"].includes(currentTool)) {
      if (!transientUiIsSettings(transientUi)) showToolSettings(currentTool);
      else closeToolSettings();
      return;
    }
    if (currentTool === normalized && currentTool === "image") {
      if (transientUi.type === "image-source-menu") closeTransientUi();
      else showImageMenu();
      return;
    }
    setTool(tool);
  }

  function quickSwitchTool() {
    const action = toolSettings.quickSwitchAction;
    if (action === "select-all") {
      selectedIds = currentContent?.elements?.map(element => element.id) || [];
      setTool("select");
      showSelectionContext();
      return;
    }
    if (action === "colors") { showToolSettings(); return; }
    if (action === "select") { setTool(currentTool === "select" ? previousTool : "select"); return; }
    if (action === "previous") { const target = previousTool; previousTool = currentTool; setTool(target); return; }
    const eraser = toolSettings.eraserMode === "pixel" ? "eraser-pixel" : "eraser-object";
    setTool(currentTool.startsWith("eraser") ? previousTool || "pen" : eraser);
  }

  function bindToolbarDrag() {
    let drag = null;
    ui.toolbarDrag.addEventListener("pointerdown", event => {
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY };
      ui.toolbar.classList.add("dragging");
      ui.toolbarDrag.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    });
    ui.toolbarDrag.addEventListener("pointermove", event => {
      if (!drag || drag.id !== event.pointerId) return;
      drag.lastX = event.clientX; drag.lastY = event.clientY;
      ui.toolbar.style.translate = `${event.clientX - drag.x}px ${event.clientY - drag.y}px`;
    });
    const finish = event => {
      if (!drag || drag.id !== event.pointerId) return;
      const distances = {
        top: drag.lastY,
        right: innerWidth - drag.lastX,
        bottom: innerHeight - drag.lastY,
        left: drag.lastX
      };
      const dock = Object.entries(distances).sort((a, b) => a[1] - b[1])[0][0];
      ui.toolbar.style.translate = "";
      ui.toolbar.classList.remove("dragging");
      drag = null;
      persistToolSettings({ toolbarDock: dock });
    };
    ui.toolbarDrag.addEventListener("pointerup", finish);
    ui.toolbarDrag.addEventListener("pointercancel", finish);
  }

  function bindEvents() {
    bindDrawingInputLayer();
    ui.noteModeBtn.addEventListener("click", () => { activateSection("note"); show(currentNote ? "editor" : "list"); void refreshNotes(); });
    ui.newNoteBtn.addEventListener("click", () => { show("create"); ui.materialPicker.classList.add("hidden"); });
    ui.cancelCreate.addEventListener("click", () => {
      if (dedicatedEditorCreateMode) globalThis.location.replace(noteListUrl().toString());
      else show("list");
    });
    ui.createView.querySelectorAll("[data-create-note]").forEach(button => button.addEventListener("click", () => {
      const type = button.dataset.createNote;
      if (type === "material") renderMaterialPicker();
      else if (type === "pdf") {
        if (dedicatedEditorCreateMode === "pdf") ui.pdfInput.click();
        else openPdfCreationSurface();
      }
      else {
        let reservedWindow;
        try { reservedWindow = reserveEditorTab(); }
        catch (error) { reportError(error); return; }
        createStandalone(type, reservedWindow).catch(error => { reservedWindow.close?.(); reportError(error); });
      }
    }));
    ui.pdfInput.addEventListener("change", () => {
      const file = ui.pdfInput.files?.[0];
      if (!file) return;
      if (dedicatedEditorCreateMode === "pdf") {
        createPdfNote(file).catch(reportError);
        return;
      }
      createPdfNote(file).catch(reportError);
    });
    ui.cancelCreateProgress.addEventListener("click", () => createController?.abort());
    ui.closeNote.addEventListener("click", () => returnToNoteList().catch(reportError));
    ui.lockReadOnly.addEventListener("click", () => {
      explicitReadOnlyMode = true;
      setEditorReadOnly(true, "読み取り専用で開いています。");
    });
    ui.lockTakeover.addEventListener("click", async () => {
      ui.lockTakeover.disabled = true;
      explicitReadOnlyMode = false;
      try {
        const result = await editorLease?.takeover();
        if (result?.acquired) setEditorReadOnly(false);
        else setEditorReadOnly(true, "編集権を取得できませんでした。もう一度お試しください。");
      } finally {
        ui.lockTakeover.disabled = false;
      }
    });
    ui.lockReturn.addEventListener("click", () => {
      returnToNoteList().catch(reportError);
    });
    ui.conflictBanner.querySelectorAll("[data-conflict-action]").forEach(button => button.addEventListener("click", () => {
      const action = button.dataset.conflictAction;
      if (action === "cloud") resolveCurrentPageConflict(false).catch(reportError);
      else if (action === "copy") resolveCurrentPageConflict(true).catch(reportError);
      else if (action === "compare") recoverPendingSaves(currentNote.id, pages).then(loadCurrentPage).catch(reportError);
      else if (action === "list") dedicatedEditor ? globalThis.close?.() : closeEditor().catch(reportError);
    }));
    ui.pagesButton.addEventListener("click", () => persistToolSettings({ sidebarVisible: !toolSettings.sidebarVisible }));
    ui.saveStatus.addEventListener("click", () => toggleSavePopover());
    ui.continueEditing.addEventListener("click", closeSavePopover);
    ui.restoreLocalDraft.addEventListener("click", () => {
      closeSavePopover();
      void restoreDedicatedLocalDraft().catch(error => setEditorStartupState("recoverable-error", {
        detail: `端末内の下書きを復元できませんでした：${error.message || error}`,
        error
      }));
    });
    ui.saveDiagnostics.addEventListener("click", () => downloadDiagnostics().catch(reportError));
    ui.saveList.addEventListener("click", () => returnToNoteList().catch(reportError));
    ui.markupDone.addEventListener("click", () => finishMarkup().catch(reportError));
    ui.title.addEventListener("change", async () => {
      const title = ui.title.value.trim(); if (!title || !currentNote || title === currentNote.title) return;
      if (!canMutateCurrentNote(currentNote)) { ui.title.value = currentNote.title || "無題ノート"; return; }
      const session = captureUserSession(); assertUserSession(session);
      if (!canMutateCurrentNote(currentNote)) { ui.title.value = currentNote.title || "無題ノート"; return; }
      await noteStore.updateNote(currentNote.id, { title }, session.uid); assertUserSession(session); currentNote.title = title;
    });
    ui.undo.addEventListener("click", undo); ui.redo.addEventListener("click", redo);
    ui.retrySave.addEventListener("click", () => {
      ui.retrySave.disabled = true;
      localRecoverySuppressed = false;
      const uid = getCurrentUser()?.uid;
      const noteId = currentNote?.id;
      recoverAllPendingWork()
        .then(() => saveCoordinator.flushAll())
        .then(async results => {
          const failure = results.find(result => result instanceof Error);
          if (failure) throw failure;
          if (uid && noteId) {
            const [pendingSaves, pendingAssets] = await Promise.all([
              localStore.listForUser("pendingSaves", uid),
              localStore.listForUser("pendingAssets", uid)
            ]);
            const remainingSaves = pendingSaves.filter(item => item.noteId === noteId).length;
            const remainingAssets = pendingAssets.filter(item => item.noteId === noteId).length;
            if (remainingSaves || remainingAssets) {
              setSaveState("recoverable-error", { detail: [
                remainingSaves ? `下書き再送待ち ${remainingSaves}件` : "",
                remainingAssets ? `画像再送待ち ${remainingAssets}件` : ""
              ].filter(Boolean).join(" / ") });
              throw new Error("未同期データを端末内に保持しています。通信状態を確認して再試行してください。");
            }
          }
          setSaveState("saved");
          closeSavePopover();
          return refreshNotes();
        })
        .catch(reportError)
        .finally(() => { ui.retrySave.disabled = false; });
    });
    ui.studyToggle.addEventListener("click", () => setStudyMode(!studyMode));
    ui.toolbar.querySelectorAll("[data-note-tool]").forEach(button => {
      let longPress = null;
      let longPressed = false;
      button.addEventListener("pointerdown", event => {
        longPressed = false;
        longPress = setTimeout(() => { longPressed = true; setTool(button.dataset.noteTool); showToolSettings(); }, 550);
        // Toolbar controls must remain operable by touch while Pencil-only drawing is enabled.
        // Palm/cooldown filtering still applies; Pencil mode itself only gates page interaction.
        if (inputGuard.shouldIgnoreTouch(event, { pencilMode: false })) clearTimeout(longPress);
      });
      ["pointerup", "pointercancel", "pointerleave"].forEach(type => button.addEventListener(type, () => clearTimeout(longPress)));
      button.addEventListener("click", event => { if (longPressed) { event.preventDefault(); return; } handleToolButton(button.dataset.noteTool); });
    });
    ui.styleBtn.addEventListener("click", () => transientUiIsSettings(transientUi) ? closeToolSettings() : showToolSettings());
    ui.settingsDone.addEventListener("click", closeToolSettings);
    ui.inputSettings?.addEventListener("click", () => {
      if (transientUi.type === "input-settings") closeTransientUi();
      else showToolSettings("input");
    });
    ui.maskVisibility?.addEventListener("click", () => {
      closeTransientUi();
      const masks = currentPageMasks();
      const hideMasks = !masks.some(mask => editingHiddenMaskIds.has(maskVisibilityKey(mask)));
      masks.forEach(mask => {
        const visibilityKey = maskVisibilityKey(mask);
        if (hideMasks) editingHiddenMaskIds.add(visibilityKey);
        else editingHiddenMaskIds.delete(visibilityKey);
      });
      if (currentContent) renderPage();
    });
    ui.maskSelectMode?.addEventListener("click", () => {
      setTool("mask");
      maskMultiSelect = !maskMultiSelect;
      ui.maskSelectMode.setAttribute("aria-pressed", String(maskMultiSelect));
      if (!maskMultiSelect) {
        selectedIds = [];
        closeTransientUi();
      }
      renderPage();
    });
    ui.imageSourceDone?.addEventListener("click", closeTransientUi);
    ui.imageClipboard?.addEventListener("click", () => {
      closeTransientUi();
      pasteFromClipboard().catch(error => {
        console.warn("クリップボード画像を直接読み取れませんでした。", error);
        showPasteFallback();
      });
    });
    ui.imagePhoto?.addEventListener("click", () => { closeTransientUi(); ui.photoInput.click(); });
    ui.imageFile?.addEventListener("click", () => { closeTransientUi(); ui.fileInput.click(); });
    ui.backgroundBtn.addEventListener("click", () => changeBackground().catch(reportError));
    ui.color.addEventListener("input", () => {
      persistToolSettings(currentTool === "highlighter" ? { highlighterColor: ui.color.value } : { penColor: ui.color.value });
    });
    ui.width.addEventListener("input", () => {
      if (currentTool === "highlighter") persistToolSettings({ highlighterWidth: Number(ui.width.value) });
      else if (currentTool.startsWith("eraser")) persistToolSettings({ eraserSize: Number(ui.width.value) });
      else persistToolSettings({ penWidth: Number(ui.width.value) });
    });
    ui.opacity.addEventListener("input", () => persistToolSettings(currentTool === "highlighter"
      ? { highlighterOpacity: Number(ui.opacity.value) }
      : { penOpacity: Number(ui.opacity.value) }));
    ui.colorPresets.addEventListener("click", event => {
      const value = event.target.closest("button[data-color]")?.dataset.color;
      if (!value) return;
      persistToolSettings(currentTool === "highlighter" ? { highlighterColor: value } : { penColor: value });
    });
    ui.widthPresets.addEventListener("click", event => {
      const value = Number(event.target.closest("button[data-width]")?.dataset.width);
      if (!value) return;
      if (currentTool === "highlighter") persistToolSettings({ highlighterWidth: value });
      else if (currentTool.startsWith("eraser")) persistToolSettings({ eraserSize: value });
      else persistToolSettings({ penWidth: value });
    });
    const persistSelectedTextDefaults = () => {
      persistToolSettings({
        textFontFamily: ui.fontFamily.value,
        textFontSize: Number(ui.fontSize.value),
        textBold: ui.fontBold.checked,
        textItalic: ui.fontItalic.checked,
        textAlign: ui.textAlign.value,
        textLineHeight: Number(ui.lineHeight.value),
        textColor: ui.textColor.value,
        textOpacity: Number(ui.textOpacity.value)
      });
      applySelectedTextStyle();
    };
    [ui.textColor, ui.textOpacity, ui.fontFamily, ui.fontSize, ui.fontBold, ui.fontItalic, ui.textAlign, ui.lineHeight]
      .forEach(control => control.addEventListener("change", persistSelectedTextDefaults));
    ui.eraserMode.addEventListener("change", () => {
      persistToolSettings({ eraserMode: ui.eraserMode.value });
      if (currentTool.startsWith("eraser")) {
        setTool("eraser-object", { keepSettings: true });
        showToolSettings(currentTool);
      }
    });
    ui.eraserSize.addEventListener("input", () => persistToolSettings({ eraserSize: Number(ui.eraserSize.value) }));
    ui.eraserPresets?.addEventListener("click", event => {
      const value = Number(event.target.closest("button[data-width]")?.dataset.width);
      if (value) persistToolSettings({ eraserSize: value });
    });
    ui.shapeType.addEventListener("change", () => persistToolSettings({ shapeType: ui.shapeType.value }));
    ui.shapeStrokeColor.addEventListener("input", () => persistToolSettings({ shapeStrokeColor: ui.shapeStrokeColor.value }));
    ui.shapeStrokeWidth.addEventListener("input", () => persistToolSettings({ shapeStrokeWidth: Number(ui.shapeStrokeWidth.value) }));
    ui.shapeStrokeOpacity.addEventListener("input", () => persistToolSettings({ shapeStrokeOpacity: Number(ui.shapeStrokeOpacity.value) }));
    ui.lineStyle.addEventListener("change", () => persistToolSettings({ shapeLineStyle: ui.lineStyle.value }));
    ui.fillColor.addEventListener("input", () => persistToolSettings({ shapeFillColor: ui.fillColor.value }));
    ui.fillOpacity.addEventListener("input", () => persistToolSettings({ shapeFillOpacity: Number(ui.fillOpacity.value) }));
    ui.pencilMode.addEventListener("change", () => persistToolSettings({ pencilMode: ui.pencilMode.checked }));
    ui.fingerDraw.addEventListener("change", () => persistToolSettings({ fingerDraw: ui.fingerDraw.checked }));
    ui.straightenEnabled.addEventListener("change", () => persistToolSettings({ straightenEnabled: ui.straightenEnabled.checked }));
    ui.toolbarAutoHide.addEventListener("change", () => persistToolSettings({ toolbarAutoHide: ui.toolbarAutoHide.checked }));
    ui.toolbarDock.addEventListener("change", () => persistToolSettings({ toolbarDock: ui.toolbarDock.value }));
    ui.quickSwitchAction.addEventListener("change", () => persistToolSettings({ quickSwitchAction: ui.quickSwitchAction.value }));
    ui.pageNavigation?.addEventListener("change", () => persistToolSettings({ pageNavigation: ui.pageNavigation.value }));
    ui.quickSwitch.addEventListener("click", quickSwitchTool);
    ui.toolbarCollapse.addEventListener("click", () => ui.toolbar.classList.toggle("collapsed"));
    ui.localEnvironmentToggle?.addEventListener("click", () => {
      if (transientUi.type === "local-environment-popover") closeTransientUi();
      else setTransientUi("local-environment-popover");
    });
    ui.localEnvironmentDone?.addEventListener("click", closeTransientUi);
    ui.moreMenu?.addEventListener("toggle", () => {
      if (syncingTransientUi) return;
      if (ui.moreMenu.open) setTransientUi("more-menu");
      else if (transientUi.type === "more-menu") closeTransientUi();
    });
    let suppressedComposingOutsidePointer = null;
    const outsideComposingEditor = target => {
      const editor = textEditorSession?.editor;
      return textEditorSession?.isComposing === true && editor?.isConnected && !editor.contains(target);
    };
    document.addEventListener("pointerdown", event => {
      if (!outsideComposingEditor(event.target)) return;
      suppressedComposingOutsidePointer = { target: event.target, expiresAt: Date.now() + 1_000 };
      event.preventDefault();
      event.stopImmediatePropagation();
    }, { capture: true });
    document.addEventListener("click", event => {
      const blocked = suppressedComposingOutsidePointer;
      const blockedTarget = blocked?.target;
      const matchesBlockedPointer = blocked?.expiresAt >= Date.now() && blockedTarget && (
        blockedTarget === event.target || blockedTarget.contains?.(event.target) || event.target?.contains?.(blockedTarget)
      );
      if (!outsideComposingEditor(event.target) && !matchesBlockedPointer) return;
      suppressedComposingOutsidePointer = null;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, { capture: true });
    document.addEventListener("pointerdown", event => {
      const target = event.target;
      if (transientUi.type === "closed") return;
      const inside = transientUiIsSettings(transientUi)
        ? ui.settings.contains(target) || ui.toolbar.contains(target)
        : transientUi.type === "image-source-menu"
          ? ui.imageSourceMenu?.contains(target) || ui.toolbar.contains(target)
          : transientUi.type === "save-status-popover"
            ? ui.savePopover.contains(target) || ui.saveStatus.contains(target)
            : transientUi.type === "local-environment-popover"
              ? ui.localEnvironmentDetails?.contains(target) || ui.localEnvironmentToggle?.contains(target)
              : transientUi.type === "more-menu"
                ? ui.moreMenu?.contains(target)
              : transientUi.type === "selection-context-menu"
                ? ui.selectionActions?.contains(target)
                : transientUi.type === "paste-fallback"
                  ? ui.pasteFallback.contains(target)
                  : transientUi.type === "crop-editor"
                  ? ui.stage.contains(target) || Boolean(target?.closest?.("[data-crop-overlay]"))
                  : false;
      if (!inside) closeTransientUi();
    }, { capture: true });
    document.addEventListener("click", event => {
      if (!cropSession || event.target?.closest?.("[data-crop-overlay]")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      showEditorNotice("トリミング編集中です。適用またはキャンセルしてから操作してください。");
      syncTransientUi();
    }, { capture: true });
    const allowNativeTextInteraction = target => isTextEditingTarget(target);
    ui.editorView.addEventListener("selectstart", event => {
      if (!allowNativeTextInteraction(event.target)) event.preventDefault();
    }, { capture: true });
    ui.editorView.addEventListener("dragstart", event => {
      if (!allowNativeTextInteraction(event.target)) event.preventDefault();
    }, { capture: true });
    ui.editorView.addEventListener("contextmenu", event => {
      if (!allowNativeTextInteraction(event.target) && ["pen", "highlighter", "eraser-object", "eraser-pixel", "shape", "mask"].includes(currentTool)) {
        event.preventDefault();
      }
    }, { capture: true });
    const dismissTransientForViewportChange = () => {
      cancelActiveInteraction("pagezoomstart");
      cancelCropEditor({ restore: true });
      closeTransientUi();
      if (currentContent) renderPage();
    };
    ui.editorView.addEventListener("gesturestart", event => {
      dismissTransientForViewportChange();
      event.preventDefault();
    }, { passive: false });
    ["gesturechange", "gestureend"].forEach(type => {
      ui.editorView.addEventListener(type, event => {
        closeTransientUi();
        event.preventDefault();
      }, { passive: false });
    });
    globalThis.addEventListener("orientationchange", dismissTransientForViewportChange);
    const repositionTransientForViewportChange = () => {
      if (transientUi.type === "closed") return;
      requestAnimationFrame(() => positionTransientUi());
    };
    globalThis.visualViewport?.addEventListener?.("resize", repositionTransientForViewportChange);
    globalThis.visualViewport?.addEventListener?.("scroll", repositionTransientForViewportChange);
    bindToolbarDrag();
    ui.viewport.addEventListener("pointerdown", event => {
      if (event.pointerType !== "touch" || inputGuard.isPalmCandidate(event)) return;
      activeTouchPointerIds.add(event.pointerId);
      if (swipeGesture) swipeGesture.blocked = true;
      if (
        activeTouchPointerIds.size !== 1 || toolSettings.pageNavigation !== "swipe" ||
        !currentNote || !currentContent || pageSwitching || textEditorSession || cropSession ||
        activeGesture || zoomController?.isPinchGestureActive || zoomController?.isPinching
      ) {
        return;
      }
      const rect = ui.stage.getBoundingClientRect();
      swipeGesture = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        endX: event.clientX,
        endY: event.clientY,
        startedAt: Number(event.timeStamp || performance.now()),
        startedAtEdge: event.clientX - rect.left <= 36 || rect.right - event.clientX <= 36,
        blocked: false
      };
    }, { capture: true });
    ui.viewport.addEventListener("pointermove", event => {
      if (event.pointerType !== "touch" || swipeGesture?.pointerId !== event.pointerId) return;
      if (activeTouchPointerIds.size > 1 || zoomController?.isPinchGestureActive || zoomController?.isPinching) {
        swipeGesture.blocked = true;
      }
      swipeGesture.endX = event.clientX;
      swipeGesture.endY = event.clientY;
    }, { capture: true });
    const finishTrackedTouch = event => {
      if (event.pointerType !== "touch") return;
      const swipe = swipeGesture?.pointerId === event.pointerId ? swipeGesture : null;
      if (swipe) {
        swipe.endX = event.clientX;
        swipe.endY = event.clientY;
        const direction = event.type === "pointercancel" ? null : resolvePageSwipe({
          ...swipe,
          elapsedMs: Number(event.timeStamp || performance.now()) - swipe.startedAt,
          zoom: zoomController?.zoom || 1,
          atLeftEdge: ui.viewport.scrollLeft <= 2,
          atRightEdge: ui.viewport.scrollLeft + ui.viewport.clientWidth >= ui.viewport.scrollWidth - 2,
          fingerDraw: toolSettings.fingerDraw && currentTool !== "pan" && !studyMode,
          blocked: swipe.blocked || activeTouchPointerIds.size > 1 ||
            Boolean(zoomController?.isPinchGestureActive || zoomController?.isPinching) ||
            Boolean(activeGesture && (activeGesture.pointerId !== event.pointerId || activeGesture.type !== "pan"))
        });
        if (direction) {
          const nextIndex = direction === "next" ? currentPageIndex + 1 : currentPageIndex - 1;
          queueMicrotask(() => void switchPage(nextIndex, { localOnly: true, direction }).catch(reportError));
        }
      }
      swipeGesture = null;
      activeTouchPointerIds.delete(event.pointerId);
    };
    ui.viewport.addEventListener("pointerup", finishTrackedTouch, { capture: true });
    ui.viewport.addEventListener("pointercancel", finishTrackedTouch, { capture: true });
    ui.stage.addEventListener("pointerdown", beginPointer); ui.stage.addEventListener("pointermove", movePointer);
    ui.stage.addEventListener("pointerup", endPointer); ui.stage.addEventListener("pointercancel", endPointer);
    // WebKit can retarget the synthetic click which follows a pointer sequence
    // after renderPage() has replaced the SVG node.  Keep selection usable by
    // resolving the click against the persisted page geometry as a fallback.
    // A completed drag already has the item selected, so it is intentionally a
    // no-op here and does not create a second history entry.
    ui.stage.addEventListener("click", event => {
      if (currentTool !== "select" || studyMode || textEditorSession || cropSession || activeGesture) return;
      const point = gesturePoint(event, ui.stage.getBoundingClientRect());
      const elementId = targetElementId(event) || hitTestElementId(point);
      if (!elementId || selectedIds.includes(elementId)) return;
      const target = currentContent?.elements?.find(element => element.id === elementId);
      if (!target || target.locked) return;
      selectedIds = event.shiftKey ? [...selectedIds, elementId] : [elementId];
      showSelectionContext();
      renderPage();
    });
    ui.stage.addEventListener("pointermove", event => {
      if (!activeGesture && currentTool === "eraser-pixel") updatePixelEraserCursor(event);
    });
    ui.stage.addEventListener("pointerleave", hidePixelEraserCursor);
    ui.viewport.addEventListener("pagezoomstart", () => {
      if (swipeGesture) swipeGesture.blocked = true;
      dismissTransientForViewportChange();
    });
    ui.stage.addEventListener("lostpointercapture", event => {
      drawingDiagnostics.lostpointercapture += 1;
      if (activeGesture?.pointerId === event.pointerId) finishPointerGesture("lostpointercapture", event);
    });
    ui.stage.addEventListener("dblclick", event => {
      const id = targetElementId(event); const element = currentContent?.elements.find(item => item.id === id);
      if (element?.type === "text") { event.preventDefault(); openTextEditor(gesturePoint(event), id); }
    });
    ui.editorView.querySelectorAll("[data-page-action]").forEach(button => button.addEventListener("click", () => {
      const action = button.dataset.pageAction;
      addPage(action === "add-ruled" ? "ruled" : action === "add-default" ? "default" : "blank").catch(reportError);
    }));
    ui.selectionActions.querySelectorAll("[data-selection-action]").forEach(button => button.addEventListener("click", () => {
      try { selectionAction(button.dataset.selectionAction); } catch (error) { reportError(error); }
    }));
    const resize = document.createElement("button"); resize.type = "button"; resize.textContent = "サイズ"; resize.dataset.selectionAction = "resize"; resize.addEventListener("click", () => { try { selectionAction("resize"); } catch (error) { reportError(error); } }); ui.selectionActions.insertBefore(resize, ui.selectionActions.lastElementChild);
    [["自由回転", "rotate"], ["縦横比", "aspect"], ["透明度", "opacity"]].forEach(([label, action]) => {
      const button = document.createElement("button"); button.type = "button"; button.textContent = label;
      button.dataset.selectionAction = action;
      button.addEventListener("click", () => { try { selectionAction(action); } catch (error) { reportError(error); } });
      ui.selectionActions.insertBefore(button, ui.selectionActions.lastElementChild);
    });
    ui.editorView.querySelectorAll("[data-study-action]").forEach(button => button.addEventListener("click", () => {
      const action = button.dataset.studyAction;
      if (action === "previous") switchPage(Math.max(0, currentPageIndex - 1)).catch(reportError);
      if (action === "next") switchPage(Math.min(pages.length - 1, currentPageIndex + 1)).catch(reportError);
      if (action === "hide-all") { revealedMaskIds.clear(); renderPage(); }
      if (action === "show-all") {
        const page = pages[currentPageIndex];
        [...getMaterialPageMasks(currentMaterial(), page.background?.materialPage), ...currentContent.noteMasks]
          .forEach(mask => revealedMaskIds.add(maskVisibilityKey(mask)));
        renderPage();
      }
    }));
    ui.editorView.querySelectorAll("[data-note-action]").forEach(button => button.addEventListener("click", () => {
      const action = button.dataset.noteAction;
      if (action === "export") openExportDialog();
      if (action === "rename") renameNote().catch(reportError);
      if (action === "duplicate") duplicateNote(currentNote.id).catch(reportError);
      if (action === "delete") deleteNote().catch(reportError);
      if (action === "reset-view") {
        closeTransientUi();
        zoomController?.reset?.();
        ui.viewport.scrollLeft = 0;
        ui.viewport.scrollTop = 0;
        globalThis.scrollTo?.(0, 0);
      }
    }));
    [ui.photoInput, ui.fileInput].forEach(input => input.addEventListener("change", () => {
      const file = input.files?.[0]; input.value = ""; if (file) addImageBlob(file).catch(reportError);
    }));
    document.addEventListener("paste", event => {
      if (!currentNote || ui.editorView.classList.contains("hidden")) return;
      if (event.target === ui.pasteFallback) closeTransientUi();
      else if (isTextEditingTarget(event.target)) return;
      const file = imageFileFromPasteEvent(event);
      if (!file) return;
      if (!isEditableNow()) { explainBlockedEdit(); return; }
      event.preventDefault(); addImageBlob(file).catch(reportError);
    });
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && !ui.editorView.classList.contains("hidden")) {
        if (cropSession) {
          event.preventDefault();
          syncTransientUi();
          return;
        }
        cancelActiveInteraction("tool-change"); closeTransientUi(); selectedIds = [];
        if (currentNote) renderPage();
        return;
      }
      if (!currentNote || ui.editorView.classList.contains("hidden") || isTextEditingTarget(event.target)) return;
      if (cropSession) return;
      const command = event.metaKey || event.ctrlKey;
      if (command && event.key.toLowerCase() === "z") { event.preventDefault(); event.shiftKey ? redo() : undo(); }
      else if (command && event.key.toLowerCase() === "c" && selectedIds.length) { event.preventDefault(); copySelection(); }
      else if (command && event.key.toLowerCase() === "v" && internalClipboard.length) { event.preventDefault(); pasteSelection(); }
      else if (["Delete", "Backspace"].includes(event.key) && selectedIds.length) { event.preventDefault(); selectionAction("delete"); }
    });
    ui.startupActions.addEventListener("click", event => {
      const action = event.target.closest("button[data-startup-action]")?.dataset.startupAction;
      if (!action) return;
      if (action === "retry") void retryDedicatedOpen();
      else if (action === "local") void restoreDedicatedLocalDraft().catch(error => setEditorStartupState("recoverable-error", { detail: error.message || String(error), error }));
      else if (action === "cloud") void retryDedicatedOpen({ preferCloud: true });
      else if (action === "readonly") void retryDedicatedOpen({ forceReadOnly: true });
      else if (action === "list") globalThis.location.assign(noteListUrl().toString());
      else if (action === "copy-diagnostics") void copyDiagnostics().catch(reportError);
      else if (action === "download-diagnostics") void downloadDiagnostics().catch(reportError);
    });
    ui.exportPurpose.addEventListener("change", () => {
      ui.exportFilename.value = createPdfFilename(currentNote?.title, ui.exportPurpose.value);
      updateExportPurposeHint();
    });
    ui.exportRangeMode.addEventListener("change", () => ui.exportRange.classList.toggle("hidden", ui.exportRangeMode.value !== "custom"));
    ui.createPdf.addEventListener("click", () => createPdfExport().catch(reportError));
    ui.downloadPdf.addEventListener("click", () => {
      if (!generatedPdf) return;
      generatedPdf.filename = sanitizePdfFilename(ui.exportFilename.value.trim() || generatedPdf.filename);
      ui.exportFilename.value = generatedPdf.filename;
      downloadPdfBlob(generatedPdf.blob, generatedPdf.filename);
    });
    ui.sharePdf.addEventListener("click", () => {
      if (!generatedPdf) return;
      generatedPdf.filename = sanitizePdfFilename(ui.exportFilename.value.trim() || generatedPdf.filename);
      ui.exportFilename.value = generatedPdf.filename;
      sharePdfBlob(generatedPdf.blob, generatedPdf.filename, currentNote.title).catch(reportError);
    });
    ui.cancelPdf.addEventListener("click", () => exportController?.abort());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "hidden" || !currentNote || readOnlyEditor) return;
      textEditorSession?.finish({ force: true });
      void saveCoordinator.flushAll();
    });
    window.addEventListener("pagehide", () => {
      if (currentNote && !readOnlyEditor) {
        textEditorSession?.finish({ force: true });
        void saveCoordinator.flushAll();
      }
      editorLease?.release();
    });
    window.addEventListener("pageshow", event => {
      if (!event.persisted || !dedicatedEditor || !currentNote) return;
      const session = captureUserSession();
      if (!session) {
        setEditorStartupState("fatal-error", { detail: "ログイン状態を確認できません。ノート一覧へ戻ってログインしてください。" });
        return;
      }
      closeTransientUi();
      setEditorStartupState("acquiring-editor-lock", { detail: "復帰した編集セッションを確認中" });
      void establishEditorLease(currentNote.id, session, { forceReadOnly: explicitReadOnlyMode })
        .then(() => setEditorStartupState("ready"))
        .catch(error => {
          editorLease?.dispose();
          editorLease = null;
          setEditorStartupState("recoverable-error", {
            detail: `編集セッションを再開できませんでした：${error.message || error}`,
            error
          });
        });
    });
    window.addEventListener("online", () => {
      if ((!readOnlyEditor || !dedicatedEditor) && !localRecoverySuppressed) {
        void recoverAllPendingWork().catch(error => console.warn("オンライン復帰後のノート再送に失敗しました。", error));
      }
    });
  }

  bindEvents();
  setSaveState("saved");
  closeTransientUi();
  show(dedicatedEditorCreateMode ? "create" : dedicatedEditor ? "editor" : "list");
  if (dedicatedEditor && !dedicatedEditorCreateMode) setEditorStartupState("initializing");

  return {
    refresh: refreshNotes,
    resetForUserChange,
    // The list tab may be replaying an already durable IndexedDB draft in the
    // background. Logging out must not wait indefinitely for that network
    // retry; only an active writer tab has editable in-memory state to flush.
    flush: () => currentNote && !readOnlyEditor ? saveCoordinator.flushAll() : Promise.resolve([]),
    openMaterialNote,
    confirmMaterialReplacement,
    finalizeMaterialReplacement,
    confirmMaterialDeletion,
    archiveMaterialLinkedNotes,
    finalizeMaterialDeletion,
    setStartupState: setEditorStartupState,
    getNotes: () => clone(notes)
  };
}
