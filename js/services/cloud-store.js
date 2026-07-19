import {
  doc,
  getDoc,
  setDoc
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
  await Promise.all([
    setDoc(refs.questions, splitState.questions),
    setDoc(refs.pdfMaterials, splitState.pdfMaterials),
    setDoc(refs.progress, splitState.progress),
    setDoc(refs.settings, splitState.settings)
  ]);
}
