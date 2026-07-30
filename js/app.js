import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js";
import { initializeFirebaseServices } from "./config/firebase.js";
import { restoreLegacyQuestionStatuses } from "./core/cloud-sync-state.js";
import { createSaveCoordinator } from "./core/save-coordinator.js";
import {
  escapeDisplayText,
  escapeHtml,
  formatDisplayText,
  normalizeQuestionAnswers,
  normalizeSubcategories
} from "./core/text-utils.js";
import {
  compareAnswerLists,
  diffAnswerLists,
  isOrderSensitiveQuestion,
  normalizeAnswerForComparison
} from "./core/answer-comparison.js";
import {
  calculateStudyCounters,
  filterQuestionsForStudy,
  getStudyPrimaryCategories,
  getStudyRelatedCategories,
  getStudySubjects,
  migrateStudyConditionGroups,
  normalizeStudyCondition,
  normalizeStudyConditionGroups
} from "./core/study-filters.js";
import { createImageMemory } from "./features/image-memory.js";
import { createQuestionManager } from "./features/question-manager.js";
import {
  CloudSaveConflictError,
  readCloudState,
  UnsafeEmptyOverwriteError,
  writeSplitDocuments
} from "./services/cloud-store.js";


window.addEventListener("error", event => {
  console.error(event.error || event.message);
  const status = document.getElementById("cloudStatus");
  if (status) status.textContent = "画面処理でエラーが出ました。\n" + (event.message || event.error || "");
});

window.addEventListener("unhandledrejection", event => {
  console.error(event.reason);
  const status = document.getElementById("cloudStatus");
  if (status) status.textContent = "非同期処理でエラーが出ました。\n" + (event.reason?.message || event.reason || "");
});

let app = null;
let auth = null;
let db = null;
let storage = null;
let currentUser = null;

let allQuestions = [];
let filteredQuestions = [];
let currentIndex = 0;
let wrongQuestionIds = [];
let deviceMode = "iphone";
let subjectFilter = "all";
let selectedSubcategories = [];
let selectedPrimarySubcategory = "";
let studyConditionGroups = [];
let migratedLegacyStudyFilters = false;
let orderMode = "sequential";
let progress = {};
let questionStatuses = {};
let studyMode = "normal";
let isApplyingCloudState = false;
let authEpoch = 0;
let syncPhase = "signed-out";
let activeSyncSession = null;

const el = {
  cloudStatus: document.getElementById("cloudStatus"),
  question: document.getElementById("question"),
  answerBox: document.getElementById("answerBox"),
  explainBox: document.getElementById("explainBox"),
  judgeStatus: document.getElementById("judgeStatus"),
  userAnswer: document.getElementById("userAnswer"),
  multiAnswerArea: document.getElementById("multiAnswerArea"),
  iphoneArea: document.getElementById("iphoneArea"),
  ipadArea: document.getElementById("ipadArea"),
  totalCount: document.getElementById("totalCount"),
  currentCount: document.getElementById("currentCount"),
  correctCount: document.getElementById("correctCount"),
  wrongCount: document.getElementById("wrongCount"),
  studyMeta: document.getElementById("studyMeta"),
  subjectFilter: document.getElementById("subjectFilter"),
  primarySubcategorySelect: document.getElementById("primarySubcategorySelect"),
  relatedSubcategoryChecklist: document.getElementById("relatedSubcategoryChecklist"),
  conditionGroupList: document.getElementById("conditionGroupList"),
  addConditionGroupBtn: document.getElementById("addConditionGroupBtn"),
  clearCurrentConditionBtn: document.getElementById("clearCurrentConditionBtn"),
  studyFilterMigrationNotice: document.getElementById("studyFilterMigrationNotice"),
  forceResetStudyFiltersBtn: document.getElementById("forceResetStudyFiltersBtn"),
  editSubcategories: document.getElementById("editSubcategories"),
  orderMode: document.getElementById("orderMode"),
  chooseIphone: document.getElementById("chooseIphone"),
  chooseIpad: document.getElementById("chooseIpad"),
  questionTableBody: document.getElementById("questionTableBody"),
  progressTableBody: document.getElementById("progressTableBody"),
  editSubject: document.getElementById("editSubject"),
  editQuestion: document.getElementById("editQuestion"),
  editAnswers: document.getElementById("editAnswers"),
  editExplanation: document.getElementById("editExplanation"),
  editOrderedAnswers: document.getElementById("editOrderedAnswers"),
  searchInput: document.getElementById("searchInput"),
  emailInput: document.getElementById("emailInput"),
  passwordInput: document.getElementById("passwordInput"),
  authStatus: document.getElementById("authStatus"),
  questionImageWrap: document.getElementById("questionImageWrap"),
  questionImage: document.getElementById("questionImage"),
  editImageFile: document.getElementById("editImageFile"),
  removeImageBtn: document.getElementById("removeImageBtn"),
  editImageName: document.getElementById("editImageName"),
  imagePreviewWrap: document.getElementById("imagePreviewWrap"),
  imagePreview: document.getElementById("imagePreview"),
  imageStatusText: document.getElementById("imageStatusText"),
  bulkImportFile: document.getElementById("bulkImportFile"),
  bulkImportImageFiles: document.getElementById("bulkImportImageFiles"),
  bulkImportValidateBtn: document.getElementById("bulkImportValidateBtn"),
  bulkImportExecuteBtn: document.getElementById("bulkImportExecuteBtn"),
  bulkImportResetBtn: document.getElementById("bulkImportResetBtn"),
  bulkImportStatus: document.getElementById("bulkImportStatus"),
  tabBtnStudy: document.getElementById("tabBtnStudy"),
  tabBtnManage: document.getElementById("tabBtnManage"),
  tabBtnAuth: document.getElementById("tabBtnAuth"),
  tabBtnProgress: document.getElementById("tabBtnProgress"),
  studyLockBanner: document.getElementById("studyLockBanner"),
  manageLockBanner: document.getElementById("manageLockBanner"),
  progressLockBanner: document.getElementById("progressLockBanner"),
  pdfLockBanner: document.getElementById("pdfLockBanner"),
  tabBtnPdf: document.getElementById("tabBtnPdf"),
  pdfStudyModeBtn: document.getElementById("pdfStudyModeBtn"),
  pdfEditModeBtn: document.getElementById("pdfEditModeBtn"),
  pdfStudyView: document.getElementById("pdfStudyView"),
  pdfEditView: document.getElementById("pdfEditView"),
  pdfSearchInput: document.getElementById("pdfSearchInput"),
  pdfSubjectFilterSelect: document.getElementById("pdfSubjectFilterSelect"),
  pdfCategoryFilterSelect: document.getElementById("pdfCategoryFilterSelect"),
  pdfTitleInput: document.getElementById("pdfTitleInput"),
  pdfSubjectInput: document.getElementById("pdfSubjectInput"),
  pdfSubjectOptions: document.getElementById("pdfSubjectOptions"),
  pdfCategoryInput: document.getElementById("pdfCategoryInput"),
  pdfCategoryOptions: document.getElementById("pdfCategoryOptions"),
  pdfFileInput: document.getElementById("pdfFileInput"),
  addPdfBtn: document.getElementById("addPdfBtn"),
  updatePdfBtn: document.getElementById("updatePdfBtn"),
  clearPdfEditorBtn: document.getElementById("clearPdfEditorBtn"),
  pdfSelectAllDeleteBtn: document.getElementById("pdfSelectAllDeleteBtn"),
  pdfClearDeleteSelectionBtn: document.getElementById("pdfClearDeleteSelectionBtn"),
  pdfDeleteCheckedBtn: document.getElementById("pdfDeleteCheckedBtn"),
  pdfTableBody: document.getElementById("pdfTableBody"),
  pdfEditTableBody: document.getElementById("pdfEditTableBody"),
  pdfEditPreview: document.getElementById("pdfEditPreview"),
  pdfMaskTableBody: document.getElementById("pdfMaskTableBody"),
  pdfViewerShell: document.getElementById("pdfViewerShell"),
  pdfViewerArea: document.getElementById("pdfViewerArea"),
  pdfFullscreenBtn: document.getElementById("pdfFullscreenBtn"),
  pdfFullscreenMaskControls: document.getElementById("pdfFullscreenMaskControls"),
  pdfMaskActionsHome: document.getElementById("pdfMaskActionsHome"),
  pdfMaskCompactActions: document.getElementById("pdfMaskCompactActions"),
  pdfStatus: document.getElementById("pdfStatus"),
  pdfEditStatus: document.getElementById("pdfEditStatus"),
  maskPageInput: document.getElementById("maskPageInput"),
  maskXInput: document.getElementById("maskXInput"),
  maskYInput: document.getElementById("maskYInput"),
  maskWInput: document.getElementById("maskWInput"),
  maskHInput: document.getElementById("maskHInput"),
  addMaskModeBtn: document.getElementById("addMaskModeBtn"),
  updateMaskBtn: document.getElementById("updateMaskBtn"),
  deleteMaskBtn: document.getElementById("deleteMaskBtn"),
  clearMaskSelectionBtn: document.getElementById("clearMaskSelectionBtn"),
  resetPdfRevealBtn: document.getElementById("resetPdfRevealBtn"),
  selectAllMasksBtn: document.getElementById("selectAllMasksBtn"),
  markWeakMaskBtn: document.getElementById("markWeakMaskBtn"),
  showAllMasksBtn: document.getElementById("showAllMasksBtn"),
  studyCard: document.querySelector(".card"),
  studyActions: document.getElementById("studyActions"),
  prevBtn: document.getElementById("prevBtn"),
  prevBtnIpad: document.getElementById("prevBtnIpad"),
  nextBtn: document.getElementById("nextBtn"),
  nextBtnIpad: document.getElementById("nextBtnIpad")
};

