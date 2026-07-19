import {
  ref as storageRef,
  uploadBytes,
  getDownloadURL,
  deleteObject
} from "https://www.gstatic.com/firebasejs/11.7.3/firebase-storage.js";
import {
  escapeHtml,
  normalizeAnswerList,
  normalizeQuestionAnswers,
  normalizeSubcategories,
  textToAnswerList,
  textToAnswers,
  textToTagList
} from "../core/text-utils.js";

export function createQuestionManager(dependencies) {
  const {
    el,
    getCurrentUser,
    getStorage,
    getQuestions,
    setQuestions,
    ensureProgressRow,
    cleanupStaleStudyFilters,
    recalcProgressFromQuestionStates,
    updateSubjectOptions,
    buildFilteredQuestions,
    renderProgressTable,
    renderStudy,
    requestAutoSave
  } = dependencies;

  const shared = {};
  Object.defineProperty(shared, "allQuestions", {
    get: getQuestions,
    set: setQuestions
  });

  let selectedQuestionId = null;
  let manageSubjectFilter = "all";
  let managePrimarySubcategory = "";
  let manageSelectedSubcategories = [];
  let isRenderingManageFilter = false;
  let manageDeleteSelectedIds = [];
  let currentEditingImageUrl = "";
  let currentEditingImageName = "";
  let currentEditingImagePath = "";
  let pendingImageFile = null;
  let pendingRemoveImage = false;
  let bulkImportPreparedItems = [];

  function subcategoriesToText(subcategories) {
    return normalizeSubcategories(subcategories).join(",");
  }

function setBulkImportStatus(message) {
  if (el.bulkImportStatus) el.bulkImportStatus.textContent = message;
}

function normalizeImportRoot(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object" && Array.isArray(raw.allQuestions)) return raw.allQuestions;
  throw new Error("JSONの最上位は配列、または { allQuestions: [...] } にしてください。");
}

function buildQuestionIdentity(item) {
  const subject = String(item.subject || "").trim();
  const question = String(item.question || "").trim();
  const answers = normalizeAnswerList(normalizeQuestionAnswers(item.answers));
  return [subject, question, answers.join("|")].join("::");
}

function validateBulkImportItems(rawItems) {
  const issues = [];
  const warnings = [];
  const prepared = [];
  const seenImport = new Set();
  const existingIds = new Set(shared.allQuestions.map(buildQuestionIdentity));

  rawItems.forEach((raw, index) => {
    const rowNo = index + 1;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      issues.push(`行${rowNo}: オブジェクト形式ではありません。`);
      return;
    }

    const subject = String(raw.subject || "").trim();
    const question = String(raw.question || "").trim();
    const answers = Array.isArray(raw.answers)
      ? raw.answers.map(v => String(v || "").trim()).filter(Boolean)
      : textToAnswerList(String(raw.answers || ""));
    const explanation = String(raw.explanation || "").trim();
    const subcategories = normalizeSubcategories(
      Array.isArray(raw.subCategories) ? raw.subCategories :
      Array.isArray(raw.subcategories) ? raw.subcategories :
      textToAnswers(String(raw.subCategories || raw.subcategories || ""))
    );

    if (!subject) issues.push(`行${rowNo}: subject が空です。`);
    if (!question) issues.push(`行${rowNo}: question が空です。`);
    if (!answers.length) issues.push(`行${rowNo}: answers が空です。`);
    if (answers.some(a => !String(a).trim())) issues.push(`行${rowNo}: answers に空要素があります。`);
    if (subcategories.some(s => s.length > 80)) issues.push(`行${rowNo}: subCategories は1件80文字以内にしてください。`);
    if (subject.length > 80) issues.push(`行${rowNo}: subject は80文字以内にしてください。`);
    if (question.length > 500) issues.push(`行${rowNo}: question は500文字以内にしてください。`);
    if (explanation.length > 2000) issues.push(`行${rowNo}: explanation は2000文字以内にしてください。`);
    if (raw.orderedAnswers !== undefined && typeof raw.orderedAnswers !== "boolean") {
      issues.push(`行${rowNo}: orderedAnswers は true または false で指定してください。`);
    }

    const preparedItem = {
      id: crypto.randomUUID(),
      subject,
      subcategories,
      question,
      answers,
      explanation,
      imageUrl: typeof raw.imageUrl === "string" ? raw.imageUrl.trim() : "",
      imagePath: typeof raw.imagePath === "string" ? raw.imagePath.trim() : "",
      imageName: typeof raw.imageName === "string" ? raw.imageName.trim() : "",
      orderedAnswers: raw.orderedAnswers === true
    };

    const identity = buildQuestionIdentity(preparedItem);
    if (seenImport.has(identity)) {
      warnings.push(`行${rowNo}: 同じ subject・question・answers の重複がJSON内にあります。この行はスキップされます。`);
      return;
    }
    seenImport.add(identity);

    if (existingIds.has(identity)) {
      warnings.push(`行${rowNo}: 既存データと重複しています。この行はスキップされます。`);
      return;
    }

    prepared.push(preparedItem);
  });

  return { issues, warnings, prepared };
}

