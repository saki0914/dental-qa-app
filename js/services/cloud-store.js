import {
  doc,
  runTransaction,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js";
import {
  createQuestionChunkStorage,
  QUESTION_CHUNK_STORAGE_MODE,
  restoreQuestionsFromChunks
} from "../core/question-import.js";
import {
  findUnsafeEmptyOverwriteAreas,
  mergeCloudState
} from "../core/cloud-sync-state.js";

const QUESTION_CHUNK_WARNING_THRESHOLD = 50;

export class UnsafeEmptyOverwriteError extends Error {
  constructor(areas) {
    super(`空状態による上書きを停止しました: ${areas.join(", ")}`);
    this.name = "UnsafeEmptyOverwriteError";
    this.areas = areas;
  }
}

function getQuestionChunkRef(db, userId, index) {
  const suffix = String(index + 1).padStart(4, "0");
  return doc(db, "users", userId, "app", `questions-${suffix}`);
}

function getSnapshotData(snapshot) {
  return snapshot.exists() ? snapshot.data() : null;
}

function getPreviousChunkCount(questionDocument) {
  return questionDocument?.storageMode === QUESTION_CHUNK_STORAGE_MODE &&
    Number.isInteger(questionDocument.chunkCount) &&
    questionDocument.chunkCount >= 0
    ? questionDocument.chunkCount
    : 0;
}

async function restoreQuestionDocumentInTransaction(transaction, db, userId, manifestDocument) {
  if (!manifestDocument) return null;
  if (
    Array.isArray(manifestDocument.allQuestions) ||
    manifestDocument.storageMode !== QUESTION_CHUNK_STORAGE_MODE
  ) {
    return manifestDocument;
  }

  const chunkCount = getPreviousChunkCount(manifestDocument);
  const chunkSnapshots = await Promise.all(
    Array.from(
      { length: chunkCount },
      (_, index) => transaction.get(getQuestionChunkRef(db, userId, index))
    )
  );
  const chunkDocuments = chunkSnapshots.map(getSnapshotData);
  const allQuestions = restoreQuestionsFromChunks(manifestDocument, chunkDocuments);
  return { ...manifestDocument, allQuestions };
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

export async function readCloudState(db, userId) {
  return runTransaction(db, async transaction => {
    const refs = getSplitDocRefs(db, userId);
    const [
      mainSnapshot,
      questionManifestSnapshot,
      pdfSnapshot,
      progressSnapshot,
      settingsSnapshot
    ] = await Promise.all([
      transaction.get(refs.main),
      transaction.get(refs.questions),
      transaction.get(refs.pdfMaterials),
      transaction.get(refs.progress),
      transaction.get(refs.settings)
    ]);

    const main = getSnapshotData(mainSnapshot);
    const questionManifest = getSnapshotData(questionManifestSnapshot);
    const questions = await restoreQuestionDocumentInTransaction(
      transaction,
      db,
      userId,
      questionManifest
    );
    const merged = mergeCloudState({
      main,
      questions,
      pdfMaterials: getSnapshotData(pdfSnapshot),
      progress: getSnapshotData(progressSnapshot),
      settings: getSnapshotData(settingsSnapshot)
    });

    return merged;
  });
}

export async function writeSplitDocuments(db, userId, splitState, options = {}) {
  const {
    allowEmptyQuestions = false,
    allowEmptyPdfMaterials = false,
    allowEmptyProgress = false,
    allowEmptySettings = false
  } = options;
  const questions = Array.isArray(splitState.questions?.allQuestions)
    ? splitState.questions.allQuestions
    : [];
  const { allQuestions: _allQuestions, ...questionMetadata } = splitState.questions || {};
  const questionStorage = createQuestionChunkStorage(questions, questionMetadata);

  if (questionStorage.chunks.length > QUESTION_CHUNK_WARNING_THRESHOLD) {
    console.warn(
      `問題データが${questionStorage.chunks.length}分割です。` +
      "Firestore transactionの書込件数上限に近づいていないか確認してください。"
    );
  }

  return runTransaction(db, async transaction => {
    const refs = getSplitDocRefs(db, userId);
    const [
      mainSnapshot,
      questionManifestSnapshot,
      pdfSnapshot,
      progressSnapshot,
      settingsSnapshot
    ] = await Promise.all([
      transaction.get(refs.main),
      transaction.get(refs.questions),
      transaction.get(refs.pdfMaterials),
      transaction.get(refs.progress),
      transaction.get(refs.settings)
    ]);

    const mainDocument = getSnapshotData(mainSnapshot);
    const questionDocument = getSnapshotData(questionManifestSnapshot);
    const pdfDocument = getSnapshotData(pdfSnapshot);
    const progressDocument = getSnapshotData(progressSnapshot);
    const settingsDocument = getSnapshotData(settingsSnapshot);
    const unsafeAreas = findUnsafeEmptyOverwriteAreas({
      questions: questionDocument || mainDocument,
      pdfMaterials: pdfDocument || mainDocument,
      progress: progressDocument || mainDocument,
      settings: settingsDocument || mainDocument
    }, splitState, {
      allowEmptyQuestions,
      allowEmptyPdfMaterials,
      allowEmptyProgress,
      allowEmptySettings
    });
    if (unsafeAreas.length) throw new UnsafeEmptyOverwriteError(unsafeAreas);

    const previousChunkCount = getPreviousChunkCount(questionDocument);
    const metadata = {
      updatedAt: serverTimestamp()
    };

    transaction.set(refs.questions, {
      ...questionStorage.manifest,
      ...metadata
    });
    questionStorage.chunks.forEach((chunkDocument, index) => {
      transaction.set(getQuestionChunkRef(db, userId, index), {
        ...chunkDocument,
        ...metadata
      });
    });
    for (let index = questionStorage.chunks.length; index < previousChunkCount; index += 1) {
      transaction.delete(getQuestionChunkRef(db, userId, index));
    }

    transaction.set(refs.pdfMaterials, {
      ...(splitState.pdfMaterials || {}),
      ...metadata
    });
    transaction.set(refs.progress, {
      ...(splitState.progress || {}),
      ...metadata
    });
    transaction.set(refs.settings, {
      ...(splitState.settings || {}),
      ...metadata
    });
    return true;
  });
}
