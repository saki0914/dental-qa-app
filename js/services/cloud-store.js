import {
  doc,
  getDoc,
  writeBatch
} from "https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js";
import {
  createQuestionChunkStorage,
  QUESTION_CHUNK_STORAGE_MODE,
  restoreQuestionsFromChunks
} from "../core/question-import.js";

function getQuestionChunkRef(db, userId, index) {
  const suffix = String(index + 1).padStart(4, "0");
  return doc(db, "users", userId, "app", `questions-${suffix}`);
}

async function readQuestionDocument(db, userId) {
  const manifestSnap = await getDoc(getSplitDocRefs(db, userId).questions);
  if (!manifestSnap.exists()) return manifestSnap;

  const manifest = manifestSnap.data() || {};
  if (Array.isArray(manifest.allQuestions) || manifest.storageMode !== QUESTION_CHUNK_STORAGE_MODE) {
    return manifestSnap;
  }

  const chunkCount = Number.isInteger(manifest.chunkCount) && manifest.chunkCount >= 0
    ? manifest.chunkCount
    : 0;
  const chunkSnaps = await Promise.all(
    Array.from({ length: chunkCount }, (_, index) => getDoc(getQuestionChunkRef(db, userId, index)))
  );
  const chunkDocuments = chunkSnaps.map(chunkSnap => chunkSnap.exists() ? chunkSnap.data() : null);
  const allQuestions = restoreQuestionsFromChunks(manifest, chunkDocuments);

  return {
    exists: () => true,
    data: () => ({ ...manifest, allQuestions })
  };
}

export function getSplitDocRefs(db, userId) {
  return {
    main: doc(db, "users", userId, "app", "main"),
    questions: doc(db, "users", userId, "app", "questions"),
    pdfMaterials: doc(db, "users", userId, "app", "pdfMaterials"),
    progress: doc(db, "users", userId, "app", "progress"),
    settings: doc(db, "users", userId, "app", "settings")
  };
}

export async function readSaveGuardDocuments(db, userId) {
  const refs = getSplitDocRefs(db, userId);
  return Promise.all([
    readQuestionDocument(db, userId),
    getDoc(refs.pdfMaterials)
  ]);
}

export async function readSplitDocuments(db, userId) {
  const refs = getSplitDocRefs(db, userId);
  return Promise.all([
    readQuestionDocument(db, userId),
    getDoc(refs.pdfMaterials),
    getDoc(refs.progress),
    getDoc(refs.settings)
  ]);
}

export async function readLegacyDocument(db, userId) {
  return getDoc(getSplitDocRefs(db, userId).main);
}

export async function writeSplitDocuments(db, userId, splitState) {
  const refs = getSplitDocRefs(db, userId);
  const questions = Array.isArray(splitState.questions?.allQuestions)
    ? splitState.questions.allQuestions
    : [];
  const { allQuestions: _allQuestions, ...questionMetadata } = splitState.questions;
  const questionStorage = createQuestionChunkStorage(questions, questionMetadata);
  const previousManifestSnap = await getDoc(refs.questions);
  const previousManifest = previousManifestSnap.exists() ? previousManifestSnap.data() : {};
  const previousChunkCount = previousManifest?.storageMode === QUESTION_CHUNK_STORAGE_MODE &&
    Number.isInteger(previousManifest.chunkCount)
    ? previousManifest.chunkCount
    : 0;
  const batch = writeBatch(db);

  batch.set(refs.questions, questionStorage.manifest);
  questionStorage.chunks.forEach((chunkDocument, index) => {
    batch.set(getQuestionChunkRef(db, userId, index), chunkDocument);
  });
  for (let index = questionStorage.chunks.length; index < previousChunkCount; index += 1) {
    batch.delete(getQuestionChunkRef(db, userId, index));
  }

  batch.set(refs.pdfMaterials, splitState.pdfMaterials);
  batch.set(refs.progress, splitState.progress);
  batch.set(refs.settings, splitState.settings);
  await batch.commit();
}