async function runBulkImportValidation() {
  if (!getCurrentUser()) {
    alert("先にログインしてください。");
    return false;
  }

  const file = el.bulkImportFile?.files?.[0];
  if (!file) {
    alert("JSONファイルを選んでください。");
    return false;
  }

  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const rawItems = normalizeImportRoot(parsed);
    const result = validateBulkImportItems(rawItems);

    bulkImportPreparedItems = result.prepared;

    const lines = [
      `選択ファイル: ${file.name}`,
      `JSON件数: ${rawItems.length}件`,
      `追加候補: ${result.prepared.length}件`,
      `エラー: ${result.issues.length}件`,
      `警告: ${result.warnings.length}件`
    ];

    if (result.issues.length) {
      const message = "一括登録を中止しました。\n\n" + result.issues.slice(0, 30).join("\n") +
        (result.issues.length > 30 ? "\n…以下省略…" : "");
      alert(message);
    } else if (result.warnings.length) {
      alert("検証は通りましたが、注意点があります。\n\n" + result.warnings.slice(0, 30).join("\n") +
        (result.warnings.length > 30 ? "\n…以下省略…" : ""));
    } else {
      alert("検証OKです。問題は見つかりませんでした。");
    }

    setBulkImportStatus(lines.join("\n"));
    return result.issues.length === 0;
  } catch (error) {
    bulkImportPreparedItems = [];
    setBulkImportStatus("検証失敗: " + error.message);
    alert("JSONの読み込みまたは検証に失敗しました。\n\n" + error.message);
    return false;
  }
}

async function executeBulkImport() {
  if (!getCurrentUser()) {
    alert("先にログインしてください。");
    return;
  }

  const ok = await runBulkImportValidation();
  if (!ok) return;

  if (!bulkImportPreparedItems.length) {
    alert("追加できるデータがありません。");
    return;
  }

  shared.allQuestions = [...shared.allQuestions, ...bulkImportPreparedItems];
  bulkImportPreparedItems.forEach(q => ensureProgressRow(q.subject));
  selectedQuestionId = null;
  afterQuestionMutation();
  setBulkImportStatus((el.bulkImportStatus?.textContent || "") + `\n一括追加完了: ${bulkImportPreparedItems.length}件`);
  alert(`一括追加が完了しました。\n${bulkImportPreparedItems.length}件を追加しました。`);
}

function resetBulkImportState() {
  bulkImportPreparedItems = [];
  if (el.bulkImportFile) el.bulkImportFile.value = "";
  setBulkImportStatus("JSONファイルを選択して「検証する」を押してください。");
}



