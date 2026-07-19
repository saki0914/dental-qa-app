import {
  createUserWithEmailAndPassword,
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
  normalizeConditionGroup,
  normalizeConditionGroups,
  normalizeQuestionAnswers,
  normalizeSubcategories,
  normalizeToken
} from "./core/text-utils.js";
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
let subcategoryConditionGroups = [];
let selectedConditionGroupIndex = 0;
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
  studySubcategoryList: document.getElementById("studySubcategoryList"),
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
  passwordConfirmInput: document.getElementById("passwordConfirmInput"),
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
  pdfTitleInput: document.getElementById("pdfTitleInput"),
  pdfFileInput: document.getElementById("pdfFileInput"),
  addPdfBtn: document.getElementById("addPdfBtn"),
  updatePdfBtn: document.getElementById("updatePdfBtn"),
  deletePdfBtn: document.getElementById("deletePdfBtn"),
  pdfTableBody: document.getElementById("pdfTableBody"),
  pdfMaskTableBody: document.getElementById("pdfMaskTableBody"),
  pdfViewerArea: document.getElementById("pdfViewerArea"),
  pdfStatus: document.getElementById("pdfStatus"),
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
  requestAutoSave: options => autoSaveToCloud(options)
});

const imageMemory = createImageMemory({
  el,
  getCurrentUser: () => currentUser,
  getStorage: () => storage,
  requestAutoSave: options => autoSaveToCloud(options),
  requestSave: options => saveToCloud(options)
});

function renderManageTable() { questionManager.render(); }
function renderManageFilterUi() { questionManager.renderFilter(); }
function resetBulkImportState() { questionManager.resetBulkImport(); }
function renderPdfTable() { imageMemory.render(); }
function renderPdfFilterDropdownUi() { imageMemory.ensureFilterUi(); }
function renderPdfMaskTable() { imageMemory.renderMasks(); }
function renderPdfViewer(preserveScroll = false) { imageMemory.renderViewer(preserveScroll); }
function ensurePdfTagUi() { imageMemory.ensureTagUi(); }


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
  const source = subjectFilter === "all"
    ? allQuestions
    : allQuestions.filter(q => q.subject === subjectFilter);

  return [...new Set(
    source
      .map(q => Array.isArray(q.subcategories) ? q.subcategories[0] : "")
      .filter(Boolean)
  )].sort();
}

function getRelatedSubcategories(primary) {
  if (!primary) return [];

  const source = subjectFilter === "all"
    ? allQuestions
    : allQuestions.filter(q => q.subject === subjectFilter);

  return [...new Set(
    source
      .filter(q => Array.isArray(q.subcategories) && q.subcategories[0] === primary)
      .flatMap(q => q.subcategories || [])
      .filter(Boolean)
  )].sort();
}

function ensureSubcategoryDropdownUi() {
  if (document.getElementById("primarySubcategorySelect")) return;

  if (!el.studySubcategoryList) return;

  const panel = document.createElement("div");
  panel.id = "subcatFilterPanel";
  panel.className = "subcat-filter-panel";
  panel.innerHTML = `
    <select id="primarySubcategorySelect">
      <option value="">章・大分類を選択してください</option>
    </select>
    <div class="subcat-checkbox-list" id="relatedSubcategoryChecklist">
      <div class="condition-group-help">上のドロップダウンから章・大分類を選んでください。</div>
    </div>
  `;

  el.studySubcategoryList.style.display = "none";
  el.studySubcategoryList.insertAdjacentElement("afterend", panel);

  document.getElementById("primarySubcategorySelect").addEventListener("change", () => {
    selectedPrimarySubcategory = document.getElementById("primarySubcategorySelect").value || "";
    selectedSubcategories = selectedPrimarySubcategory ? [selectedPrimarySubcategory] : [];
    renderStudySubcategoryChips();
    buildFilteredQuestions();
    cleanupStaleStudyFilters();
    renderStudy();
    autoSaveToCloud();
  });
}

