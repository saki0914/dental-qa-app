export const QUESTION_DOCUMENT_MAX_BYTES = 900_000;
export const QUESTION_CHUNK_TARGET_BYTES = 700_000;
export const QUESTION_CHUNK_STORAGE_MODE = "chunked-v1";

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

export function splitQuestionsIntoChunks(questions, options = {}) {
  if (!Array.isArray(questions)) {
    throw new TypeError("保存する問題データは配列で指定してください。");
  }

  const targetBytes = options.targetBytes || QUESTION_CHUNK_TARGET_BYTES;
  const maxBytes = options.maxBytes || QUESTION_DOCUMENT_MAX_BYTES;
  const encoder = new TextEncoder();
  const emptyDocumentBytes = estimateQuestionDocumentBytes([]);
  const chunks = [];
  let current = [];
  let currentBytes = emptyDocumentBytes;

  questions.forEach((question, index) => {
    const serializedQuestion = JSON.stringify(question) ?? "null";
    const questionBytes = encoder.encode(serializedQuestion).byteLength;
    const singleBytes = emptyDocumentBytes + questionBytes;
    if (singleBytes > maxBytes) {
      throw new RangeError(
        `行${index + 1}の問題データだけで${Math.ceil(singleBytes / 1000)}KBあり、` +
        `1件あたりの安全上限${Math.ceil(maxBytes / 1000)}KBを超えています。`
      );
    }

    const candidateBytes = currentBytes + questionBytes + (current.length ? 1 : 0);
    if (current.length && candidateBytes > targetBytes) {
      chunks.push(current);
      current = [question];
      currentBytes = singleBytes;
    } else {
      current.push(question);
      currentBytes = candidateBytes;
    }
  });

  if (current.length) chunks.push(current);
  return chunks;
}

export function createQuestionChunkStorage(questions, metadata = {}) {
  const chunks = splitQuestionsIntoChunks(questions);
  return {
    manifest: {
      ...metadata,
      storageMode: QUESTION_CHUNK_STORAGE_MODE,
      questionCount: questions.length,
      chunkCount: chunks.length
    },
    chunks: chunks.map((allQuestions, chunkIndex) => ({
      allQuestions,
      chunkIndex,
      chunkCount: chunks.length,
      updatedAt: metadata.updatedAt
    }))
  };
}

export function restoreQuestionsFromChunks(manifest, chunkDocuments) {
  const expectedChunkCount = Number.isInteger(manifest?.chunkCount) && manifest.chunkCount >= 0
    ? manifest.chunkCount
    : 0;
  if (!Array.isArray(chunkDocuments) || chunkDocuments.length !== expectedChunkCount) {
    throw new Error("問題データの分割ファイル数が保存情報と一致しません。");
  }

  const allQuestions = [];
  chunkDocuments.forEach((document, index) => {
    if (!Array.isArray(document?.allQuestions)) {
      throw new Error(`問題データの分割ファイル${index + 1}を読み込めませんでした。`);
    }
    allQuestions.push(...document.allQuestions);
  });

  if (Number.isInteger(manifest?.questionCount) && manifest.questionCount !== allQuestions.length) {
    throw new Error("問題データの件数が分割保存情報と一致しません。再読み込みしてください。");
  }
  return allQuestions;
}
