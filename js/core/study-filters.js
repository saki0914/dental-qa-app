function normalizeTags(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(value => String(value || "").trim()).filter(Boolean))];
}

function questionsForSubject(questions, subject) {
  const source = Array.isArray(questions) ? questions : [];
  return subject && subject !== "all"
    ? source.filter(question => question.subject === subject)
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
      .map(question => normalizeTags(question.subcategories)[0] || "")
      .filter(Boolean)
  )].sort();
}

export function getStudyRelatedCategories(questions, subject, primaryCategory) {
  if (!primaryCategory) return [];

  return [...new Set(
    questionsForSubject(questions, subject)
      .filter(question => normalizeTags(question.subcategories)[0] === primaryCategory)
      .flatMap(question => normalizeTags(question.subcategories).slice(1))
  )].sort();
}

export function normalizeStudySelection(questions, selection = {}) {
  const subjects = getStudySubjects(questions);
  const subject = selection.subject !== "all" && subjects.includes(selection.subject)
    ? selection.subject
    : "all";
  const primaryCategories = getStudyPrimaryCategories(questions, subject);
  const primaryCategory = primaryCategories.includes(selection.primaryCategory)
    ? selection.primaryCategory
    : "";
  const relatedCategories = getStudyRelatedCategories(questions, subject, primaryCategory);
  const selectedRelatedCategories = normalizeTags(selection.selectedRelatedCategories)
    .filter(category => relatedCategories.includes(category));

  return { subject, primaryCategory, selectedRelatedCategories };
}

export function filterQuestionsForStudy(questions, selection = {}) {
  const normalized = normalizeStudySelection(questions, selection);
  const requiredCategories = normalized.primaryCategory
    ? [normalized.primaryCategory, ...normalized.selectedRelatedCategories]
    : [];

  return questionsForSubject(questions, normalized.subject).filter(question => {
    if (!requiredCategories.length) return true;
    const tags = normalizeTags(question.subcategories);
    return requiredCategories.every(category => tags.includes(category));
  });
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