function isSyncSessionCurrent(session) {
  return !!session &&
    session === activeSyncSession &&
    currentUser?.uid === session.userId &&
    authEpoch === session.epoch;
}

function isInteractionReady() {
  return !!currentUser && !!activeSyncSession?.loaded &&
    activeSyncSession.conflicted !== true &&
    isSyncSessionCurrent(activeSyncSession);
}

function getSaveFailureMessage(error) {
  if (error instanceof CloudSaveConflictError) {
    return (
      "他の端末で先にクラウドデータが更新されたため、この端末からの保存を停止しました。\n" +
      "ページを再読み込みして最新の状態を確認してください。"
    );
  }
  if (error instanceof UnsafeEmptyOverwriteError) {
    return (
      "安全のため、空状態によるクラウドデータの上書きを停止しました。\n" +
      `対象: ${error.areas.join(", ")}\n` +
      "ページを再読み込みして状態を確認してください。"
    );
  }
  return "クラウド保存に失敗しました。\n" + (error?.message || error || "原因不明のエラー");
}

async function persistSnapshotToCloud({ session, snapshot, options }) {
  if (!db || !session?.loaded || session.conflicted) return false;

  try {
    const nextRevision = await writeSplitDocuments(db, session.userId, snapshot, {
      ...options,
      expectedRevision: session.revision
    });
    session.revision = nextRevision;
    return true;
  } catch (error) {
    const message = getSaveFailureMessage(error);
    if (isSyncSessionCurrent(session)) {
      if (error instanceof CloudSaveConflictError) {
        session.conflicted = true;
        syncPhase = "conflict";
        updateLoginLockedUI();
      }
      el.cloudStatus.textContent = message;
      if (options.showAlerts) alert(message);
    }
    throw error;
  }
}

const saveCoordinator = createSaveCoordinator({
  persist: persistSnapshotToCloud,
  debounceMs: 600,
  onTransition: event => {
    if (!isSyncSessionCurrent(event.session)) return;

    if (event.type === "waiting") {
      syncPhase = "ready";
      el.cloudStatus.textContent = "クラウド保存を待機しています...";
    } else if (event.type === "saving") {
      syncPhase = "saving";
      el.cloudStatus.textContent = "クラウドへ保存中です...";
    } else if (event.type === "saved") {
      syncPhase = "ready";
      el.cloudStatus.textContent = "クラウドに分離保存しました。";
    } else if (event.type === "error") {
      syncPhase = event.error instanceof CloudSaveConflictError ? "conflict" : "error";
      el.cloudStatus.textContent = getSaveFailureMessage(event.error);
      if (event.error instanceof CloudSaveConflictError) {
        event.session.conflicted = true;
        updateLoginLockedUI();
      }
    }
  }
});

const questionManager = createQuestionManager({
  el,
  getCurrentUser: () => isInteractionReady() ? currentUser : null,
  getStorage: () => storage,
  getQuestions: () => allQuestions,
  setQuestions: questions => { allQuestions = questions; },
  ensureProgressRow,
  cleanupStaleStudyFilters,
  recalcProgressFromQuestionStates,
  updateSubjectOptions,
  buildFilteredQuestions,
  renderProgressTable,
  renderStudy,
  requestAutoSave: options => autoSaveToCloud(options),
  requestSave: options => saveToCloud(options)
});

const imageMemory = createImageMemory({
  el,
  getCurrentUser: () => isInteractionReady() ? currentUser : null,
  getStorage: () => storage,
  getQuestionSubjects: () => getStudySubjects(allQuestions),
  requestAutoSave: options => autoSaveToCloud(options),
  requestSave: options => saveToCloud(options)
});

function renderManageTable() { questionManager.render(); }
function renderManageFilterUi() { questionManager.renderFilter(); }
function resetBulkImportState() { questionManager.resetBulkImport(); }
function renderPdfTable() { imageMemory.render(); }
function renderPdfFilterUi() { imageMemory.ensureFilterUi(); }
function renderPdfMaskTable() { imageMemory.renderMasks(); }
function renderPdfViewer(preserveScroll = false) { imageMemory.renderViewer(preserveScroll); }


function getCurrentQuestionAnswers(q) {
  return normalizeQuestionAnswers(q?.answers || []);
}

function ensureCurrentQuestionAnswers(q) {
  if (!q) return [];
  const normalized = getCurrentQuestionAnswers(q);
  if (JSON.stringify(q.answers || []) !== JSON.stringify(normalized)) {
    q.answers = normalized;
  }
  return normalized;
}



function getPrimarySubcategories() {
  return getStudyPrimaryCategories(allQuestions, subjectFilter);
}

function getRelatedSubcategories() {
  return getStudyRelatedCategories(allQuestions, subjectFilter, selectedPrimarySubcategory);
}

function renderPrimarySubcategorySelect() {
  if (!el.primarySubcategorySelect) return;
  const primaryItems = getPrimarySubcategories();

  if (!primaryItems.length) {
    el.primarySubcategorySelect.innerHTML = '<option value="">章・大分類は未登録です</option>';
    return;
  }

  el.primarySubcategorySelect.innerHTML = '<option value="">章・大分類を選択してください</option>' +
    primaryItems.map(item => `
      <option value="${escapeHtml(item)}" ${item === selectedPrimarySubcategory ? "selected" : ""}>
        ${escapeHtml(item)}
      </option>
    `).join("");
}

function renderRelatedSubcategoryChecklist() {
  const list = el.relatedSubcategoryChecklist;
  if (!list) return;

  if (!allQuestions.length) {
    list.innerHTML = '<div class="condition-group-help">問題が0件です。問題管理タブから問題を追加、またはJSON一括登録してください。</div>';
    return;
  }

  if (!selectedPrimarySubcategory) {
    list.innerHTML = '<div class="condition-group-help">章・大分類を選択すると追加カテゴリが表示されます。</div>';
    return;
  }

  const related = getRelatedSubcategories();

  if (!related.length) {
    list.innerHTML = '<div class="condition-group-help">対象の問題には追加カテゴリがありません。</div>';
    return;
  }

  list.innerHTML = related.map(tag => {
    const checked = selectedSubcategories.includes(tag);
    return `
      <label class="subcat-check-row ${checked ? "is-active" : ""}">
        <input type="checkbox" value="${escapeHtml(tag)}" ${checked ? "checked" : ""}>
        <span>${escapeHtml(tag)}</span>
      </label>
    `;
  }).join("");

  [...list.querySelectorAll("input[type='checkbox']")].forEach(input => {
    input.addEventListener("change", () => {
      const value = input.value;
      if (input.checked) {
        if (!selectedSubcategories.includes(value)) selectedSubcategories.push(value);
      } else {
        selectedSubcategories = selectedSubcategories.filter(tag => tag !== value);
      }
      applyStudyFilterChange();
    });
  });
}