function renderPrimarySubcategorySelect() {
  ensureSubcategoryDropdownUi();

  const select = document.getElementById("primarySubcategorySelect");
  if (!select) return;

  const primaryItems = getPrimarySubcategories();

  if (selectedPrimarySubcategory && !primaryItems.includes(selectedPrimarySubcategory)) {
    selectedPrimarySubcategory = "";
    selectedSubcategories = [];
  }

  if (!primaryItems.length) {
    select.innerHTML = '<option value="">章・大分類は未登録です</option>';
    select.value = "";
    return;
  }

  select.innerHTML = `<option value="">章・大分類を選択してください</option>` +
    primaryItems.map(item => `
      <option value="${escapeHtml(item)}" ${item === selectedPrimarySubcategory ? "selected" : ""}>
        ${escapeHtml(item)}
      </option>
    `).join("");
}

function renderRelatedSubcategoryChecklist() {
  ensureSubcategoryDropdownUi();

  const list = document.getElementById("relatedSubcategoryChecklist");
  if (!list) return;

  if (!allQuestions.length) {
    list.innerHTML = '<div class="condition-group-help">問題が0件です。問題管理タブから問題を追加、またはJSON一括登録してください。</div>';
    return;
  }

  if (!selectedPrimarySubcategory) {
    list.innerHTML = '<div class="condition-group-help">上のドロップダウンから章・大分類を選んでください。</div>';
    return;
  }

  const related = getRelatedSubcategories(selectedPrimarySubcategory);

  if (!related.length) {
    list.innerHTML = '<div class="condition-group-help">関連サブカテゴリがありません。</div>';
    return;
  }

  if (!selectedSubcategories.includes(selectedPrimarySubcategory)) {
    selectedSubcategories.unshift(selectedPrimarySubcategory);
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

      if (selectedPrimarySubcategory && !selectedSubcategories.includes(selectedPrimarySubcategory)) {
        selectedSubcategories.unshift(selectedPrimarySubcategory);
      }

      renderRelatedSubcategoryChecklist();
      renderConditionGroups();
      buildFilteredQuestions();
      renderStudy();
      autoSaveToCloud();
    });
  });
}


function getAvailableSubcategories() {
  const source = subjectFilter === "all"
    ? allQuestions
    : allQuestions.filter(q => q.subject === subjectFilter);

  return [...new Set(
    source.flatMap(q => Array.isArray(q.subcategories) ? q.subcategories : [])
  )].sort();
}

function renderStudySubcategoryChips() {
  const items = getAvailableSubcategories();

  if (!items.length) {
    el.studySubcategoryList.innerHTML = '<span class="subcat-title">サブカテゴリなし</span>';
  } else {
    el.studySubcategoryList.innerHTML = items.map(name => `
      <button type="button" class="subcat-chip ${selectedSubcategories.includes(name) ? "active" : ""}" data-subcat="${escapeHtml(name)}">
        ${escapeHtml(name)}
      </button>
    `).join("");

    [...el.studySubcategoryList.querySelectorAll("[data-subcat]")].forEach(btn => {
      btn.addEventListener("click", () => {
        const value = btn.dataset.subcat;
        if (selectedSubcategories.includes(value)) {
          selectedSubcategories = selectedSubcategories.filter(item => item !== value);
        } else {
          selectedSubcategories = [...selectedSubcategories, value];
        }
        renderStudySubcategoryChips();
        buildFilteredQuestions();
        renderStudy();
        autoSaveToCloud();
      });
    });
  }

  if (!selectedPrimarySubcategory && selectedSubcategories.length) {
    const primaryItems = getPrimarySubcategories();
    const first = selectedSubcategories.find(tag => primaryItems.includes(tag));
    if (first) selectedPrimarySubcategory = first;
  }

  renderPrimarySubcategorySelect();
  renderRelatedSubcategoryChecklist();
  ensureConditionGroupUi();
  renderConditionGroups();
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
  subjectFilter = "all";
  selectedSubcategories = [];
  selectedPrimarySubcategory = "";
  subcategoryConditionGroups = [];
  selectedConditionGroupIndex = 0;
  currentIndex = 0;

  if (el.subjectFilter) el.subjectFilter.value = "all";

  const primarySelect = document.getElementById("primarySubcategorySelect");
  if (primarySelect) primarySelect.value = "";

  cleanupStaleStudyFilters();
  renderStudySubcategoryChips();
  renderConditionGroups();
  buildFilteredQuestions();
  renderStudy();
  autoSaveToCloud();
}

