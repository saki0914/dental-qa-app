export function textToTagList(raw) {
  return (raw || "")
    .split(/\n|,|，/g)
    .map(value => value.trim())
    .filter(Boolean);
}

export function textToAnswers(raw) {
  return (raw || "")
    .split(/\n|、|,|，|・/g)
    .map(value => value.trim())
    .filter(Boolean);
}

export function textToAnswerList(raw) {
  return String(raw || "")
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .split(/\r?\n|\s*[，,]\s*/g)
    .map(value => value.trim())
    .filter(Boolean);
}

export function normalizeQuestionAnswers(rawAnswers) {
  if (Array.isArray(rawAnswers)) {
    return rawAnswers
      .flatMap(answer => textToAnswerList(String(answer || "")))
      .filter(Boolean);
  }
  return textToAnswerList(String(rawAnswers || ""));
}

export function normalizeSubcategories(values) {
  return [...new Set((values || []).map(value => String(value || "").trim()).filter(Boolean))];
}

export function normalizeToken(text) {
  return (text || "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/[ァ-ヶ]/g, value => String.fromCharCode(value.charCodeAt(0) - 0x60))
    .replace(/ー/g, "");
}

export function normalizeAnswerList(values) {
  return [...new Set((values || []).map(normalizeToken).filter(Boolean))].sort();
}

export function normalizeConditionGroup(group) {
  return [...new Set((group || []).map(tag => String(tag || "").trim()).filter(Boolean))];
}

export function normalizeConditionGroups(groups) {
  return (Array.isArray(groups) ? groups : [])
    .map(normalizeConditionGroup)
    .filter(group => group.length);
}

export function normalizePdfTags(tags) {
  return [...new Set((tags || []).map(tag => String(tag || "").trim()).filter(Boolean))];
}

export function formatDisplayText(value) {
  return String(value || "")
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\/n/g, "\n");
}

export function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function escapeDisplayText(value) {
  return escapeHtml(formatDisplayText(value));
}