function renderStudyFilterControls() {
  updateSubjectOptions();
  renderPrimarySubcategorySelect();
  renderRelatedSubcategoryChecklist();
  renderConditionGroups();
}

function clearCurrentStudyCondition({ resetSubject = false } = {}) {
  if (resetSubject) subjectFilter = "all";
  selectedPrimarySubcategory = "";
  selectedSubcategories = [];
}

function getCurrentStudyCondition() {
  return normalizeStudyCondition(allQuestions, {
    subject: subjectFilter,
    primaryCategory: selectedPrimarySubcategory,
    selectedRelatedCategories: selectedSubcategories
  });
}

function addCurrentStudyCondition() {
  const condition = getCurrentStudyCondition();
  if (!condition.primaryCategory) {
    alert("条件に追加する章・大分類を選択してください。");
    return;
  }

  const key = JSON.stringify(condition);
  if (!studyConditionGroups.some(group => JSON.stringify(group) === key)) {
    studyConditionGroups.push(condition);
  }

  clearCurrentStudyCondition();
  applyStudyFilterChange();
}

function renderConditionGroups() {
  if (!el.conditionGroupList) return;
  studyConditionGroups = normalizeStudyConditionGroups(allQuestions, studyConditionGroups);

  if (!studyConditionGroups.length) {
    el.conditionGroupList.innerHTML = '<div class="condition-group-help">追加済みの条件はありません。</div>';
    return;
  }

  el.conditionGroupList.innerHTML = studyConditionGroups.map((condition, index) => {
    const labels = [
      condition.subject === "all" ? "全教科" : condition.subject,
      condition.primaryCategory,
      ...condition.selectedRelatedCategories
    ];
    return `
      <div class="condition-group-card">
        <div class="condition-group-header">
          <div class="condition-group-title">条件${index + 1}</div>
          <button class="condition-group-remove" type="button" data-remove-condition="${index}" title="条件${index + 1}を削除" aria-label="条件${index + 1}を削除">×</button>
        </div>
        <div class="condition-group-tags">
          ${labels.map(label => `<span class="condition-group-tag">${escapeHtml(label)}</span>`).join("")}
        </div>
      </div>
    `;
  }).join("");

  [...el.conditionGroupList.querySelectorAll("[data-remove-condition]")].forEach(button => {
    button.addEventListener("click", () => {
      studyConditionGroups.splice(Number(button.dataset.removeCondition), 1);
      applyStudyFilterChange();
    });
  });
}

function applyStudyFilterChange({ reshuffle = orderMode === "random", save = true } = {}) {
  cleanupStaleStudyFilters();
  studyMode = "normal";
  currentIndex = 0;
  renderStudy({ reshuffle });
  if (save) autoSaveToCloud();
}

function getQuestionState(qid) {
  const value = questionStatuses[qid];
  return value === 1 || value === 2 ? value : null;
}

function setQuestionState(qid, state) {
  if (!qid) return;
  if (state === 1 || state === 2) {
    questionStatuses[qid] = state;
  } else {
    delete questionStatuses[qid];
  }
}

function isAnsweredQuestion(qid) {
  const state = getQuestionState(qid);
  return state === 1 || state === 2;
}

function isWeakQuestion(qid) {
  return getQuestionState(qid) === 2;
}

function migrateQuestionStatusesToFlags() {
  const migrated = {};
  Object.entries(questionStatuses || {}).forEach(([qid, value]) => {
    if (value === 1 || value === "known" || value === "done" || value === true) {
      migrated[qid] = 1;
    } else if (value === 2 || value === "unknown" || value === "wrong" || value === "weak") {
      migrated[qid] = 2;
    }
  });
  questionStatuses = migrated;
}

function recalcProgressFromQuestionStates() {
  progress = {};
  allQuestions.forEach(q => {
    ensureProgressRow(q.subject);
    const state = getQuestionState(q.id);
    if (state === 1 || state === 2) progress[q.subject].known += 1;
    if (state === 2) progress[q.subject].unknown += 1;
  });
  wrongQuestionIds = allQuestions.filter(q => getQuestionState(q.id) === 2).map(q => q.id);
}

function currentQuestion() {
  const q = filteredQuestions[currentIndex] || null;
  if (q) ensureCurrentQuestionAnswers(q);
  return q;
}



function resetWrongQuestions() {
  allQuestions.forEach(q => {
    if (getQuestionState(q.id) === 2) {
      setQuestionState(q.id, null);
    }
  });

  recalcProgressFromQuestionStates();
  buildFilteredQuestions();
  renderProgressTable();
  renderStudy();
  autoSaveToCloud({ allowEmptyProgress: true });
}


function resetStudyFiltersToAll() {
  clearCurrentStudyCondition({ resetSubject: true });
  studyConditionGroups = [];
  currentIndex = 0;

  applyStudyFilterChange({ reshuffle: orderMode === "random" });
}


function getBaseStudyQuestions() {
  return filterQuestionsForStudy(allQuestions, {
    draftCondition: getCurrentStudyCondition(),
    conditionGroups: studyConditionGroups
  });
}

function applyCurrentStudyMode({ reshuffle = false } = {}) {
  const base = getBaseStudyQuestions();
  let nextQuestions;

  if (studyMode === "wrongOnly") {
    const wrongSet = new Set(wrongQuestionIds);
    nextQuestions = base.filter(q => wrongSet.has(q.id));
  } else if (studyMode === "unansweredOnly") {
    nextQuestions = base.filter(q => getQuestionState(q.id) === null);
  } else {
    nextQuestions = base;
  }

  if (orderMode === "random") {
    if (reshuffle || !filteredQuestions.length) {
      nextQuestions = shuffle(nextQuestions);
    } else {
      const nextById = new Map(nextQuestions.map(question => [question.id, question]));
      const retained = filteredQuestions
        .map(question => nextById.get(question.id))
        .filter(Boolean);
      const retainedIds = new Set(retained.map(question => question.id));
      nextQuestions = [...retained, ...nextQuestions.filter(question => !retainedIds.has(question.id))];
    }
  }

  filteredQuestions = nextQuestions;
  if (currentIndex >= filteredQuestions.length) currentIndex = 0;
}

function renderQuestionImage(q) {
  if (q && q.imageUrl) {
    el.questionImage.src = q.imageUrl;
    el.questionImage.alt = q.imageName || "問題画像";
    el.questionImageWrap.style.display = "block";
  } else {
    el.questionImage.removeAttribute("src");
    el.questionImage.alt = "";
    el.questionImageWrap.style.display = "none";
  }
}

function ensureProgressRow(subject) {
  if (!progress[subject]) progress[subject] = { known: 0, unknown: 0 };
}


function cleanupStaleStudyFilters() {
  const normalized = normalizeStudyCondition(allQuestions, {
    subject: subjectFilter,
    primaryCategory: selectedPrimarySubcategory,
    selectedRelatedCategories: selectedSubcategories
  });
  subjectFilter = normalized.subject;
  selectedPrimarySubcategory = normalized.primaryCategory;
  selectedSubcategories = normalized.selectedRelatedCategories;
  studyConditionGroups = normalizeStudyConditionGroups(allQuestions, studyConditionGroups);

  if (currentIndex >= filteredQuestions.length) {
    currentIndex = 0;
  }

  if (!allQuestions.length) {
    subjectFilter = "all";
    selectedSubcategories = [];
    selectedPrimarySubcategory = "";
    studyConditionGroups = [];
    currentIndex = 0;
  }
}