function recoverStudyFiltersIfEmpty() {
  if (!allQuestions.length) return false;

  const beforeCount = filteredQuestions.length;
  if (beforeCount > 0) return false;

  const hadAnyFilter =
    subjectFilter !== "all" ||
    selectedSubcategories.length ||
    selectedPrimarySubcategory ||
    subcategoryConditionGroups.length;

  if (!hadAnyFilter) return false;

  subjectFilter = "all";
  selectedSubcategories = [];
  selectedPrimarySubcategory = "";
  subcategoryConditionGroups = [];
  selectedConditionGroupIndex = 0;
  currentIndex = 0;

  return true;
}


function getBaseStudyQuestions() {
  let base = subjectFilter === "all"
    ? [...allQuestions]
    : allQuestions.filter(q => q.subject === subjectFilter);

  const activeGroups = normalizeConditionGroups(subcategoryConditionGroups);
  const currentGroup = normalizeConditionGroup(selectedSubcategories);

  if (activeGroups.length || currentGroup.length) {
    base = base.filter(q => {
      const tags = Array.isArray(q.subcategories) ? q.subcategories : [];

      const matchesSavedGroups = activeGroups.length
        ? activeGroups.some(group => group.every(tag => tags.includes(tag)))
        : false;

      const matchesCurrentGroup = currentGroup.length
        ? currentGroup.every(tag => tags.includes(tag))
        : false;

      // 条件セットがある場合: 保存済み条件セット OR 現在選択中の条件。
      // 条件セットがない場合: 現在選択中の条件だけでAND検索。
      // When condition groups exist: saved groups OR current selected group.
      // When no condition group exists: use current selected group as normal AND search.
      return activeGroups.length
        ? (matchesSavedGroups || matchesCurrentGroup)
        : matchesCurrentGroup;
    });
  }
  return base;
}

function getUnansweredQuestionsFromBase() {
  return getBaseStudyQuestions().filter(q => getQuestionState(q.id) === null);
}

