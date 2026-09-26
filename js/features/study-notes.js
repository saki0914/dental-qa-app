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
import { createNoteHistory } from "../core/note-history.js";
import { createNoteLocalStore, noteLocalKey } from "../core/note-local-store.js";
import { getMaterialPageMasks } from "../core/note-mask-adapter.js";
import {
  getMaterialDefaultNoteId,
  isMaterialArchiving
} from "../core/note-material-mutation.js";
import { createNoteSaveCoordinator } from "../core/note-save-coordinator.js";
import {
  loadSessionBoundBackgroundBlob,
  loadSessionBoundMaterialDimensions
} from "../core/note-session-loading.js";
import { strokeSvgNodes } from "../core/note-stroke.js";
import { visibleTextLines } from "../core/note-text-layout.js";
import { createNoteThumbnailSignature } from "../core/note-thumbnail.js";
import { noteCanvasToJpeg, renderNotePageToCanvas } from "../core/note-renderer.js";
import { createPageZoomController } from "../core/page-zoom-controller.js";
import {
  PDF_EXPORT_PRESETS,
  createPdfFilename,
  downloadPdfBlob,
  exportNotePdf,
  parsePdfPageRange,
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
  const ui = {
    noteModeBtn: byId("noteModeBtn"), noteView: byId("noteView"), listView: byId("noteListView"),
    createView: byId("noteCreateView"), editorView: byId("noteEditorView"), list: byId("noteList"),
    listStatus: byId("noteListStatus"), newNoteBtn: byId("newNoteBtn"), cancelCreate: byId("cancelNoteCreateBtn"),
    newTitle: byId("newNoteTitle"), pdfInput: byId("notePdfInput"), materialPicker: byId("noteMaterialPicker"),
    createProgress: byId("noteCreateProgress"), createProgressLabel: byId("noteCreateProgressLabel"),
    createProgressBar: byId("noteCreateProgressBar"), cancelCreateProgress: byId("cancelNoteProgressBtn"),
    closeNote: byId("closeNoteBtn"), title: byId("noteTitleInput"), pageCounter: byId("notePageCounter"), pagesButton: byId("notePagesBtn"),
    undo: byId("noteUndoBtn"), redo: byId("noteRedoBtn"), studyToggle: byId("toggleNoteStudyBtn"),
    saveStatus: byId("noteSaveStatus"), pageSidebar: byId("notePageSidebar"), pageList: byId("notePageList"),
    retrySave: byId("noteRetrySaveBtn"),
    viewport: byId("noteViewport"), stage: byId("notePageStage"), studyControls: byId("noteStudyControls"),
    maskCounts: byId("noteMaskCounts"), selectionActions: byId("noteSelectionActions"),
    toolbar: byId("noteEditorView")?.querySelector(".note-toolbar"), settings: byId("noteToolSettings"),
    color: byId("noteColorInput"), width: byId("noteWidthInput"), opacity: byId("noteOpacityInput"),
    eraserMode: byId("noteEraserMode"), shapeType: byId("noteShapeType"), fingerDraw: byId("noteFingerDraw"),
    lineStyle: byId("noteLineStyle"), fillColor: byId("noteFillColor"), fillOpacity: byId("noteFillOpacity"),
    fontFamily: byId("noteFontFamily"), fontSize: byId("noteFontSize"), fontBold: byId("noteFontBold"),
    fontItalic: byId("noteFontItalic"), textAlign: byId("noteTextAlign"), lineHeight: byId("noteLineHeight"),
    currentColor: byId("noteCurrentColor"), styleBtn: byId("noteStyleBtn"), backgroundBtn: byId("noteBackgroundBtn"),
    photoInput: byId("noteImagePhotoInput"), fileInput: byId("noteImageFileInput"), pasteFallback: byId("notePasteFallback"),
    exportDialog: byId("noteExportDialog"), exportPurpose: byId("noteExportPurpose"), exportRangeMode: byId("noteExportRangeMode"),
    exportRange: byId("noteExportRange"), exportQuality: byId("noteExportQuality"), exportFilename: byId("noteExportFilename"),
    exportPageNumbers: byId("noteExportPageNumbers"), exportProgress: byId("noteExportProgress"), exportStatus: byId("noteExportStatus"),
    createPdf: byId("createNotePdfBtn"), downloadPdf: byId("downloadNotePdfBtn"), sharePdf: byId("shareNotePdfBtn"),
    cancelPdf: byId("cancelNotePdfBtn")
  };
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
  let renderToken = 0;
  let objectUrls = [];
  let zoomController = null;
  let createController = null;
  let exportController = null;
  let generatedPdf = null;
  let lastTap = null;
  let pasteOffset = 0;
  let studyMode = false;
  let revealedMaskIds = new Set();
  let assetCache = new Map();
  let contentCache = new Map();
  let hasSeenPen = false;
  const pendingAssetRecoveryPromises = new Map();
  const pendingRecoveryPromises = new Map();
  const pendingRecoverySweeps = new Map();
  let userSessionGeneration = 0;
  let cropSession = null;
  const thumbnailTokens = new Map();

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

  const recoveryKey = (session, noteId = "all") => `${session.uid}|${session.generation}|${noteId}`;

  const saveCoordinator = createNoteSaveCoordinator({
    localStore,
    debounceMs: 850,
    isSessionCurrent: identity => (
      getCurrentUser()?.uid === identity.uid &&
      userSessionGeneration === identity.sessionGeneration
    ),
    persist: async (identity, content, isActive) => {
      const page = currentNote?.id === identity.noteId
        ? pages.find(item => item.pageId === identity.pageId)
        : null;
      const expectedRevision = Number(page?.contentRevision ?? identity.expectedRevision);
      if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
        throw new Error("保存対象ページのリビジョンが見つかりません。");
      }
      const result = await noteStore.savePageContent({
        noteId: identity.noteId,
        pageId: identity.pageId,
        expectedRevision,
        expectedUid: identity.uid
      }, content);
      if (!isActive()) return result;
      if (page) {
        page.contentRevision = result.revision;
        page.contentPath = result.contentPath;
        page.contentHash = result.contentHash;
      }
      content.revision = result.revision;
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
    onStatus: (status, identity, detail) => {
      if (!currentNote || identity.noteId !== currentNote.id || identity.pageId !== pages[currentPageIndex]?.pageId) return;
      const labels = {
        editing: "編集中", "local-saved": "端末内へ保存済み", saving: "クラウドへ保存中",
        saved: "保存済み", offline: "オフライン", error: "保存エラー", conflict: "競合あり"
      };
      ui.saveStatus.textContent = labels[status] || status;
      ui.saveStatus.dataset.state = status;
      ui.retrySave.classList.toggle("hidden", !["error", "offline"].includes(status));
      if (status === "conflict") currentNote.hasConflict = true;
      if (detail instanceof Error) console.error(detail);
    }
  });

  function identity(page = pages[currentPageIndex]) {
    return {
      uid: getCurrentUser()?.uid,
      noteId: currentNote?.id,
      pageId: page?.pageId,
      expectedRevision: Number(page?.contentRevision || 0),
      sessionGeneration: userSessionGeneration
    };
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

  function show(view) {
    ui.listView.classList.toggle("hidden", view !== "list");
    ui.createView.classList.toggle("hidden", view !== "create");
    ui.editorView.classList.toggle("hidden", view !== "editor");
  }

  function setListStatus(message) {
    ui.listStatus.textContent = message;
  }

  async function refreshNotes() {
    const session = captureUserSession();
    if (!session) return;
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
      void recoverAllPendingWork(session).catch(error => {
        if (error?.name !== "NoteSessionChangedError") console.warn("未送信ノートの自動再送を継続できませんでした。", error);
      });
    } catch (error) {
      if (error?.name === "NoteSessionChangedError") return;
      console.error(error);
      setListStatus(`ノートを読み込めませんでした。${error.message || error}`);
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
      restore.addEventListener("click", () => restoreOrphanedDrafts(group).catch(reportError));
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
        ["編集", () => openNote(note.id)],
        ["暗記", () => openNote(note.id, { study: true })],
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

  async function createStandalone(kind) {
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
    await openNote(noteId);
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
      button.addEventListener("click", () => openMaterialNote(material.id).catch(reportError));
      ui.materialPicker.append(button);
    });
    ui.materialPicker.classList.remove("hidden");
  }

  async function openMaterialNote(materialId) {
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
    await openNote(note.id);
  }

  async function createPdfNote(file) {
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
      await openNote(noteId);
    } catch (error) {
      await compensateCreationFailure(noteId, {
        pageIds: notePages.map(page => page.pageId),
        storagePaths: uploaded,
        phase: error?.name === "AbortError" ? "cancelled" : "pdf-import",
        expectedUid: session.uid
      }, error);
      if (error?.name !== "AbortError") throw new Error(`PDFノートは作成されていません。${error.message || error}`);
      setListStatus("PDFノートの作成をキャンセルしました。");
    } finally {
      createController = null;
      ui.createProgress.classList.add("hidden");
      ui.pdfInput.value = "";
    }
  }

  async function pageContent(page) {
    const session = captureUserSession();
    assertUserSession(session);
    const cached = contentCache.get(page.pageId);
    if (cached) return clone(cached);
    const local = await localStore.get("pageDrafts", noteLocalKey(session.uid, currentNote.id, page.pageId));
    assertUserSession(session);
    const content = normalizeNoteLineElements(
      local?.uid === session.uid ? local.content : await noteStore.loadPageContent(currentNote.id, page, { expectedUid: session.uid }),
      page.size
    );
    assertUserSession(session);
    contentCache.set(page.pageId, clone(content));
    return content;
  }

  async function openNote(noteId, { study = false } = {}) {
    const session = captureUserSession();
    assertUserSession(session);
    if (currentNote && !await flushWithDecision(pages[currentPageIndex], "別のノートを開く操作")) return;
    assertUserSession(session);
    currentNote = await noteStore.getNote(noteId, { expectedUid: session.uid });
    assertUserSession(session);
    if (!currentNote || currentNote.deletedAt) throw new Error("ノートが見つかりません。");
    pages = await noteStore.listPages(noteId, { expectedUid: session.uid });
    assertUserSession(session);
    if (!pages.length) throw new Error("ノートにページがありません。");
    currentPageIndex = 0;
    ui.pageSidebar.classList.remove("open");
    ui.pagesButton.setAttribute("aria-expanded", "false");
    contentCache = new Map(); assetCache = new Map(); selectedIds = []; revealedMaskIds = new Set();
    await recoverPendingAssets(noteId);
    await recoverPendingSaves(noteId, pages);
    pages = await noteStore.listPages(noteId, { expectedUid: session.uid });
    assertUserSession(session);
    const localConflicts = await localStore.listForUser("conflicts", session.uid);
    assertUserSession(session);
    currentNote.hasConflict = localConflicts.some(conflict => conflict.noteId === noteId);
    history.clear();
    ui.title.value = currentNote.title || "無題ノート";
    show("editor");
    await loadCurrentPage();
    const [pendingForNote, pendingAssetsForNote] = await Promise.all([
      localStore.listForUser("pendingSaves", session.uid),
      localStore.listForUser("pendingAssets", session.uid)
    ]).then(([pendingSaves, pendingAssets]) => [
      pendingSaves.filter(item => item.noteId === noteId),
      pendingAssets.filter(item => item.noteId === noteId)
    ]);
    if (pendingForNote.length || pendingAssetsForNote.length) {
      ui.saveStatus.textContent = [
        pendingForNote.length ? `下書き再送待ち ${pendingForNote.length}件` : "",
        pendingAssetsForNote.length ? `画像再送待ち ${pendingAssetsForNote.length}件` : ""
      ].filter(Boolean).join(" / ");
      ui.saveStatus.dataset.state = navigator.onLine === false ? "offline" : "error";
      ui.retrySave.classList.remove("hidden");
    }
    if (currentNote.hasConflict) {
      ui.saveStatus.textContent = "競合あり";
      ui.saveStatus.dataset.state = "conflict";
    }
    setStudyMode(study);
  }

  async function loadCurrentPage() {
    const page = pages[currentPageIndex];
    if (!page) return;
    selectedIds = [];
    currentContent = await pageContent(page);
    renderPageList();
    renderPage();
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

  async function switchPage(index) {
    if (index < 0 || index >= pages.length || index === currentPageIndex) return;
    if (!await flushWithDecision(pages[currentPageIndex], "ページ切替")) return;
    contentCache.set(pages[currentPageIndex].pageId, clone(currentContent));
    currentPageIndex = index;
    history.clear();
    await loadCurrentPage();
    ui.pageSidebar.classList.remove("open");
    ui.pagesButton.setAttribute("aria-expanded", "false");
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
    const metadata = await noteStore.getAsset(sourceNoteId, assetId, { expectedUid: session.uid });
    assertUserSession(session);
    if (!metadata?.storagePath) throw new Error(`貼り付け画像 ${assetId} を取得できません。`);
    const blob = await noteStore.getStorageBlob(metadata.storagePath, { expectedUid: session.uid });
    assertUserSession(session);
    assetCache.set(key, blob);
    return blob;
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
    if (cloudRevision !== expectedRevision) {
      throw new NoteConflictError("別の端末でこのページが更新されています。", cloudRevision);
    }
    const normalizedContent = normalizeNoteLineElements(draft.content, page.size);
    const saved = await noteStore.savePageContent({
      noteId,
      pageId: page.pageId,
      expectedRevision,
      expectedUid: session.uid
    }, normalizedContent);
    assertUserSession(session);
    Object.assign(page, {
      contentRevision: saved.revision,
      contentPath: saved.contentPath,
      contentHash: saved.contentHash
    });
    const restored = { ...normalizedContent, revision: saved.revision };
    if (currentNote?.id === noteId) contentCache.set(page.pageId, restored);
    await localStore.deleteSavePairIfUnchanged(key, { draft, pending });
    assertUserSession(session);
    return saved;
  }

  async function recordRecoveredDraftFailure({ error, uid, noteId, pageId, draft, key }) {
    if (error?.name !== "NoteConflictError") return;
    await localStore.put("conflicts", {
      key, uid, noteId, pageId,
      expectedRevision: Number(draft.expectedRevision ?? draft.content?.revision),
      content: clone(draft.content), error: error.message,
      updatedAt: new Date().toISOString()
    });
    if (currentNote?.id === noteId) currentNote.hasConflict = true;
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
      transform: `rotate(${element.rotation || 0} ${(element.bounds.x + element.bounds.width / 2) * 1000} ${(element.bounds.y + element.bounds.height / 2) * 1414})`
    });
    const lineHeight = fontSize * Number(style.lineHeight || 1.25);
    visibleTextLines(element.text, {
      maxWidth: element.bounds.width * 1000,
      maxHeight: element.bounds.height * 1414,
      lineHeight,
      measureText: value => measurement.measureText(value).width
    }).forEach((line, index) => {
      const span = createSvgElement("tspan", { x: anchorX, dy: index ? lineHeight : fontSize });
      span.textContent = line || " "; node.append(span);
    });
    return node;
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

  function renderCropOverlay() {
    if (!cropSession) return;
    const image = currentContent.elements.find(element => element.id === cropSession.elementId && element.type === "image");
    if (!image) { cropSession = null; return; }
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
    overlay.append(actions);
    ui.stage.append(overlay);
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

  async function renderPage() {
    if (!currentContent || !pages[currentPageIndex]) return;
    const token = ++renderToken;
    releaseObjectUrls();
    ui.stage.replaceChildren();
    const page = pages[currentPageIndex];
    ui.stage.style.aspectRatio = `${page.size?.width || A4_SIZE.width} / ${page.size?.height || A4_SIZE.height}`;
    ui.stage.classList.toggle("study-mode", studyMode);

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
        if (token !== renderToken) return;
        const url = URL.createObjectURL(blob); objectUrls.push(url);
        const image = document.createElement("img"); image.className = "note-background-image"; image.alt = "ノート背景"; image.src = url;
        ui.stage.append(image);
      } catch (error) {
        const message = document.createElement("div"); message.className = "note-layer"; message.textContent = `背景画像を表示できません: ${error.message}`;
        ui.stage.append(message);
      }
    }

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
          const url = URL.createObjectURL(blob); objectUrls.push(url); image.src = url;
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
    [...materialMasks, ...(currentContent.noteMasks || [])].forEach(mask => {
      const node = document.createElement("div");
      const revealed = revealedMaskIds.has(mask.id);
      node.className = `note-mask ${mask.weak ? "weak" : ""} ${revealed ? "revealed" : ""} ${!mask.readOnly && currentTool === "mask" ? "editable" : ""} ${selectedIds.includes(mask.id) ? "note-selected" : ""}`;
      node.dataset.maskId = mask.id; node.dataset.readOnly = String(mask.readOnly === true); setBoundsStyle(node, mask);
      node.title = mask.readOnly ? "既存教材マスク（教材管理で編集）" : "ノート専用マスク";
      maskLayer.append(node);
    });
    ui.stage.append(maskLayer);
    renderSelectionOverlay();
    ui.selectionActions.classList.toggle("hidden", selectedIds.length === 0 || studyMode);
    const maskRotationDisabled = selectedMasks().length > 0;
    ui.selectionActions.querySelectorAll('[data-selection-action="rotate-left"], [data-selection-action="rotate-right"], [data-selection-action="rotate"]').forEach(button => {
      button.disabled = maskRotationDisabled;
      button.title = maskRotationDisabled ? "マスクを含む選択範囲は回転できません" : "";
    });
    ui.undo.disabled = !history.canUndo(); ui.redo.disabled = !history.canRedo();
    ui.pageCounter.textContent = `${currentPageIndex + 1} / ${pages.length}`;
    ui.maskCounts.textContent = `教材 ${materialMasks.length} / ノート ${currentContent.noteMasks.length}`;
    syncSelectedTextControls();
    if (!zoomController) zoomController = createPageZoomController({ viewport: ui.viewport, content: ui.stage });
  }

  function commitChange(before, label) {
    const after = clone(currentContent);
    if (!history.push(historySnapshot(before), historySnapshot(after), label)) return;
    contentCache.set(pages[currentPageIndex].pageId, clone(after));
    void saveCoordinator.schedule(identity(), after).catch(reportError);
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
    if (!snapshot?.content) return;
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
      saveCoordinator.schedule(identity(), currentContent),
      ...metadataUpdates
    ]);
    renderPageList();
    renderPage();
  }

  function setTool(tool) {
    if (tool === "eraser-object") tool = ui.eraserMode.value === "pixel" ? "eraser-pixel" : "eraser-object";
    currentTool = TOOL_LABELS[tool] ? tool : "pen";
    [...ui.toolbar.querySelectorAll("[data-note-tool]")].forEach(button => button.classList.toggle("active", button.dataset.noteTool === tool || (button.dataset.noteTool === "eraser-object" && tool === "eraser-pixel")));
    ui.stage.dataset.tool = currentTool;
    ui.stage.setAttribute("aria-label", `編集ページ: ${TOOL_LABELS[currentTool]}`);
    selectedIds = currentTool === "mask" ? selectedIds.filter(id => currentContent.noteMasks.some(mask => mask.id === id)) : selectedIds.filter(id => currentContent.elements.some(element => element.id === id));
    renderPage();
    if (tool === "image") showImageMenu();
  }

  function gesturePoint(event) {
    return clientPointToNormalized(event.clientX, event.clientY, ui.stage.getBoundingClientRect());
  }

  function targetElementId(event) {
    return event.target?.closest?.("[data-element-id]")?.dataset.elementId || "";
  }

  function targetMaskId(event) {
    return event.target?.closest?.("[data-mask-id]")?.dataset.maskId || "";
  }

  function targetTransformHandle(event) {
    return event.target?.closest?.("[data-transform-handle]")?.dataset.transformHandle || "";
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
    const radius = Number(ui.width.value) / 1000 * 2.5;
    const beforeCount = currentContent.elements.length;
    currentContent.elements = currentContent.elements.filter(element => !objectEraserHit(element, point, radius));
    if (currentContent.elements.length !== beforeCount) {
      gesture.changed = true;
      renderPage();
    }
  }

  function beginPointer(event) {
    if (!currentContent || event.button > 0) return;
    if (event.target?.closest?.("[data-crop-action]")) return;
    if (event.pointerType === "pen") {
      hasSeenPen = true;
      ui.fingerDraw.checked = false;
    }
    const point = gesturePoint(event);
    lastTap = point;
    const elementId = targetElementId(event);
    const maskId = targetMaskId(event);
    const transformHandle = targetTransformHandle(event);

    if (studyMode) {
      if (maskId) {
        revealedMaskIds.has(maskId) ? revealedMaskIds.delete(maskId) : revealedMaskIds.add(maskId);
        renderPage();
      }
      return;
    }
    if (transformHandle) {
      if (transformHandle.startsWith("crop-")) {
        const image = currentContent.elements.find(element => element.id === cropSession?.elementId);
        if (!image) return;
        activeGesture = {
          type: "crop-resize", pointerId: event.pointerId,
          handle: transformHandle.slice(5), imageId: image.id,
          original: clone(image), before: clone(currentContent)
        };
      } else if (transformHandle === "line-start" || transformHandle === "line-end") {
        const line = selectedElements()[0];
        if (!line) return;
        activeGesture = {
          type: "line-endpoint", pointerId: event.pointerId,
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
          pointerId: event.pointerId,
          handle: transformHandle.replace("resize-", ""),
          start: point,
          startAngle: angleFromCenter(point, { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }, pages[currentPageIndex]?.size),
          bounds,
          original: clone(items),
          target: currentTool === "mask" ? "masks" : "elements",
          before: clone(currentContent)
        };
      }
      if (event.isTrusted) ui.stage.setPointerCapture?.(event.pointerId);
      event.preventDefault();
      return;
    }
    const drawWithTouch = event.pointerType !== "touch" || ui.fingerDraw.checked || !hasSeenPen;
    if (["pen", "highlighter", "shape", "text", "mask", "eraser-object", "eraser-pixel"].includes(currentTool) && !drawWithTouch) {
      activeGesture = { type: "pan", pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, scrollLeft: ui.viewport.scrollLeft, scrollTop: ui.viewport.scrollTop };
    } else if (currentTool === "pan") {
      activeGesture = { type: "pan", pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, scrollLeft: ui.viewport.scrollLeft, scrollTop: ui.viewport.scrollTop };
    } else if (currentTool === "text" && elementId) {
      openTextEditor(point, elementId);
      return;
    } else if (currentTool === "eraser-object") {
      activeGesture = { type: "eraser-object", pointerId: event.pointerId, changed: false, before: clone(currentContent) };
      eraseObjectsAt(point, activeGesture);
    } else if (currentTool === "select" && elementId) {
      const target = currentContent.elements.find(element => element.id === elementId);
      if (target?.locked) return;
      if (!event.shiftKey && !selectedIds.includes(elementId)) selectedIds = [elementId];
      else if (event.shiftKey && !selectedIds.includes(elementId)) selectedIds.push(elementId);
      activeGesture = { type: "move-elements", pointerId: event.pointerId, start: point, original: clone(currentContent.elements), before: clone(currentContent) };
      renderPage();
    } else if (currentTool === "mask" && maskId) {
      const mask = currentContent.noteMasks.find(item => item.id === maskId);
      if (!mask) return;
      selectedIds = [maskId];
      activeGesture = { type: "move-mask", pointerId: event.pointerId, start: point, original: clone(mask), before: clone(currentContent) };
      renderPage();
    } else {
      activeGesture = { type: currentTool === "select" ? "lasso" : currentTool, pointerId: event.pointerId, start: point, points: [{ ...point, pressure: Number(event.pressure || .5) }], end: point, additive: event.shiftKey, before: clone(currentContent) };
      if (currentTool === "eraser-pixel") activeGesture.radius = Number(ui.width.value) / 1000 * 2.5;
      if (currentTool === "select") drawLasso([point]);
      else if (currentTool === "text") drawSelectionRect(point, point);
    }
    if (event.isTrusted) ui.stage.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  function movePointer(event) {
    if (!activeGesture || activeGesture.pointerId !== event.pointerId) return;
    if (activeGesture.type === "pan") {
      ui.viewport.scrollLeft = activeGesture.scrollLeft - (event.clientX - activeGesture.clientX);
      ui.viewport.scrollTop = activeGesture.scrollTop - (event.clientY - activeGesture.clientY);
      return;
    }
    const point = gesturePoint(event);
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
    } else if (["pen", "highlighter", "eraser-pixel"].includes(activeGesture.type)) {
      const coalesced = event.getCoalescedEvents?.();
      const events = coalesced?.length ? coalesced : [event];
      events.forEach(item => activeGesture.points.push({ ...gesturePoint(item), pressure: Number(item.pressure || .5) }));
      drawDraftPath(activeGesture.points, activeGesture.type);
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
      drawSelectionRect(activeGesture.start, point);
    } else if (["shape", "mask"].includes(activeGesture.type)) {
      drawSelectionRect(activeGesture.start, point);
    }
    event.preventDefault();
  }

  function endPointer(event) {
    if (!activeGesture || activeGesture.pointerId !== event.pointerId) return;
    const gesture = activeGesture;
    activeGesture = null;
    ui.stage.querySelectorAll("[data-note-draft]").forEach(node => node.remove());
    if (event.type === "pointercancel") {
      if (gesture.before) currentContent = clone(gesture.before);
      renderPage();
      return;
    }
    if (gesture.type === "pan") return;
    if (["resize-selection", "rotate-selection", "line-endpoint"].includes(gesture.type)) {
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
    if (["pen", "highlighter"].includes(gesture.type) && gesture.points.length > 1) {
      const isHighlighter = gesture.type === "highlighter";
      currentContent.elements.push({
        id: randomId(), type: isHighlighter ? "highlighter" : "stroke", points: gesture.points,
        pressureEnabled: !isHighlighter,
        style: {
          color: ui.color.value,
          widthRatio: Number(ui.width.value) / 10000 * (isHighlighter ? 10 : 1),
          opacity: isHighlighter ? Math.min(.35, Number(ui.opacity.value) / 100) : Number(ui.opacity.value) / 100
        },
        zIndex: elementZIndex(currentContent.elements), createdAt: new Date().toISOString()
      });
      commitChange(gesture.before, isHighlighter ? "ハイライト追加" : "ペン追加");
    } else if (gesture.type === "eraser-pixel") {
      currentContent.elements = currentContent.elements.flatMap(element => {
        if (!["stroke", "highlighter"].includes(element.type)) return [element];
        return splitStrokeByEraser(element, gesture.points, gesture.radius);
      });
      commitChange(gesture.before, "ピクセル消去");
    } else if (gesture.type === "text") {
      const bounds = normalizedBoundsFromPoints(gesture.start, end, .01);
      const dragged = Math.abs(end.x - gesture.start.x) > .01 || Math.abs(end.y - gesture.start.y) > .01;
      openTextEditor(gesture.start, "", dragged ? bounds : null);
    } else if (gesture.type === "shape") {
      const bounds = normalizedBoundsFromPoints(gesture.start, end, .01);
      const shape = {
        id: randomId(), type: "shape", shapeType: ui.shapeType.value, bounds, rotation: 0,
        style: { strokeColor: ui.color.value, strokeWidthRatio: Number(ui.width.value) / 10000, strokeOpacity: Number(ui.opacity.value) / 100, fillColor: ui.fillColor.value, fillOpacity: Number(ui.fillOpacity.value) / 100, lineStyle: ui.lineStyle.value },
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
      commitChange(gesture.before, "暗記マスク追加");
    } else if (gesture.type === "lasso") {
      const hits = currentContent.elements
        .filter(element => lassoContainsElement(gesture.points, element, pages[currentPageIndex]?.size))
        .map(element => element.id);
      selectedIds = gesture.additive ? [...new Set([...selectedIds, ...hits])] : hits;
      renderPage();
    }
  }

  function drawDraftPath(points, type) {
    ui.stage.querySelectorAll("[data-note-draft]").forEach(node => node.remove());
    const svg = createSvgElement("svg", { viewBox: "0 0 1000 1414", preserveAspectRatio: "none", class: "note-layer", "data-note-draft": "true" });
    svg.style.zIndex = "30";
    svg.append(createSvgElement("path", {
      d: pathData(points), class: "note-draft-path", stroke: ui.color.value,
      "stroke-width": Math.max(1, Number(ui.width.value) / 10 * (type === "highlighter" ? 10 : 1)),
      "stroke-opacity": type === "highlighter" ? .3 : Number(ui.opacity.value) / 100
    }));
    ui.stage.append(svg);
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

  function openTextEditor(point, existingId = "", requestedBounds = null) {
    const existing = currentContent.elements.find(element => element.id === existingId && element.type === "text");
    const before = clone(currentContent);
    const editor = document.createElement("textarea"); editor.className = "note-text-editor";
    const bounds = existing?.bounds || requestedBounds || { x: point.x, y: point.y, width: .35, height: .12 };
    setBoundsStyle(editor, bounds); editor.value = existing?.text || ""; ui.stage.append(editor); editor.focus();
    const finish = () => {
      const value = editor.value.trimEnd(); editor.remove();
      if (!value) return;
      if (existing) existing.text = value;
      else currentContent.elements.push({
        id: randomId(), type: "text", bounds, rotation: 0, text: value,
        style: { fontFamily: ui.fontFamily.value, fontSizeRatio: Number(ui.fontSize.value) / 1000, fontWeight: ui.fontBold.checked ? "bold" : "normal", fontStyle: ui.fontItalic.checked ? "italic" : "normal", textAlign: ui.textAlign.value, lineHeight: Number(ui.lineHeight.value || 1.25), color: ui.color.value, opacity: Number(ui.opacity.value) / 100 },
        zIndex: elementZIndex(currentContent.elements)
      });
      commitChange(before, existing ? "テキスト編集" : "テキスト追加");
    };
    editor.addEventListener("blur", finish, { once: true });
    editor.addEventListener("keydown", event => { if (event.key === "Escape") { editor.value = ""; editor.blur(); } });
    editor.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  function showImageMenu() {
    document.querySelector(".note-image-menu")?.remove();
    const menu = document.createElement("div"); menu.className = "note-image-menu note-selection-actions"; menu.style.top = "64px";
    [["クリップボードから貼り付け", pasteFromClipboard], ["写真から選択", () => ui.photoInput.click()], ["ファイルから選択", () => ui.fileInput.click()]].forEach(([label, action]) => {
      const button = document.createElement("button"); button.type = "button"; button.textContent = label;
      button.addEventListener("click", () => { menu.remove(); Promise.resolve(action()).catch(() => showPasteFallback()); }); menu.append(button);
    });
    ui.editorView.append(menu);
  }

  function showPasteFallback() {
    ui.pasteFallback.classList.remove("hidden"); ui.pasteFallback.textContent = "ここを長押しして「ペースト」を選択してください"; ui.pasteFallback.focus();
  }

  async function pasteFromClipboard() {
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
    if (!currentNote || !currentContent) return;
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
    await localStore.put("pendingAssets", { key: pendingKey, uid: target.uid, noteId: target.noteId, pageId: target.pageId, assetId, blob: prepared.blob, createdAt: pendingAssetCreatedAt, updatedAt: pendingAssetCreatedAt });
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
    await localStore.putSavePair(
      { key: draftKey, uid: target.uid, noteId: target.noteId, pageId: target.pageId, expectedRevision: target.expectedRevision, content: clone(target.content), mutationId, updatedAt: draftUpdatedAt },
      { key: draftKey, uid: target.uid, noteId: target.noteId, pageId: target.pageId, expectedRevision: target.expectedRevision, mutationId, updatedAt: draftUpdatedAt }
    );
    assertUserSession(session);
    if (currentNote?.id === target.noteId && pages[currentPageIndex]?.pageId === target.pageId) {
      ui.saveStatus.textContent = "端末内へ保存済み"; ui.saveStatus.dataset.state = "local-saved";
      setTool("select"); renderPage(); refreshCurrentPageThumbnail();
    }
    try {
      assertUserSession(session);
      await noteStore.uploadAsset(target.noteId, prepared.blob, { assetId, expectedUid: session.uid });
      assertUserSession(session);
      await localStore.deleteIfUnchanged("pendingAssets", pendingKey, pendingAssetCreatedAt);
      assertUserSession(session);
      await saveCoordinator.schedule({
        uid: target.uid,
        noteId: target.noteId,
        pageId: target.pageId,
        expectedRevision: target.expectedRevision,
        sessionGeneration: session.generation
      }, target.content);
      assertUserSession(session);
    } catch (error) {
      if (error?.name === "NoteSessionChangedError") throw error;
      if (currentNote?.id === target.noteId) {
        ui.saveStatus.textContent = "保存エラー（画像は端末内に保持）";
        ui.saveStatus.dataset.state = "error";
      }
      throw error;
    }
  }

  async function pageAction(action, index) {
    if (!currentNote) return;
    const session = captureUserSession();
    assertUserSession(session);
    if (action === "up" || action === "down") {
      const target = action === "up" ? index - 1 : index + 1;
      if (target < 0 || target >= pages.length) return;
      if (!await flushWithDecision(pages[currentPageIndex], "ページ並べ替え")) return;
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
      ui.pageSidebar.classList.remove("open");
      ui.pagesButton.setAttribute("aria-expanded", "false");
      return;
    }
    if (action === "duplicate") {
      const sourcePage = pages[index];
      const sourceContent = index === currentPageIndex ? clone(currentContent) : await pageContent(sourcePage);
      assertUserSession(session);
      const duplicate = { ...clone(sourcePage), pageId: randomId(), order: pages.length + 1, contentRevision: 0, contentPath: "", contentHash: "" };
      currentNote.orderRevision = await noteStore.createPage(currentNote.id, duplicate, pages.length + 1, currentNote.orderRevision, session.uid);
      pages.push(duplicate);
      const duplicatedContent = { ...clone(sourceContent), noteId: currentNote.id, pageId: duplicate.pageId, revision: 0, elements: sourceContent.elements.map(element => ({ ...element, id: randomId(), assetNoteId: element.type === "image" ? (element.assetNoteId || currentNote.id) : element.assetNoteId })), noteMasks: sourceContent.noteMasks.map(mask => ({ ...mask, id: randomId() })) };
      const saved = await noteStore.savePageContent({ noteId: currentNote.id, pageId: duplicate.pageId, expectedRevision: 0, expectedUid: session.uid }, duplicatedContent);
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
      ui.pageSidebar.classList.remove("open");
      ui.pagesButton.setAttribute("aria-expanded", "false");
    }
  }

  async function addPage(kind) {
    const session = captureUserSession();
    assertUserSession(session);
    if (!await flushWithDecision(pages[currentPageIndex], "ページ追加")) return;
    assertUserSession(session);
    const page = kind === "default"
      ? pageFromBackground(currentNote.defaultBackground || DEFAULT_BACKGROUND, pages.length + 1)
      : blankPage(kind, pages.length + 1);
    currentNote.orderRevision = await noteStore.createPage(currentNote.id, page, pages.length + 1, currentNote.orderRevision, session.uid);
    pages.push(page); currentNote.pageCount = pages.length; currentPageIndex = pages.length - 1;
    currentContent = emptyContent(currentNote.id, page.pageId); contentCache.set(page.pageId, clone(currentContent));
    history.clear(); renderPageList(); renderPage();
    ui.pageSidebar.classList.remove("open");
    ui.pagesButton.setAttribute("aria-expanded", "false");
  }

  async function changeBackground() {
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
    ui.color.value = style.color || "#111111";
    ui.opacity.value = String(Math.round(Number(style.opacity ?? 1) * 100));
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
        color: ui.color.value,
        opacity: Number(ui.opacity.value) / 100
      };
    });
    commitChange(before, "テキスト書式変更");
  }

  function selectionAction(action) {
    const elements = selectedElements();
    const masks = selectedMasks();
    if (!elements.length && !masks.length) return;
    const before = clone(currentContent);
    if (action === "delete") {
      currentContent.elements = currentContent.elements.filter(element => !selectedIds.includes(element.id) || element.locked);
      currentContent.noteMasks = currentContent.noteMasks.filter(mask => !selectedIds.includes(mask.id));
      selectedIds = [];
    } else if (action === "duplicate") {
      const copies = elements.map(element => ({
        ...translateElement(clone(element), .02, .02, pages[currentPageIndex]?.size),
        id: randomId()
      }));
      const maskCopies = masks.map(mask => ({ ...mask, id: randomId(), x: clamp(mask.x + .02, 0, 1 - mask.width), y: clamp(mask.y + .02, 0, 1 - mask.height) }));
      currentContent.elements.push(...copies); currentContent.noteMasks.push(...maskCopies); selectedIds = [...copies, ...maskCopies].map(item => item.id);
    } else if (action === "front" || action === "back") {
      const z = action === "front" ? elementZIndex(currentContent.elements) : Math.min(0, ...currentContent.elements.map(element => Number(element.zIndex || 0))) - 10;
      elements.forEach((element, index) => { element.zIndex = z + index; });
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
    }
    commitChange(before, `選択: ${action}`);
  }

  function copySelection() {
    internalClipboard = [...selectedElements(), ...selectedMasks()].map(clone);
  }

  function pasteSelection() {
    if (!internalClipboard.length) return;
    const before = clone(currentContent); const ids = [];
    internalClipboard.forEach(item => {
      const copy = { ...clone(item), id: randomId() };
      if (copy.type) currentContent.elements.push(translateElement(copy, .025, .025, pages[currentPageIndex]?.size));
      else currentContent.noteMasks.push({ ...copy, x: clamp(copy.x + .025, 0, 1 - copy.width), y: clamp(copy.y + .025, 0, 1 - copy.height) });
      ids.push(copy.id);
    });
    selectedIds = ids; commitChange(before, "アプリ内部貼り付け");
  }

  function undo() {
    const restored = history.undo(historySnapshot()); if (!restored) return;
    void applyHistorySnapshot(restored).catch(reportError);
  }

  function redo() {
    const restored = history.redo(historySnapshot()); if (!restored) return;
    void applyHistorySnapshot(restored).catch(reportError);
  }

  function setStudyMode(active) {
    studyMode = active === true;
    if (studyMode) { currentTool = "study"; selectedIds = []; }
    else setTool("pen");
    ui.studyToggle.textContent = studyMode ? "編集へ戻る" : "暗記モード";
    ui.studyControls.classList.toggle("hidden", !studyMode);
    ui.toolbar.classList.toggle("hidden", studyMode);
    ui.settings.classList.add("hidden");
    renderPage();
  }

  async function renameNote(note = currentNote) {
    const session = captureUserSession();
    assertUserSession(session);
    const title = prompt("ノート名", note.title || "無題ノート")?.trim();
    if (!title) return;
    await noteStore.updateNote(note.id, { title }, session.uid); note.title = title;
    assertUserSession(session);
    if (currentNote?.id === note.id) ui.title.value = title;
    await refreshNotes();
  }

  async function deleteNote(note = currentNote) {
    const session = captureUserSession();
    assertUserSession(session);
    if (!confirm(`「${note.title || "無題ノート"}」を削除しますか？データは論理削除され、直ちには物理削除されません。`)) return;
    if (currentNote?.id === note.id && !await flushAllWithDecision("ノート削除")) return;
    assertUserSession(session);
    await noteStore.deleteNote(note.id, session.uid);
    assertUserSession(session);
    if (currentNote?.id === note.id) { currentNote = null; pages = []; currentContent = null; show("list"); }
    await refreshNotes();
  }

  async function duplicateNote(noteId) {
    const session = captureUserSession();
    assertUserSession(session);
    const sourceNote = await noteStore.getNote(noteId, { expectedUid: session.uid });
    assertUserSession(session);
    const sourcePages = await noteStore.listPages(noteId, { expectedUid: session.uid });
    assertUserSession(session);
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
        const saved = await noteStore.savePageContent({ noteId: newId, pageId: newPages[index].pageId, expectedRevision: 0, expectedUid: session.uid }, sourceContent);
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
    const copyPages = items.map((item, index) => {
      const sourcePage = sourcePages.find(page => page.pageId === item.pageId) || blankPage("blank", index + 1);
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
      defaultBackground: sourceNote?.defaultBackground || DEFAULT_BACKGROUND,
      pages: copyPages,
      deferReady: true,
      expectedUid: session.uid
    });
    assertUserSession(session);
    const storagePaths = [];
    try {
      for (let index = 0; index < items.length; index += 1) {
        assertUserSession(session);
        const copyContent = normalizeNoteLineElements(items[index].content, copyPages[index].size);
        copyContent.elements = (copyContent.elements || []).map(element => element.type === "image"
          ? { ...element, assetNoteId: element.assetNoteId || sourceNoteId }
          : element);
        const saved = await noteStore.savePageContent({
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
    return copyId;
  }

  async function restoreOrphanedDrafts(group) {
    if (!group?.items?.length) return;
    if (!confirm(`${group.items.length}ページ分の端末内下書きを、新しいノートとして復元しますか？`)) return;
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
    await openNote(copyId);
  }

  async function resolveConflict(note) {
    const conflict = note.conflicts?.[0];
    if (!conflict) return;
    const useLocal = confirm("ローカル版を競合コピーとして残しますか？\nOK: 競合コピーを作成 / キャンセル: クラウド版を採用");
    const [draft, pending] = await Promise.all([
      localStore.get("pageDrafts", conflict.key),
      localStore.get("pendingSaves", conflict.key)
    ]);
    if (useLocal) {
      await createRecoveredDraftCopy(note.id, [{
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
    await refreshNotes();
  }

  function openExportDialog() {
    if (!currentNote) return;
    generatedPdf = null;
    ui.exportPurpose.value = "ai"; ui.exportQuality.value = "standard"; ui.exportRangeMode.value = "all";
    ui.exportRange.classList.add("hidden");
    ui.exportPageNumbers.checked = currentNote.type === "standalone";
    ui.exportFilename.value = createPdfFilename(currentNote.title, "ai");
    ui.exportProgress.value = 0; ui.exportStatus.textContent = "AI共有用では暗記マスクをPDFへ描画しません。";
    ui.downloadPdf.disabled = true;
    ui.cancelPdf.disabled = false;
    const shareSupported = Boolean(navigator.share && navigator.canShare);
    ui.sharePdf.disabled = true; ui.sharePdf.classList.toggle("hidden", !shareSupported);
    ui.exportDialog.showModal();
  }

  async function openExportFromList(noteId) {
    await openNote(noteId); openExportDialog();
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
        revealedMaskIds,
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
      releaseObjectUrls(); zoomController?.destroy(); zoomController = null;
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

  async function closeEditor() {
    if (currentNote && !await flushAllWithDecision("ノートを閉じる操作")) return;
    currentNote = null; pages = []; currentContent = null; selectedIds = []; history.clear();
    releaseObjectUrls(); releaseThumbnailUrls(); thumbnailTokens.clear(); zoomController?.destroy(); zoomController = null;
    show("list"); await refreshNotes();
  }

  function resetForUserChange() {
    userSessionGeneration += 1;
    createController?.abort(); exportController?.abort(); saveCoordinator.reset();
    pendingAssetRecoveryPromises.clear(); pendingRecoveryPromises.clear(); pendingRecoverySweeps.clear();
    currentNote = null; pages = []; currentContent = null; notes = []; orphanedDrafts = []; contentCache.clear(); assetCache.clear();
    selectedIds = []; history.clear(); releaseObjectUrls(); releaseThumbnailUrls(); thumbnailTokens.clear(); zoomController?.destroy(); zoomController = null;
    ui.list.replaceChildren(); show("list"); setListStatus("ログイン後にノートを読み込みます。");
  }

  function bindEvents() {
    ui.noteModeBtn.addEventListener("click", () => { activateSection("note"); show(currentNote ? "editor" : "list"); void refreshNotes(); });
    ui.newNoteBtn.addEventListener("click", () => { show("create"); ui.materialPicker.classList.add("hidden"); });
    ui.cancelCreate.addEventListener("click", () => show("list"));
    ui.createView.querySelectorAll("[data-create-note]").forEach(button => button.addEventListener("click", () => {
      const type = button.dataset.createNote;
      if (type === "material") renderMaterialPicker();
      else if (type === "pdf") ui.pdfInput.click();
      else createStandalone(type).catch(reportError);
    }));
    ui.pdfInput.addEventListener("change", () => createPdfNote(ui.pdfInput.files?.[0]).catch(reportError));
    ui.cancelCreateProgress.addEventListener("click", () => createController?.abort());
    ui.closeNote.addEventListener("click", () => closeEditor().catch(reportError));
    ui.pagesButton.addEventListener("click", () => {
      const open = ui.pageSidebar.classList.toggle("open");
      ui.pagesButton.setAttribute("aria-expanded", String(open));
      ui.pagesButton.setAttribute("aria-label", open ? "ページ一覧を閉じる" : "ページ一覧を開く");
    });
    ui.title.addEventListener("change", async () => {
      const title = ui.title.value.trim(); if (!title || !currentNote || title === currentNote.title) return;
      const session = captureUserSession(); assertUserSession(session);
      await noteStore.updateNote(currentNote.id, { title }, session.uid); assertUserSession(session); currentNote.title = title;
    });
    ui.undo.addEventListener("click", undo); ui.redo.addEventListener("click", redo);
    ui.retrySave.addEventListener("click", () => {
      ui.retrySave.disabled = true;
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
              ui.saveStatus.textContent = [
                remainingSaves ? `下書き再送待ち ${remainingSaves}件` : "",
                remainingAssets ? `画像再送待ち ${remainingAssets}件` : ""
              ].filter(Boolean).join(" / ");
              throw new Error("未同期データを端末内に保持しています。通信状態を確認して再試行してください。");
            }
          }
          ui.retrySave.classList.add("hidden");
          ui.saveStatus.textContent = "保存済み";
          ui.saveStatus.dataset.state = "saved";
          return refreshNotes();
        })
        .catch(reportError)
        .finally(() => { ui.retrySave.disabled = false; });
    });
    ui.studyToggle.addEventListener("click", () => setStudyMode(!studyMode));
    ui.toolbar.querySelectorAll("[data-note-tool]").forEach(button => button.addEventListener("click", () => setTool(button.dataset.noteTool)));
    ui.styleBtn.addEventListener("click", () => ui.settings.classList.toggle("hidden"));
    ui.backgroundBtn.addEventListener("click", () => changeBackground().catch(reportError));
    ui.color.addEventListener("input", () => { ui.currentColor.style.background = ui.color.value; });
    [ui.color, ui.opacity, ui.fontFamily, ui.fontSize, ui.fontBold, ui.fontItalic, ui.textAlign, ui.lineHeight]
      .forEach(control => control.addEventListener("change", applySelectedTextStyle));
    ui.eraserMode.addEventListener("change", () => { if (currentTool.startsWith("eraser")) setTool("eraser-object"); });
    ui.stage.addEventListener("pointerdown", beginPointer); ui.stage.addEventListener("pointermove", movePointer);
    ui.stage.addEventListener("pointerup", endPointer); ui.stage.addEventListener("pointercancel", endPointer);
    ui.stage.addEventListener("click", event => {
      const action = event.target?.closest?.("[data-crop-action]")?.dataset.cropAction;
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
      if (action === "apply") commitChange(before, "画像トリミング");
      else renderPage();
    });
    ui.viewport.addEventListener("pagezoomstart", () => {
      if (activeGesture?.before) currentContent = clone(activeGesture.before);
      activeGesture = null;
      ui.stage.querySelectorAll("[data-note-draft]").forEach(node => node.remove());
      renderPage();
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
      button.addEventListener("click", () => { try { selectionAction(action); } catch (error) { reportError(error); } });
      ui.selectionActions.insertBefore(button, ui.selectionActions.lastElementChild);
    });
    const weak = document.createElement("button"); weak.type = "button"; weak.textContent = "苦手色"; weak.addEventListener("click", () => selectionAction("weak")); ui.selectionActions.insertBefore(weak, ui.selectionActions.lastElementChild);
    ui.editorView.querySelectorAll("[data-study-action]").forEach(button => button.addEventListener("click", () => {
      const action = button.dataset.studyAction;
      if (action === "previous") switchPage(Math.max(0, currentPageIndex - 1)).catch(reportError);
      if (action === "next") switchPage(Math.min(pages.length - 1, currentPageIndex + 1)).catch(reportError);
      if (action === "hide-all") { revealedMaskIds.clear(); renderPage(); }
      if (action === "show-all") {
        const page = pages[currentPageIndex];
        [...getMaterialPageMasks(currentMaterial(), page.background?.materialPage), ...currentContent.noteMasks].forEach(mask => revealedMaskIds.add(mask.id)); renderPage();
      }
    }));
    ui.editorView.querySelectorAll("[data-note-action]").forEach(button => button.addEventListener("click", () => {
      const action = button.dataset.noteAction;
      if (action === "export") openExportDialog();
      if (action === "rename") renameNote().catch(reportError);
      if (action === "duplicate") duplicateNote(currentNote.id).catch(reportError);
      if (action === "delete") deleteNote().catch(reportError);
    }));
    [ui.photoInput, ui.fileInput].forEach(input => input.addEventListener("change", () => {
      const file = input.files?.[0]; input.value = ""; if (file) addImageBlob(file).catch(reportError);
    }));
    document.addEventListener("paste", event => {
      if (!currentNote || ui.editorView.classList.contains("hidden")) return;
      if (event.target === ui.pasteFallback) ui.pasteFallback.classList.add("hidden");
      else if (isTextEditingTarget(event.target)) return;
      const file = imageFileFromPasteEvent(event);
      if (!file) return;
      event.preventDefault(); addImageBlob(file).catch(reportError);
    });
    document.addEventListener("keydown", event => {
      if (!currentNote || ui.editorView.classList.contains("hidden") || isTextEditingTarget(event.target)) return;
      const command = event.metaKey || event.ctrlKey;
      if (command && event.key.toLowerCase() === "z") { event.preventDefault(); event.shiftKey ? redo() : undo(); }
      else if (command && event.key.toLowerCase() === "c" && selectedIds.length) { event.preventDefault(); copySelection(); }
      else if (command && event.key.toLowerCase() === "v" && internalClipboard.length) { event.preventDefault(); pasteSelection(); }
      else if (["Delete", "Backspace"].includes(event.key) && selectedIds.length) { event.preventDefault(); selectionAction("delete"); }
      else if (event.key === "Escape") { selectedIds = []; ui.pasteFallback.classList.add("hidden"); renderPage(); }
    });
    ui.exportPurpose.addEventListener("change", () => { ui.exportFilename.value = createPdfFilename(currentNote?.title, ui.exportPurpose.value); });
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
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden" && currentNote) void saveCoordinator.flushAll(); });
    window.addEventListener("pagehide", () => { if (currentNote) void saveCoordinator.flushAll(); });
    window.addEventListener("online", () => {
      void recoverAllPendingWork().catch(error => console.warn("オンライン復帰後のノート再送に失敗しました。", error));
    });
  }

  bindEvents();
  show("list");

  return {
    refresh: refreshNotes,
    resetForUserChange,
    flush: () => saveCoordinator.flushAll(),
    openMaterialNote,
    confirmMaterialReplacement,
    finalizeMaterialReplacement,
    confirmMaterialDeletion,
    archiveMaterialLinkedNotes,
    finalizeMaterialDeletion,
    getNotes: () => clone(notes)
  };
}
