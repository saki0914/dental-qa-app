import {
  doc,
  getDoc,
  writeBatch
} from "https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js";

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
    getDoc(refs.questions),
    getDoc(refs.pdfMaterials)
  ]);
}

export async function readSplitDocuments(db, userId) {
  const refs = getSplitDocRefs(db, userId);
  return Promise.all([
    getDoc(refs.questions),
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
  const batch = writeBatch(db);
  batch.set(refs.questions, splitState.questions);
  batch.set(refs.pdfMaterials, splitState.pdfMaterials);
  batch.set(refs.progress, splitState.progress);
  batch.set(refs.settings, splitState.settings);
  await batch.commit();
}