function renderEditorImagePreview() {
  if (currentEditingImageUrl) {
    el.imagePreview.src = currentEditingImageUrl;
    el.imagePreview.alt = currentEditingImageName || "問題画像プレビュー";
    el.imagePreviewWrap.style.display = "block";
    el.editImageName.value = currentEditingImageName || "画像あり";
    if (el.imageStatusText) {
      el.imageStatusText.textContent = pendingImageFile
        ? "未保存の画像プレビューです。追加または更新で保存されます。"
        : "保存済み画像があります。";
    }
  } else {
    el.imagePreview.removeAttribute("src");
    el.imagePreview.alt = "";
    el.imagePreviewWrap.style.display = "none";
    el.editImageName.value = "";
    if (el.imageStatusText) {
      el.imageStatusText.textContent = pendingRemoveImage
        ? "画像は削除予定です。更新で反映されます。"
        : "画像未設定です。";
    }
  }
}


function getManageSubjects() {
  return [...new Set(shared.allQuestions.map(q => q.subject).filter(Boolean))].sort();
}

function getManagePrimarySubcategories() {
  const source = manageSubjectFilter === "all" ? shared.allQuestions : shared.allQuestions.filter(q => q.subject === manageSubjectFilter);
  return [...new Set(source.map(q => Array.isArray(q.subcategories) ? q.subcategories[0] : "").filter(Boolean))].sort();
}

function getManageRelatedSubcategories(primary) {
  if (!primary) return [];
  const source = manageSubjectFilter === "all" ? shared.allQuestions : shared.allQuestions.filter(q => q.subject === manageSubjectFilter);
  return [...new Set(source.filter(q => Array.isArray(q.subcategories) && q.subcategories[0] === primary).flatMap(q => q.subcategories || []).filter(Boolean))].sort();
}

function ensureManageFilterUi() {
  const existing = document.getElementById("manageFilterPanel");
  if (existing) return;

  const table = el.questionTableBody?.closest(".table-wrap") || el.questionTableBody?.closest("table");
  if (!table) return;

  const panel = document.createElement("div");
  panel.id = "manageFilterPanel";
  panel.className = "manage-filter-panel";
  panel.innerHTML = `
    <select id="manageSubjectSelect"></select>
    <select id="managePrimarySubcategorySelect"></select>
    <div class="manage-check-list" id="manageSubcategoryChecklist"></div>
  `;
  table.insertAdjacentElement("beforebegin", panel);

  document.getElementById("manageSubjectSelect").addEventListener("change", () => {
    manageSubjectFilter = document.getElementById("manageSubjectSelect").value || "all";
    managePrimarySubcategory = "";
    manageSelectedSubcategories = [];
    renderManageFilterUi();
    renderManageTable();
  });

  document.getElementById("managePrimarySubcategorySelect").addEventListener("change", () => {
    managePrimarySubcategory = document.getElementById("managePrimarySubcategorySelect").value || "";
    manageSelectedSubcategories = managePrimarySubcategory ? [managePrimarySubcategory] : [];
    renderManageFilterUi();
    renderManageTable();
  });
}