function updateSubjectOptions() {
  if (!el.subjectFilter) return;
  const subjects = getStudySubjects(allQuestions);
  if (subjectFilter !== "all" && !subjects.includes(subjectFilter)) subjectFilter = "all";
  el.subjectFilter.innerHTML = '<option value="all">すべての教科</option>' +
    subjects.map(subject => `<option value="${escapeHtml(subject)}">${escapeHtml(subject)}</option>`).join("");
  el.subjectFilter.value = subjectFilter;
}


function buildFilteredQuestions(options = {}) {
  applyCurrentStudyMode(options);
}

function updateStudyStatsOnly() {
  const counters = calculateStudyCounters(filteredQuestions, currentIndex, questionStatuses);
  el.totalCount.textContent = String(counters.total);
  el.currentCount.textContent = String(counters.current);
  el.correctCount.textContent = String(counters.known);
  el.wrongCount.textContent = String(counters.weak);
}

function renderStudy({ reshuffle = false } = {}) {
  cleanupStaleStudyFilters();
  renderStudyFilterControls();
  buildFilteredQuestions({ reshuffle });
  updateStudyStatsOnly();

  el.chooseIphone.classList.toggle("active", deviceMode === "iphone");
  el.chooseIpad.classList.toggle("active", deviceMode === "ipad");
  el.iphoneArea.classList.toggle("hidden", deviceMode !== "iphone");
  el.ipadArea.classList.toggle("hidden", deviceMode !== "ipad");

  const rangeText = studyConditionGroups.length
    ? `追加条件: ${studyConditionGroups.length}件`
    : (subjectFilter === "all" ? "全教科" : subjectFilter);
  const selectedCategoryLabels = [selectedPrimarySubcategory, ...selectedSubcategories].filter(Boolean);
  const subcatText = !studyConditionGroups.length && selectedCategoryLabels.length
    ? ` / カテゴリ: ${selectedCategoryLabels.join("・")}`
    : "";
  const orderText = orderMode === "random" ? "ランダム" : "順番どおり";
  const modeText = studyMode === "wrongOnly"
    ? " / 苦手復習"
    : studyMode === "unansweredOnly"
      ? " / 未解答のみ"
      : "";
  el.studyMeta.textContent = `${deviceMode === "iphone" ? "iPhone版" : "iPad版"} / ${rangeText}${subcatText} / ${orderText}${modeText}`;

  const q = currentQuestion();
  if (!q) {
    el.question.textContent = allQuestions.length ? "条件に合う問題がありません。" : "問題がありません。";
    renderQuestionImage(null);
    el.answerBox.style.display = "none";
    el.explainBox.style.display = "none";
    clearIpadAnswerInputs();
    clearJudgeStatus();
    updateStudyNavigationButtons();
    return;
  }

  el.question.textContent = formatDisplayText(q.question);
  renderQuestionImage(q);
  el.answerBox.innerHTML = `<b>正解</b><br>${ensureCurrentQuestionAnswers(q).map(escapeDisplayText).join("\n")}`;
  el.explainBox.innerHTML = `<b>解説</b><br>${escapeDisplayText(q.explanation || "解説なし")}`;
  el.answerBox.style.display = "none";
  el.explainBox.style.display = "none";
  if (el.studyActions) el.studyActions.classList.remove("is-floating");
  renderIpadAnswerInputs(q);
  clearJudgeStatus();

  updateStudyNavigationButtons();
}

function showAnswerAndExplanation() {
  el.answerBox.style.display = "block";
  el.explainBox.style.display = "block";
  requestAnimationFrame(updateFloatingStudyActions);
}


function previousQuestion() {
  if (!filteredQuestions.length) return;

  if (currentIndex <= 0) {
    currentIndex = 0;
    updateStudyNavigationButtons();
    return;
  }

  currentIndex -= 1;
  renderStudy();
  renderProgressTable();
  autoSaveToCloud();
}

function updateStudyNavigationButtons() {
  const disabled = currentIndex <= 0 || filteredQuestions.length === 0;

  if (el.prevBtn) {
    el.prevBtn.disabled = disabled;
  }

  if (el.prevBtnIpad) {
    el.prevBtnIpad.disabled = disabled;
  }

  if (el.nextBtn) {
    el.nextBtn.disabled = filteredQuestions.length === 0;
  }

  if (el.nextBtnIpad) {
    el.nextBtnIpad.disabled = filteredQuestions.length === 0;
  }
}

function nextQuestion() {
  if (!filteredQuestions.length) return;
  currentIndex = (currentIndex + 1) % filteredQuestions.length;
  renderStudy();
  renderProgressTable();
  autoSaveToCloud();

  updateStudyNavigationButtons();
}


function advanceAfterAnswer() {
  if (studyMode === "unansweredOnly") {
    buildFilteredQuestions();
    if (!filteredQuestions.length) {
      studyMode = "normal";
      currentIndex = 0;
      renderStudy();
      renderProgressTable();
      autoSaveToCloud();
      alert("未解答問題はなくなりました。先頭に戻ります。");
      return;
    }
    if (currentIndex >= filteredQuestions.length) currentIndex = 0;
    renderStudy();
    renderProgressTable();
    autoSaveToCloud();
    return;
  }

  nextQuestion();
}
function markKnown() {
  const q = currentQuestion();
  if (!q) return;
  setQuestionState(q.id, 1);
  recalcProgressFromQuestionStates();
  renderProgressTable();
  buildFilteredQuestions();
  updateStudyStatsOnly();
  autoSaveToCloud();
}

function markUnknown() {
  const q = currentQuestion();
  if (!q) return;
  setQuestionState(q.id, 2);
  recalcProgressFromQuestionStates();
  renderProgressTable();
  buildFilteredQuestions();
  updateStudyStatsOnly();
  autoSaveToCloud();
}

function reviewWrongOnly() {
  studyMode = "wrongOnly";
  buildFilteredQuestions();
  if (!filteredQuestions.length) {
    studyMode = "normal";
    buildFilteredQuestions();
    alert("苦手問題はありません。");
    return;
  }
  currentIndex = 0;
  renderStudyCurrentOnly();
}

function reviewUnansweredOnly() {
  studyMode = "unansweredOnly";
  buildFilteredQuestions();
  if (!filteredQuestions.length) {
    studyMode = "normal";
    buildFilteredQuestions();
    currentIndex = 0;
    alert("未解答問題はありません。先頭に戻ります。");
    renderStudy();
    return;
  }
  currentIndex = 0;
  renderStudyCurrentOnly();
}

function renderStudyCurrentOnly() {
  el.totalCount.textContent = String(filteredQuestions.length);
  el.currentCount.textContent = String(filteredQuestions.length ? currentIndex + 1 : 0);
  const q = currentQuestion();
  if (!q) return;
  el.studyMeta.textContent = `${deviceMode === "iphone" ? "iPhone版" : "iPad版"} / 苦手復習`;
  el.question.textContent = formatDisplayText(q.question);
  renderQuestionImage(q);
  el.answerBox.innerHTML = `<b>正解</b><br>${ensureCurrentQuestionAnswers(q).map(escapeDisplayText).join("\n")}`;
  el.explainBox.innerHTML = `<b>解説</b><br>${escapeDisplayText(q.explanation || "解説なし")}`;
  el.answerBox.style.display = "none";
  el.explainBox.style.display = "none";
  if (el.studyActions) el.studyActions.classList.remove("is-floating");
  renderIpadAnswerInputs(q);
  clearJudgeStatus();
}

function getAnswerLabel(index, orderSensitive) {
  if (orderSensitive) {
    const labels = ["a", "b", "c", "d", "e", "f", "g", "h"];
    return labels[index] ? `${labels[index]}` : `${index + 1}`;
  }
  return `回答${index + 1}`;
}

