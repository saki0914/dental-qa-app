import { convertPdfToImageFiles } from "../core/pdf-converter.js";
import {
  MAX_NOTE_IMAGE_BYTES,
  MAX_NOTE_IMAGE_HEIGHT,
  MAX_NOTE_IMAGE_WIDTH,
  decodeImageDimensions,
  validateImageBlob
} from "../core/file-validator.js";
import {
  boundsIntersect,
  clamp,
  clientPointToNormalized,
  distanceToSegment,
  elementBounds,
  normalizedBoundsFromPoints,
  splitStrokeByEraser,
  translateElement
} from "../core/note-geometry.js";
import { chooseClipboardImage, imageFileFromPasteEvent, isTextEditingTarget, readClipboardImage } from "../core/note-clipboard.js";
import { createNoteHistory } from "../core/note-history.js";
import { createNoteLocalStore, noteLocalKey } from "../core/note-local-store.js";
import { getMaterialPageMasks } from "../core/note-mask-adapter.js";
import {
  getMaterialDefaultNoteId,
  isMaterialArchiving
} from "../core/note-material-mutation.js";
import { createNoteSaveCoordinator } from "../core/note-save-coordinator.js";
import { createPageZoomController } from "../core/page-zoom-controller.js";
import {
  PDF_EXPORT_PRESETS,
  createPdfFilename,
  downloadPdfBlob,
  exportNotePdf,
  parsePdfPageRange,
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
  pageId: crypto.randomUUID(),
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
  pageId: crypto.randomUUID(),
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
    viewport: byId("noteViewport"), stage: byId("notePageStage"), studyControls: byId("noteStudyControls"),
    maskCounts: byId("noteMaskCounts"), selectionActions: byId("noteSelectionActions"),
    toolbar: byId("noteEditorView")?.querySelector(".note-toolbar"), settings: byId("noteToolSettings"),
    color: byId("noteColorInput"), width: byId("noteWidthInput"), opacity: byId("noteOpacityInput"),
    eraserMode: byId("noteEraserMode"), shapeType: byId("noteShapeType"), fingerDraw: byId("noteFingerDraw"),
    lineStyle: byId("noteLineStyle"), fillColor: byId("noteFillColor"), fillOpacity: byId("noteFillOpacity"),
    fontFamily: byId("noteFontFamily"), fontSize: byId("noteFontSize"), fontBold: byId("noteFontBold"),
    fontItalic: byId("noteFontItalic"), textAlign: byId("noteTextAlign"),
    currentColor: byId("noteCurrentColor"), styleBtn: byId("noteStyleBtn"), backgroundBtn: byId("noteBackgroundBtn"),
    photoInput: byId("noteImagePhotoInput"), fileInput: byId("noteImageFileInput"), pasteFallback: byId("notePasteFallback"),
    exportDialog: byId("noteExportDialog"), exportPurpose: byId("noteExportPurpose"), exportRangeMode: byId("noteExportRangeMode"),
    exportRange: byId("noteExportRange"), exportQuality: byId("noteExportQuality"), exportFilename: byId("noteExportFilename"),
    exportPageNumbers: byId("noteExportPageNumbers"), exportProgress: byId("noteExportProgress"), exportStatus: byId("noteExportStatus"),
    createPdf: byId("createNotePdfBtn"), downloadPdf: byId("downloadNotePdfBtn"), sharePdf: byId("shareNotePdfBtn"),
    cancelPdf: byId("cancelNotePdfBtn")
  };
  const localStore = createNoteLocalStore();
  const noteStore = createNoteStore({ getDb, getStorage, getUser: getCurrentUser });
  const history = createNoteHistory({ limit: 100 });

  let notes = [];
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
  let pageBeforeGesture = null;
  const pendingAssetRecoveryPromises = new Map();
  const pendingRecoveryPromises = new Map();
  let pendingRecoverySweep = null;

  const saveCoordinator = createNoteSaveCoordinator({
    localStore,
    debounceMs: 850,
    persist: async (identity, content) => {
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
        expectedRevision
      }, content);
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
      if (status === "conflict") currentNote.hasConflict = true;
      if (detail instanceof Error) console.error(detail);
    }
  });

  function identity(page = pages[currentPageIndex]) {
    return {
      uid: getCurrentUser()?.uid,
      noteId: currentNote?.id,
      pageId: page?.pageId,
      expectedRevision: Number(page?.contentRevision || 0)
    };
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
    if (!getCurrentUser()) return;
    setListStatus("ノートを読み込んでいます...");
    try {
      notes = await noteStore.listNotes();
      const conflicts = await localStore.listForUser("conflicts", getCurrentUser().uid);
      notes.forEach(note => {
        note.conflicts = conflicts.filter(conflict => conflict.noteId === note.id);
        note.hasConflict = note.conflicts.length > 0;
      });
      renderNoteList();
      setListStatus(notes.length ? `${notes.length}件のノートがあります。` : "ノートはまだありません。");
      void recoverAllPendingWork().catch(error => console.warn("未送信ノートの自動再送を継続できませんでした。", error));
    } catch (error) {
      console.error(error);
      setListStatus(`ノートを読み込めませんでした。${error.message || error}`);
    }
  }

  function renderNoteList() {
    ui.list.replaceChildren();
    notes.forEach(note => {
      const card = document.createElement("article");
      card.className = "note-card";
      const preview = document.createElement("div"); preview.className = "note-card-preview"; preview.textContent = noteTypeLabel(note);
      const title = document.createElement("h4"); title.textContent = note.title || "無題ノート";
      const meta = document.createElement("div"); meta.className = "note-card-meta";
      const materialMaskCount = note.type === "material-linked"
        ? getMaterials().find(material => material.id === note.sourceMaterialId)?.masks?.length || 0
        : 0;
      meta.textContent = `${noteTypeLabel(note)} / ${note.pageCount || 0}ページ / ノートマスク ${note.noteMaskCount || 0}件${note.type === "material-linked" ? ` / 教材マスク ${materialMaskCount}件` : ""}${note.hasConflict ? " / 競合あり" : ""}`;
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
    });
  }

  function reportError(error) {
    console.error(error);
    alert(error?.message || error || "処理に失敗しました。");
  }

  async function createStandalone(kind) {
    const title = ui.newTitle.value.trim() || "新しい学習ノート";
    const page = blankPage(kind);
    const noteId = await noteStore.createNote({
      title, type: "standalone", defaultBackground: page.background, pages: [page]
    });
    await refreshNotes();
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
    const material = getMaterials().find(item => item.id === materialId);
    if (!material) throw new Error("教材が見つかりません。");
    if (isMaterialArchiving(material)) {
      throw new Error("教材の差し替え・削除処理中のため、連携ノートを開けません。");
    }
    await refreshNotes();
    const legacyActiveNote = notes.find(item =>
      item.type === "material-linked" && item.sourceMaterialId === materialId && !item.deletedAt
    );
    let defaultNoteId = getMaterialDefaultNoteId(material);
    if (!defaultNoteId) {
      defaultNoteId = ensureMaterialDefaultNoteId
        ? await ensureMaterialDefaultNoteId(materialId, legacyActiveNote?.id)
        : legacyActiveNote?.id || crypto.randomUUID();
    }
    let note = notes.find(item => item.id === defaultNoteId && !item.deletedAt);
    if (!note) {
      const existingDefault = await noteStore.getNote(defaultNoteId);
      if (existingDefault) {
        if (existingDefault.deletedAt) await noteStore.restoreNote(defaultNoteId);
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
          try {
            let blob;
            if (source.imagePath || source.path || source.storagePath) {
              blob = await noteStore.getStorageBlob(source.imagePath || source.path || source.storagePath);
            } else if (source.imageUrl || source.url) {
              const response = await fetch(source.imageUrl || source.url);
              if (response.ok) blob = await response.blob();
            }
            if (blob) ({ naturalWidth: width, naturalHeight: height } = await decodeImageDimensions(blob));
          } catch (error) {
            console.warn("教材画像の寸法を取得できないため既定比率を使用します。", error);
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
        defaultBackground: { ...DEFAULT_BACKGROUND }, pages: notePages
      });
      note = { id: noteId };
      await refreshNotes();
    }
    activateSection("note");
    await openNote(note.id);
  }

  async function createPdfNote(file) {
    if (!file) return;
    const title = ui.newTitle.value.trim() || file.name.replace(/\.pdf$/i, "") || "PDFノート";
    const noteId = crypto.randomUUID();
    const uploaded = [];
    const notePages = [];
    createController = new AbortController();
    ui.createProgress.classList.remove("hidden");
    ui.createProgressBar.value = 0;
    await noteStore.createCreatingNote(noteId, { title, type: "pdf-imported", defaultBackground: { ...DEFAULT_BACKGROUND } });
    try {
      await convertPdfToImageFiles(file, (current, total) => {
        const percent = Math.round(current / total * 100);
        ui.createProgressBar.value = percent;
        ui.createProgressLabel.textContent = `PDFを読み込んでいます ${current} / ${total}ページ（${percent}%）`;
      }, {
        signal: createController.signal,
        onPage: async ({ file: pageFile, pageNumber, width, height }) => {
          const pageId = crypto.randomUUID();
          const imagePath = await noteStore.uploadSourcePage(noteId, pageId, pageFile);
          uploaded.push(imagePath);
          notePages.push({
            pageId, order: pageNumber, pageType: "pdf-source-page", size: { width, height },
            background: { type: "pdf-source-page", imagePath, sourcePageNumber: pageNumber }
          });
        }
      });
      if (!notePages.length) throw new Error("PDFにページがありません。");
      await noteStore.finalizeCreatingNote(noteId, notePages);
      await refreshNotes();
      await openNote(noteId);
    } catch (error) {
      const orphanedPaths = await noteStore.deleteStoragePaths(uploaded);
      await noteStore.markCreationFailed(noteId, orphanedPaths);
      if (error?.name !== "AbortError") throw new Error(`PDFノートは作成されていません。${error.message || error}`);
      setListStatus("PDFノートの作成をキャンセルしました。");
    } finally {
      createController = null;
      ui.createProgress.classList.add("hidden");
      ui.pdfInput.value = "";
    }
  }

  async function pageContent(page) {
    const cached = contentCache.get(page.pageId);
    if (cached) return clone(cached);
    const local = await localStore.get("pageDrafts", noteLocalKey(getCurrentUser().uid, currentNote.id, page.pageId));
    const content = local?.uid === getCurrentUser().uid ? local.content : await noteStore.loadPageContent(currentNote.id, page);
    contentCache.set(page.pageId, clone(content));
    return content;
  }

  async function openNote(noteId, { study = false } = {}) {
    if (currentNote) await saveCoordinator.flush(identity()).catch(() => {});
    currentNote = await noteStore.getNote(noteId);
    if (!currentNote || currentNote.deletedAt) throw new Error("ノートが見つかりません。");
    pages = await noteStore.listPages(noteId);
    if (!pages.length) throw new Error("ノートにページがありません。");
    currentPageIndex = 0;
    ui.pageSidebar.classList.remove("open");
    ui.pagesButton.setAttribute("aria-expanded", "false");
    contentCache = new Map(); assetCache = new Map(); selectedIds = []; revealedMaskIds = new Set();
    await recoverPendingAssets(noteId);
    await recoverPendingSaves(noteId, pages);
    pages = await noteStore.listPages(noteId);
    const localConflicts = await localStore.listForUser("conflicts", getCurrentUser().uid);
    currentNote.hasConflict = localConflicts.some(conflict => conflict.noteId === noteId);
    history.clear();
    ui.title.value = currentNote.title || "無題ノート";
    show("editor");
    await loadCurrentPage();
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
    ui.pageList.replaceChildren();
    pages.forEach((page, index) => {
      const item = document.createElement("li"); item.classList.toggle("active", index === currentPageIndex);
      const open = document.createElement("button"); open.type = "button"; open.className = "note-page-thumbnail";
      open.textContent = `${index + 1}\n${page.pageType === "pdf-source-page" ? "PDF" : page.pageType === "material-page" ? "教材" : page.background?.type === "ruled" ? "罫線" : "白紙"}`;
      open.addEventListener("click", () => switchPage(index).catch(reportError));
      const actions = document.createElement("div"); actions.className = "note-page-row-actions";
      [["↑", "up"], ["↓", "down"], ["複製", "duplicate"], ["削除", "delete"]].forEach(([label, action]) => {
        const button = document.createElement("button"); button.type = "button"; button.textContent = label; button.title = `${index + 1}ページ ${label}`;
        button.addEventListener("click", () => pageAction(action, index).catch(reportError)); actions.append(button);
      });
      item.append(open, actions); ui.pageList.append(item);
    });
    ui.pageCounter.textContent = `${currentPageIndex + 1} / ${pages.length}`;
  }

  async function switchPage(index) {
    if (index < 0 || index >= pages.length || index === currentPageIndex) return;
    await saveCoordinator.flush(identity()).catch(() => {});
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
    if (page.background?.type === "pdf-source-page") return noteStore.getStorageBlob(page.background.imagePath);
    if (page.background?.type === "material-page") {
      const source = materialSourcePage(page);
      if (source?.imagePath || source?.path || source?.storagePath) {
        return noteStore.getStorageBlob(source.imagePath || source.path || source.storagePath);
      }
      if (source?.imageUrl || source?.url) {
        const response = await fetch(source.imageUrl || source.url);
        if (!response.ok) throw new Error("教材背景画像を取得できませんでした。");
        return response.blob();
      }
    }
    throw new Error("背景画像の参照先がありません。");
  }

  async function resolveAssetBlob(assetId, sourceNoteId = currentNote.id) {
    const key = `${sourceNoteId}|${assetId}`;
    if (assetCache.has(key)) return assetCache.get(key);
    const metadata = await noteStore.getAsset(sourceNoteId, assetId);
    if (!metadata?.storagePath) throw new Error(`貼り付け画像 ${assetId} を取得できません。`);
    const blob = await noteStore.getStorageBlob(metadata.storagePath);
    assetCache.set(key, blob);
    return blob;
  }

  async function recoverPendingAssets(noteId) {
    const uid = getCurrentUser()?.uid;
    if (!uid) return;
    if (navigator.onLine === false) return;
    if (pendingAssetRecoveryPromises.has(noteId)) return pendingAssetRecoveryPromises.get(noteId);
    const recovery = (async () => {
      const pending = (await localStore.listForUser("pendingAssets", uid)).filter(item => item.noteId === noteId);
      for (const item of pending) {
        assetCache.set(`${noteId}|${item.assetId}`, item.blob);
        try {
          await noteStore.uploadAsset(noteId, item.blob, { assetId: item.assetId });
          await localStore.deleteIfUnchanged("pendingAssets", item.key, item.updatedAt || item.createdAt);
        } catch (error) {
          console.warn("未送信画像は端末内に保持しています。", error);
        }
      }
    })().finally(() => pendingAssetRecoveryPromises.delete(noteId));
    pendingAssetRecoveryPromises.set(noteId, recovery);
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

  async function persistRecoveredDraft({ noteId, page, draft, pending, key, expectedRevision }) {
    const cloudRevision = Number(page.contentRevision || 0);
    if (cloudRevision !== expectedRevision) {
      throw new NoteConflictError("別の端末でこのページが更新されています。", cloudRevision);
    }
    const saved = await noteStore.savePageContent({
      noteId,
      pageId: page.pageId,
      expectedRevision
    }, draft.content);
    Object.assign(page, {
      contentRevision: saved.revision,
      contentPath: saved.contentPath,
      contentHash: saved.contentHash
    });
    const restored = { ...clone(draft.content), revision: saved.revision };
    if (currentNote?.id === noteId) contentCache.set(page.pageId, restored);
    await Promise.all([
      localStore.deleteIfUnchanged("pageDrafts", key, draft.updatedAt),
      localStore.deleteIfUnchanged("pendingSaves", key, pending.updatedAt)
    ]);
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

  async function recoverPendingSaves(noteId, notePages = pages) {
    const uid = getCurrentUser()?.uid;
    if (!uid) return;
    if (navigator.onLine === false) return;
    if (pendingRecoveryPromises.has(noteId)) return pendingRecoveryPromises.get(noteId);
    const recovery = (async () => {
      const [pendingSaves, pendingAssets, conflicts] = await Promise.all([
        localStore.listForUser("pendingSaves", uid),
        localStore.listForUser("pendingAssets", uid),
        localStore.listForUser("conflicts", uid)
      ]);
      const blockedPages = new Set([
        ...pendingAssets.filter(item => item.noteId === noteId).map(item => item.pageId),
        ...conflicts.filter(item => item.noteId === noteId).map(item => item.pageId)
      ]);
      for (const pending of pendingSaves.filter(item => item.noteId === noteId)) {
        if (blockedPages.has(pending.pageId)) continue;
        const page = notePages.find(item => item.pageId === pending.pageId);
        const key = noteLocalKey(uid, noteId, pending.pageId);
        const draft = await localStore.get("pageDrafts", key);
        if (!page || draft?.uid !== uid || !draft.content) continue;
        try {
          const expectedRevision = getRecoveryExpectedRevision(pending, draft);
          await persistRecoveredDraft({ noteId, page, draft, pending, key, expectedRevision });
        } catch (error) {
          await recordRecoveredDraftFailure({
            error,
            uid,
            noteId,
            pageId: pending.pageId,
            draft,
            key
          });
          console.warn("未送信のページ下書きは端末内に保持しています。", error);
        }
      }
    })().finally(() => pendingRecoveryPromises.delete(noteId));
    pendingRecoveryPromises.set(noteId, recovery);
    return recovery;
  }

  async function recoverAllPendingWork() {
    const uid = getCurrentUser()?.uid;
    if (!uid || navigator.onLine === false) return;
    if (pendingRecoverySweep) return pendingRecoverySweep;
    pendingRecoverySweep = (async () => {
      const [pendingSaves, pendingAssets] = await Promise.all([
        localStore.listForUser("pendingSaves", uid),
        localStore.listForUser("pendingAssets", uid)
      ]);
      const noteIds = [...new Set(
        [...pendingSaves, ...pendingAssets].map(item => item.noteId).filter(Boolean)
      )];
      for (const noteId of noteIds) {
        if (getCurrentUser()?.uid !== uid) return;
        const notePages = await noteStore.listPages(noteId);
        await recoverPendingAssets(noteId);
        await recoverPendingSaves(noteId, notePages);
      }
      if (getCurrentUser()?.uid === uid) {
        const conflicts = await localStore.listForUser("conflicts", uid);
        notes.forEach(note => {
          note.conflicts = conflicts.filter(conflict => conflict.noteId === note.id);
          note.hasConflict = note.conflicts.length > 0;
        });
        renderNoteList();
      }
    })().finally(() => { pendingRecoverySweep = null; });
    return pendingRecoverySweep;
  }

  function createSvgElement(name, attributes = {}) {
    const node = document.createElementNS(svgNamespace, name);
    Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value)));
    return node;
  }

  function pathData(points) {
    return (points || []).map((point, index) => `${index ? "L" : "M"} ${point.x * 1000} ${point.y * 1414}`).join(" ");
  }

  function shapeNode(element, arrowMarkerId = "") {
    const group = createSvgElement("g", {
      transform: `translate(${element.bounds.x * 1000} ${element.bounds.y * 1414}) rotate(${element.rotation || 0} ${element.bounds.width * 500} ${element.bounds.height * 707})`,
      class: "note-element",
      "data-element-id": element.id
    });
    const w = element.bounds.width * 1000;
    const h = element.bounds.height * 1414;
    const style = element.style || {};
    const attrs = {
      fill: Number(style.fillOpacity || 0) > 0 ? style.fillColor || "#111111" : "none",
      "fill-opacity": style.fillOpacity || 0,
      stroke: style.strokeColor || "#111111",
      "stroke-opacity": style.strokeOpacity ?? 1,
      "stroke-width": Math.max(1, Number(style.strokeWidthRatio || 0.002) * 1000),
      "stroke-dasharray": style.lineStyle === "dashed" ? "14 9" : style.lineStyle === "dotted" ? "2 8" : ""
    };
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
    } else if (["line", "arrow"].includes(element.shapeType)) {
      shape = createSvgElement("line", { x1: 0, y1: h, x2: w, y2: 0, ...attrs, fill: "none" });
      if (element.shapeType === "arrow" && arrowMarkerId) shape.setAttribute("marker-end", `url(#${arrowMarkerId})`);
    } else shape = createSvgElement("rect", { x: 0, y: 0, width: w, height: h, rx: element.shapeType === "rounded-rectangle" ? Math.min(w, h) * .12 : 0, ...attrs });
    group.append(shape);
    return group;
  }

  function textNode(element) {
    const style = element.style || {};
    const node = createSvgElement("text", {
      x: element.bounds.x * 1000,
      y: element.bounds.y * 1414,
      fill: style.color || "#111111",
      opacity: style.opacity ?? 1,
      "font-size": Number(style.fontSizeRatio || .025) * 1414,
      "font-family": style.fontFamily === "system-serif" ? "serif" : style.fontFamily === "monospace" ? "monospace" : "sans-serif",
      "font-weight": style.fontWeight || "normal",
      "font-style": style.fontStyle || "normal",
      class: "note-element",
      "data-element-id": element.id,
      transform: `rotate(${element.rotation || 0} ${(element.bounds.x + element.bounds.width / 2) * 1000} ${(element.bounds.y + element.bounds.height / 2) * 1414})`
    });
    String(element.text || "").split("\n").forEach((line, index) => {
      const span = createSvgElement("tspan", { x: element.bounds.x * 1000, dy: index ? "1.25em" : "1em" });
      span.textContent = line || " "; node.append(span);
    });
    return node;
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
        svg.append(createSvgElement("path", {
          d: pathData(element.points), fill: "none", stroke: element.style?.color || "#111111",
          "stroke-width": Math.max(1, Number(element.style?.widthRatio || .0025) * 1000),
          "stroke-opacity": element.style?.opacity ?? (element.type === "highlighter" ? .3 : 1),
          "stroke-linecap": "round", "stroke-linejoin": "round",
          class: `note-element ${selectedIds.includes(element.id) ? "note-selected" : ""}`,
          "data-element-id": element.id
        }));
      } else if (element.type === "shape") {
        const markerId = `noteArrowHead-${String(element.id).replace(/[^a-zA-Z0-9_-]/g, "")}`;
        if (element.shapeType === "arrow") {
          const defs = createSvgElement("defs");
          const marker = createSvgElement("marker", { id: markerId, markerWidth: 10, markerHeight: 10, refX: 8, refY: 3, orient: "auto", markerUnits: "strokeWidth" });
          marker.append(createSvgElement("path", { d: "M0,0 L0,6 L9,3 z", fill: "context-stroke" })); defs.append(marker); svg.append(defs);
        }
        const node = shapeNode(element, markerId); if (selectedIds.includes(element.id)) node.classList.add("note-selected"); svg.append(node);
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
    ui.selectionActions.classList.toggle("hidden", selectedIds.length === 0 || studyMode);
    ui.undo.disabled = !history.canUndo(); ui.redo.disabled = !history.canRedo();
    ui.pageCounter.textContent = `${currentPageIndex + 1} / ${pages.length}`;
    ui.maskCounts.textContent = `教材 ${materialMasks.length} / ノート ${currentContent.noteMasks.length}`;
    if (!zoomController) zoomController = createPageZoomController({ viewport: ui.viewport, content: ui.stage });
  }

  function commitChange(before, label) {
    const after = clone(currentContent);
    if (!history.push(historySnapshot(before), historySnapshot(after), label)) return;
    contentCache.set(pages[currentPageIndex].pageId, clone(after));
    void saveCoordinator.schedule(identity(), after).catch(reportError);
    renderPage();
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
      }));
    });
    const defaultChanged = JSON.stringify(currentNote.defaultBackground) !== JSON.stringify(snapshot.defaultBackground);
    currentNote.defaultBackground = clone(snapshot.defaultBackground);
    if (defaultChanged) metadataUpdates.push(noteStore.updateNote(currentNote.id, {
      defaultBackground: currentNote.defaultBackground
    }));
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

  function objectEraserHit(element, point, radius) {
    if (["stroke", "highlighter"].includes(element.type)) {
      const points = element.points || [];
      if (points.length === 1) return Math.hypot(points[0].x - point.x, points[0].y - point.y) <= radius;
      return points.slice(1).some((end, index) => distanceToSegment(point, points[index], end) <= radius);
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
    if (event.pointerType === "pen") {
      hasSeenPen = true;
      ui.fingerDraw.checked = false;
    }
    const point = gesturePoint(event);
    lastTap = point;
    const elementId = targetElementId(event);
    const maskId = targetMaskId(event);

    if (studyMode) {
      if (maskId) {
        revealedMaskIds.has(maskId) ? revealedMaskIds.delete(maskId) : revealedMaskIds.add(maskId);
        renderPage();
      }
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
      pageBeforeGesture = clone(currentContent);
      activeGesture = { type: "eraser-object", pointerId: event.pointerId, changed: false };
      eraseObjectsAt(point, activeGesture);
    } else if (currentTool === "select" && elementId) {
      const target = currentContent.elements.find(element => element.id === elementId);
      if (target?.locked) return;
      if (!event.shiftKey && !selectedIds.includes(elementId)) selectedIds = [elementId];
      else if (event.shiftKey && !selectedIds.includes(elementId)) selectedIds.push(elementId);
      pageBeforeGesture = clone(currentContent);
      activeGesture = { type: "move-elements", pointerId: event.pointerId, start: point, original: clone(currentContent.elements) };
      renderPage();
    } else if (currentTool === "mask" && maskId) {
      const mask = currentContent.noteMasks.find(item => item.id === maskId);
      if (!mask) return;
      selectedIds = [maskId]; pageBeforeGesture = clone(currentContent);
      activeGesture = { type: "move-mask", pointerId: event.pointerId, start: point, original: clone(mask) };
      renderPage();
    } else {
      pageBeforeGesture = clone(currentContent);
      activeGesture = { type: currentTool === "select" ? "lasso" : currentTool, pointerId: event.pointerId, start: point, points: [{ ...point, pressure: Number(event.pressure || .5) }], end: point };
      if (currentTool === "eraser-pixel") activeGesture.radius = Number(ui.width.value) / 1000 * 2.5;
      if (["select", "text"].includes(currentTool)) drawSelectionRect(point, point);
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
    if (["pen", "highlighter", "eraser-pixel"].includes(activeGesture.type)) {
      const coalesced = event.getCoalescedEvents?.();
      const events = coalesced?.length ? coalesced : [event];
      events.forEach(item => activeGesture.points.push({ ...gesturePoint(item), pressure: Number(item.pressure || .5) }));
      drawDraftPath(activeGesture.points, activeGesture.type);
    } else if (activeGesture.type === "eraser-object") {
      eraseObjectsAt(point, activeGesture);
    } else if (activeGesture.type === "move-elements") {
      const dx = point.x - activeGesture.start.x;
      const dy = point.y - activeGesture.start.y;
      currentContent.elements = activeGesture.original.map(element => selectedIds.includes(element.id) ? translateElement(element, dx, dy) : element);
      renderPage();
    } else if (activeGesture.type === "move-mask") {
      const dx = point.x - activeGesture.start.x;
      const dy = point.y - activeGesture.start.y;
      const mask = currentContent.noteMasks.find(item => item.id === activeGesture.original.id);
      mask.x = clamp(activeGesture.original.x + dx, 0, 1 - mask.width);
      mask.y = clamp(activeGesture.original.y + dy, 0, 1 - mask.height);
      renderPage();
    } else if (["lasso", "text"].includes(activeGesture.type)) {
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
    if (gesture.type === "pan") return;
    if (gesture.type === "eraser-object") {
      if (gesture.changed) commitChange(pageBeforeGesture, "オブジェクト消去");
      return;
    }
    if (gesture.type === "move-elements" || gesture.type === "move-mask") {
      commitChange(pageBeforeGesture, gesture.type === "move-mask" ? "マスク移動" : "オブジェクト移動");
      return;
    }
    const end = gesture.end || gesture.start;
    if (["pen", "highlighter"].includes(gesture.type) && gesture.points.length > 1) {
      const isHighlighter = gesture.type === "highlighter";
      const averagePressure = gesture.points.reduce((sum, point) => sum + Number(point.pressure || .5), 0) / gesture.points.length;
      currentContent.elements.push({
        id: crypto.randomUUID(), type: isHighlighter ? "highlighter" : "stroke", points: gesture.points,
        style: {
          color: ui.color.value,
          widthRatio: Number(ui.width.value) / 10000 * (isHighlighter ? 10 : Math.max(.5, .5 + averagePressure)),
          opacity: isHighlighter ? Math.min(.35, Number(ui.opacity.value) / 100) : Number(ui.opacity.value) / 100
        },
        zIndex: elementZIndex(currentContent.elements), createdAt: new Date().toISOString()
      });
      commitChange(pageBeforeGesture, isHighlighter ? "ハイライト追加" : "ペン追加");
    } else if (gesture.type === "eraser-pixel") {
      currentContent.elements = currentContent.elements.flatMap(element => {
        if (!["stroke", "highlighter"].includes(element.type)) return [element];
        return splitStrokeByEraser(element, gesture.points, gesture.radius);
      });
      commitChange(pageBeforeGesture, "ピクセル消去");
    } else if (gesture.type === "text") {
      const bounds = normalizedBoundsFromPoints(gesture.start, end, .01);
      const dragged = Math.abs(end.x - gesture.start.x) > .01 || Math.abs(end.y - gesture.start.y) > .01;
      openTextEditor(gesture.start, "", dragged ? bounds : null);
    } else if (gesture.type === "shape") {
      const bounds = normalizedBoundsFromPoints(gesture.start, end, .01);
      currentContent.elements.push({
        id: crypto.randomUUID(), type: "shape", shapeType: ui.shapeType.value, bounds, rotation: 0,
        style: { strokeColor: ui.color.value, strokeWidthRatio: Number(ui.width.value) / 10000, strokeOpacity: Number(ui.opacity.value) / 100, fillColor: ui.fillColor.value, fillOpacity: Number(ui.fillOpacity.value) / 100, lineStyle: ui.lineStyle.value },
        zIndex: elementZIndex(currentContent.elements)
      });
      commitChange(pageBeforeGesture, "図形追加");
    } else if (gesture.type === "mask") {
      const bounds = normalizedBoundsFromPoints(gesture.start, end, .01);
      const mask = { id: crypto.randomUUID(), ...bounds, weak: false };
      currentContent.noteMasks.push(mask); selectedIds = [mask.id];
      commitChange(pageBeforeGesture, "暗記マスク追加");
    } else if (gesture.type === "lasso") {
      const bounds = normalizedBoundsFromPoints(gesture.start, end);
      selectedIds = currentContent.elements.filter(element => boundsIntersect(bounds, elementBounds(element))).map(element => element.id);
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
        id: crypto.randomUUID(), type: "text", bounds, rotation: 0, text: value,
        style: { fontFamily: ui.fontFamily.value, fontSizeRatio: Number(ui.fontSize.value) / 1000, fontWeight: ui.fontBold.checked ? "bold" : "normal", fontStyle: ui.fontItalic.checked ? "italic" : "normal", textAlign: ui.textAlign.value, color: ui.color.value, opacity: Number(ui.opacity.value) / 100 },
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
    const initialContext = {
      uid: getCurrentUser().uid,
      noteId: currentNote.id,
      page: pages[currentPageIndex],
      content: currentContent,
      tap: lastTap ? { ...lastTap } : null
    };
    const prepared = await prepareImage(inputBlob);
    if (
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
    const assetId = crypto.randomUUID();
    const pendingKey = noteLocalKey(target.uid, target.noteId, target.pageId, assetId);
    const pendingAssetCreatedAt = new Date().toISOString();
    await localStore.put("pendingAssets", { key: pendingKey, uid: target.uid, noteId: target.noteId, pageId: target.pageId, assetId, blob: prepared.blob, createdAt: pendingAssetCreatedAt, updatedAt: pendingAssetCreatedAt });
    assetCache.set(`${target.noteId}|${assetId}`, prepared.blob);
    const aspect = prepared.width / prepared.height;
    let width = Math.min(.7, .7 * Math.min(1, aspect));
    let height = width / aspect * ((target.page.size?.width || 1) / (target.page.size?.height || 1));
    if (height > .7) { height = .7; width = height * aspect * ((target.page.size?.height || 1) / (target.page.size?.width || 1)); }
    const center = target.tap || { x: .5, y: .5 };
    const offset = (pasteOffset++ % 5) * .02;
    const bounds = { x: clamp(center.x - width / 2 + offset, 0, 1 - width), y: clamp(center.y - height / 2 + offset, 0, 1 - height), width, height };
    const before = clone(target.content);
    const element = { id: crypto.randomUUID(), type: "image", assetId, bounds, crop: { x: 0, y: 0, width: 1, height: 1 }, rotation: 0, opacity: 1, locked: false, aspectLocked: true, zIndex: elementZIndex(target.content.elements) };
    target.content.elements.push(element); selectedIds = [element.id];
    history.push(historySnapshot(before), historySnapshot(target.content), "画像貼り付け");
    contentCache.set(target.pageId, clone(target.content));
    const draftKey = noteLocalKey(target.uid, target.noteId, target.pageId);
    await Promise.all([
      localStore.put("pageDrafts", { key: draftKey, uid: target.uid, noteId: target.noteId, pageId: target.pageId, expectedRevision: target.expectedRevision, content: clone(target.content), updatedAt: new Date().toISOString() }),
      localStore.put("pendingSaves", { key: draftKey, uid: target.uid, noteId: target.noteId, pageId: target.pageId, expectedRevision: target.expectedRevision, updatedAt: new Date().toISOString() })
    ]);
    if (currentNote?.id === target.noteId && pages[currentPageIndex]?.pageId === target.pageId) {
      ui.saveStatus.textContent = "端末内へ保存済み"; ui.saveStatus.dataset.state = "local-saved";
      setTool("select"); renderPage();
    }
    try {
      await noteStore.uploadAsset(target.noteId, prepared.blob, { assetId });
      await localStore.delete("pendingAssets", pendingKey);
      await saveCoordinator.schedule({
        uid: target.uid,
        noteId: target.noteId,
        pageId: target.pageId,
        expectedRevision: target.expectedRevision
      }, target.content);
    } catch (error) {
      if (currentNote?.id === target.noteId) {
        ui.saveStatus.textContent = "保存エラー（画像は端末内に保持）";
        ui.saveStatus.dataset.state = "error";
      }
      throw error;
    }
  }

  async function pageAction(action, index) {
    if (!currentNote) return;
    if (action === "up" || action === "down") {
      const target = action === "up" ? index - 1 : index + 1;
      if (target < 0 || target >= pages.length) return;
      await saveCoordinator.flush(identity()).catch(() => {});
      const previousPages = [...pages];
      const currentPageId = pages[currentPageIndex]?.pageId;
      [pages[index], pages[target]] = [pages[target], pages[index]];
      try {
        currentNote.orderRevision = await noteStore.updatePageOrder(currentNote.id, pages, Number(currentNote.orderRevision || 0));
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
      const duplicate = { ...clone(sourcePage), pageId: crypto.randomUUID(), order: pages.length + 1, contentRevision: 0, contentPath: "", contentHash: "" };
      currentNote.orderRevision = await noteStore.createPage(currentNote.id, duplicate, pages.length + 1, currentNote.orderRevision);
      pages.push(duplicate);
      const duplicatedContent = { ...clone(sourceContent), noteId: currentNote.id, pageId: duplicate.pageId, revision: 0, elements: sourceContent.elements.map(element => ({ ...element, id: crypto.randomUUID(), assetNoteId: element.type === "image" ? (element.assetNoteId || currentNote.id) : element.assetNoteId })), noteMasks: sourceContent.noteMasks.map(mask => ({ ...mask, id: crypto.randomUUID() })) };
      const saved = await noteStore.savePageContent({ noteId: currentNote.id, pageId: duplicate.pageId, expectedRevision: 0 }, duplicatedContent);
      Object.assign(duplicate, { contentRevision: saved.revision, contentPath: saved.contentPath, contentHash: saved.contentHash });
      contentCache.set(duplicate.pageId, { ...duplicatedContent, revision: saved.revision });
      currentNote.pageCount = pages.length;
      renderPageList(); return;
    }
    if (action === "delete") {
      if (pages.length <= 1) throw new Error("ノートには1ページ以上必要です。");
      if (!confirm(`${index + 1}ページを削除しますか？ページ内容は論理削除されます。`)) return;
      const page = pages[index];
      await saveCoordinator.flush(identity(page)).catch(() => {});
      const remainingPages = pages.filter((_, pageIndex) => pageIndex !== index);
      currentNote.orderRevision = await noteStore.deletePage(
        currentNote.id,
        page.pageId,
        remainingPages,
        currentNote.orderRevision
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
    await saveCoordinator.flush(identity()).catch(() => {});
    const page = kind === "default"
      ? pageFromBackground(currentNote.defaultBackground || DEFAULT_BACKGROUND, pages.length + 1)
      : blankPage(kind, pages.length + 1);
    currentNote.orderRevision = await noteStore.createPage(currentNote.id, page, pages.length + 1, currentNote.orderRevision);
    pages.push(page); currentNote.pageCount = pages.length; currentPageIndex = pages.length - 1;
    currentContent = emptyContent(currentNote.id, page.pageId); contentCache.set(page.pageId, clone(currentContent));
    history.clear(); renderPageList(); renderPage();
    ui.pageSidebar.classList.remove("open");
    ui.pagesButton.setAttribute("aria-expanded", "false");
  }

  async function changeBackground() {
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
      ...targets.map(target => noteStore.updatePage(currentNote.id, target.pageId, { background: target.background })),
      ...(scope !== "current" ? [noteStore.updateNote(currentNote.id, { defaultBackground: currentNote.defaultBackground })] : [])
    ]);
    history.push(before, historySnapshot(), "背景変更");
    renderPageList();
    renderPage();
  }

  function selectedElements() { return currentContent.elements.filter(element => selectedIds.includes(element.id)); }
  function selectedMasks() { return currentContent.noteMasks.filter(mask => selectedIds.includes(mask.id)); }
  let internalClipboard = [];

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
      const copies = elements.map(element => ({ ...translateElement(clone(element), .02, .02), id: crypto.randomUUID() }));
      const maskCopies = masks.map(mask => ({ ...mask, id: crypto.randomUUID(), x: clamp(mask.x + .02, 0, 1 - mask.width), y: clamp(mask.y + .02, 0, 1 - mask.height) }));
      currentContent.elements.push(...copies); currentContent.noteMasks.push(...maskCopies); selectedIds = [...copies, ...maskCopies].map(item => item.id);
    } else if (action === "front" || action === "back") {
      const z = action === "front" ? elementZIndex(currentContent.elements) : Math.min(0, ...currentContent.elements.map(element => Number(element.zIndex || 0))) - 10;
      elements.forEach((element, index) => { element.zIndex = z + index; });
    } else if (action === "rotate-left" || action === "rotate-right") {
      elements.filter(element => ["image", "shape", "text"].includes(element.type)).forEach(element => { element.rotation = Number(element.rotation || 0) + (action === "rotate-left" ? -90 : 90); });
    } else if (action === "rotate") {
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
      const raw = prompt("トリミング範囲 x,y,幅,高さ を0〜100で入力（例: 10,10,80,80）。resetで解除", "0,0,100,100");
      if (!raw) return;
      if (raw.toLowerCase() === "reset") image.crop = { x: 0, y: 0, width: 1, height: 1 };
      else {
        const values = raw.split(",").map(value => Number(value.trim()) / 100);
        if (values.length !== 4 || values.some(value => !Number.isFinite(value)) || values[0] < 0 || values[1] < 0 || values[2] <= 0 || values[3] <= 0 || values[0] + values[2] > 1 || values[1] + values[3] > 1) throw new Error("トリミング範囲が正しくありません。");
        image.crop = { x: values[0], y: values[1], width: values[2], height: values[3] };
      }
    } else if (action === "resize") {
      const raw = prompt("選択オブジェクトの幅,高さをページ比率（%）で入力", "40,20");
      if (!raw) return;
      const [width, height] = raw.split(",").map(value => Number(value.trim()) / 100);
      if (!(width > 0 && height > 0 && width <= 1 && height <= 1)) throw new Error("サイズが正しくありません。");
      elements.filter(element => element.bounds && !element.locked).forEach(element => {
        const nextWidth = Math.min(width, 1 - element.bounds.x);
        const nextHeight = element.type === "image" && element.aspectLocked !== false
          ? Math.min(nextWidth * element.bounds.height / element.bounds.width, 1 - element.bounds.y)
          : Math.min(height, 1 - element.bounds.y);
        element.bounds.width = nextWidth; element.bounds.height = nextHeight;
      });
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
      const copy = { ...clone(item), id: crypto.randomUUID() };
      if (copy.type) currentContent.elements.push(translateElement(copy, .025, .025));
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
    const title = prompt("ノート名", note.title || "無題ノート")?.trim();
    if (!title) return;
    await noteStore.updateNote(note.id, { title }); note.title = title;
    if (currentNote?.id === note.id) ui.title.value = title;
    await refreshNotes();
  }

  async function deleteNote(note = currentNote) {
    if (!confirm(`「${note.title || "無題ノート"}」を削除しますか？データは論理削除され、直ちには物理削除されません。`)) return;
    if (currentNote?.id === note.id) await saveCoordinator.flush(identity()).catch(() => {});
    await noteStore.deleteNote(note.id);
    if (currentNote?.id === note.id) { currentNote = null; pages = []; currentContent = null; show("list"); }
    await refreshNotes();
  }

  async function duplicateNote(noteId) {
    const sourceNote = await noteStore.getNote(noteId);
    const sourcePages = await noteStore.listPages(noteId);
    const newPages = sourcePages.map((page, index) => ({ ...clone(page), pageId: crypto.randomUUID(), order: index + 1, contentRevision: 0, contentPath: "", contentHash: "" }));
    const newId = await noteStore.createNote({
      title: `${sourceNote.title || "無題ノート"} のコピー`, type: sourceNote.type,
      sourceMaterialId: sourceNote.sourceMaterialId || null, defaultBackground: sourceNote.defaultBackground || DEFAULT_BACKGROUND,
      pages: newPages
    });
    for (let index = 0; index < sourcePages.length; index += 1) {
      const sourceContent = currentNote?.id === noteId && pages[currentPageIndex]?.pageId === sourcePages[index].pageId ? clone(currentContent) : await noteStore.loadPageContent(noteId, sourcePages[index]);
      sourceContent.elements = sourceContent.elements.map(element => ({ ...element, id: crypto.randomUUID(), assetNoteId: element.type === "image" ? (element.assetNoteId || noteId) : element.assetNoteId }));
      sourceContent.noteMasks = sourceContent.noteMasks.map(mask => ({ ...mask, id: crypto.randomUUID() }));
      await noteStore.savePageContent({ noteId: newId, pageId: newPages[index].pageId, expectedRevision: 0 }, sourceContent);
    }
    await refreshNotes();
    return newId;
  }

  async function resolveConflict(note) {
    const conflict = note.conflicts?.[0];
    if (!conflict) return;
    const useLocal = confirm("ローカル版を競合コピーとして残しますか？\nOK: 競合コピーを作成 / キャンセル: クラウド版を採用");
    if (useLocal) {
      const sourcePages = await noteStore.listPages(note.id);
      const sourcePage = sourcePages.find(page => page.pageId === conflict.pageId) || sourcePages[0] || blankPage("blank");
      const copyPage = { ...clone(sourcePage), pageId: crypto.randomUUID(), order: 1, contentRevision: 0, contentPath: "", contentHash: "" };
      const copyId = await noteStore.createNote({ title: `${note.title || "無題ノート"}（競合コピー）`, type: "standalone", defaultBackground: note.defaultBackground || DEFAULT_BACKGROUND, pages: [copyPage] });
      const copyContent = clone(conflict.content);
      copyContent.elements = copyContent.elements.map(element => element.type === "image" ? { ...element, assetNoteId: element.assetNoteId || note.id } : element);
      await noteStore.savePageContent({ noteId: copyId, pageId: copyPage.pageId, expectedRevision: 0 }, copyContent);
    }
    saveCoordinator.discard({
      uid: conflict.uid,
      noteId: conflict.noteId,
      pageId: conflict.pageId
    });
    contentCache.delete(conflict.pageId);
    await Promise.all([
      localStore.delete("conflicts", conflict.key),
      localStore.delete("pageDrafts", conflict.key),
      localStore.delete("pendingSaves", conflict.key)
    ]);
    await refreshNotes();
  }

  function openExportDialog() {
    if (!currentNote) return;
    generatedPdf = null;
    ui.exportPurpose.value = "ai"; ui.exportQuality.value = "standard"; ui.exportRangeMode.value = "all";
    ui.exportRange.classList.add("hidden"); ui.exportPageNumbers.checked = true;
    ui.exportFilename.value = createPdfFilename(currentNote.title, "ai");
    ui.exportProgress.value = 0; ui.exportStatus.textContent = "AI共有用では暗記マスクをPDFへ描画しません。";
    ui.downloadPdf.disabled = true;
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
        }
      });
      generatedPdf.filename = ui.exportFilename.value.trim() || generatedPdf.filename;
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
      exportController = null; ui.createPdf.disabled = false;
    }
  }

  async function confirmMaterialReplacement(material, nextPageCount) {
    const linked = await noteStore.listNotesByMaterial(material.id, { includeDeleted: true });
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
    const materialIds = materials.map(material => material.id);
    const linkedGroups = await Promise.all(materialIds.map(materialId =>
      noteStore.listNotesByMaterial(materialId, { includeDeleted: true })
    ));
    const linked = [...new Map(linkedGroups.flat().map(note => [note.id, note])).values()];
    if (!linked.length) return { allowed: true, materialIds, linkedNoteCount: 0 };
    const allowed = confirm(`選択した教材には${linked.length}件の連携ノートがあります。\n教材を削除すると背景画像を利用できなくなります。\n\n教材と連携ノートを削除しますか？`);
    return { allowed, materialIds, linkedNoteCount: linked.length };
  }

  async function archiveMaterialLinkedNotes(decision, operation) {
    if (!decision?.materialIds?.length) return { deletedCount: 0, batchCount: 0, noteIds: [] };
    const currentMaterialRefs = Array.isArray(currentNote?.materialRefs)
      ? currentNote.materialRefs
      : currentNote?.sourceMaterialId ? [currentNote.sourceMaterialId] : [];
    if (currentMaterialRefs.some(materialId => decision.materialIds.includes(materialId))) {
      await saveCoordinator.flush(identity()).catch(() => {});
    }
    const closeCurrentIfDeleted = noteIds => {
      if (!noteIds?.includes(currentNote?.id)) return;
      currentNote = null; pages = []; currentContent = null; selectedIds = []; history.clear();
      releaseObjectUrls(); zoomController?.destroy(); zoomController = null;
      show("list");
    };
    try {
      const result = await noteStore.deleteMaterialLinkedNotes(decision.materialIds, operation);
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
    if (currentNote) await saveCoordinator.flush(identity()).catch(() => {});
    currentNote = null; pages = []; currentContent = null; selectedIds = []; history.clear();
    releaseObjectUrls(); zoomController?.destroy(); zoomController = null;
    show("list"); await refreshNotes();
  }

  function resetForUserChange() {
    createController?.abort(); exportController?.abort(); saveCoordinator.reset();
    currentNote = null; pages = []; currentContent = null; notes = []; contentCache.clear(); assetCache.clear();
    selectedIds = []; history.clear(); releaseObjectUrls(); zoomController?.destroy(); zoomController = null;
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
      await noteStore.updateNote(currentNote.id, { title }); currentNote.title = title;
    });
    ui.undo.addEventListener("click", undo); ui.redo.addEventListener("click", redo);
    ui.studyToggle.addEventListener("click", () => setStudyMode(!studyMode));
    ui.toolbar.querySelectorAll("[data-note-tool]").forEach(button => button.addEventListener("click", () => setTool(button.dataset.noteTool)));
    ui.styleBtn.addEventListener("click", () => ui.settings.classList.toggle("hidden"));
    ui.backgroundBtn.addEventListener("click", () => changeBackground().catch(reportError));
    ui.color.addEventListener("input", () => { ui.currentColor.style.background = ui.color.value; });
    ui.eraserMode.addEventListener("change", () => { if (currentTool.startsWith("eraser")) setTool("eraser-object"); });
    ui.stage.addEventListener("pointerdown", beginPointer); ui.stage.addEventListener("pointermove", movePointer);
    ui.stage.addEventListener("pointerup", endPointer); ui.stage.addEventListener("pointercancel", endPointer);
    ui.viewport.addEventListener("pagezoomstart", () => {
      activeGesture = null;
      ui.stage.querySelectorAll("[data-note-draft]").forEach(node => node.remove());
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
    ui.downloadPdf.addEventListener("click", () => { if (generatedPdf) downloadPdfBlob(generatedPdf.blob, generatedPdf.filename); });
    ui.sharePdf.addEventListener("click", () => { if (generatedPdf) sharePdfBlob(generatedPdf.blob, generatedPdf.filename, currentNote.title).catch(reportError); });
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
