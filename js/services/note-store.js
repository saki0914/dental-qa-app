import {
  arrayRemove,
  arrayUnion,
  collection,
  doc,
  getDoc,
  getDocs,
  increment,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";
import {
  deleteObject,
  getBlob,
  ref as storageRef,
  uploadBytes
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-storage.js";
import {
  assertNonEmptyBlob,
  decodeImageDimensions,
  serializeValidatedJson,
  validateImageBlob
} from "../core/file-validator.js";
import {
  MATERIAL_NOTE_DELETE_REASONS,
  isMaterialArchiving,
  isMaterialDeletedReason,
  normalizeMaterialIds,
  shouldArchiveLinkedNote,
  splitLinkedNoteWrites
} from "../core/note-material-mutation.js";
import { randomId } from "../core/id.js";
import { normalizeNoteLineElements } from "../core/note-geometry.js";
import { sha256Hex } from "../core/sha256.js";
import { runWithConcurrency } from "../core/bounded-concurrency.js";
import { createNotePageSaveQueue } from "../core/note-page-save-queue.js";

export class NoteConflictError extends Error {
  constructor(message, cloudRevision) {
    super(message);
    this.name = "NoteConflictError";
    this.cloudRevision = cloudRevision;
  }
}

export class NoteRestoreBlockedError extends Error {
  constructor(message = "教材の差し替え・削除により削除されたノートは復元できません。") {
    super(message);
    this.name = "NoteRestoreBlockedError";
  }
}

export class NoteSessionChangedError extends Error {
  constructor() {
    super("ログインユーザーが切り替わったため、ノート処理を中断しました。");
    this.name = "NoteSessionChangedError";
  }
}

class NoteSameWriterRebaseError extends Error {
  constructor(cloudRevision) {
    super("同じ編集セッションの先行保存へ追従します。");
    this.name = "NoteSameWriterRebaseError";
    this.cloudRevision = cloudRevision;
  }
}

const nowIso = () => new Date().toISOString();
// HTTP LAN Emulator sessions have no crypto.subtle. The software digest keeps
// the hash (and therefore the revision path) identical for identical bytes so
// retried saves stay idempotent instead of creating time-dependent paths.
const hashText = text => sha256Hex(new TextEncoder().encode(text));
const hashBlob = async blob => sha256Hex(await blob.arrayBuffer());

const CREATION_BATCH_SIZE = 400;
const MAX_PENDING_STORAGE_PATHS = 1000;
const NOTE_CREATION_WAIT_TIMEOUT_MS = 15_000;
const NOTE_CREATION_POLL_INTERVAL_MS = 250;
const MAX_SAME_WRITER_REBASE_ATTEMPTS = 1;
const STORAGE_DELETE_CONCURRENCY = 4;
const isReadyNote = note => !note?.status || note.status === "ready";
export function noteTimestampMs(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.toDate === "function") return value.toDate().getTime();
  if (Number.isFinite(value.seconds)) return value.seconds * 1000 + Math.floor(Number(value.nanoseconds || 0) / 1e6);
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export function createNoteStore({ getDb, getStorage, getUser, queueCleanup = async () => {} }) {
  const pageSaveQueue = createNotePageSaveQueue();
  function requireExpectedUid(expectedUid) {
    if (typeof expectedUid !== "string" || !expectedUid.trim()) {
      throw new TypeError("ノート操作にはexpectedUidが必要です。");
    }
    return expectedUid;
  }

  function context(expectedUid) {
    const requiredUid = requireExpectedUid(expectedUid);
    const user = getUser();
    if (user?.uid !== requiredUid) throw new NoteSessionChangedError();
    const db = getDb();
    const storage = getStorage();
    if (!user || !db || !storage) throw new Error("ノートを保存するにはログインが必要です。");
    return { uid: user.uid, db, storage };
  }

  function writeContext(expectedUid) {
    return context(requireExpectedUid(expectedUid));
  }

  function readContext(expectedUid) {
    return context(requireExpectedUid(expectedUid));
  }
  // Guard immediately before work that can still be cancelled. Once the final
  // write has committed, return that success without reclassifying it as a
  // session error; UI state is protected separately by the session generation.
  const noteRef = (db, uid, noteId) => doc(db, "users", uid, "notes", noteId);
  const pageRef = (db, uid, noteId, pageId) => doc(db, "users", uid, "notes", noteId, "pages", pageId);
  const assetRef = (db, uid, noteId, assetId) => doc(db, "users", uid, "notes", noteId, "assets", assetId);
  const materialsRef = (db, uid) => doc(db, "users", uid, "app", "pdfMaterials");

  function journalStoragePath(noteId, path, expectedUid) {
    return journalStoragePaths(noteId, [path], expectedUid);
  }

  async function journalStoragePaths(noteId, paths, expectedUid) {
    const { uid, db } = writeContext(expectedUid);
    const reference = noteRef(db, uid, noteId);
    const requested = [...new Set(paths.filter(path => typeof path === "string" && path))];
    if (!requested.length) throw new Error("記録するStorageパスがありません。");
    // A plain read followed by an atomic arrayUnion keeps every check of the
    // former read-modify-write transaction (missing, deleted or failed notes
    // and a full journal are rejected before anything is uploaded) without
    // transaction retries, which the SDK backs off by about a second whenever
    // page saves or PDF page uploads touch the same note document at once.
    // A note deleted after this read is still rejected by the commit
    // transaction that follows every upload; it removes the uploaded object
    // and this journal entry again.
    const snapshot = await getDoc(reference);
    context(expectedUid);
    const data = snapshot.exists() ? snapshot.data() : null;
    if (!data || data.deletedAt || data.status === "failed") {
      throw new Error("Storage書込み先のノートを確認できません。");
    }
    const currentPaths = new Set((Array.isArray(data.pendingStoragePaths) ? data.pendingStoragePaths : [])
      .filter(item => typeof item === "string" && item));
    if (currentPaths.size > MAX_PENDING_STORAGE_PATHS) {
      throw new Error("未確認のStorageパスが上限を超えているため、クリーンアップ完了までアップロードできません。");
    }
    const added = requested.filter(path => !currentPaths.has(path));
    if (currentPaths.size + added.length > MAX_PENDING_STORAGE_PATHS) {
      throw new Error("未確認のStorageパスが上限に達したため、新しいアップロードを開始できません。");
    }
    context(expectedUid);
    await updateDoc(reference, {
      pendingStoragePaths: arrayUnion(...requested),
      updatedAt: serverTimestamp()
    });
  }

  async function clearStorageJournalPaths(noteId, paths, expectedUid) {
    const normalized = [...new Set(paths.filter(path => typeof path === "string" && path))];
    if (!normalized.length) return;
    const { uid, db } = writeContext(expectedUid);
    context(expectedUid);
    await updateDoc(noteRef(db, uid, noteId), {
      pendingStoragePaths: arrayRemove(...normalized),
      updatedAt: serverTimestamp()
    });
  }

  async function clearJournalAfterFailedUpload(noteId, path, expectedUid, uploadError) {
    try {
      await clearStorageJournalPaths(noteId, [path], expectedUid);
    } catch (journalError) {
      uploadError.journalCleanupError = journalError;
    }
  }

  async function queueOrphanedStoragePath({ uid, noteId, path, kind, cleanupError, primaryError }) {
    try {
      await queueCleanup({ uid, noteId, path, kind, error: cleanupError });
    } catch (queueError) {
      primaryError.cleanupQueueError = queueError;
    }
  }

  // Every note root document (including creating/failed/deleted ones). The
  // list screen reads it once and derives both the visible list and the
  // stale-creation cleanup from the same snapshot.
  async function listNoteDocuments({ expectedUid } = {}) {
    const { uid, db } = readContext(expectedUid);
    const snapshots = await getDocs(collection(db, "users", uid, "notes"));
    context(expectedUid);
    return snapshots.docs.map(snapshot => ({ id: snapshot.id, ...snapshot.data() }));
  }

  function visibleNotes(documents, { includeDeleted = false } = {}) {
    return documents
      .filter(note => includeDeleted || !note.deletedAt)
      .filter(isReadyNote)
      .sort((a, b) => noteTimestampMs(b.updatedAt) - noteTimestampMs(a.updatedAt));
  }

  async function listNotes({ includeDeleted = false, expectedUid, documents = null } = {}) {
    return visibleNotes(Array.isArray(documents) ? documents : await listNoteDocuments({ expectedUid }), { includeDeleted });
  }

  async function getNote(noteId, { expectedUid } = {}) {
    const { uid, db } = readContext(expectedUid);
    const snapshot = await getDoc(noteRef(db, uid, noteId));
    context(expectedUid);
    return snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null;
  }

  async function listNotesByMaterial(materialId, { includeDeleted = false, expectedUid } = {}) {
    const { uid, db } = readContext(expectedUid);
    const [normalizedMaterialId] = normalizeMaterialIds([materialId]);
    if (!normalizedMaterialId) return [];
    const snapshots = await getDocs(query(
      collection(db, "users", uid, "notes"),
      where("materialRefs", "array-contains", normalizedMaterialId)
    ));
    context(expectedUid);
    return snapshots.docs
      .map(snapshot => ({ id: snapshot.id, ...snapshot.data() }))
      .filter(note => includeDeleted || !note.deletedAt);
  }

  async function listPages(noteId, { expectedUid } = {}) {
    const { uid, db } = context(expectedUid);
    const snapshots = await getDocs(collection(db, "users", uid, "notes", noteId, "pages"));
    context(expectedUid);
    return snapshots.docs.map(snapshot => ({ pageId: snapshot.id, ...snapshot.data() }))
      .filter(page => !page.deletedAt)
      .sort((a, b) => Number(a.order) - Number(b.order));
  }

  function pageDocument(noteId, page, index) {
    return {
      schemaVersion: 1,
      ...page,
      noteId,
      order: index + 1,
      contentRevision: 0,
      contentPath: "",
      contentHash: "",
      noteMaskCount: 0,
      deletedAt: null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    };
  }

  async function createPageChunks(noteId, pages, expectedUid) {
    const { uid, db } = writeContext(expectedUid);
    for (let offset = 0; offset < pages.length; offset += CREATION_BATCH_SIZE) {
      const chunk = pages.slice(offset, offset + CREATION_BATCH_SIZE);
      const batch = writeBatch(db);
      chunk.forEach((page, chunkIndex) => {
        const index = offset + chunkIndex;
        batch.set(pageRef(db, uid, noteId, page.pageId), pageDocument(noteId, page, index));
      });
      batch.update(noteRef(db, uid, noteId), {
        createdPageCount: increment(chunk.length),
        updatedAt: serverTimestamp()
      });
      context(expectedUid);
      await batch.commit();
    }
  }

  async function rollbackCreatedPages(noteId, pageIds, expectedUid) {
    const { uid, db } = writeContext(expectedUid);
    const failedPageIds = [];
    for (let offset = 0; offset < pageIds.length; offset += CREATION_BATCH_SIZE) {
      const chunk = pageIds.slice(offset, offset + CREATION_BATCH_SIZE);
      const batch = writeBatch(db);
      chunk.forEach(pageId => batch.delete(pageRef(db, uid, noteId, pageId)));
      try {
        context(expectedUid);
        await batch.commit();
      } catch (error) {
        console.warn("作成失敗ページの補償削除に失敗しました。", error);
        failedPageIds.push(...chunk);
      }
    }
    return failedPageIds;
  }

  async function finalizeNoteCreation(noteId, expectedPageCount, expectedUid) {
    const { uid, db } = writeContext(expectedUid);
    await runTransaction(db, async transaction => {
      const reference = noteRef(db, uid, noteId);
      const snapshot = await transaction.get(reference);
      context(expectedUid);
      const createdPageCount = Number(snapshot.data()?.createdPageCount || 0);
      if (!snapshot.exists() || snapshot.data()?.status !== "creating" || createdPageCount !== expectedPageCount) {
        throw new Error(`ノートページの作成件数が一致しません（${createdPageCount}/${expectedPageCount}）。`);
      }
      context(expectedUid);
      transaction.update(reference, {
        status: "ready",
        pageCount: expectedPageCount,
        createdPageCount,
        orderRevision: 1,
        failedAt: null,
        errorPhase: null,
        errorMessage: null,
        pendingStoragePaths: [],
        updatedAt: serverTimestamp()
      });
    });
  }

  async function reserveNoteRoot(noteId, noteDocument, materialRefs, expectedUid, reuseExisting) {
    const { uid, db } = writeContext(expectedUid);
    return runTransaction(db, async transaction => {
      const reference = noteRef(db, uid, noteId);
      const noteSnapshotPromise = transaction.get(reference);
      const materialsSnapshotPromise = materialRefs.length
        ? transaction.get(materialsRef(db, uid))
        : Promise.resolve(null);
      const [noteSnapshot, materialsSnapshot] = await Promise.all([
        noteSnapshotPromise,
        materialsSnapshotPromise
      ]);
      context(expectedUid);

      if (materialsSnapshot) {
        const materials = materialsSnapshot.data()?.pdfMaterials;
        const unavailable = materialRefs.find(materialId => {
          const material = Array.isArray(materials)
            ? materials.find(candidate => candidate?.id === materialId)
            : null;
          return !material || isMaterialArchiving(material);
        });
        if (unavailable) {
          throw new Error("教材の差し替え・削除処理中のため、連携ノートを作成できません。");
        }
      }

      if (noteSnapshot.exists()) {
        const existing = noteSnapshot.data();
        if (reuseExisting && !existing.deletedAt && isReadyNote(existing)) return "ready";
        if (reuseExisting && !existing.deletedAt && existing.status === "creating") return "creating";
        if (!(reuseExisting && existing.status === "failed")) {
          throw new Error("同じIDのノートが既に存在するため、新しいノートで上書きできません。");
        }
      }

      context(expectedUid);
      transaction.set(reference, noteDocument);
      return "created";
    });
  }

  async function waitForReusableNote(noteId, noteDocument, materialRefs, expectedUid) {
    const { uid, db } = readContext(expectedUid);
    const deadline = Date.now() + NOTE_CREATION_WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await wait(NOTE_CREATION_POLL_INTERVAL_MS);
      context(expectedUid);
      const snapshot = await getDoc(noteRef(db, uid, noteId));
      context(expectedUid);
      if (!snapshot.exists() || snapshot.data()?.status === "failed") {
        const reservation = await reserveNoteRoot(noteId, noteDocument, materialRefs, expectedUid, true);
        if (reservation !== "creating") return reservation;
        continue;
      }
      if (!snapshot.data()?.deletedAt && isReadyNote(snapshot.data())) return "ready";
      if (snapshot.data()?.deletedAt || snapshot.data()?.status !== "creating") {
        throw new Error("既定ノートの作成状態を確認できません。もう一度お試しください。");
      }
    }
    throw new Error("別の画面で既定ノートを作成中です。完了後にもう一度お試しください。");
  }

  async function createNote({
    noteId = randomId(),
    pages,
    deferReady = false,
    reuseExisting = false,
    expectedUid,
    ...metadata
  } = {}) {
    writeContext(expectedUid);
    const materialRefs = normalizeMaterialIds(
      Array.isArray(metadata.materialRefs)
        ? metadata.materialRefs
        : metadata.sourceMaterialId ? [metadata.sourceMaterialId] : []
    );
    const timestamps = { createdAt: serverTimestamp(), updatedAt: serverTimestamp() };
    const noteDocument = {
      schemaVersion: 1,
      ...metadata,
      status: "creating",
      pageCount: pages.length,
      createdPageCount: 0,
      pendingStoragePaths: [],
      noteMaskCount: 0,
      orderRevision: 1,
      deletedAt: null,
      deletedReason: null,
      deletedMaterialRefs: [],
      materialRefs,
      ...timestamps
    };
    let rootCreated = false;
    try {
      let reservation = await reserveNoteRoot(
        noteId,
        noteDocument,
        materialRefs,
        expectedUid,
        reuseExisting
      );
      if (reservation === "creating") {
        reservation = await waitForReusableNote(noteId, noteDocument, materialRefs, expectedUid);
      }
      if (reservation === "ready") {
        context(expectedUid);
        return noteId;
      }
      context(expectedUid);
      rootCreated = true;
      await createPageChunks(noteId, pages, expectedUid);
      if (!deferReady) await finalizeNoteCreation(noteId, pages.length, expectedUid);
      return noteId;
    } catch (error) {
      if (rootCreated) {
        const compensation = await abortCreatingNote(noteId, {
          pageIds: pages.map(page => page.pageId),
          phase: "page-create",
          error,
          expectedUid
        });
        if (compensation.errors.length) error.creationCleanupErrors = compensation.errors;
      }
      throw error;
    }
  }

  async function createCreatingNote(noteId, metadata, expectedUid) {
    const { uid, db } = writeContext(expectedUid);
    context(expectedUid);
    await setDoc(noteRef(db, uid, noteId), {
      schemaVersion: 1,
      ...metadata,
      status: "creating",
      pageCount: 0,
      createdPageCount: 0,
      pendingStoragePaths: [],
      noteMaskCount: 0,
      orderRevision: 0,
      deletedAt: null,
      deletedReason: null,
      deletedMaterialRefs: [],
      materialRefs: [],
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
  }

  async function finalizeCreatingNote(noteId, pages, expectedUid) {
    await createPageChunks(noteId, pages, expectedUid);
    context(expectedUid);
    await finalizeNoteCreation(noteId, pages.length, expectedUid);
  }

  async function markCreationFailed(noteId, details = {}, expectedUid) {
    const { uid, db } = writeContext(expectedUid);
    const normalized = Array.isArray(details) ? { orphanedPaths: details } : details;
    context(expectedUid);
    await updateDoc(noteRef(db, uid, noteId), {
      status: "failed",
      failedAt: serverTimestamp(),
      errorPhase: normalized.phase || "unknown",
      errorMessage: String(normalized.error?.message || normalized.error || "ノート作成に失敗しました。").slice(0, 500),
      orphanedPaths: normalized.orphanedPaths || [],
      pendingStoragePaths: normalized.orphanedPaths || [],
      failedPageIds: normalized.failedPageIds || [],
      updatedAt: serverTimestamp()
    });
  }

  async function abortCreatingNote(noteId, { pageIds = [], storagePaths = [], phase = "content-create", error, expectedUid } = {}) {
    writeContext(expectedUid);
    const errors = [];
    let failedPageIds = [...pageIds];
    let orphanedPaths = [...storagePaths];
    try {
      failedPageIds = await rollbackCreatedPages(noteId, pageIds, expectedUid);
    } catch (cleanupError) {
      errors.push(cleanupError);
      console.error("作成失敗ページの補償削除を開始できませんでした。", cleanupError);
    }
    try {
      orphanedPaths = await deleteStoragePaths(storagePaths, expectedUid);
    } catch (cleanupError) {
      errors.push(cleanupError);
      console.error("作成失敗ファイルの補償削除を開始できませんでした。", cleanupError);
    }
    for (const path of orphanedPaths) {
      try {
        const { uid } = context(expectedUid);
        await queueCleanup({
          uid,
          noteId,
          path,
          kind: "note-creation",
          error: new Error("ノート作成失敗時のStorage補償削除に失敗しました。")
        });
      } catch (cleanupError) {
        errors.push(cleanupError);
        console.error("作成失敗ファイルを再試行キューへ記録できませんでした。", cleanupError);
      }
    }
    try {
      context(expectedUid);
      await markCreationFailed(noteId, { phase, error, failedPageIds, orphanedPaths }, expectedUid);
    } catch (cleanupError) {
      errors.push(cleanupError);
      console.error("作成失敗ノートの状態記録に失敗しました。", cleanupError);
    }
    return { failedPageIds, orphanedPaths, errors };
  }

  async function cleanupStuckCreatingNotes({ olderThanMs = 24 * 60 * 60 * 1000, now = Date.now(), expectedUid, documents = null } = {}) {
    const { uid, db } = writeContext(expectedUid);
    const noteDocuments = Array.isArray(documents) ? documents : await listNoteDocuments({ expectedUid });
    context(expectedUid);
    const snapshots = {
      docs: noteDocuments.map(({ id, ...data }) => ({ id, data: () => data }))
    };
    const stale = snapshots.docs.filter(snapshot => {
      const data = snapshot.data();
      const pendingPaths = Array.isArray(data?.pendingStoragePaths) ? data.pendingStoragePaths : [];
      if (data?.status !== "creating" && !pendingPaths.length) return false;
      const timestamp = data?.status === "creating" ? data.createdAt : (data.updatedAt || data.createdAt);
      const timestampMs = typeof timestamp?.toMillis === "function"
        ? timestamp.toMillis()
        : new Date(timestamp || 0).getTime();
      return Number.isFinite(timestampMs) && timestampMs > 0 && now - timestampMs >= olderThanMs;
    });
    const results = [];
    for (const snapshot of stale) {
      const data = snapshot.data();
      const storagePaths = Array.isArray(data?.pendingStoragePaths)
        ? [...new Set(data.pendingStoragePaths.filter(path => typeof path === "string" && path))]
        : [];
      if (data?.status !== "creating") {
        const failedPaths = await deleteStoragePaths(storagePaths, expectedUid);
        const failedSet = new Set(failedPaths);
        const cleanedPaths = storagePaths.filter(path => !failedSet.has(path));
        await clearStorageJournalPaths(snapshot.id, cleanedPaths, expectedUid);
        const errors = [];
        for (const path of failedPaths) {
          try {
            await queueCleanup({
              uid,
              noteId: snapshot.id,
              path,
              kind: "stale-storage-journal",
              error: new Error("放置されたStorage journalの削除に失敗しました。")
            });
          } catch (error) {
            errors.push(error);
          }
        }
        results.push({ noteId: snapshot.id, failedPageIds: [], orphanedPaths: failedPaths, errors });
        continue;
      }
      context(expectedUid);
      const pageSnapshots = await getDocs(collection(db, "users", uid, "notes", snapshot.id, "pages"));
      context(expectedUid);
      const result = await abortCreatingNote(snapshot.id, {
        pageIds: pageSnapshots.docs.map(pageSnapshot => pageSnapshot.id),
        storagePaths,
        phase: "stuck-creating",
        error: new Error("作成開始から24時間以上完了しなかったため補償処理を行いました。"),
        expectedUid
      });
      results.push({ noteId: snapshot.id, ...result });
    }
    return results;
  }

  const sourcePagePath = (uid, noteId, pageId) => `users/${uid}/notes/${noteId}/sourcePages/${pageId}/background.jpg`;

  // Records the page image paths of a note being created in one write, before
  // any of them is uploaded, so that the uploads need no Firestore round trip
  // each. Returns the paths in `pageIds` order.
  async function journalSourcePages(noteId, pageIds, expectedUid) {
    const { uid } = writeContext(expectedUid);
    const paths = pageIds.map(pageId => sourcePagePath(uid, noteId, pageId));
    await journalStoragePaths(noteId, paths, expectedUid);
    return paths;
  }

  // `journaled`: the path is already recorded by journalSourcePages. It stays
  // recorded when the upload fails, because a failed request may still have
  // stored the object; the caller deletes it with the creation compensation.
  async function uploadSourcePage(noteId, pageId, blob, expectedUid, { journaled = false } = {}) {
    requireExpectedUid(expectedUid);
    validateImageBlob(blob, { label: "PDFページ画像", allowedTypes: ["image/jpeg"] });
    const { uid, storage } = context(expectedUid);
    const path = sourcePagePath(uid, noteId, pageId);
    context(expectedUid);
    if (!journaled) await journalStoragePath(noteId, path, expectedUid);
    try {
      context(expectedUid);
      await uploadBytes(storageRef(storage, path), blob, { contentType: "image/jpeg" });
    } catch (error) {
      if (!journaled) await clearJournalAfterFailedUpload(noteId, path, expectedUid, error);
      throw error;
    }
    return path;
  }

  async function uploadRecoveredBackground(noteId, pageId, blob, expectedUid) {
    requireExpectedUid(expectedUid);
    validateImageBlob(blob, {
      label: "復元ページ背景",
      allowedTypes: ["image/png", "image/jpeg", "image/webp"]
    });
    const { uid, storage } = context(expectedUid);
    const extension = blob.type === "image/png" ? "png" : blob.type === "image/webp" ? "webp" : "jpg";
    const path = `users/${uid}/notes/${noteId}/sourcePages/${pageId}/background.${extension}`;
    context(expectedUid);
    await journalStoragePath(noteId, path, expectedUid);
    try {
      context(expectedUid);
      await uploadBytes(storageRef(storage, path), blob, { contentType: blob.type });
    } catch (error) {
      await clearJournalAfterFailedUpload(noteId, path, expectedUid, error);
      throw error;
    }
    return path;
  }

  async function deleteStoragePaths(paths, expectedUid) {
    const { storage } = writeContext(expectedUid);
    const failed = [];
    // Deletions are independent; a few in parallel keeps compensation of a
    // large PDF note from taking one round trip per page.
    await runWithConcurrency(paths, STORAGE_DELETE_CONCURRENCY, async path => {
      try {
        context(expectedUid);
        await deleteObject(storageRef(storage, path));
      } catch (error) {
        if (error?.name === "NoteSessionChangedError") throw error;
        if (error?.code !== "storage/object-not-found") failed.push(path);
      }
    });
    return failed;
  }

  async function cleanupStoragePath(path, { noteId = "", expectedUid } = {}) {
    const { storage } = writeContext(expectedUid);
    try {
      context(expectedUid);
      await deleteObject(storageRef(storage, path));
    } catch (error) {
      if (error?.code !== "storage/object-not-found") throw error;
    }
    if (noteId) await clearStorageJournalPaths(noteId, [path], expectedUid);
  }

  async function loadPageContent(noteId, page, { expectedUid } = {}) {
    const { storage } = readContext(expectedUid);
    if (!page?.contentPath) return { schemaVersion: 1, noteId, pageId: page.pageId, revision: 0, elements: [], noteMasks: [], savedAt: "" };
    const blob = await getBlob(storageRef(storage, page.contentPath));
    context(expectedUid);
    assertNonEmptyBlob(blob, "ページ内容JSON");
    const parsed = JSON.parse(await blob.text());
    serializeValidatedJson(parsed, { noteId, pageId: page.pageId }, { strict: false });
    return normalizeNoteLineElements(parsed, page.size);
  }

  async function persistPageContentAttempt({
    noteId,
    pageId,
    expectedRevision,
    expectedUid,
    clientInstanceId = "",
    editorTabId = "",
    writerSessionId = "",
    clientMutationId = randomId(),
    mutationCreatedAt = "",
    baseRevision = expectedRevision
  }, content) {
    const { uid, db, storage } = writeContext(expectedUid);
    const mutationId = String(clientMutationId || randomId());
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(mutationId)) {
      throw new TypeError("ページ保存のmutationIdが不正です。");
    }
    const saveId = mutationId;
    const currentRevision = Number(expectedRevision);
    if (!Number.isInteger(currentRevision) || currentRevision < 0) {
      throw new TypeError("ページ内容の保存前リビジョンが不正です。");
    }
    if (Number(baseRevision) !== currentRevision) {
      throw new TypeError("ページ保存の基準リビジョンが一致しません。");
    }
    const nextRevision = currentRevision + 1;
    const writer = {
      clientInstanceId: String(clientInstanceId || ""),
      editorTabId: String(editorTabId || ""),
      writerSessionId: String(writerSessionId || ""),
      clientMutationId: mutationId,
      baseRevision: currentRevision
    };
    const savedAt = mutationCreatedAt || nowIso();
    const payload = { ...content, ...writer, schemaVersion: 1, noteId, pageId, revision: nextRevision, savedAt };
    const { json, blob } = serializeValidatedJson(payload, { noteId, pageId });
    const contentHash = await hashText(json);
    const path = `users/${uid}/notes/${noteId}/pages/${pageId}/revisions/${saveId}-${contentHash.slice(0, 16)}.json`;
    context(expectedUid);
    await journalStoragePath(noteId, path, expectedUid);
    let uploaded = false;

    try {
      context(expectedUid);
      await uploadBytes(storageRef(storage, path), blob, { contentType: "application/json" });
      uploaded = true;
      context(expectedUid);
      let idempotentResult = null;
      await runTransaction(db, async transaction => {
        const reference = pageRef(db, uid, noteId, pageId);
        const noteReference = noteRef(db, uid, noteId);
        const [snapshot, noteSnapshot] = await Promise.all([
          transaction.get(reference),
          transaction.get(noteReference)
        ]);
        context(expectedUid);
        const cloudRevision = Number(snapshot.data()?.contentRevision || 0);
        const cloudMutationId = String(snapshot.data()?.lastClientMutationId || "");
        if (!noteSnapshot.exists() || noteSnapshot.data()?.deletedAt || noteSnapshot.data()?.status === "failed") {
          throw new NoteConflictError("このノートは削除済みか、作成に失敗しているため保存できません。", cloudRevision);
        }
        if (snapshot.exists() && !snapshot.data()?.deletedAt &&
            cloudRevision === currentRevision + 1 && cloudMutationId === writer.clientMutationId &&
            snapshot.data()?.contentHash === contentHash) {
          idempotentResult = {
            revision: cloudRevision,
            contentPath: snapshot.data()?.contentPath || path,
            contentHash: snapshot.data()?.contentHash || contentHash,
            idempotent: true
          };
          transaction.update(noteReference, {
            ...(noteSnapshot.data()?.status === "creating" ? {} : { pendingStoragePaths: arrayRemove(path) }),
            updatedAt: serverTimestamp()
          });
          return;
        }
        if (snapshot.exists() && !snapshot.data()?.deletedAt &&
            cloudRevision > currentRevision && writer.writerSessionId &&
            snapshot.data()?.lastWriterSessionId === writer.writerSessionId) {
          throw new NoteSameWriterRebaseError(cloudRevision);
        }
        if (!snapshot.exists() || snapshot.data()?.deletedAt || cloudRevision !== currentRevision) {
          throw new NoteConflictError("別の端末でこのページが更新されています。", cloudRevision);
        }
        context(expectedUid);
        transaction.update(reference, {
          contentRevision: nextRevision,
          contentPath: path,
          contentHash,
          noteMaskCount: payload.noteMasks.length,
          lastClientInstanceId: writer.clientInstanceId,
          lastEditorTabId: writer.editorTabId,
          lastWriterSessionId: writer.writerSessionId,
          lastClientMutationId: writer.clientMutationId,
          lastBaseRevision: currentRevision,
          updatedAt: serverTimestamp()
        });
        const maskDelta = payload.noteMasks.length - Number(snapshot.data()?.noteMaskCount || 0);
        transaction.update(noteReference, {
          noteMaskCount: increment(maskDelta),
          ...(noteSnapshot.data()?.status === "creating" ? {} : { pendingStoragePaths: arrayRemove(path) }),
          updatedAt: serverTimestamp()
        });
      });
      if (idempotentResult) return idempotentResult;
      return { revision: nextRevision, contentPath: path, contentHash };
    } catch (error) {
      if (!uploaded) {
        await clearJournalAfterFailedUpload(noteId, path, expectedUid, error);
        throw error;
      }
      let deleted = false;
      try {
        await deleteObject(storageRef(storage, path));
        deleted = true;
      } catch (cleanupError) {
        if (cleanupError?.code !== "storage/object-not-found") {
          await queueOrphanedStoragePath({
            uid, noteId, path, kind: "page-revision", cleanupError, primaryError: error
          });
        } else {
          deleted = true;
        }
      }
      if (deleted) await clearJournalAfterFailedUpload(noteId, path, expectedUid, error);
      throw error;
    }
  }

  async function persistPageContent(options, content) {
    let attempt = 0;
    let activeOptions = { ...options };
    while (true) {
      try {
        return await persistPageContentAttempt(activeOptions, content);
      } catch (error) {
        if (error?.name !== "NoteSameWriterRebaseError" ||
            attempt >= MAX_SAME_WRITER_REBASE_ATTEMPTS ||
            !Number.isInteger(error.cloudRevision) || error.cloudRevision < 0) {
          if (error?.name === "NoteSameWriterRebaseError") {
            throw new NoteConflictError("同じ編集セッションの保存が連続したため、自動追従を停止しました。", error.cloudRevision);
          }
          throw error;
        }
        attempt += 1;
        activeOptions = {
          ...activeOptions,
          expectedRevision: error.cloudRevision,
          baseRevision: error.cloudRevision
        };
      }
    }
  }

  async function enqueuePageContentSave(options, content) {
    const expectedUid = requireExpectedUid(options?.expectedUid);
    const noteId = String(options?.noteId || "");
    const pageId = String(options?.pageId || "");
    if (!noteId || !pageId) throw new TypeError("ページ保存先が不足しています。");
    const key = `${expectedUid}|${noteId}|${pageId}`;
    return pageSaveQueue.enqueue(key, () => persistPageContent(options, content));
  }

  const savePageContent = enqueuePageContentSave;

  async function uploadAsset(noteId, blob, { assetId = randomId(), filename = "original.png", expectedUid } = {}) {
    requireExpectedUid(expectedUid);
    validateImageBlob(blob, { label: "貼り付け画像" });
    const { naturalWidth, naturalHeight, oversized } = await decodeImageDimensions(blob);
    if (oversized) {
      throw new Error("貼り付け画像の縦横サイズまたは総画素数が上限を超えています。");
    }
    const { uid, db, storage } = context(expectedUid);
    const extension = blob.type === "image/jpeg" ? "jpg" : blob.type === "image/webp" ? "webp" : "png";
    const safeStem = filename.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._-]/g, "_") || "original";
    const path = `users/${uid}/notes/${noteId}/assets/${assetId}/${safeStem}.${extension}`;
    const hash = await hashBlob(blob);
    context(expectedUid);
    await journalStoragePath(noteId, path, expectedUid);
    let uploaded = false;
    try {
      context(expectedUid);
      await uploadBytes(storageRef(storage, path), blob, { contentType: blob.type });
      uploaded = true;
      context(expectedUid);
      await runTransaction(db, async transaction => {
        const noteReference = noteRef(db, uid, noteId);
        const noteSnapshot = await transaction.get(noteReference);
        context(expectedUid);
        if (!noteSnapshot.exists() || noteSnapshot.data()?.deletedAt || noteSnapshot.data()?.status === "failed") {
          throw new Error("貼り付け画像の保存先ノートを確認できません。");
        }
        transaction.set(assetRef(db, uid, noteId, assetId), {
          schemaVersion: 1,
          storagePath: path,
          mimeType: blob.type,
          naturalWidth,
          naturalHeight,
          byteSize: blob.size,
          hash,
          createdAt: serverTimestamp(),
          deletedAt: null
        });
        transaction.update(noteReference, {
          ...(noteSnapshot.data()?.status === "creating" ? {} : { pendingStoragePaths: arrayRemove(path) }),
          updatedAt: serverTimestamp()
        });
      });
    } catch (error) {
      if (!uploaded) {
        await clearJournalAfterFailedUpload(noteId, path, expectedUid, error);
        throw error;
      }
      let deleted = false;
      try {
        await deleteObject(storageRef(storage, path));
        deleted = true;
      } catch (cleanupError) {
        if (cleanupError?.code === "storage/object-not-found") {
          deleted = true;
        } else {
          error.orphanedStoragePath = path;
          await queueOrphanedStoragePath({ uid, noteId, path, kind: "asset", cleanupError, primaryError: error });
        }
      }
      if (deleted) await clearJournalAfterFailedUpload(noteId, path, expectedUid, error);
      throw error;
    }
    return { assetId, storagePath: path, mimeType: blob.type, naturalWidth, naturalHeight, byteSize: blob.size, hash };
  }

  async function getAsset(noteId, assetId, { expectedUid } = {}) {
    const { uid, db } = readContext(expectedUid);
    const snapshot = await getDoc(assetRef(db, uid, noteId, assetId));
    context(expectedUid);
    return snapshot.exists() ? { assetId, ...snapshot.data() } : null;
  }

  async function getStorageBlob(path, { expectedUid } = {}) {
    const { storage } = readContext(expectedUid);
    const blob = await getBlob(storageRef(storage, path));
    context(expectedUid);
    return blob;
  }

  async function updatePageOrder(noteId, pages, expectedOrderRevision, expectedUid) {
    const { uid, db } = writeContext(expectedUid);
    const expectedRevision = Number(expectedOrderRevision);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw new TypeError("ページ並び替え前のリビジョンが不正です。");
    }
    await runTransaction(db, async transaction => {
      const reference = noteRef(db, uid, noteId);
      const snapshot = await transaction.get(reference);
      context(expectedUid);
      const cloudRevision = Number(snapshot.data()?.orderRevision || 0);
      if (!snapshot.exists() || cloudRevision !== expectedRevision) {
        throw new NoteConflictError("別の端末でページ順が変更されています。", cloudRevision);
      }
      context(expectedUid);
      pages.forEach((page, index) => transaction.update(pageRef(db, uid, noteId, page.pageId), { order: index + 1, updatedAt: serverTimestamp() }));
      transaction.update(reference, { orderRevision: cloudRevision + 1, pageCount: pages.length, updatedAt: serverTimestamp() });
    });
    return expectedRevision + 1;
  }

  async function createPage(noteId, page, pageCount, expectedOrderRevision, expectedUid) {
    const { uid, db } = writeContext(expectedUid);
    const expectedRevision = Number(expectedOrderRevision);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw new TypeError("ページ追加前の並び順リビジョンが不正です。");
    }
    const nextRevision = await runTransaction(db, async transaction => {
      const noteReference = noteRef(db, uid, noteId);
      const snapshot = await transaction.get(noteReference);
      context(expectedUid);
      const cloudRevision = Number(snapshot.data()?.orderRevision || 0);
      if (!snapshot.exists() || cloudRevision !== expectedRevision) {
        throw new NoteConflictError("別の端末でページ順が変更されています。", cloudRevision);
      }
      context(expectedUid);
      transaction.set(pageRef(db, uid, noteId, page.pageId), {
        schemaVersion: 1, noteId, contentRevision: 0, contentPath: "", contentHash: "", noteMaskCount: 0, deletedAt: null,
        ...page, createdAt: serverTimestamp(), updatedAt: serverTimestamp()
      });
      transaction.update(noteReference, {
        pageCount,
        orderRevision: cloudRevision + 1,
        updatedAt: serverTimestamp()
      });
      return cloudRevision + 1;
    });
    return nextRevision;
  }

  async function deletePage(noteId, pageId, remainingPages, expectedOrderRevision, expectedUid) {
    const { uid, db } = writeContext(expectedUid);
    const expectedRevision = Number(expectedOrderRevision);
    if (!Array.isArray(remainingPages) || !remainingPages.length) {
      throw new TypeError("ノートには1ページ以上必要です。");
    }
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw new TypeError("ページ削除前の並び順リビジョンが不正です。");
    }
    const nextRevision = await runTransaction(db, async transaction => {
      const noteReference = noteRef(db, uid, noteId);
      const pageReference = pageRef(db, uid, noteId, pageId);
      const [noteSnapshot, pageSnapshot] = await Promise.all([
        transaction.get(noteReference),
        transaction.get(pageReference)
      ]);
      context(expectedUid);
      const cloudRevision = Number(noteSnapshot.data()?.orderRevision || 0);
      if (!noteSnapshot.exists() || cloudRevision !== expectedRevision) {
        throw new NoteConflictError("別の端末でページ順が変更されています。", cloudRevision);
      }
      if (!pageSnapshot.exists() || pageSnapshot.data()?.deletedAt) {
        throw new NoteConflictError("別の端末でこのページが削除されています。", cloudRevision);
      }
      context(expectedUid);
      remainingPages.forEach((page, index) => {
        transaction.update(pageRef(db, uid, noteId, page.pageId), {
          order: index + 1,
          updatedAt: serverTimestamp()
        });
      });
      transaction.update(pageReference, {
        deletedAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
      const noteUpdate = {
        pageCount: remainingPages.length,
        orderRevision: cloudRevision + 1,
        updatedAt: serverTimestamp()
      };
      const removedMaskCount = Number(pageSnapshot.data()?.noteMaskCount || 0);
      if (removedMaskCount > 0) noteUpdate.noteMaskCount = increment(-removedMaskCount);
      transaction.update(noteReference, noteUpdate);
      return cloudRevision + 1;
    });
    return nextRevision;
  }

  // Page metadata updates of one operation are written atomically together
  // with one update of the note root: its updatedAt is the list screen's
  // change marker (cached card thumbnails), and `noteFields` carries related
  // note settings such as defaultBackground. Formerly every page was a
  // separate write, so a failure could leave some pages changed.
  async function updatePages(noteId, updates, expectedUid, { noteFields = null } = {}) {
    const { uid, db } = writeContext(expectedUid);
    const list = (Array.isArray(updates) ? updates : []).filter(update => update?.pageId);
    const chunks = [];
    for (let index = 0; index < list.length; index += CREATION_BATCH_SIZE) {
      chunks.push(list.slice(index, index + CREATION_BATCH_SIZE));
    }
    if (!chunks.length) chunks.push([]);
    for (const [chunkIndex, chunk] of chunks.entries()) {
      context(expectedUid);
      const batch = writeBatch(db);
      chunk.forEach(({ pageId, fields }) => {
        batch.update(pageRef(db, uid, noteId, pageId), { ...fields, updatedAt: serverTimestamp() });
      });
      if (chunkIndex === chunks.length - 1) {
        batch.update(noteRef(db, uid, noteId), { ...(noteFields || {}), updatedAt: serverTimestamp() });
      }
      await batch.commit();
    }
  }

  async function updatePage(noteId, pageId, fields, expectedUid) {
    await updatePages(noteId, [{ pageId, fields }], expectedUid);
  }

  async function updateNote(noteId, fields, expectedUid) {
    const { uid, db } = writeContext(expectedUid);
    context(expectedUid);
    await updateDoc(noteRef(db, uid, noteId), { ...fields, updatedAt: serverTimestamp() });
  }

  async function deleteMaterialLinkedNotes(materialIds, operation, expectedUid) {
    requireExpectedUid(expectedUid);
    const normalizedMaterialIds = normalizeMaterialIds(materialIds);
    const deletedReason = MATERIAL_NOTE_DELETE_REASONS[operation];
    if (!deletedReason) throw new TypeError("連携ノートの削除理由が不正です。");
    const { uid, db } = context(expectedUid);
    const snapshotsByPath = new Map();
    for (const materialId of normalizedMaterialIds) {
      const snapshots = await getDocs(query(
        collection(db, "users", uid, "notes"),
        where("materialRefs", "array-contains", materialId)
      ));
      context(expectedUid);
      snapshots.docs.forEach(snapshot => snapshotsByPath.set(snapshot.ref.path, snapshot));
    }
    const targetSnapshots = [...snapshotsByPath.values()].filter(snapshot =>
      shouldArchiveLinkedNote(snapshot.data(), deletedReason)
    );
    const batches = splitLinkedNoteWrites(targetSnapshots);
    const committedNoteIds = [];
    for (const snapshots of batches) {
      const batch = writeBatch(db);
      snapshots.forEach(snapshot => {
        const deletedMaterialRefs = normalizeMaterialIds(snapshot.data()?.materialRefs || [])
          .filter(materialId => normalizedMaterialIds.includes(materialId));
        batch.update(snapshot.ref, {
          deletedAt: serverTimestamp(),
          deletedReason,
          deletedMaterialRefs,
          updatedAt: serverTimestamp()
        });
      });
      try {
        context(expectedUid);
        await batch.commit();
        committedNoteIds.push(...snapshots.map(snapshot => snapshot.id));
      } catch (error) {
        error.deletedNoteIds = committedNoteIds;
        error.deletedCount = committedNoteIds.length;
        throw error;
      }
    }
    return {
      deletedCount: targetSnapshots.length,
      batchCount: batches.length,
      noteIds: committedNoteIds
    };
  }

  async function restoreNote(noteId, expectedUid) {
    const { uid, db } = writeContext(expectedUid);
    await runTransaction(db, async transaction => {
      const reference = noteRef(db, uid, noteId);
      const snapshot = await transaction.get(reference);
      context(expectedUid);
      if (!snapshot.exists()) throw new Error("ノートが見つかりません。");
      if (isMaterialDeletedReason(snapshot.data()?.deletedReason)) {
        throw new NoteRestoreBlockedError();
      }
      context(expectedUid);
      transaction.update(reference, {
        deletedAt: null,
        deletedReason: null,
        deletedMaterialRefs: [],
        updatedAt: serverTimestamp()
      });
    });
  }

  async function deleteNote(noteId, expectedUid) {
    return updateNote(noteId, {
      deletedAt: serverTimestamp(),
      deletedReason: "user",
      deletedMaterialRefs: []
    }, expectedUid);
  }

  return {
    listNoteDocuments, listNotes, getNote, listNotesByMaterial, listPages, createNote, createCreatingNote, finalizeCreatingNote,
    finalizeNoteCreation, abortCreatingNote, cleanupStuckCreatingNotes, markCreationFailed,
    journalSourcePages, uploadSourcePage, uploadRecoveredBackground, deleteStoragePaths, loadPageContent, savePageContent, enqueuePageContentSave, uploadAsset, getAsset,
    getStorageBlob, cleanupStoragePath, updatePageOrder, createPage, deletePage, updatePage, updatePages, updateNote,
    deleteMaterialLinkedNotes, restoreNote, deleteNote
  };
}