function renderIpadAnswerInputs(q) {
  if (!el.multiAnswerArea || !el.userAnswer) return;

  const normalizedAnswers = ensureCurrentQuestionAnswers(q);
  const answerCount = Math.max(1, normalizedAnswers.length || 1);
  const orderSensitive = isOrderSensitiveQuestion(q);

  // 旧textareaは内部互換用に残し、画面では回答数分のテキストボックスを使う。
  // Keep the old textarea for compatibility, but use one input per answer on screen.
  el.userAnswer.style.display = "none";
  el.userAnswer.value = "";
  el.multiAnswerArea.innerHTML = "";

  for (let index = 0; index < answerCount; index++) {
    const row = document.createElement("div");
    row.className = "multi-answer-row";

    const label = document.createElement("div");
    label.className = "multi-answer-label";
    label.textContent = getAnswerLabel(index, orderSensitive);

    const input = document.createElement("input");
    input.className = "multi-answer-input";
    input.type = "text";
    input.dataset.answerIndex = String(index);
    input.placeholder = orderSensitive
      ? `${getAnswerLabel(index, orderSensitive)} の答え`
      : `${index + 1}つ目の答え`;

    row.appendChild(label);
    row.appendChild(input);
    el.multiAnswerArea.appendChild(row);
  }
}

function clearIpadAnswerInputs() {
  if (el.multiAnswerArea) el.multiAnswerArea.innerHTML = "";
  if (el.userAnswer) {
    el.userAnswer.value = "";
    el.userAnswer.style.display = "";
  }
}

function getIpadAnswerInputs() {
  return el.multiAnswerArea
    ? [...el.multiAnswerArea.querySelectorAll(".multi-answer-input")]
    : [];
}

function collectIpadAnswerValues() {
  const inputs = getIpadAnswerInputs();
  if (inputs.length) {
    return inputs.map(input => input.value.trim());
  }
  return normalizeQuestionAnswers(el.userAnswer.value || "");
}


function judgeIpadAnswer() {
  const q = currentQuestion();
  if (!q) return;

  const inputValues = collectIpadAnswerValues();
  const rawInput = inputValues.join("\n");
  const expectedOriginal = ensureCurrentQuestionAnswers(q);
  const orderSensitive = isOrderSensitiveQuestion(q);

  if (!inputValues.some(value => value.trim())) {
    setJudgeStatus("warn", "まだ解答が入っていません。");
    return;
  }

  let isCorrect = false;
  let statusType = "ng";
  let statusMessage = "";

  if (orderSensitive) {
    const normalizedExpected = expectedOriginal.map(normalizeAnswerForComparison);
    const normalizedActual = inputValues.map(normalizeAnswerForComparison);
    const missingLabels = [];
    const wrongLabels = [];

    normalizedExpected.forEach((answer, index) => {
      const actual = normalizedActual[index] || "";
      if (!actual) missingLabels.push(getAnswerLabel(index, true));
      else if (actual !== answer) wrongLabels.push(getAnswerLabel(index, true));
    });

    const extraAnswers = normalizedActual.slice(normalizedExpected.length).filter(Boolean);

    if (
      compareAnswerLists(expectedOriginal, inputValues, { ordered: true }) &&
      !missingLabels.length &&
      !wrongLabels.length &&
      !extraAnswers.length
    ) {
      isCorrect = true;
      statusType = "ok";
      statusMessage = "正解です。";
    } else {
      const pieces = [];
      if (missingLabels.length) pieces.push(`未入力: ${missingLabels.join("、")}`);
      if (wrongLabels.length) pieces.push(`違う可能性がある欄: ${wrongLabels.join("、")}`);
      if (extraAnswers.length) pieces.push(`余計な答え: ${extraAnswers.join("、")}`);
      statusType = wrongLabels.length || extraAnswers.length ? "ng" : "warn";
      statusMessage = pieces.join("\n");
    }
  } else {
    const { missing, extra } = diffAnswerLists(expectedOriginal, inputValues);

    if (compareAnswerLists(expectedOriginal, inputValues)) {
      isCorrect = true;
      statusType = "ok";
      statusMessage = "正解です。";
    } else if (missing.length > 0 && extra.length === 0) {
      statusType = "warn";
      statusMessage = `惜しいです。\n足りない答え: ${missing.join("、")}`;
    } else {
      const pieces = [];
      if (missing.length) pieces.push(`足りない答え: ${missing.join("、")}`);
      if (extra.length) pieces.push(`余計な答え: ${extra.join("、")}`);
      statusType = "ng";
      statusMessage = pieces.join("\n");
    }
  }

  setQuestionState(q.id, isCorrect ? 1 : 2);
  recalcProgressFromQuestionStates();
  setJudgeStatus(statusType, statusMessage);
  showAnswerAndExplanation();
  renderProgressTable();
  buildFilteredQuestions();
  updateStudyStatsOnly();

  el.userAnswer.value = rawInput;
  autoSaveToCloud();
}

function setJudgeStatus(type, message) {
  el.judgeStatus.className = `status ${type}`;
  el.judgeStatus.textContent = message;
}

function clearJudgeStatus() {
  el.judgeStatus.className = "status";
  el.judgeStatus.textContent = "";
}

function updateFloatingStudyActions() {
  if (!el.studyActions || !el.studyCard) return;

  const q = currentQuestion();
  const answerVisible =
    el.answerBox.style.display === "block" || el.explainBox.style.display === "block";

  if (!q || !answerVisible) {
    el.studyActions.classList.remove("is-floating");
    return;
  }

  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;

  // 固定中に自分自身の位置を見て判定するとチカチカするため、
  // 本来の位置を測るための目印を一時的に作る。
  // If we measure the fixed element itself, it flickers.
  // So we create a temporary marker to measure the original position.
  let marker = document.getElementById("studyActionsMarker");
  if (!marker) {
    marker = document.createElement("div");
    marker.id = "studyActionsMarker";
    marker.style.height = "1px";
    marker.style.margin = "0";
    marker.style.padding = "0";
    marker.style.pointerEvents = "none";
    el.studyActions.parentNode.insertBefore(marker, el.studyActions);
  }

  const cardRect = el.studyCard.getBoundingClientRect();
  const markerRect = marker.getBoundingClientRect();
  const isFloating = el.studyActions.classList.contains("is-floating");

  // 問題カードが画面に見えている間だけ固定対象。
  // Only float while the study card is visible.
  const cardIsVisible = cardRect.top < viewportHeight && cardRect.bottom > 0;

  // ヒステリシスを入れて、境界付近で出たり消えたりしないようにする。
  // Hysteresis prevents flickering near the viewport boundary.
  const showThreshold = viewportHeight - 120;
  const hideThreshold = viewportHeight - 40;

  const shouldStartFloating = cardIsVisible && markerRect.top > showThreshold;
  const shouldStopFloating = !cardIsVisible || markerRect.top < hideThreshold;

  if (!isFloating && shouldStartFloating) {
    marker.style.height = `${el.studyActions.offsetHeight}px`;
    el.studyActions.classList.add("is-floating");
    return;
  }

  if (isFloating && shouldStopFloating) {
    el.studyActions.classList.remove("is-floating");
    marker.style.height = "1px";
  }
}

function renderProgressTable() {
  const subjects = [...new Set(allQuestions.map(q => q.subject).filter(Boolean))].sort();

  if (!subjects.length) {
    el.progressTableBody.innerHTML = '<tr><td colspan="5">問題がありません。</td></tr>';
    return;
  }

  el.progressTableBody.innerHTML = subjects.map(subject => {
    const subjectQuestions = allQuestions.filter(q => q.subject === subject);
    const total = subjectQuestions.length;
    const done = subjectQuestions.filter(q => getQuestionState(q.id) === 1).length;
    const notYet = subjectQuestions.filter(q => getQuestionState(q.id) === 2).length;
    const doneRate = total ? Math.round((done / total) * 100) : 0;

    return `
      <tr>
        <td>${escapeHtml(subject)}</td>
        <td>${total}</td>
        <td>${done}</td>
        <td>${notYet}</td>
        <td>${doneRate}%</td>
      </tr>
    `;
  }).join("");
}


