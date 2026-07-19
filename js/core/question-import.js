export const QUESTION_DOCUMENT_MAX_BYTES = 900_000;

export function normalizeImportAssetPath(value) {
  return String(value || "")
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/")
    .toLowerCase();
}

function getFilePath(file) {
  return normalizeImportAssetPath(file?.webkitRelativePath || file?.name || "");
}

export function resolveImportImageFile(reference, files = []) {
  const normalizedReference = normalizeImportAssetPath(reference);
  if (!normalizedReference) return { file: null, error: null };

  const source = Array.from(files || []);
  const exactMatches = source.filter(file => {
    const path = getFilePath(file);
    return path === normalizedReference || path.endsWith(`/${normalizedReference}`);
  });

  if (exactMatches.length === 1) return { file: exactMatches[0], error: null };
  if (exactMatches.length > 1) return { file: null, error: "ambiguous" };

  const basename = normalizedReference.split("/").pop();
  const basenameMatches = source.filter(file => getFilePath(file).split("/").pop() === basename);

  if (basenameMatches.length === 1) return { file: basenameMatches[0], error: null };
  if (basenameMatches.length > 1) return { file: null, error: "ambiguous" };
  return { file: null, error: "missing" };
}

export function estimateQuestionDocumentBytes(questions) {
  return new TextEncoder().encode(JSON.stringify({ allQuestions: questions })).byteLength;
}
