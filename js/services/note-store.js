import {
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
} from "https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js";
import {
  deleteObject,
  getBlob,
  ref as storageRef,
  uploadBytes
} from "https://www.gstatic.com/firebasejs/11.7.3/firebase-storage.js";
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
  splitLinkedNoteWrites
} from "../core/note-material-mutation.js";

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

const nowIso = () => new Date().toISOString();
const hashText = async text => {
  const bytes = new TextEncoder().encode(text);
  if (!globalThis.crypto?.subtle) return `${bytes.byteLength}-${Date.now()}`;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
};
const hashBlob = async blob => {
  if (!globalThis.crypto?.subtle) return `${blob.size}-${blob.type}-${Date.now()}`;
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
};

export function createNoteStore({ getDb, getStorage, getUser }) {
  function context() {
    const user = getUser();
    const db = getDb();
    const storage = getStorage();
    if (!user || !db || !storage) throw new Error("ノートを保存するにはログインが必要です。");
    return { uid: user.uid, db, storage };
  }
  const noteRef = (db, uid, noteId) => doc(db, "users", uid, "notes", noteId);
  const pageRef = (db, uid, noteId, pageId) => doc(db, "users", uid, "notes", noteId, "pages", pageId);
  const assetRef = (db, uid, noteId, assetId) => doc(db, "users", uid, "notes", noteId, "assets", assetId);
  const materialsRef = (db, uid) => doc(db, "users", uid, "app", "pdfMaterials");

  async function listNotes({ includeDeleted = false } = {}) {
    const { uid, db } = context();
    const snapshots = await getDocs(collection(db, "users", uid, "notes"));
    return snapshots.docs
      .map(snapshot => ({ id: snapshot.id, ...snapshot.data() }))
      .filter(note => includeDeleted || !note.deletedAt)
      .filter(note => note.status === "ready")
      .sort((a, b) => String(b.updatedAt?.toDate?.() || b.updatedAt || "").localeCompare(String(a.updatedAt?.toDate?.() || a.updatedAt || "")));
  }

  async function getNote(noteId) {
    const { uid, db } = context();
    const snapshot = await getDoc(noteRef(db, uid, noteId));
    return snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null;
  }

  async function listNotesByMaterial(materialId, { includeDeleted = false } = {}) {
    const [normalizedMaterialId] = normalizeMaterialIds([materialId]);
    if (!normalizedMaterialId) return [];
    const { uid, db } = context();
    const snapshots = await getDocs(query(
      collection(db, "users", uid, "notes"),
      where("materialRefs", "array-contains", normalizedMaterialId)
    ));
    return snapshots.docs
      .map(snapshot => ({ id: snapshot.id, ...snapshot.data() }))
      .filter(note => includeDeleted || !note.deletedAt);
  }

  async function listPages(noteId) {
    const { uid, db } = context();
    const snapshots = await getDocs(collection(db, "users", uid, "notes", noteId, "pages"));
    return snapshots.docs.map(snapshot => ({ pageId: snapshot.id, ...snapshot.data() }))
      .filter(page => !page.deletedAt)
      .sort((a, b) => Number(a.order) - Number(b.order));
  }

  async function createNote({ noteId = crypto.randomUUID(), pages, ...metadata }) {
    const { uid, db } = context();
    const materialRefs = normalizeMaterialIds(
      Array.isArray(metadata.materialRefs)
        ? metadata.materialRefs
        : metadata.sourceMaterialId ? [metadata.sourceMaterialId] : []
    );
    const timestamps = { createdAt: serverTimestamp(), updatedAt: serverTimestamp() };
    const noteDocument = {
      schemaVersion: 1,
      status: metadata.status || "ready",
      pageCount: pages.length,
      noteMaskCount: 0,
      orderRevision: 1,
      deletedAt: null,
      deletedReason: null,
      deletedMaterialRefs: [],
      ...metadata,
      materialRefs,
      ...timestamps
    };
    if (materialRefs.length) {
      await runTransaction(db, async transaction => {
        const snapshot = await transaction.get(materialsRef(db, uid));
        const materials = snapshot.data()?.pdfMaterials;
        const unavailable = materialRefs.find(materialId => {
          const material = Array.isArray(materials)
            ? materials.find(candidate => candidate?.id === materialId)
            : null;
          return !material || isMaterialArchiving(material);
        });
        if (unavailable) {
          throw new Error("教材の差し替え・削除処理中のため、連携ノートを作成できません。");
        }
        transaction.set(noteRef(db, uid, noteId), noteDocument);
      });
    } else {
      await setDoc(noteRef(db, uid, noteId), noteDocument);
    }
    await Promise.all(pages.map((page, index) => setDoc(pageRef(db, uid, noteId, page.pageId), {
      schemaVersion: 1,
      noteId,
      order: index + 1,
      contentRevision: 0,
      contentPath: "",
      contentHash: "",
      noteMaskCount: 0,
      deletedAt: null,
      ...page,
      ...timestamps
    })));
    return noteId;
  }

  async function createCreatingNote(noteId, metadata) {
    const { uid, db } = context();
    await setDoc(noteRef(db, uid, noteId), {
      schemaVersion: 1,
      ...metadata,
      status: "creating",
      pageCount: 0,
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

  async function finalizeCreatingNote(noteId, pages) {
    const { uid, db } = context();
    await Promise.all(pages.map((page, index) => setDoc(pageRef(db, uid, noteId, page.pageId), {
      schemaVersion: 1,
      noteId,
      order: index + 1,
      contentRevision: 0,
      contentPath: "",
      contentHash: "",
      noteMaskCount: 0,
      deletedAt: null,
      ...page,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    })));
    await updateDoc(noteRef(db, uid, noteId), {
      status: "ready",
      pageCount: pages.length,
      orderRevision: 1,
      updatedAt: serverTimestamp()
    });
  }

  async function markCreationFailed(noteId, orphanedPaths = []) {
    const { uid, db } = context();
    await updateDoc(noteRef(db, uid, noteId), {
      status: "failed",
      orphanedPaths,
      updatedAt: serverTimestamp()
    }).catch(() => {});
  }

  async function uploadSourcePage(noteId, pageId, blob) {
    validateImageBlob(blob, { label: "PDFページ画像", allowedTypes: ["image/jpeg"] });
    const { uid, storage } = context();
    const path = `users/${uid}/notes/${noteId}/sourcePages/${pageId}/background.jpg`;
    await uploadBytes(storageRef(storage, path), blob, { contentType: "image/jpeg" });
    return path;
  }

  async function deleteStoragePaths(paths) {
    const { storage } = context();
    const failed = [];
    for (const path of paths) {
      try { await deleteObject(storageRef(storage, path)); } catch (error) {
        if (error?.code !== "storage/object-not-found") failed.push(path);
      }
    }
    return failed;
  }

  async function loadPageContent(noteId, page) {
    if (!page?.contentPath) return { schemaVersion: 1, noteId, pageId: page.pageId, revision: 0, elements: [], noteMasks: [], savedAt: "" };
    const { storage } = context();
    const blob = await getBlob(storageRef(storage, page.contentPath));
    assertNonEmptyBlob(blob, "ページ内容JSON");
    const parsed = JSON.parse(await blob.text());
    serializeValidatedJson(parsed, { noteId, pageId: page.pageId });
    return parsed;
  }

  async function savePageContent({ noteId, pageId, expectedRevision }, content) {
    const { uid, db, storage } = context();
    const saveId = crypto.randomUUID();
    const currentRevision = Number(expectedRevision);
    if (!Number.isInteger(currentRevision) || currentRevision < 0) {
      throw new TypeError("ページ内容の保存前リビジョンが不正です。");
    }
    const nextRevision = currentRevision + 1;
    const payload = { ...content, schemaVersion: 1, noteId, pageId, revision: nextRevision, savedAt: nowIso() };
    const { json, blob } = serializeValidatedJson(payload, { noteId, pageId });
    const path = `users/${uid}/notes/${noteId}/pages/${pageId}/revisions/${saveId}.json`;
    await uploadBytes(storageRef(storage, path), blob, { contentType: "application/json" });
    const contentHash = await hashText(json);

    try {
      await runTransaction(db, async transaction => {
        const reference = pageRef(db, uid, noteId, pageId);
        const snapshot = await transaction.get(reference);
        const cloudRevision = Number(snapshot.data()?.contentRevision || 0);
        if (!snapshot.exists() || snapshot.data()?.deletedAt || cloudRevision !== currentRevision) {
          throw new NoteConflictError("別の端末でこのページが更新されています。", cloudRevision);
        }
        transaction.update(reference, {
          contentRevision: nextRevision,
          contentPath: path,
          contentHash,
          noteMaskCount: payload.noteMasks.length,
          updatedAt: serverTimestamp()
        });
        const maskDelta = payload.noteMasks.length - Number(snapshot.data()?.noteMaskCount || 0);
        transaction.update(noteRef(db, uid, noteId), { noteMaskCount: increment(maskDelta), updatedAt: serverTimestamp() });
      });
      return { revision: nextRevision, contentPath: path, contentHash };
    } catch (error) {
      await deleteObject(storageRef(storage, path)).catch(() => {});
      throw error;
    }
  }

  async function uploadAsset(noteId, blob, { assetId = crypto.randomUUID(), filename = "original.png" } = {}) {
    validateImageBlob(blob, { label: "貼り付け画像" });
    const { naturalWidth, naturalHeight, oversized } = await decodeImageDimensions(blob);
    if (oversized) {
      throw new Error("貼り付け画像の縦横サイズまたは総画素数が上限を超えています。");
    }
    const { uid, db, storage } = context();
    const extension = blob.type === "image/jpeg" ? "jpg" : blob.type === "image/webp" ? "webp" : "png";
    const safeStem = filename.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._-]/g, "_") || "original";
    const path = `users/${uid}/notes/${noteId}/assets/${assetId}/${safeStem}.${extension}`;
    const hash = await hashBlob(blob);
    await uploadBytes(storageRef(storage, path), blob, { contentType: blob.type });
    try {
      await setDoc(assetRef(db, uid, noteId, assetId), {
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
    } catch (error) {
      try {
        await deleteObject(storageRef(storage, path));
      } catch {
        error.orphanedStoragePath = path;
      }
      throw error;
    }
    return { assetId, storagePath: path, mimeType: blob.type, naturalWidth, naturalHeight, byteSize: blob.size, hash };
  }

  async function getAsset(noteId, assetId) {
    const { uid, db } = context();
    const snapshot = await getDoc(assetRef(db, uid, noteId, assetId));
    return snapshot.exists() ? { assetId, ...snapshot.data() } : null;
  }

  async function getStorageBlob(path) {
    const { storage } = context();
    return getBlob(storageRef(storage, path));
  }

  async function updatePageOrder(noteId, pages, expectedOrderRevision) {
    const { uid, db } = context();
    const expectedRevision = Number(expectedOrderRevision);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw new TypeError("ページ並び替え前のリビジョンが不正です。");
    }
    await runTransaction(db, async transaction => {
      const reference = noteRef(db, uid, noteId);
      const snapshot = await transaction.get(reference);
      const cloudRevision = Number(snapshot.data()?.orderRevision || 0);
      if (!snapshot.exists() || cloudRevision !== expectedRevision) {
        throw new NoteConflictError("別の端末でページ順が変更されています。", cloudRevision);
      }
      pages.forEach((page, index) => transaction.update(pageRef(db, uid, noteId, page.pageId), { order: index + 1, updatedAt: serverTimestamp() }));
      transaction.update(reference, { orderRevision: cloudRevision + 1, pageCount: pages.length, updatedAt: serverTimestamp() });
    });
    return expectedRevision + 1;
  }

  async function createPage(noteId, page, pageCount, expectedOrderRevision) {
    const { uid, db } = context();
    const expectedRevision = Number(expectedOrderRevision);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw new TypeError("ページ追加前の並び順リビジョンが不正です。");
    }
    const nextRevision = await runTransaction(db, async transaction => {
      const noteReference = noteRef(db, uid, noteId);
      const snapshot = await transaction.get(noteReference);
      const cloudRevision = Number(snapshot.data()?.orderRevision || 0);
      if (!snapshot.exists() || cloudRevision !== expectedRevision) {
        throw new NoteConflictError("別の端末でページ順が変更されています。", cloudRevision);
      }
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

  async function deletePage(noteId, pageId, remainingPages, expectedOrderRevision) {
    const { uid, db } = context();
    const expectedRevision = Number(expectedOrderRevision);
    if (!Array.isArray(remainingPages) || !remainingPages.length) {
      throw new TypeError("ノートには1ページ以上必要です。");
    }
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw new TypeError("ページ削除前の並び順リビジョンが不正です。");
    }
    return runTransaction(db, async transaction => {
      const noteReference = noteRef(db, uid, noteId);
      const pageReference = pageRef(db, uid, noteId, pageId);
      const [noteSnapshot, pageSnapshot] = await Promise.all([
        transaction.get(noteReference),
        transaction.get(pageReference)
      ]);
      const cloudRevision = Number(noteSnapshot.data()?.orderRevision || 0);
      if (!noteSnapshot.exists() || cloudRevision !== expectedRevision) {
        throw new NoteConflictError("別の端末でページ順が変更されています。", cloudRevision);
      }
      if (!pageSnapshot.exists() || pageSnapshot.data()?.deletedAt) {
        throw new NoteConflictError("別の端末でこのページが削除されています。", cloudRevision);
      }
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
      transaction.update(noteReference, {
        pageCount: remainingPages.length,
        noteMaskCount: increment(-Number(pageSnapshot.data()?.noteMaskCount || 0)),
        orderRevision: cloudRevision + 1,
        updatedAt: serverTimestamp()
      });
      return cloudRevision + 1;
    });
  }

  async function updatePage(noteId, pageId, fields) {
    const { uid, db } = context();
    await updateDoc(pageRef(db, uid, noteId, pageId), { ...fields, updatedAt: serverTimestamp() });
  }

  async function updateNote(noteId, fields) {
    const { uid, db } = context();
    await updateDoc(noteRef(db, uid, noteId), { ...fields, updatedAt: serverTimestamp() });
  }

  async function deleteMaterialLinkedNotes(materialIds, operation) {
    const normalizedMaterialIds = normalizeMaterialIds(materialIds);
    const deletedReason = MATERIAL_NOTE_DELETE_REASONS[operation];
    if (!deletedReason) throw new TypeError("連携ノートの削除理由が不正です。");
    const { uid, db } = context();
    const snapshotsByPath = new Map();
    for (const materialId of normalizedMaterialIds) {
      const snapshots = await getDocs(query(
        collection(db, "users", uid, "notes"),
        where("materialRefs", "array-contains", materialId)
      ));
      snapshots.docs.forEach(snapshot => snapshotsByPath.set(snapshot.ref.path, snapshot));
    }
    const activeSnapshots = [...snapshotsByPath.values()].filter(snapshot => !snapshot.data()?.deletedAt);
    const batches = splitLinkedNoteWrites(activeSnapshots);
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
        await batch.commit();
        committedNoteIds.push(...snapshots.map(snapshot => snapshot.id));
      } catch (error) {
        error.deletedNoteIds = committedNoteIds;
        error.deletedCount = committedNoteIds.length;
        throw error;
      }
    }
    return {
      deletedCount: activeSnapshots.length,
      batchCount: batches.length,
      noteIds: committedNoteIds
    };
  }

  async function restoreNote(noteId) {
    const { uid, db } = context();
    await runTransaction(db, async transaction => {
      const reference = noteRef(db, uid, noteId);
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists()) throw new Error("ノートが見つかりません。");
      if (isMaterialDeletedReason(snapshot.data()?.deletedReason)) {
        throw new NoteRestoreBlockedError();
      }
      transaction.update(reference, {
        deletedAt: null,
        deletedReason: null,
        deletedMaterialRefs: [],
        updatedAt: serverTimestamp()
      });
    });
  }

  async function deleteNote(noteId) {
    return updateNote(noteId, {
      deletedAt: serverTimestamp(),
      deletedReason: "user",
      deletedMaterialRefs: []
    });
  }

  return {
    listNotes, getNote, listNotesByMaterial, listPages, createNote, createCreatingNote, finalizeCreatingNote, markCreationFailed,
    uploadSourcePage, deleteStoragePaths, loadPageContent, savePageContent, uploadAsset, getAsset,
    getStorageBlob, updatePageOrder, createPage, deletePage, updatePage, updateNote,
    deleteMaterialLinkedNotes, restoreNote, deleteNote
  };
}
