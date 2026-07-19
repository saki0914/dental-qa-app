function normalizeValues(values) {
  const source = Array.isArray(values) ? values : [values];
  return [...new Set(source.map(value => String(value || "").trim()).filter(Boolean))];
}

function normalizeSubjects(values) {
  return normalizeValues(values).filter(value => value !== "all");
}

function questionsForSubjects(questions, selectedSubjects) {
  const source = Array.isArray(questions) ? questions : [];
  const subjects = normalizeSubjects(selectedSubjects);
  if (!subjects.length) return source;
  const selected = new Set(subjects);
  return source.filter(question => selected.has(String(question.subject || "").trim()));
}

export function getStudySubjects(questions) {
  return [...new Set(
    (Array.isArray(questions) ? questions : [])
      .map(question => String(question.subject || "").trim())
      .filter(Boolean)
  )].sort();
}

export function getStudyPrimaryCategories(questions, selectedSubjects = []) {
  return [...new Set(
    questionsForSubjects(questions, selectedSubjects)
      .map(question => normalizeValues(question.subcategories)[0] || "")
      .filter(Boolean)
  )].sort();
}

export function getStudyRelatedCategories(questions, selectedSubjects = [], selectedPrimaryCategories = []) {
  const primaryCategories = normalizeValues(selectedPrimaryCategories);
  const selectedPrimary = new Set(primaryCategories);

  return [...new Set(
    questionsForSubjects(questions, selectedSubjects)
      .filter(question => {
        if (!selectedPrimary.size) return true;
        const primary = normalizeValues(question.subcategories)[0] || "";
        return selectedPrimary.has(primary);
      })
      .flatMap(question => normalizeValues(question.subcategories).slice(1))
  )].sort();
}

export function normalizeStudySelection(questions, selection = {}) {
  const subjects = getStudySubjects(questions);
  const requestedSubjects = selection.selectedSubjects ?? selection.subject ?? [];
  const selectedSubjects = normalizeSubjects(requestedSubjects)
    .filter(subject => subjects.includes(subject));

  const primaryCategories = getStudyPrimaryCategories(questions, selectedSubjects);
  const requestedPrimaryCategories = selection.selectedPrimaryCategories ?? selection.primaryCategory ?? [];
  const selectedPrimaryCategories = normalizeValues(requestedPrimaryCategories)
    .filter(category => primaryCategories.includes(category));

  const relatedCategories = getStudyRelatedCategories(
    questions,
    selectedSubjects,
    selectedPrimaryCategories
  );
  const selectedRelatedCategories = normalizeValues(selection.selectedRelatedCategories)
    .filter(category => relatedCategories.includes(category));

  return { selectedSubjects, selectedPrimaryCategories, selectedRelatedCategories };
}

export function filterQuestionsForStudy(questions, selection = {}) {
  const normalized = normalizeStudySelection(questions, selection);
  const selectedPrimary = new Set(normalized.selectedPrimaryCategories);

  return questionsForSubjects(questions, normalized.selectedSubjects).filter(question => {
    const categories = normalizeValues(question.subcategories);
    if (selectedPrimary.size && !selectedPrimary.has(categories[0] || "")) return false;
    return normalized.selectedRelatedCategories.every(category => categories.includes(category));
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