function resetProgress() {
  if (!isInteractionReady()) return;
  if (!confirm("進捗をリセットしますか？")) return;
  progress = {};
  questionStatuses = {};
  wrongQuestionIds = [];
  studyMode = "normal";
  allQuestions.forEach(q => ensureProgressRow(q.subject));
  renderProgressTable();
  renderStudy();
  autoSaveToCloud({ allowEmptyProgress: true });
}

function applyStudyCondition() {
  orderMode = el.orderMode.value;
  applyStudyFilterChange({ reshuffle: orderMode === "random" });
}

function shuffle(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function showTab(tabName) {
  if (!isInteractionReady() && tabName !== "auth") {
    tabName = "auth";
  }
  document.querySelectorAll(".tab").forEach(tab => {
    const canShow = isInteractionReady() || tab.dataset.tab === "auth";
    tab.classList.toggle("active", canShow && tab.dataset.tab === tabName);
  });
  document.querySelectorAll('[id^="tab-"]').forEach(panel => panel.classList.add("hidden"));
  document.getElementById(`tab-${tabName}`).classList.remove("hidden");
}


function applyState(state) {
  isApplyingCloudState = true;
  try {
    allQuestions = Array.isArray(state.allQuestions) && state.allQuestions.length
      ? state.allQuestions.map(q => ({
          ...q,
          subcategories: normalizeSubcategories(q.subcategories || []),
          imageUrl: q.imageUrl || "",
          imagePath: q.imagePath || "",
          imageName: q.imageName || "",
          orderedAnswers: q.orderedAnswers === true
        }))
      : [];

    wrongQuestionIds = Array.isArray(state.wrongQuestionIds) ? state.wrongQuestionIds : [];
    currentIndex = Number.isInteger(state.currentIndex) ? state.currentIndex : 0;
    deviceMode = state.deviceMode || "iphone";
    const storedSubcategories = Array.isArray(state.selectedSubcategories) ? state.selectedSubcategories : [];
    const storedSubjects = Array.isArray(state.selectedSubjects) ? state.selectedSubjects : [];
    const storedPrimaryCategories = Array.isArray(state.selectedPrimarySubcategories)
      ? state.selectedPrimarySubcategories
      : [];
    subjectFilter = state.subjectFilter || (storedSubjects.length === 1 ? storedSubjects[0] : "all");
    selectedPrimarySubcategory = state.selectedPrimarySubcategory ||
      (storedPrimaryCategories.length === 1 ? storedPrimaryCategories[0] : "");
    selectedSubcategories = storedSubcategories.filter(tag => tag !== selectedPrimarySubcategory);
    studyConditionGroups = migrateStudyConditionGroups(allQuestions, state);
    migratedLegacyStudyFilters = state.studyFilterVersion !== "condition-groups-v3" &&
      studyConditionGroups.length > 0;
    orderMode = state.orderMode || "sequential";
    progress = state.progress || {};
    questionStatuses = restoreLegacyQuestionStatuses(state);
    migrateQuestionStatusesToFlags();
    recalcProgressFromQuestionStates();
    studyMode = state.studyMode || "normal";

    questionManager.apply(state);
    imageMemory.apply(state);

    allQuestions.forEach(q => ensureProgressRow(q.subject));
    updateSubjectOptions();
    el.orderMode.value = orderMode;
    cleanupStaleStudyFilters();
    buildFilteredQuestions();
    renderManageTable();
    renderProgressTable();
    renderStudy();
    renderPdfTable();
    renderPdfMaskTable();
    renderPdfViewer();
    if (el.studyFilterMigrationNotice) {
      el.studyFilterMigrationNotice.classList.toggle("hidden", !migratedLegacyStudyFilters);
      el.studyFilterMigrationNotice.textContent = migratedLegacyStudyFilters
        ? "以前の学習条件を、教科を含む条件追加方式へ移行しました。追加済み条件を確認してください。"
        : "";
    }
  } finally {
    isApplyingCloudState = false;
  }
}

function setInteractiveDisabled(ids, disabled) {
  ids.forEach(id => {
    const node = document.getElementById(id);
    if (node) node.disabled = disabled;
  });
}

function updateLoginLockedUI() {
  const loggedIn = !!currentUser;
  const canInteract = isInteractionReady();
  const hasConflict = loggedIn && activeSyncSession?.conflicted === true;
  const lockMessages = hasConflict
    ? {
        study: "他の端末で更新されました。再読み込みするまで学習操作を停止しています。",
        manage: "他の端末で更新されました。再読み込みするまで問題管理を停止しています。",
        progress: "他の端末で更新されました。再読み込みするまで進捗操作を停止しています。",
        pdf: "他の端末で更新されました。再読み込みするまで画像暗記を停止しています。"
      }
    : {
        study: loggedIn ? "クラウド読込の完了後に学習が使えます。" : "ログインすると学習が使えます。",
        manage: loggedIn ? "クラウド読込の完了後に問題管理が使えます。" : "ログインすると問題管理が使えます。",
        progress: loggedIn ? "クラウド読込の完了後に進捗が使えます。" : "ログインすると進捗が使えます。",
        pdf: loggedIn ? "クラウド読込の完了後に画像暗記が使えます。" : "ログインすると画像暗記が使えます。"
      };

  el.studyLockBanner.textContent = lockMessages.study;
  el.manageLockBanner.textContent = lockMessages.manage;
  el.progressLockBanner.textContent = lockMessages.progress;
  el.pdfLockBanner.textContent = lockMessages.pdf;

  document.querySelectorAll('.tab').forEach(tab => {
    const isAuth = tab.dataset.tab === "auth";
    tab.classList.toggle("hidden", !canInteract && !isAuth);
  });

  document.getElementById("tab-study").classList.toggle("hidden", !canInteract);
  document.getElementById("tab-manage").classList.toggle("hidden", !canInteract);
  document.getElementById("tab-progress").classList.toggle("hidden", !canInteract);
  document.getElementById("tab-pdf").classList.toggle("hidden", !canInteract);
  document.getElementById("tab-auth").classList.toggle("hidden", false);

  el.studyLockBanner.classList.toggle("hidden", canInteract);
  el.manageLockBanner.classList.toggle("hidden", canInteract);
  el.progressLockBanner.classList.toggle("hidden", canInteract);
  el.pdfLockBanner.classList.toggle("hidden", canInteract);

  setInteractiveDisabled([
    "chooseIphone","chooseIpad","subjectFilter","primarySubcategorySelect","orderMode","applyStudyBtn","shuffleBtn","forceResetStudyFiltersBtn","addConditionGroupBtn","clearCurrentConditionBtn",
    "userAnswer","judgeBtn","showAnswerBtnIpad","nextBtnIpad","showAnswerBtn","nextBtn",
    "knownBtn","unknownBtn","reviewWrongBtn","reviewUnansweredBtn","resetWrongQuestionsBtn"
  ], !canInteract);

  document.querySelectorAll("#relatedSubcategoryChecklist input")
    .forEach(input => { input.disabled = !canInteract; });

  setInteractiveDisabled([
    "editSubject","searchInput","editQuestion","editAnswers","editExplanation","editOrderedAnswers","editImageFile","removeImageBtn","editImageName",
    "addBtn","updateBtn","deleteBtn","clearFormBtn","bulkImportFile","bulkImportImageFiles","bulkImportValidateBtn","bulkImportExecuteBtn","bulkImportResetBtn",
    "resetProgressBtn",
    "pdfStudyModeBtn","pdfEditModeBtn","pdfSearchInput","pdfSubjectFilterSelect","pdfCategoryFilterSelect","pdfFullscreenBtn",
    "pdfTitleInput","pdfSubjectInput","pdfCategoryInput","pdfFileInput","addPdfBtn","updatePdfBtn","clearPdfEditorBtn",
    "pdfSelectAllDeleteBtn","pdfClearDeleteSelectionBtn","pdfDeleteCheckedBtn",
    "maskPageInput","maskXInput","maskYInput","maskWInput","maskHInput",
    "addMaskModeBtn","updateMaskBtn","deleteMaskBtn","clearMaskSelectionBtn","selectAllMasksBtn","markWeakMaskBtn","showAllMasksBtn","resetPdfRevealBtn"
  ], !canInteract);

  if (!canInteract) {
    document.querySelectorAll(".tab").forEach(tab => {
      tab.classList.toggle("active", tab.dataset.tab === "auth");
    });
  }

  if (loggedIn && !canInteract && syncPhase === "loading") {
    el.authStatus.textContent = `ログイン中: ${currentUser.email || "メール不明"}（クラウド読込中）`;
  } else if (hasConflict) {
    el.authStatus.textContent =
      `ログイン中: ${currentUser.email || "メール不明"}（他端末との保存競合により操作停止中）`;
  }
}

function clearLocalState() {
  applyState({});
  resetBulkImportState();
}

async function initFirebase() {
  try {
    el.cloudStatus.textContent = "Firebase初期化中です...";
    ({ app, auth, db, storage } = initializeFirebaseServices());
    el.cloudStatus.textContent = "Firebase初期化完了です。ログイン状態を確認しています...";

    onAuthStateChanged(auth, async user => {
      const epoch = ++authEpoch;
      saveCoordinator.setSession(null);
      activeSyncSession = null;
      currentUser = user || null;
      clearLocalState();

      if (!user) {
        syncPhase = "signed-out";
        el.authStatus.textContent = "未ログインです。";
        el.cloudStatus.textContent =
          "Firebase接続済みです。ログインすると学習・問題管理・進捗・クラウド連携が使えます。";
        updateLoginLockedUI();
        showTab("auth");
        return;
      }

      const session = {
        epoch,
        userId: user.uid,
        loaded: false,
        conflicted: false,
        revision: 0
      };
      activeSyncSession = session;
      saveCoordinator.setSession(session);
      syncPhase = "loading";
      el.authStatus.textContent = `ログイン中: ${user.email || "メール不明"}（クラウド読込中）`;
      el.cloudStatus.textContent = "Firebase接続済みです。クラウド保存データを確認しています...";
      updateLoginLockedUI();
      showTab("auth");

      try {
        const result = await loadFromCloud({
          session,
          silentNoData: true,
          autoMode: true
        });
        if (!isSyncSessionCurrent(session) || result.stale) return;

        session.loaded = true;
        syncPhase = "ready";
        el.authStatus.textContent = `ログイン中: ${user.email || "メール不明"}`;
        el.cloudStatus.textContent = result.loaded
          ? result.source === "split-with-legacy-fallback"
            ? "Firebase接続済みです。分割データの欠損箇所を旧形式データで補完して反映しました。"
            : "Firebase接続済みです。クラウド内容を自動反映しました。"
          : "Firebase接続済みです。クラウド保存データがないため、空の初期状態を表示しています。";
        updateLoginLockedUI();
        showTab("study");
      } catch (error) {
        if (!isSyncSessionCurrent(session)) return;
        console.error(error);
        syncPhase = "error";
        session.loaded = false;
        el.cloudStatus.textContent =
          "クラウドデータの初期読込に失敗したため、編集をロックしています。\n" +
          "ページを再読み込みしてください。\n" + (error.message || error);
        updateLoginLockedUI();
      }
    });
  } catch (error) {
    console.error(error);
    el.cloudStatus.textContent = "Firebase接続エラーです。\n" + (error.message || error);
    alert("Firebase接続エラーです。\n\n" + (error.message || error));
  }
}

async function signInUser() {
  if (!auth) {
    alert("Firebase未接続です。");
    return;
  }
  const email = el.emailInput.value.trim();
  const password = el.passwordInput.value;

  if (!email || !password) {
    alert("メールアドレスとパスワードを入力してください。");
    return;
  }

  try {
    await signInWithEmailAndPassword(auth, email, password);
    el.cloudStatus.textContent = "ログインに成功しました。";
  } catch (error) {
    console.error(error);
    alert("ログインに失敗しました: " + error.message);
  }
}

async function signOutUser() {
  if (!auth) return;
  const session = activeSyncSession;

  if (session && saveCoordinator.isDirty(session)) {
    el.cloudStatus.textContent = "未保存の変更を保存してからログアウトします...";
    const timeout = new Promise(resolve => {
      setTimeout(() => resolve("timeout"), 10_000);
    });
    const result = await Promise.race([
      saveCoordinator.flush(session),
      timeout
    ]);

    if (result !== true) {
      const proceed = confirm(
        result === "timeout"
          ? "クラウド保存が10秒以内に完了しませんでした。\n未保存の変更が失われる可能性がありますが、ログアウトしますか？"
          : "クラウド保存に失敗しました。\n未保存の変更が失われる可能性がありますが、ログアウトしますか？"
      );
      if (!proceed) {
        el.cloudStatus.textContent =
          "未保存の変更を保持するため、ログアウトを中止しました。";
        return;
      }
    }
  }

  await signOut(auth);
}


function buildSplitStates() {
  const imageState = imageMemory.serialize();
  const questionSettings = questionManager.serialize();

  return {
    questions: {
      allQuestions
    },
    pdfMaterials: {
      pdfMaterials: imageState.pdfMaterials,
      pdfRevealStates: imageState.pdfRevealStates,
      selectedPdfId: imageState.selectedPdfId,
      selectedMaskId: imageState.selectedMaskId,
      pdfSearchQuery: imageState.pdfSearchQuery
    },
    progress: {
      progress,
      questionStatuses,
      wrongQuestionIds
    },
    settings: {
      filteredQuestionIds: filteredQuestions.map(q => q.id),
      currentIndex,
      deviceMode,
      subjectFilter,
      selectedSubcategories,
      selectedPrimarySubcategory,
      studyConditionGroups,
      orderMode,
      studyMode,
      manageSubjectFilter: questionSettings.manageSubjectFilter,
      managePrimarySubcategory: questionSettings.managePrimarySubcategory,
      manageSelectedSubcategories: questionSettings.manageSelectedSubcategories,
      pdfSubjectFilter: imageState.pdfSubjectFilter,
      pdfCategoryFilter: imageState.pdfCategoryFilter,
      pdfViewMode: imageState.pdfViewMode,
      studyFilterVersion: "condition-groups-v3",
      schemaVersion: "split-v2"
    }
  };
}


async function saveToCloud(options = {}) {
  const session = activeSyncSession;
  const showAlerts = options.showAlerts !== false;
  if (!db || !isInteractionReady() || !session) {
    if (showAlerts) alert("クラウド読込の完了後に操作してください。");
    return false;
  }

  return saveCoordinator.request({
    session,
    snapshot: buildSplitStates(),
    options: {
      allowEmptyPdfMaterials: options.allowEmptyPdfMaterials === true,
      allowEmptyQuestions: options.allowEmptyQuestions === true,
      allowEmptyProgress: options.allowEmptyProgress === true,
      allowEmptySettings: options.allowEmptySettings === true,
      showAlerts
    },
    immediate: true
  });
}

async function loadFromCloud(options = {}) {
  const {
    session = activeSyncSession,
    silentNoData = false,
    autoMode = false
  } = options;
  if (!db || !session) {
    if (!silentNoData) alert("先にログインしてください。");
    return { loaded: false, source: "none", stale: false };
  }

  const result = await readCloudState(db, session.userId);
  if (!isSyncSessionCurrent(session)) {
    return {
      loaded: false,
      source: result.source,
      stale: true
    };
  }

  session.revision = result.revision;
  if (!result.hasData) {
    applyState({});
    if (!silentNoData) alert("クラウド保存データがまだありません。");
    return {
      loaded: false,
      source: result.source,
      stale: false
    };
  }

  applyState(result.state);

  if (!autoMode) {
    el.cloudStatus.textContent = result.source === "legacy"
      ? "旧形式のクラウドデータから再開しました。次回保存から分離保存されます。"
      : "クラウドから分離保存データを再開しました。";
  }
  return {
    loaded: true,
    source: result.source,
    stale: false
  };
}

async function refreshFromCloudIfClean() {
  const session = activeSyncSession;
  if (
    !db ||
    !isSyncSessionCurrent(session) ||
    !session.loaded ||
    session.conflicted ||
    syncPhase !== "ready" ||
    saveCoordinator.isDirty(session)
  ) {
    return false;
  }
  if (session.refreshPromise) return session.refreshPromise;

  const refreshPromise = (async () => {
    try {
      const result = await readCloudState(db, session.userId);
      if (
        !isSyncSessionCurrent(session) ||
        !session.loaded ||
        session.conflicted ||
        saveCoordinator.isDirty(session)
      ) {
        return false;
      }
      if (result.revision === session.revision) return false;

      applyState(result.hasData ? result.state : {});
      session.revision = result.revision;
      el.cloudStatus.textContent =
        "他の端末で更新されたクラウド内容を自動反映しました。";
      return true;
    } catch (error) {
      if (isSyncSessionCurrent(session) && !saveCoordinator.isDirty(session)) {
        console.error(error);
        el.cloudStatus.textContent =
          "クラウドの更新確認に失敗しました。次回の画面復帰時に再試行します。\n" +
          (error?.message || error);
      }
      return false;
    } finally {
      if (session.refreshPromise === refreshPromise) {
        session.refreshPromise = null;
      }
    }
  })();
  session.refreshPromise = refreshPromise;
  return refreshPromise;
}

function autoSaveToCloud(options = {}) {
  const session = activeSyncSession;
  if (!db || !isInteractionReady() || !session || isApplyingCloudState) return;

  void saveCoordinator.request({
    session,
    snapshot: buildSplitStates(),
    options: {
      allowEmptyPdfMaterials: options.allowEmptyPdfMaterials === true,
      allowEmptyQuestions: options.allowEmptyQuestions === true,
      allowEmptyProgress: options.allowEmptyProgress === true,
      allowEmptySettings: options.allowEmptySettings === true,
      showAlerts: options.showAlerts === true
    },
    immediate: false
  });
}

document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => showTab(tab.dataset.tab));
});

