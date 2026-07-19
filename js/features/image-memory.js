import {
  ref as storageRef,
  uploadBytes,
  getDownloadURL,
  deleteObject
} from "https://www.gstatic.com/firebasejs/11.7.3/firebase-storage.js";
import {
  escapeHtml,
  normalizePdfTags,
  textToTagList
} from "../core/text-utils.js";
import {
  classifyStorageError,
  getPdfImageLoadFailureMessage
} from "../core/storage-errors.js";
import {
  filterImageMemoryMaterials,
  getImageMemoryCategories,
  getImageMemorySubjects,
  normalizeImageMaterial,
  normalizeImageMemoryFilter
} from "../core/image-memory-filters.js";

export function createImageMemory(dependencies) {
  const {
    el,
    getCurrentUser,
    getStorage,
    getQuestionSubjects = () => [],
    requestAutoSave,
    requestSave
  } = dependencies;

  let pdfMaterials = [];
  let selectedPdfId = null;
  let editingPdfId = null;
  let pdfDeleteSelectedIds = [];
  let pdfSearchQuery = "";
  let pdfSubjectFilter = "all";
  let pdfCategoryFilter = "";
  let pdfViewMode = "study";
  let pdfViewerFullscreen = false;
  let selectedMaskId = null;
  let selectedMaskIds = [];
  let pdfRevealStates = {};
  let pdfAddMaskMode = false;
  let pdfDraft = null;
  let pdfRenderToken = 0;
  let pdfZoom = 1;
  let pdfPinchStartDistance = null;
  let pdfPinchStartZoom = 1;
  let pdfZoomEventsAttached = false;
  let pdfGestureStartZoom = 1;
  let pdfPinchAnchor = null;
  let pdfGestureAnchor = null;

function currentPdfMaterial() {
  return pdfMaterials.find(pdf => pdf.id === selectedPdfId) || null;
}

function currentEditingPdfMaterial() {
  return pdfMaterials.find(pdf => pdf.id === editingPdfId) || null;
}

function currentPdfMask() {
  const pdf = currentPdfMaterial();
  if (!pdf) return null;
  return (pdf.masks || []).find(mask => mask.id === selectedMaskId) || null;
}

function setPdfStatus(message) {
  if (el.pdfStatus) el.pdfStatus.textContent = message;
}

function setPdfEditStatus(message) {
  if (el.pdfEditStatus) el.pdfEditStatus.textContent = message;
}

function getPdfRevealMap(pdfId) {
  if (!pdfRevealStates[pdfId]) pdfRevealStates[pdfId] = {};
  return pdfRevealStates[pdfId];
}

function formatPercent(value) {
  const number = Number(value || 0);
  return Number.isInteger(number) ? String(number) : number.toFixed(1);
}

function readPdfMaskForm() {
  const page = Number(el.maskPageInput.value);
  const x = Number(el.maskXInput.value);
  const y = Number(el.maskYInput.value);
  const width = Number(el.maskWInput.value);
  const height = Number(el.maskHInput.value);

  if (!Number.isFinite(page) || page < 1) {
    alert("ページ番号を1以上で入力してください。");
    return null;
  }
  if (![x, y, width, height].every(Number.isFinite)) {
    alert("x・y・幅・高さを入力してください。");
    return null;
  }
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 100 || y + height > 100) {
    alert("隠し範囲はPDFページ内に収まるようにしてください。");
    return null;
  }
  return { page: Math.round(page), x, y, width, height };
}

function fillPdfMaskForm(mask) {
  if (!mask) {
    el.maskPageInput.value = "";
    el.maskXInput.value = "";
    el.maskYInput.value = "";
    el.maskWInput.value = "";
    el.maskHInput.value = "";
    return;
  }
  el.maskPageInput.value = mask.page;
  el.maskXInput.value = formatPercent(mask.x);
  el.maskYInput.value = formatPercent(mask.y);
  el.maskWInput.value = formatPercent(mask.width);
  el.maskHInput.value = formatPercent(mask.height);
}


function pdfCategoriesToText(categories) {
  return normalizePdfTags(categories).join(",");
}

function fillPdfEditorForm(pdf) {
  if (el.pdfTitleInput) el.pdfTitleInput.value = pdf?.title || "";
  if (el.pdfSubjectInput) el.pdfSubjectInput.value = pdf?.subject || "";
  if (el.pdfCategoryInput) {
    el.pdfCategoryInput.value = pdfCategoriesToText(pdf?.categories || pdf?.tags || []);
  }
  renderPdfEditorOptions();
}

function renderPdfEditorOptions() {
  const subjects = [...new Set([
    ...getQuestionSubjects(),
    ...getImageMemorySubjects(pdfMaterials)
  ].map(value => String(value || "").trim()).filter(Boolean))].sort();
  if (el.pdfSubjectOptions) {
    el.pdfSubjectOptions.innerHTML = subjects
      .map(subject => `<option value="${escapeHtml(subject)}"></option>`)
      .join("");
  }

  if (el.pdfCategoryOptions) {
    const subject = String(el.pdfSubjectInput?.value || "").trim() || "all";
    el.pdfCategoryOptions.innerHTML = getImageMemoryCategories(pdfMaterials, subject)
      .map(category => `<option value="${escapeHtml(category)}"></option>`)
      .join("");
  }
}