function renderManageFilterUi() {
  ensureManageFilterUi();

  const subjectSelect = document.getElementById("manageSubjectSelect");
  const primarySelect = document.getElementById("managePrimarySubcategorySelect");
  const checklist = document.getElementById("manageSubcategoryChecklist");
  if (!subjectSelect || !primarySelect || !checklist) return;

  const subjects = getManageSubjects();

  if (manageSubjectFilter !== "all" && !subjects.includes(manageSubjectFilter)) {
    manageSubjectFilter = "all";
    managePrimarySubcategory = "";
    manageSelectedSubcategories = [];
  }

  subjectSelect.innerHTML = `<option value="all">全教科</option>` +
    subjects.map(subject => `
      <option value="${escapeHtml(subject)}" ${subject === manageSubjectFilter ? "selected" : ""}>
        ${escapeHtml(subject)}
      </option>
    `).join("");

  subjectSelect.value = manageSubjectFilter;

  const primaryItems = getManagePrimarySubcategories();

  if (managePrimarySubcategory && !primaryItems.includes(managePrimarySubcategory)) {
    managePrimarySubcategory = "";
    manageSelectedSubcategories = [];
  }

  primarySelect.innerHTML = `<option value="">章・大分類を選択してください</option>` +
    primaryItems.map(item => `
      <option value="${escapeHtml(item)}" ${item === managePrimarySubcategory ? "selected" : ""}>
        ${escapeHtml(item)}
      </option>
    `).join("");

  primarySelect.value = managePrimarySubcategory || "";

  if (!managePrimarySubcategory) {
    manageSelectedSubcategories = [];
    checklist.innerHTML = '<div class="helper">章・大分類を選ぶと、関連サブカテゴリだけを表示します。未選択なら全件表示します。</div>';
    return;
  }

  const related = getManageRelatedSubcategories(managePrimarySubcategory);

  if (!manageSelectedSubcategories.includes(managePrimarySubcategory)) {
    manageSelectedSubcategories.unshift(managePrimarySubcategory);
  }

  checklist.innerHTML = related.map(tag => {
    const checked = manageSelectedSubcategories.includes(tag);
    return `
      <label class="manage-check-row ${checked ? "is-active" : ""}">
        <input type="checkbox" value="${escapeHtml(tag)}" ${checked ? "checked" : ""}>
        <span>${escapeHtml(tag)}</span>
      </label>
    `;
  }).join("");

  [...checklist.querySelectorAll("input[type='checkbox']")].forEach(input => {
    input.addEventListener("change", () => {
      const value = input.value;
      if (input.checked) {
        if (!manageSelectedSubcategories.includes(value)) {
          manageSelectedSubcategories.push(value);
        }
      } else {
        manageSelectedSubcategories = manageSelectedSubcategories.filter(tag => tag !== value);
      }

      if (managePrimarySubcategory && !manageSelectedSubcategories.includes(managePrimarySubcategory)) {
        manageSelectedSubcategories.unshift(managePrimarySubcategory);
      }

      renderManageFilterUi();
      renderManageTable();
    });
  });
}

function getFilteredManageQuestions() {
  return shared.allQuestions.filter(q => {
    if (manageSubjectFilter !== "all" && q.subject !== manageSubjectFilter) {
      return false;
    }

    const tags = Array.isArray(q.subcategories) ? q.subcategories : [];

    // 章・大分類が未選択なら、教科条件だけで表示する。
    // If no primary category is selected, show all questions within the subject filter.
    if (!managePrimarySubcategory) {
      return true;
    }

    if (!tags.includes(managePrimarySubcategory)) {
      return false;
    }

    // チェック済みサブカテゴリがなければ、章・大分類だけで表示する。
    // If no child subcategory is checked, show all questions in the selected primary category.
    const activeTags = manageSelectedSubcategories.filter(Boolean);

    if (!activeTags.length) {
      return true;
    }

    return activeTags.every(tag => tags.includes(tag));
  });
}



function fillEditorForm(q) {
  if (!q) return;

  el.editSubject.value = q.subject || "";
  el.editSubcategories.value = subcategoriesToText(q.subcategories || []);
  el.editQuestion.value = q.question || "";
  el.editAnswers.value = Array.isArray(q.answers) ? q.answers.join("\n") : String(q.answers || "");
  el.editExplanation.value = q.explanation || "";

  if (el.editOrderedAnswers) {
    el.editOrderedAnswers.checked = !!q.orderedAnswers;
  }

  currentEditingImageUrl = q.imageUrl || "";
  currentEditingImagePath = q.imagePath || "";
  currentEditingImageName = q.imageName || "";
  pendingImageFile = null;
  pendingRemoveImage = false;
  renderEditorImagePreview();
}


