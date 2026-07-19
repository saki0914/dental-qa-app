function normalizeValues(values) {
  const source = Array.isArray(values) ? values : [values];
  return [...new Set(source.map(value => String(value || "").trim()).filter(Boolean))];
}

function questionsForSubject(questions, subject) {
  const source = Array.isArray(questions) ? questions : [];
  return subject && subject !== "all"
    ? source.filter(question => String(question.subject || "").trim() === subject)
    : source;
}

export function getStudySubjects(questions) {
  return [...new Set(
    (Array.isArray(questions) ? questions : [])
      .map(question => String(question.subject || "").trim())
      .filter(Boolean)
  )].sort();
}

export function getStudyPrimaryCategories(questions, subject = "all") {
  return [...new Set(
    questionsForSubject(questions, subject)
      .map(question => normalizeValues(question.subcategories)[0] || "")
      .filter(Boolean)
  )].sort();
}

export function getStudyRelatedCategories(questions, subject = "all", primaryCategory = "") {
  if (!primaryCategory) return [];

  return [...new Set(
    questionsForSubject(questions, subject)
      .filter(question => normalizeValues(question.subcategories)[0] === primaryCategory)
      .flatMap(question => normalizeValues(question.subcategories).slice(1))
  )].sort();
}

export function normalizeStudyCondition(questions, condition = {}) {
  const subjects = getStudySubjects(questions);
  const requestedSubject = String(condition.subject || "all").trim();
  const subject = requestedSubject !== "all" && subjects.includes(requestedSubject)
    ? requestedSubject
    : "all";
  const primaryCategories = getStudyPrimaryCategories(questions, subject);
  const primaryCategory = primaryCategories.includes(condition.primaryCategory)
    ? condition.primaryCategory
    : "";
  const relatedCategories = getStudyRelatedCategories(questions, subject, primaryCategory);
  const selectedRelatedCategories = normalizeValues(condition.selectedRelatedCategories)
    .filter(category => relatedCategories.includes(category));

  return { subject, primaryCategory, selectedRelatedCategories };
}

export function normalizeStudyConditionGroups(questions, groups) {
  const subjects = getStudySubjects(questions);
  return (Array.isArray(groups) ? groups : [])
    .filter(group => group && typeof group === "object" && !Array.isArray(group))
    .filter(group => group.subject === "all" || subjects.includes(String(group.subject || "").trim()))
    .map(group => normalizeStudyCondition(questions, group))
    .filter(group => group.primaryCategory)
    .filter((group, index, source) => {
      const key = JSON.stringify(group);
      return source.findIndex(item => JSON.stringify(item) === key) === index;
    });
}

export function migrateStudyConditionGroups(questions, state = {}) {
  if (Array.isArray(state.studyConditionGroups)) {
    return normalizeStudyConditionGroups(questions, state.studyConditionGroups);
  }

  const legacyGroups = Array.isArray(state.subcategoryConditionGroups)
    ? state.subcategoryConditionGroups
    : [];
  if (legacyGroups.length) {
    const legacySubject = state.subjectFilter || "all";
    return normalizeStudyConditionGroups(questions, legacyGroups
      .filter(group => Array.isArray(group) && group.length)
      .map(group => ({
        subject: legacySubject,
        primaryCategory: group[0] || "",
        selectedRelatedCategories: group.slice(1)
      })));
  }

  const storedSubjects = Array.isArray(state.selectedSubjects) ? state.selectedSubjects : [];
  const storedPrimaryCategories = Array.isArray(state.selectedPrimarySubcategories)
    ? state.selectedPrimarySubcategories
    : [];
  if (storedSubjects.length <= 1 && storedPrimaryCategories.length <= 1) return [];

  const subjects = storedSubjects.length ? storedSubjects : ["all"];
  return normalizeStudyConditionGroups(questions, subjects.flatMap(subject => storedPrimaryCategories
    .filter(primaryCategory => getStudyPrimaryCategories(questions, subject).includes(primaryCategory))
    .map(primaryCategory => ({
      subject,
      primaryCategory,
      selectedRelatedCategories: Array.isArray(state.selectedSubcategories) ? state.selectedSubcategories : []
    }))));
}

function questionMatchesCondition(question, condition) {
  if (condition.subject !== "all" && question.subject !== condition.subject) return false;
  const categories = normalizeValues(question.subcategories);
  if (condition.primaryCategory && categories[0] !== condition.primaryCategory) return false;
  return condition.selectedRelatedCategories.every(category => categories.includes(category));
}

export function filterQuestionsForStudy(questions, selection = {}) {
  const source = Array.isArray(questions) ? questions : [];
  const groups = normalizeStudyConditionGroups(questions, selection.conditionGroups);
  if (groups.length) {
    return source.filter(question => groups.some(group => questionMatchesCondition(question, group)));
  }

  const draft = normalizeStudyCondition(questions, selection.draftCondition || selection);
  return source.filter(question => questionMatchesCondition(question, draft));
}

export function calculateStudyCounters(questions, currentIndex, questionStatuses = {}) {
  const source = Array.isArray(questions) ? questions : [];
  return {
    total: source.length,
    current: source.length ? Math.min(Math.max(Number(currentIndex) || 0, 0), source.length - 1) + 1 : 0,
    known: source.filter(question => questionStatuses[question.id] === 1).length,
    weak: source.filter(question => questionStatuses[question.id] === 2).length
  };
}