function applyCurrentStudyMode() {
  const base = getBaseStudyQuestions();

  if (studyMode === "wrongOnly") {
    const wrongSet = new Set(wrongQuestionIds);
    filteredQuestions = base.filter(q => wrongSet.has(q.id));
  } else if (studyMode === "unansweredOnly") {
    filteredQuestions = base.filter(q => getQuestionState(q.id) === null);
  } else {
    filteredQuestions = orderMode === "random" ? shuffle(base) : base;
  }

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


function getAvailableSubcategorySetForCurrentSubject() {
  const source = subjectFilter === "all"
    ? allQuestions
    : allQuestions.filter(q => q.subject === subjectFilter);

  return new Set(
    source.flatMap(q => Array.isArray(q.subcategories) ? q.subcategories : []).filter(Boolean)
  );
}

function cleanupStaleStudyFilters() {
  const subjects = [...new Set(allQuestions.map(q => q.subject).filter(Boolean))];

  if (subjectFilter !== "all" && !subjects.includes(subjectFilter)) {
    subjectFilter = "all";
  }

  const availableTags = getAvailableSubcategorySetForCurrentSubject();

  selectedSubcategories = selectedSubcategories.filter(tag => availableTags.has(tag));

  const primaryItems = getPrimarySubcategories();
  if (selectedPrimarySubcategory && !primaryItems.includes(selectedPrimarySubcategory)) {
    selectedPrimarySubcategory = "";
  }

  subcategoryConditionGroups = normalizeConditionGroups(subcategoryConditionGroups)
    .map(group => group.filter(tag => availableTags.has(tag)))
    .filter(group => group.length);

  if (selectedConditionGroupIndex < 0 || selectedConditionGroupIndex >= subcategoryConditionGroups.length) {
    selectedConditionGroupIndex = 0;
  }

  if (currentIndex >= filteredQuestions.length) {
    currentIndex = 0;
  }

  if (!allQuestions.length) {
    subjectFilter = "all";
    selectedSubcategories = [];
    selectedPrimarySubcategory = "";
    subcategoryConditionGroups = [];
    selectedConditionGroupIndex = 0;
    currentIndex = 0;
  }
}


function updateSubjectOptions() {
  const subjects = [...new Set(allQuestions.map(q => q.subject).filter(Boolean))].sort();

  if (!el.subjectFilter) return;

  el.subjectFilter.innerHTML =
    '<option value="all">すべての教科</option>' +
    subjects.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("");

  if (subjectFilter !== "all" && !subjects.includes(subjectFilter)) {
    subjectFilter = "all";
  }

  el.subjectFilter.value = subjectFilter;
}


function ensureConditionGroupUi() {
  if (document.getElementById("conditionGroupBox")) return;

  const subcatList =
    document.getElementById("subcatFilterPanel") ||
    document.getElementById("studySubcategoryList") ||
    document.getElementById("subcategoryList") ||
    document.getElementById("subCategoryList") ||
    document.getElementById("subcatList") ||
    document.querySelector("#tab-study .subcat-list") ||
    [...document.querySelectorAll(".subcat-list")].find(node => node.querySelector(".subcat-chip"));

  if (!subcatList) return;

  const box = document.createElement("div");
  box.id = "conditionGroupBox";
  box.className = "condition-groups";
  box.innerHTML = `
    <div class="condition-group-help">
条件セット検索：
選択中のサブカテゴリを「条件セット」として追加できます。
条件セット内はAND、条件セット同士はORです。

例：
条件1：2章_医療安全と感染予防 ＋ 分類
条件2：3章_滅菌・消毒 ＋ 数値
→ 条件1 または 条件2 に当てはまる問題を出題します。
    </div>
    <div class="grid3">
      <button class="btn soft" id="addConditionGroupBtn" type="button">現在の選択を条件セット追加</button>
      <button class="btn" id="clearCurrentSubcatBtn" type="button">現在の選択を解除</button>
    </div>
    <div id="conditionGroupList"></div>
  `;

  subcatList.insertAdjacentElement("afterend", box);

  document.getElementById("addConditionGroupBtn").addEventListener("click", addCurrentSubcategoriesAsConditionGroup);
  document.getElementById("clearCurrentSubcatBtn").addEventListener("click", () => {
    selectedSubcategories = [];
    selectedPrimarySubcategory = "";
    renderStudySubcategoryChips();
    renderConditionGroups();
    buildFilteredQuestions();
    renderStudy();
    autoSaveToCloud();
  });

  renderConditionGroups();
}

function addCurrentSubcategoriesAsConditionGroup() {
  const group = normalizeConditionGroup(selectedSubcategories);
  if (!group.length) {
    alert("条件セットに追加するサブカテゴリを選択してください。");
    return;
  }

  const key = JSON.stringify(group);
  const exists = subcategoryConditionGroups.some(existing => JSON.stringify(normalizeConditionGroup(existing)) === key);
  if (!exists) {
    subcategoryConditionGroups.push(group);
    selectedConditionGroupIndex = subcategoryConditionGroups.length - 1;
  } else {
    selectedConditionGroupIndex = subcategoryConditionGroups.findIndex(existing => JSON.stringify(normalizeConditionGroup(existing)) === key);
  }

  // 次の条件を作れるように、現在の選択状態を完全に空にする。
  // Clear the current selection completely so the next condition can be created.
  selectedSubcategories = [];
  selectedPrimarySubcategory = "";

  renderStudySubcategoryChips();
  renderConditionGroups();
  buildFilteredQuestions();
  renderStudy();
  autoSaveToCloud();
}

function renderConditionGroups() {
  const list = document.getElementById("conditionGroupList");
  if (!list) return;

  subcategoryConditionGroups = normalizeConditionGroups(subcategoryConditionGroups);

  if (!subcategoryConditionGroups.length) {
    selectedConditionGroupIndex = 0;
    list.innerHTML = '<div class="condition-group-help">条件セットは未設定です。必要な場合は現在の選択を条件セットとして追加できます。</div>';
    return;
  }

  if (selectedConditionGroupIndex < 0 || selectedConditionGroupIndex >= subcategoryConditionGroups.length) {
    selectedConditionGroupIndex = 0;
  }

  const selectedGroup = subcategoryConditionGroups[selectedConditionGroupIndex] || [];

  list.innerHTML = `
    <select id="conditionGroupSelect" style="margin-bottom:10px;">
      ${subcategoryConditionGroups.map((group, index) => `
        <option value="${index}" ${index === selectedConditionGroupIndex ? "selected" : ""}>
          条件${index + 1}：${escapeHtml(group.join(" ＋ "))}
        </option>
      `).join("")}
    </select>

    <div class="condition-group-card">
      <div class="condition-group-title">条件${selectedConditionGroupIndex + 1}</div>
      <div class="condition-group-tags">
        ${selectedGroup.map(tag => `<span class="condition-group-tag">${escapeHtml(tag)}</span>`).join("")}
      </div>
      <button class="btn ng" type="button" id="removeSelectedConditionGroupBtn">この条件を削除</button>
    </div>
  `;

  document.getElementById("conditionGroupSelect").addEventListener("change", event => {
    selectedConditionGroupIndex = Number(event.target.value || 0);
    renderConditionGroups();
    autoSaveToCloud();
  });

  document.getElementById("removeSelectedConditionGroupBtn").addEventListener("click", () => {
    subcategoryConditionGroups.splice(selectedConditionGroupIndex, 1);
    if (selectedConditionGroupIndex >= subcategoryConditionGroups.length) {
      selectedConditionGroupIndex = Math.max(0, subcategoryConditionGroups.length - 1);
    }
    renderConditionGroups();
    buildFilteredQuestions();
    renderStudy();
    autoSaveToCloud();
  });
}

function questionMatchesConditionGroups(q) {
  const groups = normalizeConditionGroups(subcategoryConditionGroups);
  if (!groups.length) return true;

  const tags = Array.isArray(q.subcategories) ? q.subcategories : [];

  // 条件セット内はAND、条件セット同士はOR。
  // Inside each condition group is AND, between groups is OR.
  return groups.some(group => group.every(tag => tags.includes(tag)));
}


function buildFilteredQuestions() {
  applyCurrentStudyMode();

  if (recoverStudyFiltersIfEmpty()) {
    filteredQuestions = getBaseStudyQuestions();
  }
}

function updateStudyStatsOnly() {
  el.totalCount.textContent = String(filteredQuestions.length);
  el.currentCount.textContent = String(filteredQuestions.length ? currentIndex + 1 : 0);
  el.correctCount.textContent = String(filteredQuestions.filter(q => getQuestionState(q.id) === 1).length);
  el.wrongCount.textContent = String(filteredQuestions.filter(q => getQuestionState(q.id) === 2).length);
}

function renderStudy() {
  if (allQuestions.length && filteredQuestions.length === 0 && recoverStudyFiltersIfEmpty()) buildFilteredQuestions();
  cleanupStaleStudyFilters();
  updateSubjectOptions();
  renderStudySubcategoryChips();
  buildFilteredQuestions();

  el.totalCount.textContent = String(filteredQuestions.length);
  el.currentCount.textContent = String(filteredQuestions.length ? currentIndex + 1 : 0);
  const filteredIds = new Set(filteredQuestions.map(q => q.id));
  const wrongCount = filteredQuestions.filter(q => questionStatuses[q.id] === "unknown").length;
  const correctCount = filteredQuestions.filter(q => questionStatuses[q.id] === "known").length;
  el.wrongCount.textContent = String(filteredQuestions.filter(q => getQuestionState(q.id) === 2).length);
  el.correctCount.textContent = String(filteredQuestions.filter(q => getQuestionState(q.id) === 1).length);

  el.chooseIphone.classList.toggle("active", deviceMode === "iphone");
  el.chooseIpad.classList.toggle("active", deviceMode === "ipad");
  el.iphoneArea.classList.toggle("hidden", deviceMode !== "iphone");
  el.ipadArea.classList.toggle("hidden", deviceMode !== "ipad");

  const rangeText = subjectFilter === "all" ? "全教科" : subjectFilter;
  const subcatText = selectedSubcategories.length ? ` / サブカテゴリ: ${selectedSubcategories.join("・")}` : "";
  const orderText = orderMode === "random" ? "ランダム" : "順番どおり";
  const modeText = studyMode === "wrongOnly"
    ? " / 苦手復習"
    : studyMode === "unansweredOnly"
      ? " / 未解答のみ"
      : "";
  el.studyMeta.textContent = `${deviceMode === "iphone" ? "iPhone版" : "iPad版"} / ${rangeText}${subcatText} / ${orderText}${modeText}`;

  const q = currentQuestion();
  if (!q) {
    el.question.textContent = "問題がありません。";
    renderQuestionImage(null);
    el.answerBox.style.display = "none";
    el.explainBox.style.display = "none";
    clearIpadAnswerInputs();
    clearJudgeStatus();
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
  subjectFilter = el.subjectFilter.value;
  selectedSubcategories = selectedSubcategories.filter(name => getAvailableSubcategories().includes(name));
  orderMode = el.orderMode.value;
  studyMode = "normal";
  currentIndex = 0;
  renderStudy();
  autoSaveToCloud();
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
    subjectFilter = state.subjectFilter || "all";
    selectedSubcategories = Array.isArray(state.selectedSubcategories) ? state.selectedSubcategories : [];
    selectedPrimarySubcategory = state.selectedPrimarySubcategory || selectedSubcategories[0] || "";
    subcategoryConditionGroups = normalizeConditionGroups(state.subcategoryConditionGroups);
    selectedConditionGroupIndex = Number.isInteger(state.selectedConditionGroupIndex) ? state.selectedConditionGroupIndex : 0;
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
    el.subjectFilter.value = subjectFilter;
    el.orderMode.value = orderMode;
    selectedSubcategories = selectedSubcategories.filter(name => getAvailableSubcategories().includes(name));
    buildFilteredQuestions();
    renderManageTable();
    renderProgressTable();
    renderStudy();
    renderPdfTable();
    renderPdfMaskTable();
    renderPdfViewer();
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
    "chooseIphone","chooseIpad","subjectFilter","orderMode","applyStudyBtn","shuffleBtn","forceResetStudyFiltersBtn",
    "userAnswer","judgeBtn","showAnswerBtnIpad","nextBtnIpad","showAnswerBtn","nextBtn",
    "knownBtn","unknownBtn","reviewWrongBtn","reviewUnansweredBtn","resetWrongQuestionsBtn"
  ], !loggedIn);

  setInteractiveDisabled([
    "editSubject","searchInput","editQuestion","editAnswers","editExplanation","editOrderedAnswers","editImageFile","removeImageBtn","editImageName",
    "addBtn","updateBtn","deleteBtn","clearFormBtn","saveCloudBtn","loadCloudBtn","bulkImportFile","bulkImportValidateBtn","bulkImportExecuteBtn","bulkImportResetBtn",
    "saveCloudBtn2","resetProgressBtn",
    "pdfTitleInput","pdfFileInput","addPdfBtn","updatePdfBtn","deletePdfBtn",
    "maskPageInput","maskXInput","maskYInput","maskWInput","maskHInput",
    "addMaskModeBtn","updateMaskBtn","deleteMaskBtn","clearMaskSelectionBtn","resetPdfRevealBtn"
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

async function signUpUser() {
  if (!auth) {
    alert("Firebase未接続です。");
    return;
  }
  const email = el.emailInput.value.trim();
  const password = el.passwordInput.value;
  const confirmPassword = el.passwordConfirmInput.value;

  if (!email || !password) {
    alert("メールアドレスとパスワードを入力してください。");
    return;
  }
  if (password !== confirmPassword) {
    alert("確認用パスワードが一致していません。");
    return;
  }

  try {
    await createUserWithEmailAndPassword(auth, email, password);
    el.cloudStatus.textContent = "新規登録に成功しました。";
  } catch (error) {
    console.error(error);
    alert("新規登録に失敗しました: " + error.message);
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
      selectedPdfTags: imageState.selectedPdfTags,
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
      subcategoryConditionGroups,
      selectedConditionGroupIndex,
      orderMode,
      studyMode,
      manageSubjectFilter: questionSettings.manageSubjectFilter,
      managePrimarySubcategory: questionSettings.managePrimarySubcategory,
      manageSelectedSubcategories: questionSettings.manageSelectedSubcategories,
      pdfSelectedTagFilter: imageState.pdfSelectedTagFilter,
      schemaVersion: "split-v1",
      updatedAt: serverTimestamp()
    },
    main: {
      schemaVersion: "split-v1",
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

document.getElementById("subjectFilter").addEventListener("change", () => {
  subjectFilter = el.subjectFilter.value;
  selectedSubcategories = selectedSubcategories.filter(name => getAvailableSubcategories().includes(name));
  renderStudySubcategoryChips();
});
document.getElementById("applyStudyBtn").addEventListener("click", applyStudyCondition);
document.getElementById("shuffleBtn").addEventListener("click", () => {
  filteredQuestions = shuffle(filteredQuestions);
  currentIndex = 0;
  renderStudyCurrentOnlyAfterShuffle();
  autoSaveToCloud();
});

function renderStudyCurrentOnlyAfterShuffle() {
  el.totalCount.textContent = String(filteredQuestions.length);
  el.currentCount.textContent = String(filteredQuestions.length ? currentIndex + 1 : 0);
  const q = currentQuestion();
  if (!q) return;
  el.question.textContent = formatDisplayText(q.question);
  renderQuestionImage(q);
  el.answerBox.innerHTML = `<b>正解</b><br>${ensureCurrentQuestionAnswers(q).map(escapeDisplayText).join("\n")}`;
  el.explainBox.innerHTML = `<b>解説</b><br>${escapeDisplayText(q.explanation || "解説なし")}`;
  el.answerBox.style.display = "none";
  el.explainBox.style.display = "none";
  if (el.studyActions) el.studyActions.classList.remove("is-floating");
  el.userAnswer.value = "";
  clearJudgeStatus();
}

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

document.getElementById("signUpBtn").addEventListener("click", signUpUser);
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
    try { if (typeof renderPdfFilterDropdownUi === "function") renderPdfFilterDropdownUi(); } catch (error) { console.error("renderPdfFilterDropdownUi failed", error); }
    try { renderPdfMaskTable(); } catch (error) { console.error("renderPdfMaskTable failed", error); }
    try { renderPdfViewer(); } catch (error) { console.error("renderPdfViewer failed", error); }
    try { resetBulkImportState(); } catch (error) { console.error("resetBulkImportState failed", error); }
    try { updateLoginLockedUI(); } catch (error) { console.error("updateLoginLockedUI failed", error); }
    try { showTab("auth"); } catch (error) { console.error("showTab failed", error); }
    try { movePdfMaskManagementBelowViewer(); } catch (error) { console.error("movePdfMaskManagementBelowViewer failed", error); }
    try { ensurePdfTagUi(); } catch (error) { console.error("ensurePdfTagUi failed", error); }
    try { ensureConditionGroupUi(); } catch (error) { console.error("ensureConditionGroupUi failed", error); }

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
