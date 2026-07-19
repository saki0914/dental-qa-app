import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js";
import {
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js";
import { initializeFirebaseServices } from "./config/firebase.js";
import {
  escapeDisplayText,
  escapeHtml,
  formatDisplayText,
  normalizeAnswerList,
  normalizeQuestionAnswers,
  normalizeSubcategories,
  normalizeToken
} from "./core/text-utils.js";
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
  readLegacyDocument,
  readSaveGuardDocuments,
  readSplitDocuments,
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
  managePanel: document.getElementById("tab-manage"),
  manageFullscreenBtn: document.getElementById("manageFullscreenBtn"),
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
  deletePdfBtn: document.getElementById("deletePdfBtn"),
  pdfTableBody: document.getElementById("pdfTableBody"),
  pdfEditTableBody: document.getElementById("pdfEditTableBody"),
  pdfEditPreview: document.getElementById("pdfEditPreview"),
  pdfMaskTableBody: document.getElementById("pdfMaskTableBody"),
  pdfViewerArea: document.getElementById("pdfViewerArea"),
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

const questionManager = createQuestionManager({
  el,
  getCurrentUser: () => currentUser,
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
  getCurrentUser: () => currentUser,
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
  autoSaveToCloud();
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

function resetWrongQuestionsQuestions() {
  allQuestions.forEach(q => {
    if (getQuestionState(q.id) === 2) {
      setQuestionState(q.id, null);
    }
  });
  recalcProgressFromQuestionStates();
  buildFilteredQuestions();
  renderProgressTable();
  renderStudy();
  autoSaveToCloud();
}


function isOrderSensitiveQuestion(q) {
  const questionText = String(q?.question || "");

  // JSON側で orderedAnswers: true を指定した場合は順番固定にする。
  // If orderedAnswers: true is set in JSON, answers are checked in order.
  if (q && q.orderedAnswers === true) return true;

  // 穴埋めや a〜d 指定がある問題は、各欄の順番を固定して判定する。
  // Fill-in-the-blank questions with a-d labels are checked in order.
  return /(穴埋め|空欄|空所|[a-dａ-ｄＡ-Ｄ]\s*[〜~～]|[a-dａ-ｄＡ-Ｄ]\s*[）\).．:：])/i.test(questionText);
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
  const expected = normalizeAnswerList(expectedOriginal);
  const orderSensitive = isOrderSensitiveQuestion(q);

  if (!inputValues.some(value => value.trim())) {
    setJudgeStatus("warn", "まだ解答が入っていません。");
    return;
  }

  let isCorrect = false;
  let statusType = "ng";
  let statusMessage = "";

  if (orderSensitive) {
    const normalizedExpected = expectedOriginal.map(answer => normalizeToken(answer));
    const normalizedActual = inputValues.map(answer => normalizeToken(answer));
    const missingLabels = [];
    const wrongLabels = [];

    normalizedExpected.forEach((answer, index) => {
      const actual = normalizedActual[index] || "";
      if (!actual) missingLabels.push(getAnswerLabel(index, true));
      else if (actual !== answer) wrongLabels.push(getAnswerLabel(index, true));
    });

    const extraAnswers = normalizedActual.slice(normalizedExpected.length).filter(Boolean);

    if (!missingLabels.length && !wrongLabels.length && !extraAnswers.length) {
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
    const actual = normalizeAnswerList(inputValues);
    const missing = expected.filter(x => !actual.includes(x));
    const extra = actual.filter(x => !expected.includes(x));

    if (missing.length === 0 && extra.length === 0) {
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
  if (!currentUser) return;
  if (!confirm("進捗をリセットしますか？")) return;
  progress = {};
  questionStatuses = {};
  wrongQuestionIds = [];
  studyMode = "normal";
  allQuestions.forEach(q => ensureProgressRow(q.subject));
  renderProgressTable();
  renderStudy();
  autoSaveToCloud();
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
  if (!currentUser && tabName !== "auth") {
    tabName = "auth";
  }
  document.querySelectorAll(".tab").forEach(tab => {
    const canShow = currentUser || tab.dataset.tab === "auth";
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
    questionStatuses = state.questionStatuses || {};
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

  document.querySelectorAll('.tab').forEach(tab => {
    const isAuth = tab.dataset.tab === "auth";
    tab.classList.toggle("hidden", !loggedIn && !isAuth);
  });

  document.getElementById("tab-study").classList.toggle("hidden", !loggedIn);
  document.getElementById("tab-manage").classList.toggle("hidden", !loggedIn);
  document.getElementById("tab-progress").classList.toggle("hidden", !loggedIn);
  document.getElementById("tab-pdf").classList.toggle("hidden", !loggedIn);
  document.getElementById("tab-auth").classList.toggle("hidden", false);

  el.studyLockBanner.classList.toggle("hidden", loggedIn);
  el.manageLockBanner.classList.toggle("hidden", loggedIn);
  el.progressLockBanner.classList.toggle("hidden", loggedIn);
  el.pdfLockBanner.classList.toggle("hidden", loggedIn);

  setInteractiveDisabled([
    "chooseIphone","chooseIpad","subjectFilter","primarySubcategorySelect","orderMode","applyStudyBtn","shuffleBtn","forceResetStudyFiltersBtn","addConditionGroupBtn","clearCurrentConditionBtn",
    "userAnswer","judgeBtn","showAnswerBtnIpad","nextBtnIpad","showAnswerBtn","nextBtn",
    "knownBtn","unknownBtn","reviewWrongBtn","reviewUnansweredBtn","resetWrongQuestionsBtn"
  ], !loggedIn);

  document.querySelectorAll("#relatedSubcategoryChecklist input")
    .forEach(input => { input.disabled = !loggedIn; });

  setInteractiveDisabled([
    "editSubject","searchInput","editQuestion","editAnswers","editExplanation","editOrderedAnswers","editImageFile","removeImageBtn","editImageName",
    "addBtn","updateBtn","deleteBtn","clearFormBtn","saveCloudBtn","loadCloudBtn","bulkImportFile","bulkImportImageFiles","bulkImportValidateBtn","bulkImportExecuteBtn","bulkImportResetBtn","manageFullscreenBtn",
    "saveCloudBtn2","resetProgressBtn",
    "pdfStudyModeBtn","pdfEditModeBtn","pdfSearchInput","pdfSubjectFilterSelect","pdfCategoryFilterSelect",
    "pdfTitleInput","pdfSubjectInput","pdfCategoryInput","pdfFileInput","addPdfBtn","updatePdfBtn","deletePdfBtn",
    "maskPageInput","maskXInput","maskYInput","maskWInput","maskHInput",
    "addMaskModeBtn","updateMaskBtn","deleteMaskBtn","clearMaskSelectionBtn","selectAllMasksBtn","markWeakMaskBtn","showAllMasksBtn","resetPdfRevealBtn"
  ], !loggedIn);

  if (!loggedIn) {
    document.querySelectorAll(".tab").forEach(tab => {
      tab.classList.toggle("active", tab.dataset.tab === "auth");
    });
  }
}


function movePdfMaskManagementBelowViewer() {
  const panel = document.getElementById("pdfMaskManagementPanel");
  const viewer = document.getElementById("pdfViewerArea");
  if (!panel || !viewer) return;
  if (viewer.nextElementSibling !== panel) {
    viewer.parentNode.insertBefore(panel, viewer.nextSibling);
  }
}

async function initFirebase() {
  try {
    el.cloudStatus.textContent = "Firebase初期化中です...";
    ({ app, auth, db, storage } = initializeFirebaseServices());
    el.cloudStatus.textContent = "Firebase初期化完了です。ログイン状態を確認しています...";

    onAuthStateChanged(auth, async (user) => {
      if (user) {
        currentUser = user;
        el.authStatus.textContent = `ログイン中: ${user.email || "メール不明"}`;
        el.cloudStatus.textContent = "Firebase接続済みです。クラウド保存データを確認しています...";
        updateLoginLockedUI();

        const loaded = await loadFromCloud({ silentNoData: true, autoMode: true });
        if (loaded) {
          el.cloudStatus.textContent = "Firebase接続済みです。クラウド内容を自動反映しました。";
        } else {
          el.cloudStatus.textContent = "Firebase接続済みです。クラウド保存データがないため、現在の初期データを表示しています。";
          renderManageTable();
          renderProgressTable();
          renderStudy();
          renderPdfTable();
          renderPdfMaskTable();
          renderPdfViewer();
        }
        if (document.getElementById("tab-auth").classList.contains("hidden") === false) {
          showTab("study");
        }
      } else {
        currentUser = null;
        el.authStatus.textContent = "未ログインです。";
        el.cloudStatus.textContent = "Firebase接続済みです。ログインすると学習・問題管理・進捗・クラウド連携が使えます。";
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
  await signOut(auth);
  el.cloudStatus.textContent = "ログアウトしました。";
}


function buildSplitStates() {
  const imageState = imageMemory.serialize();
  const questionSettings = questionManager.serialize();

  return {
    questions: {
      allQuestions,
      updatedAt: serverTimestamp()
    },
    pdfMaterials: {
      pdfMaterials: imageState.pdfMaterials,
      pdfRevealStates: imageState.pdfRevealStates,
      selectedPdfId: imageState.selectedPdfId,
      selectedMaskId: imageState.selectedMaskId,
      pdfSearchQuery: imageState.pdfSearchQuery,
      updatedAt: serverTimestamp()
    },
    progress: {
      progress,
      questionStatuses,
      wrongQuestionIds,
      updatedAt: serverTimestamp()
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
      schemaVersion: "split-v2",
      updatedAt: serverTimestamp()
    },
    main: {
      schemaVersion: "split-v2",
      updatedAt: serverTimestamp()
    }
  };
}


async function saveToCloud(options = {}) {
  const {
    allowEmptyPdfMaterials = false,
    allowEmptyQuestions = false,
    showAlerts = true
  } = options;

  if (!db || !currentUser) {
    if (showAlerts) alert("先にログインしてください。");
    return false;
  }

  el.cloudStatus.textContent = "クラウドへ保存中です...";

  const userId = currentUser.uid;
  const splitState = buildSplitStates();

  const [questionsSnap, pdfSnap] = await readSaveGuardDocuments(db, userId);

  const currentQuestions = questionsSnap.exists() && Array.isArray(questionsSnap.data()?.allQuestions)
    ? questionsSnap.data().allQuestions
    : [];
  const nextQuestions = Array.isArray(splitState.questions.allQuestions)
    ? splitState.questions.allQuestions
    : [];

  if (!allowEmptyQuestions && currentQuestions.length > 0 && nextQuestions.length === 0) {
    const message =
      "安全のため保存を停止しました。\n\n" +
      "Firestore側には問題データが残っていますが、画面側の問題データが0件です。\n" +
      "このまま保存すると問題データが空で上書きされる可能性があります。\n\n" +
      "ページを再読み込みしてから確認してください。";

    el.cloudStatus.textContent = message;

    if (showAlerts) {
      alert(message);
    }

    return false;
  }

  const currentPdfMaterials = pdfSnap.exists() && Array.isArray(pdfSnap.data()?.pdfMaterials)
    ? pdfSnap.data().pdfMaterials
    : [];
  const nextPdfMaterials = Array.isArray(splitState.pdfMaterials.pdfMaterials)
    ? splitState.pdfMaterials.pdfMaterials
    : [];

  if (!allowEmptyPdfMaterials && currentPdfMaterials.length > 0 && nextPdfMaterials.length === 0) {
    const message =
      "安全のため画像暗記データの自動保存を停止しました。\n" +
      "Firestore側には画像暗記データが残っていますが、画面側の画像暗記データが0件です。\n" +
      "自動保存では空上書きしません。削除する場合は画像教材の削除ボタンから実行してください。";

    el.cloudStatus.textContent = message;

    if (showAlerts) {
      alert(
        "安全のため保存を停止しました。\n\n" +
        "Firestore側には画像暗記データが残っていますが、画面側の画像暗記データが0件です。\n" +
        "このまま保存すると画像暗記データが空で上書きされる可能性があります。\n\n" +
        "ページを再読み込みしてから確認してください。"
      );
    }

    return false;
  }

  await writeSplitDocuments(db, userId, splitState);

  el.cloudStatus.textContent = "クラウドに分離保存しました。";
  return true;
}

async function loadFromCloud(options = {}) {
  const { silentNoData = false, autoMode = false } = options;
  if (!db || !currentUser) {
    if (!silentNoData) alert("先にログインしてください。");
    return false;
  }

  const userId = currentUser.uid;
  const [questionsSnap, pdfSnap, progressSnap, settingsSnap] = await readSplitDocuments(db, userId);

  const hasSplitData =
    questionsSnap.exists() ||
    pdfSnap.exists() ||
    progressSnap.exists() ||
    settingsSnap.exists();

  if (hasSplitData) {
    const mergedState = {
      ...(questionsSnap.exists() ? questionsSnap.data() : {}),
      ...(pdfSnap.exists() ? pdfSnap.data() : {}),
      ...(progressSnap.exists() ? progressSnap.data() : {}),
      ...(settingsSnap.exists() ? settingsSnap.data() : {})
    };

    applyState(mergedState);

    if (!autoMode) {
      el.cloudStatus.textContent = "クラウドから分離保存データを再開しました。";
    }
    return true;
  }

  // 旧形式 app/main からの互換読み込み。
  // Compatible loading from the old app/main format.
  const legacySnap = await readLegacyDocument(db, userId);
  if (!legacySnap.exists()) {
    if (!silentNoData) alert("クラウド保存データがまだありません。");
    return false;
  }

  const legacyData = legacySnap.data();
  const hasLegacyContent =
    Array.isArray(legacyData.allQuestions) ||
    Array.isArray(legacyData.pdfMaterials);

  if (!hasLegacyContent) {
    if (!silentNoData) alert("クラウド保存データがまだありません。");
    return false;
  }

  applyState(legacyData);

  if (!autoMode) {
    el.cloudStatus.textContent = "旧形式のクラウドデータから再開しました。次回保存から分離保存されます。";
  }
  return true;
}

let autoSaveTimer = null;
function autoSaveToCloud(options = {}) {
  if (!db || !currentUser || isApplyingCloudState) return;

  const {
    allowEmptyPdfMaterials = false,
    allowEmptyQuestions = false,
    showAlerts = false
  } = options;

  el.cloudStatus.textContent = "クラウド保存を待機しています...";
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    saveToCloud({ allowEmptyPdfMaterials, allowEmptyQuestions, showAlerts }).catch(err => {
      console.error(err);
      el.cloudStatus.textContent = "クラウド自動保存を停止しました。詳細は画面メッセージまたはコンソールを確認してください。";
    });
  }, 600);
}

document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => showTab(tab.dataset.tab));
});

window.addEventListener("scroll", updateFloatingStudyActions, { passive: true });
window.addEventListener("resize", updateFloatingStudyActions);

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

document.getElementById("saveCloudBtn").addEventListener("click", () => saveToCloud().catch(console.error));
document.getElementById("saveCloudBtn2").addEventListener("click", () => saveToCloud().catch(console.error));
document.getElementById("loadCloudBtn").addEventListener("click", () => loadFromCloud().catch(console.error));
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
    try { movePdfMaskManagementBelowViewer(); } catch (error) { console.error("movePdfMaskManagementBelowViewer failed", error); }
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