window.addEventListener("scroll", updateFloatingStudyActions, { passive: true });
window.addEventListener("resize", updateFloatingStudyActions);
document.addEventListener("visibilitychange", () => {
  const session = activeSyncSession;
  if (document.visibilityState === "hidden" && session && saveCoordinator.isDirty(session)) {
    void saveCoordinator.flush(session);
  } else if (document.visibilityState === "visible") {
    void refreshFromCloudIfClean();
  }
});
window.addEventListener("pageshow", () => {
  void refreshFromCloudIfClean();
});
window.addEventListener("pagehide", () => {
  const session = activeSyncSession;
  if (session && saveCoordinator.isDirty(session)) {
    void saveCoordinator.flush(session);
  }
});
window.addEventListener("beforeunload", event => {
  const session = activeSyncSession;
  if (!session || !saveCoordinator.isDirty(session)) return;
  event.preventDefault();
  event.returnValue = "";
});

document.getElementById("chooseIphone").addEventListener("click", () => {
  deviceMode = "iphone";
  renderStudy();
  autoSaveToCloud();
});
document.getElementById("chooseIpad").addEventListener("click", () => {
  deviceMode = "ipad";
  renderStudy();
  autoSaveToCloud();
});

el.subjectFilter.addEventListener("change", () => {
  subjectFilter = el.subjectFilter.value || "all";
  selectedPrimarySubcategory = "";
  selectedSubcategories = [];
  applyStudyFilterChange();
});
el.primarySubcategorySelect.addEventListener("change", () => {
  selectedPrimarySubcategory = el.primarySubcategorySelect.value || "";
  selectedSubcategories = [];
  applyStudyFilterChange();
});
el.addConditionGroupBtn.addEventListener("click", addCurrentStudyCondition);
el.clearCurrentConditionBtn.addEventListener("click", () => {
  clearCurrentStudyCondition({ resetSubject: true });
  applyStudyFilterChange();
});
el.orderMode.addEventListener("change", () => {
  orderMode = el.orderMode.value;
  applyStudyFilterChange({ reshuffle: orderMode === "random" });
});
document.getElementById("applyStudyBtn").addEventListener("click", applyStudyCondition);
document.getElementById("shuffleBtn").addEventListener("click", () => {
  currentIndex = 0;
  renderStudy({ reshuffle: true });
  autoSaveToCloud();
});

