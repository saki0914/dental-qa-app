const LEGACY_CONTENT_KEYS = [
  "allQuestions",
  "pdfMaterials",
  "pdfRevealStates",
  "progress",
  "questionStatuses",
  "wrongQuestionIds",
  "currentIndex",
  "deviceMode",
  "subjectFilter",
  "studyConditionGroups"
];

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasObjectEntries(value) {
  return isObject(value) && Object.keys(value).length > 0;
}

function hasSettingsContent(value) {
  if (!isObject(value)) return false;
  return Object.keys(value).some(key => ![
    "schemaVersion",
    "updatedAt"
  ].includes(key));
}

function getQuestionCount(value) {
  if (!isObject(value)) return 0;
  if (Array.isArray(value.allQuestions)) return value.allQuestions.length;
  return Number.isInteger(value.questionCount) && value.questionCount >= 0
    ? value.questionCount
    : 0;
}

export function cloneCloudState(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

export function mergeCloudState(documents = {}) {
  const main = isObject(documents.main) ? documents.main : {};
  const splitDocuments = [
    documents.questions,
    documents.pdfMaterials,
    documents.progress,
    documents.settings
  ];
  const hasSplitData = splitDocuments.some(document => isObject(document));
  const hasLegacyData = LEGACY_CONTENT_KEYS.some(key => Object.hasOwn(main, key));

  if (!hasSplitData) {
    return {
      hasData: hasLegacyData,
      hasSplitData: false,
      source: hasLegacyData ? "legacy" : "none",
      state: hasLegacyData ? { ...main } : {}
    };
  }

  return {
    hasData: true,
    hasSplitData: true,
    source: hasLegacyData && splitDocuments.some(document => !isObject(document))
      ? "split-with-legacy-fallback"
      : "split",
    state: {
      ...main,
      ...(isObject(documents.questions) ? documents.questions : {}),
      ...(isObject(documents.pdfMaterials) ? documents.pdfMaterials : {}),
      ...(isObject(documents.progress) ? documents.progress : {}),
      ...(isObject(documents.settings) ? documents.settings : {})
    }
  };
}

export function restoreLegacyQuestionStatuses(state = {}) {
  const restored = isObject(state.questionStatuses)
    ? { ...state.questionStatuses }
    : {};

  (Array.isArray(state.wrongQuestionIds) ? state.wrongQuestionIds : []).forEach(questionId => {
    const value = restored[questionId];
    const hasKnownStatus = value === 1 || value === 2 ||
      value === "known" || value === "done" || value === true ||
      value === "unknown" || value === "wrong" || value === "weak";
    if (!hasKnownStatus) restored[questionId] = 2;
  });

  return restored;
}

export function findUnsafeEmptyOverwriteAreas(currentDocuments = {}, splitState = {}, options = {}) {
  const {
    allowEmptyQuestions = false,
    allowEmptyPdfMaterials = false,
    allowEmptyProgress = false,
    allowEmptySettings = false
  } = options;
  const unsafeAreas = [];

  if (
    !allowEmptyQuestions &&
    getQuestionCount(currentDocuments.questions) > 0 &&
    getQuestionCount(splitState.questions) === 0
  ) {
    unsafeAreas.push("questions");
  }

  const currentPdfMaterials = Array.isArray(currentDocuments.pdfMaterials?.pdfMaterials)
    ? currentDocuments.pdfMaterials.pdfMaterials
    : [];
  const nextPdfMaterials = Array.isArray(splitState.pdfMaterials?.pdfMaterials)
    ? splitState.pdfMaterials.pdfMaterials
    : [];
  if (!allowEmptyPdfMaterials && currentPdfMaterials.length > 0 && nextPdfMaterials.length === 0) {
    unsafeAreas.push("pdfMaterials");
  }

  if (!allowEmptyProgress) {
    const currentProgress = currentDocuments.progress || {};
    const nextProgress = splitState.progress || {};
    if (hasObjectEntries(currentProgress.progress) && !hasObjectEntries(nextProgress.progress)) {
      unsafeAreas.push("progress");
    }
    if (
      hasObjectEntries(currentProgress.questionStatuses) &&
      !hasObjectEntries(nextProgress.questionStatuses)
    ) {
      unsafeAreas.push("questionStatuses");
    }
    if (
      Array.isArray(currentProgress.wrongQuestionIds) &&
      currentProgress.wrongQuestionIds.length > 0 &&
      (!Array.isArray(nextProgress.wrongQuestionIds) || nextProgress.wrongQuestionIds.length === 0) &&
      !hasObjectEntries(nextProgress.questionStatuses)
    ) {
      unsafeAreas.push("wrongQuestionIds");
    }
  }

  if (
    !allowEmptySettings &&
    hasSettingsContent(currentDocuments.settings) &&
    !hasSettingsContent(splitState.settings)
  ) {
    unsafeAreas.push("settings");
  }

  return [...new Set(unsafeAreas)];
}
