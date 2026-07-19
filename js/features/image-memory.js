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

export function createImageMemory(dependencies) {
  const {
    el,
    getCurrentUser,
    getStorage,
    requestAutoSave,
    requestSave
  } = dependencies;

  let pdfSelectedTagFilter = "";
  let pdfMaterials = [];
  let selectedPdfId = null;
  let pdfSearchQuery = "";
  let selectedPdfTags = [];
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
  let pdfPinchStartCenter = null;
  let pdfPinchStartViewerScroll = null;

function currentPdfMaterial() {
  return pdfMaterials.find(pdf => pdf.id === selectedPdfId) || null;
}

function currentPdfMask() {
  const pdf = currentPdfMaterial();
  if (!pdf) return null;
  return (pdf.masks || []).find(mask => mask.id === selectedMaskId) || null;
}

function setPdfStatus(message) {
  if (el.pdfStatus) el.pdfStatus.textContent = message;
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


function pdfTagsToText(tags) {
  return normalizePdfTags(tags).join(",");
}

function ensurePdfTagUi() {
  if (document.getElementById("pdfSearchInput")) return;

  const toolbar = document.querySelector("#tab-pdf .pdf-toolbar");
  if (!toolbar) return;

  const box = document.createElement("div");
  box.id = "pdfTagSearchBox";
  box.innerHTML = `
    <div class="grid2" style="margin-bottom:10px;">
      <input id="pdfSearchInput" placeholder="教材名・タグ名で検索">
      <input id="pdfTagInput" placeholder="タグ名（複数は読点・カンマ区切り）">
    </div>
    <div class="subcat-box" style="margin-bottom:12px;">
      <div class="subcat-title">タグを選択できます（未選択なら全件）</div>
      <div class="subcat-list" id="pdfTagChipList"></div>
    </div>
  `;

  toolbar.insertAdjacentElement("afterend", box);

  const searchInput = document.getElementById("pdfSearchInput");
  searchInput.value = pdfSearchQuery || "";
  searchInput.addEventListener("input", () => {
    pdfSearchQuery = searchInput.value || "";
    renderPdfTable();
  renderPdfFilterDropdownUi();
  });
}

function getPdfTagInput() {
  ensurePdfTagUi();
  return document.getElementById("pdfTagInput");
}

function getPdfSearchInput() {
  ensurePdfTagUi();
  return document.getElementById("pdfSearchInput");
}

function getPdfTagChipList() {
  ensurePdfTagUi();
  return document.getElementById("pdfTagChipList");
}

function getAvailablePdfTags() {
  return [...new Set(
    pdfMaterials.flatMap(pdf => Array.isArray(pdf.tags) ? pdf.tags : [])
  )].sort();
}

function getFilteredPdfMaterials() {
  const query = (pdfSearchQuery || "").trim().toLowerCase();

  return pdfMaterials.filter(pdf => {
    const tags = Array.isArray(pdf.tags) ? pdf.tags : [];
    const searchText = [
      pdf.title || "",
      pdf.pdfName || "",
      pdf.sourceName || "",
      tags.join(" ")
    ].join(" ").toLowerCase();

    const matchesQuery = !query || searchText.includes(query);
    const matchesTags = !selectedPdfTags.length || selectedPdfTags.every(tag => tags.includes(tag));
    return matchesQuery && matchesTags;
  });
}

function renderPdfTagChips() {
  const chipList = getPdfTagChipList();
  if (!chipList) return;

  const tags = getAvailablePdfTags();
  selectedPdfTags = selectedPdfTags.filter(tag => tags.includes(tag));

  if (!tags.length) {
    chipList.innerHTML = '<span class="subcat-title">タグなし</span>';
    return;
  }

  chipList.innerHTML = tags.map(tag => `
    <button type="button" class="subcat-chip ${selectedPdfTags.includes(tag) ? "active" : ""}" data-pdf-tag="${escapeHtml(tag)}">
      ${escapeHtml(tag)}
    </button>
  `).join("");

  [...chipList.querySelectorAll("[data-pdf-tag]")].forEach(btn => {
    btn.addEventListener("click", () => {
      const tag = btn.dataset.pdfTag;
      if (selectedPdfTags.includes(tag)) {
        selectedPdfTags = selectedPdfTags.filter(item => item !== tag);
      } else {
        selectedPdfTags = [...selectedPdfTags, tag];
      }
      renderPdfTagChips();
      renderPdfTable();
    });
  });
}



function getAvailablePdfTagList() {
  return [...new Set(pdfMaterials.flatMap(item => Array.isArray(item.tags) ? item.tags : []).filter(Boolean))].sort();
}

function ensurePdfFilterDropdownUi() {
  if (document.getElementById("pdfTagFilterSelect")) return;
  const table = el.pdfTableBody?.closest(".table-wrap") || el.pdfTableBody?.closest("table");
  if (!table) return;
  const panel = document.createElement("div");
  panel.id = "pdfFilterPanel";
  panel.className = "pdf-filter-panel";
  panel.innerHTML = `<select id="pdfTagFilterSelect"><option value="">全タグ</option></select>`;
  table.insertAdjacentElement("beforebegin", panel);
  document.getElementById("pdfTagFilterSelect").addEventListener("change", () => {
    pdfSelectedTagFilter = document.getElementById("pdfTagFilterSelect").value || "";
    renderPdfTable();
  });
}

function renderPdfFilterDropdownUi() {
  ensurePdfFilterDropdownUi();
  const select = document.getElementById("pdfTagFilterSelect");
  if (!select) return;
  const tags = getAvailablePdfTagList();
  if (pdfSelectedTagFilter && !tags.includes(pdfSelectedTagFilter)) pdfSelectedTagFilter = "";
  select.innerHTML = `<option value="">全タグ</option>` +
    tags.map(tag => `<option value="${escapeHtml(tag)}" ${tag === pdfSelectedTagFilter ? "selected" : ""}>${escapeHtml(tag)}</option>`).join("");
}

function pdfMatchesDropdownFilter(pdf) {
  if (!pdfSelectedTagFilter) return true;
  const tags = Array.isArray(pdf.tags) ? pdf.tags : [];
  return tags.includes(pdfSelectedTagFilter);
}


















function renderPdfTable() {
  if (!el.pdfTableBody) return;

  ensurePdfTagUi();
  renderPdfTagChips();

  renderPdfFilterDropdownUi();
  const filteredMaterials = getFilteredPdfMaterials().filter(pdfMatchesDropdownFilter);

  if (!filteredMaterials.length) {
    el.pdfTableBody.innerHTML = '<tr><td colspan="4">該当する画像教材がありません。</td></tr>';
    return;
  }

  el.pdfTableBody.innerHTML = filteredMaterials.map(pdf => {
    const revealMap = getPdfRevealMap(pdf.id);
    const masks = Array.isArray(pdf.masks) ? pdf.masks : [];
    const pages = Array.isArray(pdf.pages) ? pdf.pages : [];
    const revealed = masks.filter(mask => revealMap[mask.id]).length;
    const fileLabel = pages.length
      ? `${pages.length}枚`
      : (pdf.pdfName || "旧PDF");
    const tags = normalizePdfTags(pdf.tags || []);
    const tagHtml = tags.length
      ? `<div style="font-size:12px;color:#6b7280;margin-top:4px;">${escapeHtml(tags.join(" / "))}</div>`
      : "";
    return `
      <tr class="${selectedPdfId === pdf.id ? "selected" : ""}" data-pdf-id="${pdf.id}">
        <td>${escapeHtml(pdf.title || "無題教材")}${tagHtml}</td>
        <td>${masks.length}</td>
        <td>${revealed}</td>
        <td>${escapeHtml(fileLabel)}</td>
      </tr>
    `;
  }).join("");

  [...el.pdfTableBody.querySelectorAll("tr[data-pdf-id]")].forEach(row => {
    row.addEventListener("click", () => {
      selectedPdfId = row.dataset.pdfId;
      selectedMaskId = null;
      selectedMaskIds = [];
      pdfAddMaskMode = false;
      if (el.pdfViewerArea) el.pdfViewerArea.classList.remove("is-add-mask-mode");
      const pdf = currentPdfMaterial();
      el.pdfTitleInput.value = pdf?.title || "";
      const tagInput = getPdfTagInput();
      if (tagInput) tagInput.value = pdfTagsToText(pdf?.tags || []);
      fillPdfMaskForm(null);
      renderPdfTable();
      renderPdfMaskTable();
      renderPdfViewer();
      requestAutoSave();
    });
  });
}

function renderPdfMaskTable() {
  if (!el.pdfMaskTableBody) return;
  const pdf = currentPdfMaterial();
  if (!pdf) {
    el.pdfMaskTableBody.innerHTML = '<tr><td colspan="5">画像教材を選択してください。</td></tr>';
    return;
  }
  const masks = Array.isArray(pdf.masks) ? pdf.masks : [];
  if (!masks.length) {
    el.pdfMaskTableBody.innerHTML = '<tr><td colspan="5">隠し範囲がありません。</td></tr>';
    return;
  }

  el.pdfMaskTableBody.innerHTML = masks.map(mask => `
    <tr class="${selectedMaskId === mask.id || selectedMaskIds.includes(mask.id) ? "selected" : ""}" data-mask-id="${mask.id}">
      <td>${mask.page}</td>
      <td>${formatPercent(mask.x)}%</td>
      <td>${formatPercent(mask.y)}%</td>
      <td>${formatPercent(mask.width)}%</td>
      <td>${formatPercent(mask.height)}%</td>
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


async function addPdfMaterial() {
  if (!getCurrentUser()) return;

  ensurePdfTagUi();
  const title = el.pdfTitleInput.value.trim();
  const tagInput = getPdfTagInput();
  const tags = normalizePdfTags(textToTagList(tagInput ? tagInput.value : ""));
  const selectedFiles = Array.from(el.pdfFileInput.files || []);

  if (!title) {
    alert("教材タイトルを入力してください。");
    return;
  }
  if (!selectedFiles.length) {
    alert("PDFまたは画像ファイルを選んでください。");
    return;
  }

  const pdfFiles = selectedFiles.filter(file => file.type === "application/pdf" || /\.pdf$/i.test(file.name));
  const imageFiles = selectedFiles.filter(file => file.type.startsWith("image/") || /\.(jpg|jpeg|png|webp)$/i.test(file.name));

  if (pdfFiles.length && imageFiles.length) {
    alert("PDFと画像は同時に登録できません。PDFだけ、または画像だけを選んでください。");
    return;
  }
  if (pdfFiles.length > 1) {
    alert("PDFは1ファイルずつ登録してください。複数ページPDFは自動でページごとに画像化されます。");
    return;
  }

  const pdfId = crypto.randomUUID();
  let filesToUpload = [];

  try {
    if (pdfFiles.length === 1) {
      const pdfFile = pdfFiles[0];
      setPdfStatus("PDFを画像に変換しています...");

      filesToUpload = await convertPdfToImageFiles(pdfFile, (page, total, stage) => {
        if (stage === "converting") {
          setPdfStatus(`PDFを画像に変換しています... ${page}/${total}ページ`);
        }
      });

      if (!filesToUpload.length) {
        alert("PDFから画像を作成できませんでした。");
        setPdfStatus("PDFから画像を作成できませんでした。");
        return;
      }
    } else {
      filesToUpload = imageFiles;
    }

    setPdfStatus(`画像をアップロードしています... 0/${filesToUpload.length}`);

    const pages = [];
    for (let index = 0; index < filesToUpload.length; index++) {
      const pageNumber = index + 1;
      const meta = await uploadPdfFile(pdfId, filesToUpload[index], pageNumber);
      pages.push({ page: pageNumber, ...meta });
      setPdfStatus(`画像をアップロードしています... ${pageNumber}/${filesToUpload.length}`);
    }

    pdfMaterials.push({
      id: pdfId,
      title,
      pages,
      masks: [],
      tags,
      sourceType: pdfFiles.length === 1 ? "pdf-converted" : "images",
      sourceName: pdfFiles.length === 1 ? pdfFiles[0].name : ""
    });

    selectedPdfId = pdfId;
    selectedMaskId = null;
    el.pdfFileInput.value = "";
    renderPdfTable();
    renderPdfMaskTable();
    renderPdfViewer();
    setPdfStatus("教材を追加しました。PDFは画像として保存済みです。隠したい範囲をドラッグで追加できます。");
    requestAutoSave();
  } catch (error) {
    console.error(error);
    setPdfStatus("教材追加に失敗しました。\n" + (error.message || error));
    alert("教材追加に失敗しました。\n\n" + (error.message || error));
  }
}

function updatePdfMaterialTitle() {
  if (!getCurrentUser()) return;
  const pdf = currentPdfMaterial();
  if (!pdf) {
    alert("更新したい画像教材を選択してください。");
    return;
  }
  const title = el.pdfTitleInput.value.trim();
  if (!title) {
    alert("画像教材タイトルを入力してください。");
    return;
  }

  ensurePdfTagUi();
  const tagInput = getPdfTagInput();

  pdf.title = title;
  pdf.tags = normalizePdfTags(textToTagList(tagInput ? tagInput.value : ""));

  renderPdfTable();
  renderPdfTagChips();
  setPdfStatus("画像教材タイトルとタグを更新しました。");
  requestAutoSave();
}

async function deletePdfMaterial() {
  if (!getCurrentUser()) return;

  const pdf = currentPdfMaterial();
  if (!pdf) {
    alert("削除したい画像教材を選択してください。");
    return;
  }

  const title = pdf.title || "無題教材";

  const ok = confirm(
    "この画像教材を削除しますか？\n\n" +
    "Firestoreの教材データとStorage上の画像ファイルを削除します。\n\n" +
    "教材：" + title
  );
  if (!ok) return;

  try {
    setPdfStatus("画像教材を削除しています...");
    await deletePdfStorageFiles(pdf);
  } catch (error) {
    console.warn(error);
  }

  pdfMaterials = pdfMaterials.filter(item => item.id !== pdf.id);

  if (selectedPdfId === pdf.id) {
    selectedPdfId = pdfMaterials[0]?.id || null;
  }

  selectedMaskId = null;
  selectedMaskIds = [];

  renderPdfTable();
  renderPdfMaskTable();
  renderPdfViewer();
  setPdfStatus("画像教材を削除しました。");

  await requestSave({
    allowEmptyPdfMaterials: true,
    showAlerts: true
  });
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
  el.pdfViewerArea.querySelectorAll(".pdf-page-wrap").forEach(pageWrap => {
    pageWrap.style.width = `${pdfZoom * 100}%`;
    pageWrap.style.maxWidth = `${920 * pdfZoom}px`;
  });
}

function attachPdfViewerZoomEvents() {
  if (!el.pdfViewerArea || pdfZoomEventsAttached) return;
  pdfZoomEventsAttached = true;

  el.pdfViewerArea.addEventListener("touchstart", (event) => {
    if (event.touches.length === 2) {
      event.preventDefault();
      pdfPinchStartDistance = getTouchDistance(event.touches);
      pdfPinchStartCenter = getTouchCenter(event.touches);
      pdfPinchStartZoom = pdfZoom;
      pdfPinchStartViewerScroll = {
        top: el.pdfViewerArea.scrollTop,
        left: el.pdfViewerArea.scrollLeft
      };
    }
  }, { passive: false });

  el.pdfViewerArea.addEventListener("touchmove", (event) => {
    if (event.touches.length === 2 && pdfPinchStartDistance && pdfPinchStartCenter && pdfPinchStartViewerScroll) {
      event.preventDefault();
      event.stopPropagation();

      const currentDistance = getTouchDistance(event.touches);
      const currentCenter = getTouchCenter(event.touches);

      pdfZoom = clampPdfZoom(pdfPinchStartZoom * (currentDistance / pdfPinchStartDistance));
      applyPdfZoom();

      // 2本指のまま動かした分だけ画像表示エリアを移動する。
      // Move the viewer while two fingers are moving.
      el.pdfViewerArea.scrollLeft = pdfPinchStartViewerScroll.left - (currentCenter.x - pdfPinchStartCenter.x);
      el.pdfViewerArea.scrollTop = pdfPinchStartViewerScroll.top - (currentCenter.y - pdfPinchStartCenter.y);
    }
  }, { passive: false });

  el.pdfViewerArea.addEventListener("touchend", (event) => {
    if (event.touches.length < 2) {
      pdfPinchStartDistance = null;
      pdfPinchStartCenter = null;
      pdfPinchStartViewerScroll = null;
      pdfPinchStartZoom = pdfZoom;
    }
  }, { passive: false });

  el.pdfViewerArea.addEventListener("touchcancel", () => {
    pdfPinchStartDistance = null;
    pdfPinchStartCenter = null;
    pdfPinchStartViewerScroll = null;
    pdfPinchStartZoom = pdfZoom;
  }, { passive: false });

  el.pdfViewerArea.addEventListener("gesturestart", (event) => {
    event.preventDefault();
    pdfGestureStartZoom = pdfZoom;
  }, { passive: false });

  el.pdfViewerArea.addEventListener("gesturechange", (event) => {
    event.preventDefault();
    pdfZoom = clampPdfZoom(pdfGestureStartZoom * event.scale);
    applyPdfZoom();
  }, { passive: false });

  el.pdfViewerArea.addEventListener("gestureend", (event) => {
    event.preventDefault();
    pdfGestureStartZoom = pdfZoom;
  }, { passive: false });

  el.pdfViewerArea.addEventListener("wheel", (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const direction = event.deltaY > 0 ? -0.08 : 0.08;
    pdfZoom = clampPdfZoom(pdfZoom + direction);
    applyPdfZoom();
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
    height: Number(height.toFixed(2))
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

  el.pdfViewerArea.querySelectorAll(".pdf-mask").forEach(maskEl => {
    const id = maskEl.dataset.maskId;
    maskEl.classList.toggle("revealed", !!revealMap[id]);
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

async function setPdfImageSource(img, pdf, page) {
  try {
    const src = await resolvePdfPageImageUrl(pdf, page);

    if (!src) {
      throw new Error("画像URLが空です。");
    }

    img.dataset.storageErrorCategory = "";
    img.src = src;
    requestAutoSave();
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
    setPdfStatus(getPdfImageLoadFailureMessage(category, page.page));
  }
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
      selectedPdfTags,
      pdfSelectedTagFilter
    };
  }

  function apply(persistedState = {}) {
    pdfMaterials = Array.isArray(persistedState.pdfMaterials)
      ? persistedState.pdfMaterials.map(pdf => ({
          ...pdf,
          masks: Array.isArray(pdf.masks) ? pdf.masks : [],
          tags: normalizePdfTags(pdf.tags || [])
        }))
      : [];
    selectedPdfId = persistedState.selectedPdfId || null;
    selectedMaskId = persistedState.selectedMaskId || null;
    selectedMaskIds = [];
    pdfRevealStates = persistedState.pdfRevealStates || {};
    pdfSearchQuery = persistedState.pdfSearchQuery || "";
    selectedPdfTags = Array.isArray(persistedState.selectedPdfTags) ? persistedState.selectedPdfTags : [];
    pdfSelectedTagFilter = persistedState.pdfSelectedTagFilter || "";
    pdfAddMaskMode = false;
    pdfDraft = null;

    ensurePdfTagUi();
    const searchInput = getPdfSearchInput();
    if (searchInput) searchInput.value = pdfSearchQuery;
    if (selectedPdfId && !pdfMaterials.some(pdf => pdf.id === selectedPdfId)) {
      selectedPdfId = null;
      selectedMaskId = null;
    }
  }

  function bindEvents() {
    el.addPdfBtn?.addEventListener("click", () => addPdfMaterial().catch(console.error));
    el.updatePdfBtn?.addEventListener("click", updatePdfMaterialTitle);
    el.deletePdfBtn?.addEventListener("click", () => deletePdfMaterial().catch(console.error));
    el.addMaskModeBtn?.addEventListener("click", togglePdfAddMaskMode);
    el.updateMaskBtn?.addEventListener("click", updatePdfMaskFromForm);
    el.deleteMaskBtn?.addEventListener("click", deletePdfMask);
    el.clearMaskSelectionBtn?.addEventListener("click", clearPdfMaskSelection);
    el.selectAllMasksBtn?.addEventListener("click", selectAllMasks);
    el.showAllMasksBtn?.addEventListener("click", showAllMasks);
    el.resetPdfRevealBtn?.addEventListener("click", resetPdfRevealState);
  }

  return {
    apply,
    bindEvents,
    ensureFilterUi: renderPdfFilterDropdownUi,
    ensureTagUi: ensurePdfTagUi,
    render: renderPdfTable,
    renderMasks: renderPdfMaskTable,
    renderViewer: renderPdfViewer,
    serialize
  };
}