document.getElementById("showAnswerBtn").addEventListener("click", showAnswerAndExplanation);
document.getElementById("showAnswerBtnIpad").addEventListener("click", showAnswerAndExplanation);
const nextBtn = document.getElementById("nextBtn");
if (nextBtn) nextBtn.addEventListener("click", nextQuestion);
const nextBtnIpad = document.getElementById("nextBtnIpad");
if (nextBtnIpad) nextBtnIpad.addEventListener("click", nextQuestion);
document.getElementById("judgeBtn").addEventListener("click", judgeIpadAnswer);
document.getElementById("knownBtn").addEventListener("click", markKnown);
document.getElementById("unknownBtn").addEventListener("click", markUnknown);
document.getElementById("reviewWrongBtn").addEventListener("click", reviewWrongOnly);
document.getElementById("reviewUnansweredBtn").addEventListener("click", reviewUnansweredOnly);
const resetWrongBtn = document.getElementById("resetWrongQuestionsBtn");
if (resetWrongBtn) resetWrongBtn.addEventListener("click", resetWrongQuestions);

document.getElementById("resetProgressBtn").addEventListener("click", resetProgress);

questionManager.bindEvents();
imageMemory.bindEvents();

document.getElementById("signInBtn").addEventListener("click", signInUser);
document.getElementById("signOutBtn").addEventListener("click", signOutUser);

el.userAnswer.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    judgeIpadAnswer();
  }
});

function init() {
  try {
    allQuestions = [];
    wrongQuestionIds = [];
    progress = {};
    questionStatuses = {};
    studyMode = "normal";

    if (el.cloudStatus) {
      el.cloudStatus.textContent = "JavaScript起動確認：Firebase初期化を開始します...";
    }

    try { updateSubjectOptions(); } catch (error) { console.error("updateSubjectOptions failed", error); }
    try { renderManageTable(); } catch (error) { console.error("renderManageTable failed", error); }
    try { if (typeof renderManageFilterUi === "function") renderManageFilterUi(); } catch (error) { console.error("renderManageFilterUi failed", error); }
    try { renderProgressTable(); } catch (error) { console.error("renderProgressTable failed", error); }
    try { renderStudy(); } catch (error) { console.error("renderStudy failed", error); }
    try { renderPdfTable(); } catch (error) { console.error("renderPdfTable failed", error); }
    try { renderPdfFilterUi(); } catch (error) { console.error("renderPdfFilterUi failed", error); }
    try { renderPdfMaskTable(); } catch (error) { console.error("renderPdfMaskTable failed", error); }
    try { renderPdfViewer(); } catch (error) { console.error("renderPdfViewer failed", error); }
    try { resetBulkImportState(); } catch (error) { console.error("resetBulkImportState failed", error); }
    try { updateLoginLockedUI(); } catch (error) { console.error("updateLoginLockedUI failed", error); }
    try { showTab("auth"); } catch (error) { console.error("showTab failed", error); }
    if (el.forceResetStudyFiltersBtn) {
      el.forceResetStudyFiltersBtn.addEventListener("click", resetStudyFiltersToAll);
    }
  } catch (error) {
    console.error("init failed", error);
    if (el.cloudStatus) {
      el.cloudStatus.textContent = "初期表示でエラーが出ましたが、Firebase接続を続行します。\n" + (error.message || error);
    }
  } finally {
    initFirebase();
  }
}


if (el.prevBtn) {
  el.prevBtn.addEventListener("click", previousQuestion);
}
if (el.prevBtnIpad) {
  el.prevBtnIpad.addEventListener("click", previousQuestion);
}

init();