function renderPdfFilterUi() {
  const normalized = normalizeImageMemoryFilter(pdfMaterials, {
    subject: pdfSubjectFilter,
    category: pdfCategoryFilter
  });
  pdfSubjectFilter = normalized.subject;
  pdfCategoryFilter = normalized.category;

  if (el.pdfSearchInput) el.pdfSearchInput.value = pdfSearchQuery;
  if (el.pdfSubjectFilterSelect) {
    el.pdfSubjectFilterSelect.innerHTML = '<option value="all">すべての教科</option>' +
      getImageMemorySubjects(pdfMaterials)
        .map(subject => `<option value="${escapeHtml(subject)}">${escapeHtml(subject)}</option>`)
        .join("");
    el.pdfSubjectFilterSelect.value = pdfSubjectFilter;
  }
  if (el.pdfCategoryFilterSelect) {
    el.pdfCategoryFilterSelect.innerHTML = '<option value="">すべてのカテゴリ</option>' +
      getImageMemoryCategories(pdfMaterials, pdfSubjectFilter)
        .map(category => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`)
        .join("");
    el.pdfCategoryFilterSelect.value = pdfCategoryFilter;
  }
  renderPdfEditorOptions();
}

function renderPdfViewMode() {
  const isStudy = pdfViewMode !== "edit";
  el.pdfStudyView?.classList.toggle("hidden", !isStudy);
  el.pdfEditView?.classList.toggle("hidden", isStudy);
  el.pdfStudyModeBtn?.classList.toggle("active", isStudy);
  el.pdfEditModeBtn?.classList.toggle("active", !isStudy);
  el.pdfStudyModeBtn?.setAttribute("aria-pressed", String(isStudy));
  el.pdfEditModeBtn?.setAttribute("aria-pressed", String(!isStudy));
}

function setPdfViewMode(mode, { save = true } = {}) {
  pdfViewMode = mode === "edit" ? "edit" : "study";
  renderPdfViewMode();
  if (pdfViewMode === "edit") {
    fillPdfEditorForm(currentEditingPdfMaterial());
    renderPdfEditPreview();
  } else {
    const selectionChanged = renderPdfTable();
    if (!selectionChanged) {
      renderPdfMaskTable();
      renderPdfViewer();
    }
  }
  if (save) requestAutoSave();
}

function setPdfViewerFullscreen(active) {
  if (!el.pdfViewerShell || !el.pdfFullscreenBtn) return;
  pdfViewerFullscreen = active === true;
  el.pdfViewerShell.classList.toggle("is-fullscreen", pdfViewerFullscreen);
  document.body.classList.toggle("has-pdf-viewer-fullscreen", pdfViewerFullscreen);
  el.pdfFullscreenBtn.setAttribute("aria-pressed", String(pdfViewerFullscreen));
  el.pdfFullscreenBtn.setAttribute(
    "aria-label",
    pdfViewerFullscreen ? "教材画像の全画面表示を終了" : "教材画像を全画面表示"
  );
  el.pdfFullscreenBtn.title = pdfViewerFullscreen
    ? "全画面表示を終了"
    : "教材画像を全画面表示";
  el.pdfFullscreenBtn.textContent = pdfViewerFullscreen ? "✕" : "⛶";

  requestAnimationFrame(() => {
    applyPdfZoom();
    el.pdfFullscreenBtn.focus({ preventScroll: true });
  });
}

function selectPdfMaterial(pdfId) {
  selectedPdfId = pdfId;
  selectedMaskId = null;
  selectedMaskIds = [];
  pdfAddMaskMode = false;
  if (el.pdfViewerArea) el.pdfViewerArea.classList.remove("is-add-mask-mode");
  fillPdfMaskForm(null);
  renderPdfTable();
  renderPdfMaskTable();
  renderPdfViewer();
  requestAutoSave();
}

function selectPdfMaterialForEdit(pdfId) {
  const pdf = pdfMaterials.find(item => item.id === pdfId);
  if (!pdf) {
    alert("選択した画像教材が見つかりません。");
    return;
  }

  editingPdfId = pdf.id;
  pdfDeleteSelectedIds = pdfDeleteSelectedIds.filter(id => id !== editingPdfId);
  fillPdfEditorForm(pdf);
  if (el.pdfFileInput) el.pdfFileInput.value = "";
  renderPdfTable();
  renderPdfEditPreview();
  setPdfEditStatus(`更新対象: ${pdf.title || "無題教材"}`);
}

function updatePdfBulkDeleteButtonState() {
  const validIds = new Set(pdfMaterials.map(pdf => pdf.id));
  pdfDeleteSelectedIds = [...new Set(pdfDeleteSelectedIds)]
    .filter(id => validIds.has(id))
    .filter(id => id !== editingPdfId);

  if (!el.pdfDeleteCheckedBtn) return;
  el.pdfDeleteCheckedBtn.disabled = pdfDeleteSelectedIds.length === 0;
  el.pdfDeleteCheckedBtn.textContent = pdfDeleteSelectedIds.length
    ? `選択した教材を削除（${pdfDeleteSelectedIds.length}件）`
    : "選択した教材を削除";
}


















function renderPdfTable() {
  renderPdfFilterUi();
  renderPdfViewMode();

  const filteredMaterials = filterImageMemoryMaterials(pdfMaterials, {
    query: pdfSearchQuery,
    subject: pdfSubjectFilter,
    category: pdfCategoryFilter
  });
  let learningSelectionChanged = false;

  if (pdfViewMode === "study") {
    const visibleIds = new Set(filteredMaterials.map(pdf => pdf.id));
    if (!selectedPdfId || !visibleIds.has(selectedPdfId)) {
      const nextPdfId = filteredMaterials[0]?.id || null;
      learningSelectionChanged = selectedPdfId !== nextPdfId;
      selectedPdfId = nextPdfId;
      selectedMaskId = null;
      selectedMaskIds = [];
      pdfAddMaskMode = false;
      fillPdfMaskForm(null);
    }
  }

  if (el.pdfTableBody) {
    el.pdfTableBody.innerHTML = filteredMaterials.length
      ? filteredMaterials.map(pdf => {
          const revealMap = getPdfRevealMap(pdf.id);
          const masks = Array.isArray(pdf.masks) ? pdf.masks : [];
          const pages = Array.isArray(pdf.pages) ? pdf.pages : [];
          const revealed = masks.filter(mask => revealMap[mask.id]).length;
          const fileLabel = pages.length ? `${pages.length}枚` : (pdf.pdfName || "旧PDF");
          const detail = [pdf.subject, ...pdf.categories].filter(Boolean).join(" / ");
          return `
            <tr class="${selectedPdfId === pdf.id ? "selected" : ""}" data-pdf-id="${escapeHtml(pdf.id)}">
              <td>${escapeHtml(pdf.title || "無題教材")}<div class="pdf-material-meta">${escapeHtml(detail)}</div></td>
              <td>${masks.length}</td>
              <td>${revealed}</td>
              <td>${escapeHtml(fileLabel)}</td>
            </tr>
          `;
        }).join("")
      : '<tr><td colspan="4">該当する画像教材がありません。</td></tr>';
  }

  if (el.pdfEditTableBody) {
    el.pdfEditTableBody.innerHTML = pdfMaterials.length
      ? pdfMaterials.map(rawPdf => {
          const pdf = normalizeImageMaterial(rawPdf);
          const pages = Array.isArray(pdf.pages) ? pdf.pages : [];
          const isEditing = editingPdfId === pdf.id;
          const checked = pdfDeleteSelectedIds.includes(pdf.id);
          return `
            <tr class="${isEditing ? "pdf-editing-row" : ""}" data-edit-pdf-row="${escapeHtml(pdf.id)}">
              <td>
                <input
                  type="checkbox"
                  class="pdf-delete-check"
                  data-delete-pdf="${escapeHtml(pdf.id)}"
                  ${checked ? "checked" : ""}
                  ${isEditing ? "disabled" : ""}
                  aria-label="削除対象にする"
                >
              </td>
              <td>
                <button
                  type="button"
                  class="pdf-edit-btn ${isEditing ? "is-selected" : ""}"
                  data-edit-pdf="${escapeHtml(pdf.id)}"
                >
                  ${isEditing ? "更新対象" : "編集"}
                </button>
              </td>
              <td>${escapeHtml(pdf.title || "無題教材")}</td>
              <td>${escapeHtml(pdf.subject)}</td>
              <td>${escapeHtml(pdf.categories.join(" / ") || "未登録")}</td>
              <td>${pages.length ? `${pages.length}枚` : "旧PDF"}</td>
            </tr>
          `;
        }).join("")
      : '<tr><td colspan="6">画像教材がありません。</td></tr>';
  }

  [...(el.pdfTableBody?.querySelectorAll("tr[data-pdf-id]") || [])].forEach(row => {
    row.addEventListener("click", () => selectPdfMaterial(row.dataset.pdfId));
  });

  [...(el.pdfEditTableBody?.querySelectorAll("[data-edit-pdf]") || [])].forEach(button => {
    button.addEventListener("click", event => {
      event.stopPropagation();
      selectPdfMaterialForEdit(button.dataset.editPdf);
    });
  });

  [...(el.pdfEditTableBody?.querySelectorAll("[data-edit-pdf-row]") || [])].forEach(row => {
    row.addEventListener("click", event => {
      if (event.target.closest("[data-delete-pdf], [data-edit-pdf]")) return;
      selectPdfMaterialForEdit(row.dataset.editPdfRow);
    });
  });

  [...(el.pdfEditTableBody?.querySelectorAll("[data-delete-pdf]") || [])].forEach(input => {
    input.addEventListener("click", event => event.stopPropagation());
    input.addEventListener("change", () => {
      const id = input.dataset.deletePdf;
      if (id === editingPdfId) {
        input.checked = false;
        return;
      }
      pdfDeleteSelectedIds = input.checked
        ? [...new Set([...pdfDeleteSelectedIds, id])]
        : pdfDeleteSelectedIds.filter(item => item !== id);
      updatePdfBulkDeleteButtonState();
    });
  });

  updatePdfBulkDeleteButtonState();

  if (learningSelectionChanged) {
    renderPdfMaskTable();
    renderPdfViewer();
  }
  return learningSelectionChanged;
}

function renderPdfMaskTable() {
  if (!el.pdfMaskTableBody) return;
  const pdf = currentPdfMaterial();
  if (!pdf) {
    el.pdfMaskTableBody.innerHTML = '<tr><td colspan="6">画像教材を選択してください。</td></tr>';
    return;
  }
  const masks = Array.isArray(pdf.masks) ? pdf.masks : [];
  if (!masks.length) {
    el.pdfMaskTableBody.innerHTML = '<tr><td colspan="6">隠し範囲がありません。</td></tr>';
    return;
  }

  el.pdfMaskTableBody.innerHTML = masks.map(mask => `
    <tr class="${selectedMaskId === mask.id || selectedMaskIds.includes(mask.id) ? "selected" : ""}" data-mask-id="${mask.id}">
      <td>${mask.page}</td>
      <td>${formatPercent(mask.x)}%</td>
      <td>${formatPercent(mask.y)}%</td>
      <td>${formatPercent(mask.width)}%</td>
      <td>${formatPercent(mask.height)}%</td>
      <td>${mask.weak ? "苦手" : "通常"}</td>
    </tr>
  `).join("");

  [...el.pdfMaskTableBody.querySelectorAll("tr[data-mask-id]")].forEach(row => {
    row.addEventListener("click", () => {
      const viewerScrollTop = el.pdfViewerArea ? el.pdfViewerArea.scrollTop : 0;
      const viewerScrollLeft = el.pdfViewerArea ? el.pdfViewerArea.scrollLeft : 0;
      const windowScrollY = window.scrollY || document.documentElement.scrollTop || 0;

      selectedMaskId = row.dataset.maskId;
      selectedMaskIds = [];
      fillPdfMaskForm(currentPdfMask());
      renderPdfMaskTable();
      updatePdfMaskElementsOnly();

      requestAnimationFrame(() => {
        if (el.pdfViewerArea) {
          el.pdfViewerArea.scrollTop = viewerScrollTop;
          el.pdfViewerArea.scrollLeft = viewerScrollLeft;
        }
        window.scrollTo({ top: windowScrollY, left: 0, behavior: "auto" });
      });

      requestAutoSave();
    });
  });
}

async function uploadPdfFile(pdfId, file, pageNumber = 1) {
  if (!getStorage() || !getCurrentUser() || !file) return { imageUrl: "", imagePath: "", imageName: "" };

  if (typeof file.size === "number" && file.size <= 0) {
    throw new Error("画像ファイルが0バイトです。保存を停止しました。");
  }

  const safeName = (file.name || `page_${pageNumber}.jpg`).replace(/[^a-zA-Z0-9._-]/g, "_");
  const path = `users/${getCurrentUser().uid}/imageMaterials/${pdfId}/page_${pageNumber}_${Date.now()}_${safeName}`;
  const refObj = storageRef(getStorage(), path);

  await uploadBytes(refObj, file, { contentType: file.type || "image/jpeg" });
  const url = await getDownloadURL(refObj);

  return {
    imageUrl: url,
    url,
    imagePath: path,
    imageName: file.name || safeName,
    size: file.size || null
  };
}

async function deletePdfFileByPath(path) {
  if (!getStorage() || !path) return;
  try {
    await deleteObject(storageRef(getStorage(), path));
  } catch (error) {
    console.warn("教材削除をスキップ:", error);
  }
}


let cachedPdfJsLib = null;

async function getPdfJsLibForConvert() {
  if (cachedPdfJsLib) return cachedPdfJsLib;
  cachedPdfJsLib = await import("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs");
  cachedPdfJsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs";
  return cachedPdfJsLib;
}

function canvasToBlob(canvas, type = "image/jpeg", quality = 0.9) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("PDFページの画像化に失敗しました。"));
      }
    }, type, quality);
  });
}

async function convertPdfToImageFiles(pdfFile, onProgress) {
  const pdfjsLib = await getPdfJsLibForConvert();
  const arrayBuffer = await pdfFile.arrayBuffer();

  const loadingTask = pdfjsLib.getDocument({
    data: arrayBuffer,
    useSystemFonts: true,
    disableFontFace: false,
    cMapUrl: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/standard_fonts/"
  });

  const pdfDoc = await loadingTask.promise;
  const imageFiles = [];

  for (let pageNumber = 1; pageNumber <= pdfDoc.numPages; pageNumber++) {
    if (onProgress) onProgress(pageNumber, pdfDoc.numPages, "converting");

    const page = await pdfDoc.getPage(pageNumber);
    const baseViewport = page.getViewport({ scale: 1 });

    // PowerPoint由来PDFは細かい文字や図形が多いため、やや高解像度で画像化する。
    // PowerPoint PDFs often have small text/shapes, so render at a higher resolution.
    const targetWidth = 2200;
    const scale = Math.min(3.2, Math.max(1.8, targetWidth / baseViewport.width));
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { alpha: false });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);

    // 透明背景や白抜け対策として、先に白で塗る。
    // Fill white first to avoid transparent/background rendering gaps.
    context.save();
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.restore();

    const renderOptions = {
      canvasContext: context,
      viewport,
      background: "white"
    };

    if (pdfjsLib.AnnotationMode) {
      renderOptions.annotationMode = pdfjsLib.AnnotationMode.ENABLE;
    }

    await page.render(renderOptions).promise;

    const blob = await canvasToBlob(canvas, "image/jpeg", 0.92);
    const baseName = (pdfFile.name || "converted.pdf").replace(/\.pdf$/i, "");
    const imageName = `${baseName}_page_${String(pageNumber).padStart(3, "0")}.jpg`;
    const imageFile = new File([blob], imageName, { type: "image/jpeg" });
    imageFiles.push(imageFile);

    canvas.width = 1;
    canvas.height = 1;
  }

  return imageFiles;
}







































function isPdfFile(file) {
  return !!file && (file.type === "application/pdf" || /\.pdf$/i.test(file.name || ""));
}

function isImageFile(file) {
  return !!file && (!!file.type?.startsWith("image/") || /\.(png|jpe?g|webp)$/i.test(file.name || ""));
}

function readPdfEditorMetadata() {
  const title = String(el.pdfTitleInput?.value || "").trim();
  const subject = String(el.pdfSubjectInput?.value || "").trim();
  const categories = normalizePdfTags(textToTagList(el.pdfCategoryInput?.value || ""));

  if (!title) {
    alert("教材タイトルを入力してください。");
    return null;
  }
  if (!subject) {
    alert("教科を入力してください。");
    return null;
  }
  if (!categories.length) {
    alert("カテゴリを1件以上入力してください。");
    return null;
  }

  return { title, subject, categories, tags: categories };
}

function clearPdfEditorForm() {
  editingPdfId = null;
  fillPdfEditorForm(null);
  if (el.pdfFileInput) el.pdfFileInput.value = "";
  renderPdfTable();
  renderPdfEditPreview();
  setPdfEditStatus("新しい教材を入力してください。");
}

async function prepareAndUploadPdfPages(pdfId, selectedFiles) {
  const pdfFiles = selectedFiles.filter(isPdfFile);
  const imageFiles = selectedFiles.filter(isImageFile);

  if (pdfFiles.length + imageFiles.length !== selectedFiles.length) {
    throw new Error("PDF、PNG、JPEG、WebPのいずれかを選んでください。");
  }
  if (pdfFiles.length && imageFiles.length) {
    throw new Error("PDFと画像は同時に登録できません。PDFだけ、または画像だけを選んでください。");
  }
  if (pdfFiles.length > 1) {
    throw new Error("PDFは1ファイルずつ登録してください。複数ページPDFは自動でページごとに画像化されます。");
  }

  let filesToUpload = imageFiles;
  if (pdfFiles.length === 1) {
    const pdfFile = pdfFiles[0];
    setPdfEditStatus("PDFを画像に変換しています...");
    filesToUpload = await convertPdfToImageFiles(pdfFile, (page, total, stage) => {
      if (stage === "converting") {
        setPdfEditStatus(`PDFを画像に変換しています... ${page}/${total}ページ`);
      }
    });
  }

  if (!filesToUpload.length) {
    throw new Error("PDFまたは画像から登録用画像を作成できませんでした。");
  }

  const pages = [];
  try {
    setPdfEditStatus(`画像をアップロードしています... 0/${filesToUpload.length}`);
    for (let index = 0; index < filesToUpload.length; index++) {
      const pageNumber = index + 1;
      const meta = await uploadPdfFile(pdfId, filesToUpload[index], pageNumber);
      pages.push({ page: pageNumber, ...meta });
      setPdfEditStatus(`画像をアップロードしています... ${pageNumber}/${filesToUpload.length}`);
    }
  } catch (error) {
    await Promise.all(pages.map(page => deletePdfFileByPath(page.imagePath)));
    throw error;
  }

  return {
    pages,
    sourceType: pdfFiles.length === 1 ? "pdf-converted" : "images",
    sourceName: pdfFiles.length === 1 ? pdfFiles[0].name : ""
  };
}


async function addPdfMaterial() {
  if (!getCurrentUser()) return;

  const metadata = readPdfEditorMetadata();
  if (!metadata) return;
  const selectedFiles = Array.from(el.pdfFileInput.files || []);
  if (!selectedFiles.length) {
    alert("PDFまたは画像ファイルを選んでください。");
    return;
  }

  const pdfId = crypto.randomUUID();
  let uploadResult = null;
  let added = false;

  try {
    uploadResult = await prepareAndUploadPdfPages(pdfId, selectedFiles);
    pdfMaterials.push(normalizeImageMaterial({
      id: pdfId,
      ...metadata,
      ...uploadResult,
      masks: [],
    }));
    added = true;

    selectedPdfId = pdfId;
    editingPdfId = pdfId;
    pdfDeleteSelectedIds = pdfDeleteSelectedIds.filter(id => id !== pdfId);
    selectedMaskId = null;
    el.pdfFileInput.value = "";
    renderPdfTable();
    renderPdfMaskTable();
    renderPdfEditPreview();
    const saved = await requestSave({ showAlerts: true });
    if (!saved) throw new Error("教材データをクラウド保存できませんでした。");
    setPdfEditStatus("教材を追加しました。");
  } catch (error) {
    if (added) pdfMaterials = pdfMaterials.filter(pdf => pdf.id !== pdfId);
    if (uploadResult?.pages?.length) {
      await Promise.all(uploadResult.pages.map(page => deletePdfFileByPath(page.imagePath)));
    }
    selectedPdfId = pdfMaterials[0]?.id || null;
    if (editingPdfId === pdfId) editingPdfId = null;
    renderPdfTable();
    renderPdfMaskTable();
    renderPdfEditPreview();
    console.error(error);
    setPdfEditStatus("教材追加に失敗しました。\n" + (error.message || error));
    alert("教材追加に失敗しました。\n\n" + (error.message || error));
  }
}

async function updatePdfMaterial() {
  if (!getCurrentUser()) return;
  const pdf = currentEditingPdfMaterial();
  if (!pdf) {
    alert("更新したい画像教材を一覧の「編集」から選んでください。");
    return;
  }
  const metadata = readPdfEditorMetadata();
  if (!metadata) return;
  const selectedFiles = Array.from(el.pdfFileInput.files || []);

  if (!selectedFiles.length) {
    Object.assign(pdf, metadata);
    renderPdfTable();
    setPdfEditStatus("教材情報を更新しました。");
    requestAutoSave();
    return;
  }

  const masks = Array.isArray(pdf.masks) ? pdf.masks : [];
  if (masks.length && !confirm(
    `画像を差し替えると、位置が合わなくなるため${masks.length}件の隠し範囲を削除します。\n\n画像を差し替えますか？`
  )) return;

  const previous = {
    title: pdf.title,
    subject: pdf.subject,
    categories: pdf.categories,
    tags: pdf.tags,
    pages: pdf.pages,
    masks: pdf.masks,
    sourceType: pdf.sourceType,
    sourceName: pdf.sourceName,
    pdfUrl: pdf.pdfUrl,
    pdfName: pdf.pdfName,
    revealState: pdfRevealStates[pdf.id]
  };
  let uploadResult = null;

  try {
    uploadResult = await prepareAndUploadPdfPages(pdf.id, selectedFiles);
    Object.assign(pdf, metadata, uploadResult, { masks: [], pdfUrl: "", pdfName: "" });
    pdfRevealStates[pdf.id] = {};
    selectedMaskId = null;
    selectedMaskIds = [];
    el.pdfFileInput.value = "";
    renderPdfTable();
    renderPdfMaskTable();
    renderPdfEditPreview();

    const saved = await requestSave({ showAlerts: true });
    if (!saved) throw new Error("更新した教材データをクラウド保存できませんでした。");
    await Promise.all((previous.pages || []).map(page => deletePdfFileByPath(getPdfPageImagePath(page))));
    setPdfEditStatus("教材情報と画像を更新しました。隠し範囲は初期化されています。");
  } catch (error) {
    Object.assign(pdf, {
      title: previous.title,
      subject: previous.subject,
      categories: previous.categories,
      tags: previous.tags,
      pages: previous.pages,
      masks: previous.masks,
      sourceType: previous.sourceType,
      sourceName: previous.sourceName,
      pdfUrl: previous.pdfUrl,
      pdfName: previous.pdfName
    });
    pdfRevealStates[pdf.id] = previous.revealState || {};
    if (uploadResult?.pages?.length) {
      await Promise.all(uploadResult.pages.map(page => deletePdfFileByPath(page.imagePath)));
    }
    renderPdfTable();
    renderPdfMaskTable();
    renderPdfEditPreview();
    console.error(error);
    setPdfEditStatus("教材更新に失敗しました。\n" + (error.message || error));
    alert("教材更新に失敗しました。\n\n" + (error.message || error));
  }
}

async function deleteCheckedPdfMaterials() {
  if (!getCurrentUser()) return;

  const ids = [...new Set(pdfDeleteSelectedIds)].filter(id => id !== editingPdfId);
  if (!ids.length) {
    alert("削除する画像教材をチェックしてください。");
    return;
  }

  const targets = pdfMaterials.filter(pdf => ids.includes(pdf.id));
  const preview = targets
    .slice(0, 10)
    .map((pdf, index) => `${index + 1}. ${pdf.subject || "教科未設定"} / ${pdf.title || "無題教材"}`)
    .join("\n");
  const extra = targets.length > 10 ? `\n...ほか ${targets.length - 10}件` : "";
  const ok = confirm(
    `${targets.length}件の画像教材を削除します。\n` +
    "Firestoreの教材データとStorage上の画像ファイルが削除されます。\n\n" +
    `削除対象:\n${preview}${extra}`
  );
  if (!ok) return;

  const previousMaterials = pdfMaterials;
  const previousRevealStates = pdfRevealStates;
  const previousSelectedPdfId = selectedPdfId;
  const idSet = new Set(ids);
  pdfMaterials = pdfMaterials.filter(pdf => !idSet.has(pdf.id));
  pdfRevealStates = Object.fromEntries(
    Object.entries(pdfRevealStates).filter(([pdfId]) => !idSet.has(pdfId))
  );
  pdfDeleteSelectedIds = [];

  if (selectedPdfId && idSet.has(selectedPdfId)) {
    selectedPdfId = pdfMaterials[0]?.id || null;
  }

  selectedMaskId = null;
  selectedMaskIds = [];

  renderPdfTable();
  renderPdfMaskTable();
  renderPdfViewer();
  renderPdfEditPreview();
  setPdfEditStatus(`${targets.length}件の画像教材を削除しています...`);

  try {
    const saved = await requestSave({
      allowEmptyPdfMaterials: true,
      showAlerts: true
    });
    if (!saved) throw new Error("削除後の教材データをクラウド保存できませんでした。");
    await Promise.all(targets.map(deletePdfStorageFiles));
    setPdfEditStatus(`${targets.length}件の画像教材を削除しました。`);
  } catch (error) {
    pdfMaterials = previousMaterials;
    pdfRevealStates = previousRevealStates;
    selectedPdfId = previousSelectedPdfId;
    pdfDeleteSelectedIds = ids;
    renderPdfTable();
    renderPdfMaskTable();
    renderPdfViewer();
    renderPdfEditPreview();
    console.error(error);
    setPdfEditStatus("教材削除に失敗しました。\n" + (error.message || error));
    alert("教材削除に失敗しました。\n\n" + (error.message || error));
  }
}

function updatePdfMaskFromForm() {
  if (!getCurrentUser()) return;
  const pdf = currentPdfMaterial();
  const mask = currentPdfMask();
  if (!pdf || !mask) {
    alert("更新したい隠し範囲を選択してください。");
    return;
  }
  const payload = readPdfMaskForm();
  if (!payload) return;
  Object.assign(mask, payload);
  renderPdfMaskTable();
  renderPdfViewer(true);
  setPdfStatus("隠し範囲を更新しました。");
  requestAutoSave();
}

function deletePdfMask() {
  const pdf = currentPdfMaterial();
  if (!pdf) {
    alert("画像教材を選択してください。");
    return;
  }

  const targetIds = selectedMaskIds.length ? [...selectedMaskIds] : (selectedMaskId ? [selectedMaskId] : []);
  if (!targetIds.length) {
    alert("削除したい隠し範囲を選択してください。");
    return;
  }

  if (!confirm(`${targetIds.length}件の隠し範囲を削除しますか？`)) return;

  const targetSet = new Set(targetIds);
  pdf.masks = (pdf.masks || []).filter(mask => !targetSet.has(mask.id));

  const revealMap = getPdfRevealMap(pdf.id);
  targetIds.forEach(id => {
    delete revealMap[id];
    removeSinglePdfMaskElement(id);
  });

  selectedMaskId = null;
  selectedMaskIds = [];
  fillPdfMaskForm(null);
  renderPdfMaskTable();
  renderPdfTable();
  updatePdfMaskElementsOnly();
  setPdfStatus(`隠し範囲を削除しました。${targetIds.length}件`);
  requestAutoSave();
}

function clearPdfMaskSelection() {
  selectedMaskId = null;
  selectedMaskIds = [];
  fillPdfMaskForm(null);
  renderPdfMaskTable();
  updatePdfMaskElementsOnly();
  setPdfStatus("選択を解除しました。");
}


function selectAllMasks() {
  const pdf = currentPdfMaterial();
  if (!pdf) {
    alert("画像教材を選択してください。");
    return;
  }

  const masks = Array.isArray(pdf.masks) ? pdf.masks : [];
  if (!masks.length) {
    alert("選択できるマスクがありません。");
    return;
  }

  selectedMaskIds = masks.map(mask => mask.id);
  selectedMaskId = selectedMaskIds[0] || null;
  if (selectedMaskId) fillPdfMaskForm(currentPdfMask());

  renderPdfMaskTable();
  updatePdfMaskElementsOnly();
  setPdfStatus(`マスクを全選択しました。${selectedMaskIds.length}件`);
}

function toggleWeakMasks() {
  const pdf = currentPdfMaterial();
  if (!pdf) {
    alert("画像教材を選択してください。");
    return;
  }

  const targetIds = selectedMaskIds.length
    ? [...selectedMaskIds]
    : (selectedMaskId ? [selectedMaskId] : []);
  if (!targetIds.length) {
    alert("苦手色を付ける隠し範囲を選択してください。");
    return;
  }

  const targetSet = new Set(targetIds);
  const targets = (pdf.masks || []).filter(mask => targetSet.has(mask.id));
  const nextWeak = targets.some(mask => !mask.weak);
  targets.forEach(mask => { mask.weak = nextWeak; });

  renderPdfMaskTable();
  updatePdfMaskElementsOnly();
  setPdfStatus(`${targets.length}件を${nextWeak ? "苦手色にしました" : "通常色に戻しました"}。`);
  requestAutoSave();
}

function showAllMasks() {
  const pdf = currentPdfMaterial();
  if (!pdf) {
    alert("画像教材を選択してください。");
    return;
  }

  const masks = Array.isArray(pdf.masks) ? pdf.masks : [];
  if (!masks.length) {
    alert("表示できるマスクがありません。");
    return;
  }

  const snapshot = getScrollSnapshot();
  const revealMap = getPdfRevealMap(pdf.id);
  masks.forEach(mask => {
    revealMap[mask.id] = true;
  });

  renderPdfMaskTable();
  renderPdfTable();
  updatePdfMaskElementsOnly();
  restoreScrollSnapshot(snapshot);
  setPdfStatus(`マスクを全表示しました。${masks.length}件`);
  requestAutoSave();
}


function resetPdfRevealState() {
  const pdf = currentPdfMaterial();
  if (!pdf) {
    alert("画像教材を選択してください。");
    return;
  }
  if (!confirm("この画像教材の確認済み状態をリセットしますか？")) return;
  pdfRevealStates[pdf.id] = {};
  renderPdfTable();
  renderPdfMaskTable();
  renderPdfViewer(true);
  setPdfStatus("表示状態をリセットしました。");
  requestAutoSave();
}


function clampPdfZoom(value) {
  return Math.min(5, Math.max(0.8, value));
}

function getTouchDistance(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.hypot(dx, dy);
}

function getTouchCenter(touches) {
  return {
    x: (touches[0].clientX + touches[1].clientX) / 2,
    y: (touches[0].clientY + touches[1].clientY) / 2
  };
}

function applyPdfZoom() {
  if (!el.pdfViewerArea) return;
  const pageWraps = [...el.pdfViewerArea.querySelectorAll(".pdf-page-wrap")];
  const viewerStyle = getComputedStyle(el.pdfViewerArea);
  const horizontalPadding = parseFloat(viewerStyle.paddingLeft) + parseFloat(viewerStyle.paddingRight);
  const contentWidth = Math.max(0, el.pdfViewerArea.clientWidth - horizontalPadding);
  const maximumBaseWidth = pdfViewerFullscreen ? contentWidth : 920;

  pageWraps.forEach(pageWrap => {
    pageWrap.style.width = `${pdfZoom * 100}%`;
    pageWrap.style.maxWidth = `${maximumBaseWidth * pdfZoom}px`;
    const baseWidth = Math.min(contentWidth, maximumBaseWidth);
    pageWrap.style.marginRight = `${Math.max(0, contentWidth - baseWidth)}px`;
    pageWrap.style.marginBottom = "0px";
  });
}

function getViewerCenter() {
  const rect = el.pdfViewerArea.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function capturePdfZoomAnchor(clientX, clientY) {
  if (!el.pdfViewerArea) return null;
  let pageWrap = document.elementFromPoint(clientX, clientY)?.closest?.(".pdf-page-wrap");
  if (!pageWrap || !el.pdfViewerArea.contains(pageWrap)) {
    const pages = [...el.pdfViewerArea.querySelectorAll(".pdf-page-wrap")];
    pageWrap = pages.find(page => {
      const rect = page.getBoundingClientRect();
      return clientY >= rect.top && clientY <= rect.bottom;
    }) || pages[0];
  }
  if (!pageWrap) return null;

  const rect = pageWrap.getBoundingClientRect();
  return {
    pageNumber: pageWrap.dataset.page,
    xRatio: Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)),
    yRatio: Math.min(1, Math.max(0, (clientY - rect.top) / rect.height))
  };
}

function restorePdfZoomAnchor(anchor, clientX, clientY) {
  if (!anchor || !el.pdfViewerArea) return;
  const pageWrap = el.pdfViewerArea.querySelector(`.pdf-page-wrap[data-page="${anchor.pageNumber}"]`);
  if (!pageWrap) return;
  const rect = pageWrap.getBoundingClientRect();
  const anchoredClientX = rect.left + rect.width * anchor.xRatio;
  const anchoredClientY = rect.top + rect.height * anchor.yRatio;
  el.pdfViewerArea.scrollLeft += anchoredClientX - clientX;
  el.pdfViewerArea.scrollTop += anchoredClientY - clientY;

  const adjustedRect = pageWrap.getBoundingClientRect();
  const residualY = adjustedRect.top + adjustedRect.height * anchor.yRatio - clientY;
  if (Math.abs(residualY) > 0.5) window.scrollBy(0, residualY);
}

function zoomPdfAt(nextZoom, clientX, clientY, anchor = null) {
  const clampedZoom = clampPdfZoom(nextZoom);
  if (clampedZoom === pdfZoom) return;
  const resolvedAnchor = anchor || capturePdfZoomAnchor(clientX, clientY);
  pdfZoom = clampedZoom;
  applyPdfZoom();
  restorePdfZoomAnchor(resolvedAnchor, clientX, clientY);
}

function attachPdfViewerZoomEvents() {
  if (!el.pdfViewerArea || pdfZoomEventsAttached) return;
  pdfZoomEventsAttached = true;

  el.pdfViewerArea.addEventListener("touchstart", (event) => {
    if (event.touches.length === 2) {
      event.preventDefault();
      pdfPinchStartDistance = getTouchDistance(event.touches);
      pdfPinchStartZoom = pdfZoom;
      const center = getTouchCenter(event.touches);
      pdfPinchAnchor = capturePdfZoomAnchor(center.x, center.y);
    }
  }, { passive: false });

  el.pdfViewerArea.addEventListener("touchmove", (event) => {
    if (event.touches.length === 2 && pdfPinchStartDistance && pdfPinchAnchor) {
      event.preventDefault();
      event.stopPropagation();

      const currentDistance = getTouchDistance(event.touches);
      const currentCenter = getTouchCenter(event.touches);

      zoomPdfAt(
        pdfPinchStartZoom * (currentDistance / pdfPinchStartDistance),
        currentCenter.x,
        currentCenter.y,
        pdfPinchAnchor
      );
    }
  }, { passive: false });

  el.pdfViewerArea.addEventListener("touchend", (event) => {
    if (event.touches.length < 2) {
      pdfPinchStartDistance = null;
      pdfPinchAnchor = null;
      pdfPinchStartZoom = pdfZoom;
    }
  }, { passive: false });

  el.pdfViewerArea.addEventListener("touchcancel", () => {
    pdfPinchStartDistance = null;
    pdfPinchAnchor = null;
    pdfPinchStartZoom = pdfZoom;
  }, { passive: false });

  el.pdfViewerArea.addEventListener("gesturestart", (event) => {
    event.preventDefault();
    pdfGestureStartZoom = pdfZoom;
    const center = getViewerCenter();
    pdfGestureAnchor = capturePdfZoomAnchor(center.x, center.y);
  }, { passive: false });

  el.pdfViewerArea.addEventListener("gesturechange", (event) => {
    event.preventDefault();
    const center = getViewerCenter();
    zoomPdfAt(pdfGestureStartZoom * event.scale, center.x, center.y, pdfGestureAnchor);
  }, { passive: false });

  el.pdfViewerArea.addEventListener("gestureend", (event) => {
    event.preventDefault();
    pdfGestureStartZoom = pdfZoom;
    pdfGestureAnchor = null;
  }, { passive: false });

  el.pdfViewerArea.addEventListener("wheel", (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const direction = event.deltaY > 0 ? -0.08 : 0.08;
    zoomPdfAt(pdfZoom + direction, event.clientX, event.clientY);
  }, { passive: false });
}


function getScrollSnapshot() {
  return {
    windowY: window.scrollY || document.documentElement.scrollTop || 0,
    viewerTop: el.pdfViewerArea ? el.pdfViewerArea.scrollTop : 0,
    viewerLeft: el.pdfViewerArea ? el.pdfViewerArea.scrollLeft : 0
  };
}

function restoreScrollSnapshot(snapshot) {
  if (!snapshot) return;
  requestAnimationFrame(() => {
    if (el.pdfViewerArea) {
      el.pdfViewerArea.scrollTop = snapshot.viewerTop || 0;
      el.pdfViewerArea.scrollLeft = snapshot.viewerLeft || 0;
    }
    window.scrollTo({ top: snapshot.windowY || 0, left: 0, behavior: "auto" });
  });
}

function withScrollPreserved(fn) {
  const snapshot = getScrollSnapshot();
  const result = fn();
  restoreScrollSnapshot(snapshot);
  return result;
}


function togglePdfAddMaskMode() {
  if (!currentPdfMaterial()) {
    alert("先に画像教材を選択してください。");
    return;
  }
  pdfAddMaskMode = !pdfAddMaskMode;
  el.addMaskModeBtn.textContent = pdfAddMaskMode ? "✅" : "➕";
  if (el.pdfViewerArea) el.pdfViewerArea.classList.toggle("is-add-mask-mode", pdfAddMaskMode);
  setPdfStatus(pdfAddMaskMode
    ? "画像上で隠したい範囲をドラッグしてください。拡大縮小したいときは、ドラッグ追加を終了してから2本指でピンチしてください。"
    : "ドラッグ追加モードを終了しました。2本指で画像を拡大縮小できます。"
  );
}

function getPointerPercent(event, pageWrap) {
  const rect = pageWrap.getBoundingClientRect();
  const x = Math.min(Math.max(event.clientX - rect.left, 0), rect.width);
  const y = Math.min(Math.max(event.clientY - rect.top, 0), rect.height);
  return {
    x: (x / rect.width) * 100,
    y: (y / rect.height) * 100
  };
}


function finishMaskDrag(pageNumber, startPoint, currentPoint) {
  const snapshot = getScrollSnapshot();
  const pdf = currentPdfMaterial();
  if (!pdf) return;

  const x = Math.max(0, Math.min(startPoint.x, currentPoint.x));
  const y = Math.max(0, Math.min(startPoint.y, currentPoint.y));
  const width = Math.min(100 - x, Math.abs(currentPoint.x - startPoint.x));
  const height = Math.min(100 - y, Math.abs(currentPoint.y - startPoint.y));

  if (width < 0.5 || height < 0.5) {
    setPdfStatus("隠し範囲が小さすぎます。少し大きめにドラッグしてください。");
    return;
  }

  const mask = {
    id: crypto.randomUUID(),
    page: pageNumber,
    x: Number(x.toFixed(2)),
    y: Number(y.toFixed(2)),
    width: Number(width.toFixed(2)),
    height: Number(height.toFixed(2)),
    weak: false
  };

  if (!Array.isArray(pdf.masks)) pdf.masks = [];
  pdf.masks.push(mask);
  selectedMaskId = mask.id;
  fillPdfMaskForm(mask);
  renderPdfMaskTable();
  renderPdfTable();
  addSinglePdfMaskElement(mask);
  restoreScrollSnapshot(snapshot);
  setPdfStatus("隠し範囲を追加しました。");
  requestAutoSave();
}


function attachPdfPageDragEvents(pageWrap, pageNumber) {
  let startPoint = null;
  let draftEl = null;
  let isDraggingMask = false;

  function getLocalPoint(event) {
    const rect = pageWrap.getBoundingClientRect();
    const clientX = event.touches?.[0]?.clientX ?? event.clientX;
    const clientY = event.touches?.[0]?.clientY ?? event.clientY;
    return {
      x: ((clientX - rect.left) / rect.width) * 100,
      y: ((clientY - rect.top) / rect.height) * 100
    };
  }

  function removeDraft() {
    if (draftEl) draftEl.remove();
    draftEl = null;
  }

  pageWrap.addEventListener("pointerdown", (event) => {
    if (!pdfAddMaskMode) return;
    if (event.pointerType === "touch") return; // touchは下のtouchイベントで処理する
    if (event.target.closest(".pdf-mask")) return;

    event.preventDefault();
    isDraggingMask = true;
    startPoint = getLocalPoint(event);
    removeDraft();

    draftEl = document.createElement("div");
    draftEl.className = "pdf-draft-mask";
    pageWrap.appendChild(draftEl);
    pageWrap.setPointerCapture?.(event.pointerId);
  });

  pageWrap.addEventListener("pointermove", (event) => {
    if (!pdfAddMaskMode || !isDraggingMask || !startPoint || !draftEl) return;
    if (event.pointerType === "touch") return;

    event.preventDefault();
    const current = getLocalPoint(event);
    const x = Math.max(0, Math.min(startPoint.x, current.x));
    const y = Math.max(0, Math.min(startPoint.y, current.y));
    const width = Math.min(100 - x, Math.abs(current.x - startPoint.x));
    const height = Math.min(100 - y, Math.abs(current.y - startPoint.y));

    draftEl.style.left = `${x}%`;
    draftEl.style.top = `${y}%`;
    draftEl.style.width = `${width}%`;
    draftEl.style.height = `${height}%`;
  });

  pageWrap.addEventListener("pointerup", (event) => {
    if (!pdfAddMaskMode || !isDraggingMask || !startPoint) return;
    if (event.pointerType === "touch") return;

    event.preventDefault();
    const current = getLocalPoint(event);
    finishMaskDrag(pageNumber, startPoint, current);
    startPoint = null;
    isDraggingMask = false;
    removeDraft();
  });

  pageWrap.addEventListener("touchstart", (event) => {
    if (!pdfAddMaskMode) return;
    if (event.touches.length >= 2) {
      // 2本指はピンチ用。隠し範囲作成は中断する。
      // Two fingers are for pinch zoom. Cancel mask drawing.
      startPoint = null;
      isDraggingMask = false;
      removeDraft();
      return;
    }
    if (event.target.closest(".pdf-mask")) return;

    event.preventDefault();
    isDraggingMask = true;
    startPoint = getLocalPoint(event);
    removeDraft();

    draftEl = document.createElement("div");
    draftEl.className = "pdf-draft-mask";
    pageWrap.appendChild(draftEl);
  }, { passive:false });

  pageWrap.addEventListener("touchmove", (event) => {
    if (!pdfAddMaskMode) return;
    if (event.touches.length >= 2) {
      startPoint = null;
      isDraggingMask = false;
      removeDraft();
      return;
    }
    if (!isDraggingMask || !startPoint || !draftEl) return;

    event.preventDefault();
    const current = getLocalPoint(event);
    const x = Math.max(0, Math.min(startPoint.x, current.x));
    const y = Math.max(0, Math.min(startPoint.y, current.y));
    const width = Math.min(100 - x, Math.abs(current.x - startPoint.x));
    const height = Math.min(100 - y, Math.abs(current.y - startPoint.y));

    draftEl.style.left = `${x}%`;
    draftEl.style.top = `${y}%`;
    draftEl.style.width = `${width}%`;
    draftEl.style.height = `${height}%`;
  }, { passive:false });

  pageWrap.addEventListener("touchend", (event) => {
    if (!pdfAddMaskMode || !isDraggingMask || !startPoint) return;
    if (event.changedTouches.length !== 1) return;

    event.preventDefault();
    const touch = event.changedTouches[0];
    const rect = pageWrap.getBoundingClientRect();
    const current = {
      x: ((touch.clientX - rect.left) / rect.width) * 100,
      y: ((touch.clientY - rect.top) / rect.height) * 100
    };

    finishMaskDrag(pageNumber, startPoint, current);
    startPoint = null;
    isDraggingMask = false;
    removeDraft();
  }, { passive:false });

  pageWrap.addEventListener("touchcancel", () => {
    startPoint = null;
    isDraggingMask = false;
    removeDraft();
  }, { passive:true });
}

function drawPdfDraftMask(draft) {
  const x = Math.min(draft.start.x, draft.current.x);
  const y = Math.min(draft.start.y, draft.current.y);
  const width = Math.abs(draft.current.x - draft.start.x);
  const height = Math.abs(draft.current.y - draft.start.y);
  draft.draftEl.style.left = `${x}%`;
  draft.draftEl.style.top = `${y}%`;
  draft.draftEl.style.width = `${width}%`;
  draft.draftEl.style.height = `${height}%`;
}



function clearPdfMaskElementsOnly() {
  if (!el.pdfViewerArea) return;
  el.pdfViewerArea.querySelectorAll(".pdf-mask").forEach(node => node.remove());
}

function refreshPdfMasksOnly() {
  const pdf = currentPdfMaterial();
  if (!pdf || !el.pdfViewerArea) return;

  clearPdfMaskElementsOnly();

  el.pdfViewerArea.querySelectorAll(".pdf-page-wrap[data-page]").forEach(pageWrap => {
    addPdfMaskOverlays(pageWrap, pdf, Number(pageWrap.dataset.page));
  });

  updatePdfMaskElementsOnly();
}

function createPdfMaskElement(pageWrap, pdf, mask) {
  const revealMap = getPdfRevealMap(pdf.id);

  const maskEl = document.createElement("button");
  maskEl.type = "button";
  maskEl.className = "pdf-mask";
  if (revealMap[mask.id]) maskEl.classList.add("revealed");
  if (mask.weak) maskEl.classList.add("is-weak");
  if (selectedMaskId === mask.id) maskEl.classList.add("selected");
  maskEl.style.left = `${mask.x}%`;
  maskEl.style.top = `${mask.y}%`;
  maskEl.style.width = `${mask.width}%`;
  maskEl.style.height = `${mask.height}%`;
  maskEl.innerHTML = "";
  maskEl.textContent = "";
  maskEl.title = "";
  maskEl.dataset.maskId = mask.id;
  maskEl.setAttribute("aria-label", "隠し範囲");

  maskEl.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();

    const snapshot = getScrollSnapshot();

    selectedMaskId = mask.id;
    revealMap[mask.id] = !revealMap[mask.id];
    fillPdfMaskForm(mask);

    renderPdfMaskTable();
    renderPdfTable();
    updatePdfMaskElementsOnly();

    restoreScrollSnapshot(snapshot);
    setPdfStatus("表示を切り替えました。");
    requestAutoSave();
  });

  return maskEl;
}

function addSinglePdfMaskElement(mask) {
  const pdf = currentPdfMaterial();
  if (!pdf || !el.pdfViewerArea || !mask) return;
  const pageWrap = el.pdfViewerArea.querySelector(`.pdf-page-wrap[data-page="${mask.page}"]`);
  if (!pageWrap) {
    refreshPdfMasksOnly();
    return;
  }
  pageWrap.appendChild(createPdfMaskElement(pageWrap, pdf, mask));
  updatePdfMaskElementsOnly();
}

function removeSinglePdfMaskElement(maskId) {
  if (!el.pdfViewerArea || !maskId) return;
  const target = el.pdfViewerArea.querySelector(`.pdf-mask[data-mask-id="${maskId}"]`);
  if (target) target.remove();
  updatePdfMaskElementsOnly();
}


function updatePdfMaskElementsOnly() {
  const pdf = currentPdfMaterial();
  if (!pdf || !el.pdfViewerArea) return;
  const revealMap = getPdfRevealMap(pdf.id);
  const masksById = new Map((pdf.masks || []).map(mask => [mask.id, mask]));

  el.pdfViewerArea.querySelectorAll(".pdf-mask").forEach(maskEl => {
    const id = maskEl.dataset.maskId;
    maskEl.classList.toggle("revealed", !!revealMap[id]);
    maskEl.classList.toggle("is-weak", !!masksById.get(id)?.weak);
    maskEl.classList.toggle("selected", selectedMaskId === id || selectedMaskIds.includes(id));
  });
}


function addPdfMaskOverlays(pageWrap, pdf, pageNumber) {
  (pdf.masks || []).filter(mask => Number(mask.page) === pageNumber).forEach(mask => {
    pageWrap.appendChild(createPdfMaskElement(pageWrap, pdf, mask));
  });
}










function getSavedPdfPageImageUrl(page) {
  if (!page) return "";
  return page.imageUrl || page.url || page.downloadUrl || page.src || "";
}

function getPdfPageImagePath(page) {
  if (!page) return "";
  return page.imagePath || page.path || page.storagePath || "";
}

async function resolvePdfPageImageUrl(pdf, page) {
  if (!page) return "";

  const imagePath = getPdfPageImagePath(page);
  if (getStorage() && imagePath) {
    const refObj = storageRef(getStorage(), imagePath);
    const freshUrl = await getDownloadURL(refObj);

    page.imagePath = imagePath;
    page.imageUrl = freshUrl;
    page.url = freshUrl;

    const material = pdfMaterials.find(item => item.id === pdf.id);
    if (material && Array.isArray(material.pages)) {
      const targetPage = material.pages.find(item => String(item.page) === String(page.page));
      if (targetPage) {
        targetPage.imagePath = imagePath;
        targetPage.imageUrl = freshUrl;
        targetPage.url = freshUrl;
      }
    }

    return freshUrl;
  }

  return getSavedPdfPageImageUrl(page);
}

async function setPdfImageSource(
  img,
  pdf,
  page,
  setErrorStatus = setPdfStatus,
  saveResolvedUrl = true
) {
  try {
    const src = await resolvePdfPageImageUrl(pdf, page);

    if (!src) {
      throw new Error("画像URLが空です。");
    }

    img.dataset.storageErrorCategory = "";
    img.src = src;
    if (saveResolvedUrl) requestAutoSave();
  } catch (error) {
    console.error(error);
    const category = classifyStorageError(error);
    img.dataset.storageErrorCategory = category;

    const fallback = getSavedPdfPageImageUrl(page);
    if (fallback) {
      img.src = fallback;
      return;
    }

    img.alt = "画像URLを取得できません";
    setErrorStatus(getPdfImageLoadFailureMessage(category, page.page));
  }
}

function renderPdfEditPreview() {
  if (!el.pdfEditPreview) return;
  const pdf = currentEditingPdfMaterial();
  const renderToken = ++pdfRenderToken;

  if (!pdf) {
    el.pdfEditPreview.innerHTML = "<div>編集する画像教材を選択してください。</div>";
    return;
  }

  const pages = Array.isArray(pdf.pages) ? pdf.pages : [];
  el.pdfEditPreview.innerHTML = "";

  if (pages.length) {
    pages.forEach(page => {
      const pageWrap = document.createElement("div");
      pageWrap.className = "pdf-edit-preview-page";

      const img = document.createElement("img");
      img.alt = page.imageName || `${page.page || 1}ページ`;
      img.loading = "eager";
      img.draggable = false;
      img.addEventListener("error", () => {
        if (renderToken === pdfRenderToken) {
          const category = img.dataset.storageErrorCategory || "image-error";
          setPdfEditStatus(getPdfImageLoadFailureMessage(category, page.page || 1));
        }
      });

      pageWrap.appendChild(img);
      el.pdfEditPreview.appendChild(pageWrap);
      setPdfImageSource(img, pdf, page, setPdfEditStatus, false);
    });
    return;
  }

  if (pdf.pdfUrl) {
    el.pdfEditPreview.innerHTML = `
      <iframe
        src="${escapeHtml(pdf.pdfUrl)}"
        title="${escapeHtml(pdf.title || "旧PDF")}"
        style="width:100%;height:58vh;border:0;background:#fff;">
      </iframe>
    `;
    return;
  }

  el.pdfEditPreview.innerHTML = "<div>画像URLがありません。</div>";
}

async function deletePdfStorageFiles(pdf) {
  if (!getStorage() || !pdf || !Array.isArray(pdf.pages)) return;

  const paths = [...new Set(
    pdf.pages
      .map(page => page.imagePath || page.path || page.storagePath)
      .filter(Boolean)
  )];

  await Promise.all(paths.map(async path => {
    try {
      await deleteObject(storageRef(getStorage(), path));
    } catch (error) {
      console.warn("Storage画像削除をスキップしました:", path, error);
    }
  }));
}


function renderPdfViewer(preserveScroll = false) {
  const snapshot = preserveScroll ? getScrollSnapshot() : null;
  const pdf = currentPdfMaterial();
  if (!el.pdfViewerArea) return;

  attachPdfViewerZoomEvents();
  el.pdfViewerArea.classList.toggle("is-add-mask-mode", pdfAddMaskMode);

  if (!pdf) {
    el.pdfViewerArea.innerHTML = "<div>画像教材を選択してください。</div>";
    setPdfStatus("画像教材を選択してください。");
    restoreScrollSnapshot(snapshot);
    return;
  }

  const pages = Array.isArray(pdf.pages) ? pdf.pages : [];
  el.pdfViewerArea.innerHTML = "";

  if (pages.length) {
    pages.forEach(page => {
      const pageNumber = Number(page.page || 1);
      const pageWrap = document.createElement("div");
      pageWrap.className = "pdf-page-wrap";
      pageWrap.dataset.page = String(pageNumber);

      const label = document.createElement("div");
      label.className = "pdf-page-label";
      label.textContent = `${pageNumber}ページ`;
      pageWrap.appendChild(label);

      const img = document.createElement("img");
      img.alt = page.imageName || `${pageNumber}ページ`;
      img.loading = "eager";
      img.draggable = false;

      const onLoadImage = () => {
        if (img.naturalWidth && img.naturalHeight) {
          pageWrap.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
        }

        addPdfMaskOverlays(pageWrap, pdf, pageNumber);
        attachPdfPageDragEvents(pageWrap, pageNumber);
        applyPdfZoom();
        restoreScrollSnapshot(snapshot);
      };

      img.addEventListener("load", onLoadImage, { once: true });

      img.addEventListener("error", () => {
        const category = img.dataset.storageErrorCategory || "image-error";
        setPdfStatus(getPdfImageLoadFailureMessage(category, pageNumber));
      });

      pageWrap.appendChild(img);
      el.pdfViewerArea.appendChild(pageWrap);

      // 保存済みURLではなく、表示時にimagePathから最新URLを取得して表示する。
      // Use a fresh URL from imagePath when rendering, instead of relying only on the saved URL.
      setPdfImageSource(img, pdf, page);
    });

    applyPdfZoom();
    setPdfStatus("画像教材を表示しています。Storageから最新URLを取得します。");
    restoreScrollSnapshot(snapshot);
    return;
  }

  if (pdf.pdfUrl) {
    el.pdfViewerArea.innerHTML = `
      <iframe
        src="${pdf.pdfUrl}"
        title="${escapeHtml(pdf.title || "旧PDF")}"
        style="width:100%;height:70vh;border:none;border-radius:12px;background:#fff;">
      </iframe>
    `;
    setPdfStatus("旧PDF教材を表示しました。画像版で使う場合はPDFを登録し直してください。");
    restoreScrollSnapshot(snapshot);
    return;
  }

  el.pdfViewerArea.innerHTML = "<div>画像URLがありません。</div>";
  setPdfStatus("画像URLがありません。画像教材を登録し直してください。");
  restoreScrollSnapshot(snapshot);
}




  function serialize() {
    return {
      pdfMaterials,
      pdfRevealStates,
      selectedPdfId,
      selectedMaskId,
      pdfSearchQuery,
      pdfSubjectFilter,
      pdfCategoryFilter,
      pdfViewMode
    };
  }

  function apply(persistedState = {}) {
    pdfMaterials = Array.isArray(persistedState.pdfMaterials)
      ? persistedState.pdfMaterials.map(pdf => normalizeImageMaterial({
          ...pdf,
          masks: Array.isArray(pdf.masks)
            ? pdf.masks.map(mask => ({ ...mask, weak: mask.weak === true }))
            : []
        }))
      : [];
    selectedPdfId = persistedState.selectedPdfId || null;
    editingPdfId = null;
    pdfDeleteSelectedIds = [];
    selectedMaskId = persistedState.selectedMaskId || null;
    selectedMaskIds = [];
    pdfRevealStates = persistedState.pdfRevealStates || {};
    pdfSearchQuery = persistedState.pdfSearchQuery || "";
    const legacySelectedTags = Array.isArray(persistedState.selectedPdfTags)
      ? persistedState.selectedPdfTags
      : [];
    pdfSubjectFilter = persistedState.pdfSubjectFilter || "all";
    pdfCategoryFilter = persistedState.pdfCategoryFilter ||
      persistedState.pdfSelectedTagFilter ||
      legacySelectedTags[0] ||
      "";
    pdfViewMode = persistedState.pdfViewMode === "edit" ? "edit" : "study";
    pdfViewerFullscreen = false;
    el.pdfViewerShell?.classList.remove("is-fullscreen");
    document.body.classList.remove("has-pdf-viewer-fullscreen");
    if (el.pdfFullscreenBtn) {
      el.pdfFullscreenBtn.setAttribute("aria-pressed", "false");
      el.pdfFullscreenBtn.setAttribute("aria-label", "教材画像を全画面表示");
      el.pdfFullscreenBtn.title = "教材画像を全画面表示";
      el.pdfFullscreenBtn.textContent = "⛶";
    }
    pdfAddMaskMode = false;
    pdfDraft = null;

    if (selectedPdfId && !pdfMaterials.some(pdf => pdf.id === selectedPdfId)) {
      selectedPdfId = null;
      selectedMaskId = null;
    }
    fillPdfEditorForm(null);
    renderPdfViewMode();
  }

  function bindEvents() {
    el.addPdfBtn?.addEventListener("click", () => addPdfMaterial().catch(console.error));
    el.updatePdfBtn?.addEventListener("click", () => updatePdfMaterial().catch(console.error));
    el.clearPdfEditorBtn?.addEventListener("click", clearPdfEditorForm);
    el.pdfSelectAllDeleteBtn?.addEventListener("click", () => {
      pdfDeleteSelectedIds = pdfMaterials
        .filter(pdf => pdf.id !== editingPdfId)
        .map(pdf => pdf.id);
      renderPdfTable();
    });
    el.pdfClearDeleteSelectionBtn?.addEventListener("click", () => {
      pdfDeleteSelectedIds = [];
      renderPdfTable();
    });
    el.pdfDeleteCheckedBtn?.addEventListener("click", () => deleteCheckedPdfMaterials().catch(console.error));
    el.pdfFullscreenBtn?.addEventListener("click", () => {
      setPdfViewerFullscreen(!pdfViewerFullscreen);
    });
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && pdfViewerFullscreen) {
        setPdfViewerFullscreen(false);
      }
    });
    el.pdfStudyModeBtn?.addEventListener("click", () => setPdfViewMode("study"));
    el.pdfEditModeBtn?.addEventListener("click", () => setPdfViewMode("edit"));
    el.pdfSearchInput?.addEventListener("input", event => {
      pdfSearchQuery = event.currentTarget.value || "";
      renderPdfTable();
      requestAutoSave();
    });
    el.pdfSubjectFilterSelect?.addEventListener("change", event => {
      pdfSubjectFilter = event.currentTarget.value || "all";
      pdfCategoryFilter = "";
      renderPdfTable();
      requestAutoSave();
    });
    el.pdfCategoryFilterSelect?.addEventListener("change", event => {
      pdfCategoryFilter = event.currentTarget.value || "";
      renderPdfTable();
      requestAutoSave();
    });
    el.pdfSubjectInput?.addEventListener("input", renderPdfEditorOptions);
    el.addMaskModeBtn?.addEventListener("click", togglePdfAddMaskMode);
    el.updateMaskBtn?.addEventListener("click", updatePdfMaskFromForm);
    el.deleteMaskBtn?.addEventListener("click", deletePdfMask);
    el.clearMaskSelectionBtn?.addEventListener("click", clearPdfMaskSelection);
    el.selectAllMasksBtn?.addEventListener("click", selectAllMasks);
    el.markWeakMaskBtn?.addEventListener("click", toggleWeakMasks);
    el.showAllMasksBtn?.addEventListener("click", showAllMasks);
    el.resetPdfRevealBtn?.addEventListener("click", resetPdfRevealState);
  }

  return {
    apply,
    bindEvents,
    ensureFilterUi: renderPdfFilterUi,
    render: renderPdfTable,
    renderMasks: renderPdfMaskTable,
    renderEditor: renderPdfEditPreview,
    renderViewer: renderPdfViewer,
    serialize
  };
}