function ensureManageBulkDeleteUi() {
  if (document.getElementById("manageBulkDeletePanel")) return;

  const table = el.questionTableBody?.closest(".table-wrap") || el.questionTableBody?.closest("table");
  if (!table) return;

  const panel = document.createElement("div");
  panel.id = "manageBulkDeletePanel";
  panel.className = "manage-bulk-actions";
  panel.innerHTML = `
    <button type="button" class="btn" id="manageSelectAllDeleteBtn">全て選択</button>
    <button type="button" class="btn" id="manageClearDeleteSelectionBtn">選択解除</button>
    <button type="button" class="btn ng" id="manageDeleteCheckedBtn" disabled>選択した問題を削除</button>
  `;

  table.insertAdjacentElement("beforebegin", panel);

  document.getElementById("manageSelectAllDeleteBtn").addEventListener("click", () => {
    const visibleIds = getVisibleManageQuestions()
      .filter(q => q.id !== selectedQuestionId)
      .map(q => q.id);

    manageDeleteSelectedIds = [...new Set(visibleIds)];
    renderManageTable();
  });

  document.getElementById("manageClearDeleteSelectionBtn").addEventListener("click", () => {
    manageDeleteSelectedIds = [];
    renderManageTable();
  });

  document.getElementById("manageDeleteCheckedBtn").addEventListener("click", deleteCheckedManageQuestions);
}

function updateManageBulkDeleteButtonState() {
  const deleteBtn = document.getElementById("manageDeleteCheckedBtn");
  if (!deleteBtn) return;

  const validIds = new Set(shared.allQuestions.map(q => q.id));
  manageDeleteSelectedIds = manageDeleteSelectedIds
    .filter(id => validIds.has(id))
    .filter(id => id !== selectedQuestionId);

  const disabled = manageDeleteSelectedIds.length === 0;
  deleteBtn.disabled = disabled;
  deleteBtn.textContent = manageDeleteSelectedIds.length
    ? `選択した問題を削除（${manageDeleteSelectedIds.length}件）`
    : "選択した問題を削除";
}

function getVisibleManageQuestions() {
  const keyword = (el.searchInput?.value || "").trim().toLowerCase();
  const filteredByDropdown = typeof getFilteredManageQuestions === "function"
    ? getFilteredManageQuestions()
    : shared.allQuestions;

  return filteredByDropdown.filter(q => {
    if (!keyword) return true;

    const haystack = [
      q.subject || "",
      ...(Array.isArray(q.subcategories) ? q.subcategories : []),
      q.question || "",
      Array.isArray(q.answers) ? q.answers.join(" ") : String(q.answers || ""),
      q.explanation || ""
    ].join(" ").toLowerCase();

    return haystack.includes(keyword);
  });
}

function deleteCheckedManageQuestions() {
  const ids = [...new Set(manageDeleteSelectedIds)].filter(id => id !== selectedQuestionId);

  if (!ids.length) {
    alert("削除する問題をチェックしてください。");
    return;
  }

  if (ids.length >= shared.allQuestions.length) {
    alert("安全のため、全問題が0件になる削除はできません。");
    return;
  }

  const targets = shared.allQuestions.filter(q => ids.includes(q.id));
  const preview = targets
    .slice(0, 10)
    .map((q, index) => `${index + 1}. ${q.subject || "教科未設定"} / ${q.question || "無題"}`)
    .join("\n");

  const extra = targets.length > 10
    ? `\n...ほか ${targets.length - 10}件`
    : "";

  const ok = confirm(
    `${targets.length}件の問題を削除します。\nこの操作は元に戻せません。\n\n削除対象:\n${preview}${extra}`
  );
  if (!ok) return;

  const idSet = new Set(ids);
  shared.allQuestions = shared.allQuestions.filter(q => !idSet.has(q.id));
  manageDeleteSelectedIds = [];

  cleanupStaleStudyFilters();
  recalcProgressFromQuestionStates();
  renderManageFilterUi();
  renderManageTable();
  renderProgressTable();
  buildFilteredQuestions();
  renderStudy();
  requestAutoSave();
}



function selectQuestionForEdit(questionId) {
  const q = shared.allQuestions.find(item => item.id === questionId);
  if (!q) {
    alert("選択した問題が見つかりません。");
    return;
  }

  selectedQuestionId = q.id;

  // 更新対象は削除対象から外す。
  // Remove the editing target from deletion targets.
  if (Array.isArray(manageDeleteSelectedIds)) {
    manageDeleteSelectedIds = manageDeleteSelectedIds.filter(id => id !== selectedQuestionId);
  }

  fillEditorForm(q);
  renderManageTable();

  if (typeof updateManageBulkDeleteButtonState === "function") {
    updateManageBulkDeleteButtonState();
  }

  const editorAnchor =
    document.getElementById("questionForm") ||
    document.getElementById("questionEditor") ||
    el.questionTextInput ||
    el.questionInput;

  if (editorAnchor && typeof editorAnchor.scrollIntoView === "function") {
    editorAnchor.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}


function renderManageTable() {
  if (!el.questionTableBody) return;

  if (typeof renderManageFilterUi === "function" && !isRenderingManageFilter) {
    isRenderingManageFilter = true;
    try {
      renderManageFilterUi();
    } finally {
      isRenderingManageFilter = false;
    }
  }

  ensureManageBulkDeleteUi();

  const source = getVisibleManageQuestions();

  const validVisibleIds = new Set(source.map(q => q.id));
  manageDeleteSelectedIds = manageDeleteSelectedIds
    .filter(id => validVisibleIds.has(id))
    .filter(id => id !== selectedQuestionId);

  if (!source.length) {
    el.questionTableBody.innerHTML = '<tr><td colspan="6">条件に合う問題がありません。</td></tr>';
    updateManageBulkDeleteButtonState();
    return;
  }

  el.questionTableBody.innerHTML = source.map(q => {
    const isEditing = q.id === selectedQuestionId;
    const checked = manageDeleteSelectedIds.includes(q.id);
    const subcategories = Array.isArray(q.subcategories) ? q.subcategories.join(" / ") : "";
    const answers = Array.isArray(q.answers) ? q.answers.join(" / ") : String(q.answers || "");

    return `
      <tr class="${isEditing ? "manage-editing-row" : ""}" data-manage-row="${escapeHtml(q.id)}">
        <td>
          <input
            type="checkbox"
            class="manage-delete-check"
            data-delete-question="${escapeHtml(q.id)}"
            ${checked ? "checked" : ""}
            ${isEditing ? "disabled" : ""}
            aria-label="削除対象にする"
          >
        </td>
        <td>
          <button
            type="button"
            class="manage-edit-btn ${isEditing ? "is-selected" : ""}"
            data-edit-question="${escapeHtml(q.id)}"
          >
            ${isEditing ? "更新対象" : "編集"}
          </button>
        </td>
        <td>${escapeHtml(q.subject || "")}</td>
        <td>${escapeHtml(subcategories)}</td>
        <td>${escapeHtml(q.question || "")}</td>
        <td>${escapeHtml(answers)}</td>
      </tr>
    `;
  }).join("");

  [...el.questionTableBody.querySelectorAll("[data-edit-question]")].forEach(btn => {
    btn.addEventListener("click", event => {
      event.stopPropagation();
      selectQuestionForEdit(btn.dataset.editQuestion);
    });
  });

  [...el.questionTableBody.querySelectorAll("[data-manage-row]")].forEach(row => {
    row.addEventListener("click", event => {
      if (event.target.closest("[data-delete-question]")) return;
      if (event.target.closest("[data-edit-question]")) return;
      selectQuestionForEdit(row.dataset.manageRow);
    });
  });

  [...el.questionTableBody.querySelectorAll("[data-delete-question]")].forEach(input => {
    input.addEventListener("click", event => {
      event.stopPropagation();
    });

    input.addEventListener("change", () => {
      const id = input.dataset.deleteQuestion;
      if (id === selectedQuestionId) {
        input.checked = false;
        return;
      }

      if (input.checked) {
        if (!manageDeleteSelectedIds.includes(id)) {
          manageDeleteSelectedIds.push(id);
        }
      } else {
        manageDeleteSelectedIds = manageDeleteSelectedIds.filter(item => item !== id);
      }

      updateManageBulkDeleteButtonState();
    });
  });

  updateManageBulkDeleteButtonState();
}


async function uploadQuestionImage(questionId, file) {
  if (!getStorage() || !getCurrentUser() || !file) return { imageUrl: "", imagePath: "", imageName: "" };
  const safeName = (file.name || "image").replace(/[^a-zA-Z0-9._-]/g, "_");
  const path = `users/${getCurrentUser().uid}/questions/${questionId}/${Date.now()}_${safeName}`;
  const refObj = storageRef(getStorage(), path);
  await uploadBytes(refObj, file, { contentType: file.type || "image/jpeg" });
  const url = await getDownloadURL(refObj);
  return { imageUrl: url, imagePath: path, imageName: file.name || safeName };
}

async function deleteQuestionImageByPath(path) {
  if (!getStorage() || !path) return;
  try {
    await deleteObject(storageRef(getStorage(), path));
  } catch (error) {
    console.warn("画像削除をスキップ:", error);
  }
}

async function addQuestion() {
  if (!getCurrentUser()) return;
  const payload = readEditorForm();
  if (!payload) return;

  const questionId = crypto.randomUUID();
  let imageMeta = {
    imageUrl: currentEditingImageUrl || "",
    imagePath: currentEditingImagePath || "",
    imageName: currentEditingImageName || ""
  };

  if (pendingImageFile) {
    imageMeta = await uploadQuestionImage(questionId, pendingImageFile);
  }

  const question = {
    id: questionId,
    ...payload,
    ...imageMeta
  };
  shared.allQuestions.push(question);
  ensureProgressRow(question.subject);
  selectedQuestionId = question.id;
  pendingImageFile = null;
  pendingRemoveImage = false;
  afterQuestionMutation();
}

async function updateQuestion() {
  if (!getCurrentUser()) return;
  if (!selectedQuestionId) {
    alert("更新したい問題を一覧から選んでください。");
    return;
  }
  const payload = readEditorForm();
  if (!payload) return;

  const index = shared.allQuestions.findIndex(q => q.id === selectedQuestionId);
  if (index === -1) return;

  const before = shared.allQuestions[index];
  let imageMeta = {
    imageUrl: before.imageUrl || "",
    imagePath: before.imagePath || "",
    imageName: before.imageName || ""
  };

  if (pendingRemoveImage && before.imagePath) {
    await deleteQuestionImageByPath(before.imagePath);
    imageMeta = { imageUrl: "", imagePath: "", imageName: "" };
  }

  if (pendingImageFile) {
    if (before.imagePath) {
      await deleteQuestionImageByPath(before.imagePath);
    }
    imageMeta = await uploadQuestionImage(selectedQuestionId, pendingImageFile);
  }

  shared.allQuestions[index] = { ...before, ...payload, subcategories: normalizeSubcategories(payload.subcategories), ...imageMeta };
  if (before.subject !== payload.subject) ensureProgressRow(payload.subject);

  currentEditingImageUrl = imageMeta.imageUrl || "";
  currentEditingImagePath = imageMeta.imagePath || "";
  currentEditingImageName = imageMeta.imageName || "";
  pendingImageFile = null;
  pendingRemoveImage = false;
  renderEditorImagePreview();
  afterQuestionMutation();
}

function deleteQuestion() {
  alert("問題の削除は、一覧のチェックボックスで選択してから「選択した問題を削除」を押してください。");
}

function readEditorForm() {
  const subject = el.editSubject.value.trim();
  const subcategories = textToTagList(el.editSubcategories.value);
  const question = el.editQuestion.value.trim();
  const answers = normalizeQuestionAnswers(el.editAnswers.value);
  const explanation = el.editExplanation.value.trim();
  const orderedAnswers = el.editOrderedAnswers ? el.editOrderedAnswers.checked : false;

  if (!subject || !question || !answers.length) {
    alert("教科・問題・答えは必須です。");
    return null;
  }
  return { subject, subcategories, question, answers, explanation, orderedAnswers };
}

function clearEditorForm() {
  el.editSubject.value = "";
  el.editSubcategories.value = "";
  el.editQuestion.value = "";
  el.editAnswers.value = "";
  el.editExplanation.value = "";
  if (el.editOrderedAnswers) el.editOrderedAnswers.checked = false;
  currentEditingImageUrl = "";
  currentEditingImageName = "";
  currentEditingImagePath = "";
  pendingImageFile = null;
  pendingRemoveImage = false;
  el.editImageFile.value = "";
  renderEditorImagePreview();
  selectedQuestionId = null;
  renderManageTable();
}

function afterQuestionMutation() {
  cleanupStaleStudyFilters();
  updateSubjectOptions();
  renderManageTable();
  renderProgressTable();
  renderStudy();
  requestAutoSave();
}




  function serialize() {
    return {
      manageSubjectFilter,
      managePrimarySubcategory,
      manageSelectedSubcategories
    };
  }

  function apply(persistedState = {}) {
    manageSubjectFilter = persistedState.manageSubjectFilter || "all";
    managePrimarySubcategory = persistedState.managePrimarySubcategory || "";
    manageSelectedSubcategories = Array.isArray(persistedState.manageSelectedSubcategories)
      ? persistedState.manageSelectedSubcategories
      : [];
    selectedQuestionId = null;
    manageDeleteSelectedIds = [];
  }

  function bindEvents() {
    el.searchInput?.addEventListener("input", renderManageTable);
    el.bulkImportValidateBtn?.addEventListener("click", () => runBulkImportValidation().catch(console.error));
    el.bulkImportExecuteBtn?.addEventListener("click", () => executeBulkImport().catch(console.error));
    el.bulkImportResetBtn?.addEventListener("click", resetBulkImportState);
    document.getElementById("addBtn")?.addEventListener("click", () => addQuestion().catch(console.error));
    document.getElementById("updateBtn")?.addEventListener("click", () => updateQuestion().catch(console.error));
    document.getElementById("deleteBtn")?.addEventListener("click", deleteQuestion);
    document.getElementById("clearFormBtn")?.addEventListener("click", clearEditorForm);

    el.editImageFile?.addEventListener("change", event => {
      const file = event.target.files?.[0];
      if (!file) return;
      if (!file.type.startsWith("image/")) {
        alert("画像ファイルを選んでください。");
        event.target.value = "";
        return;
      }

      pendingImageFile = file;
      pendingRemoveImage = false;
      currentEditingImageName = file.name || "image";
      currentEditingImagePath = "";

      const reader = new FileReader();
      reader.onload = () => {
        currentEditingImageUrl = typeof reader.result === "string" ? reader.result : "";
        renderEditorImagePreview();
      };
      reader.readAsDataURL(file);
    });

    el.removeImageBtn?.addEventListener("click", () => {
      if (!getCurrentUser()) return;
      currentEditingImageUrl = "";
      currentEditingImageName = "";
      currentEditingImagePath = "";
      pendingImageFile = null;
      pendingRemoveImage = true;
      el.editImageFile.value = "";
      renderEditorImagePreview();
    });
  }

  return {
    apply,
    bindEvents,
    render: renderManageTable,
    renderFilter: renderManageFilterUi,
    resetBulkImport: resetBulkImportState,
    serialize
  };
}
