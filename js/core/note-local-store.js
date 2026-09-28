const DATABASE_NAME = "dentalQaNoteLocal";
// The v2 keyPath already groups records as uid|noteId|... in its primary
// B-tree. Prefix ranges keep lookups indexed without a schema upgrade that
// could be blocked by another app tab (notably on iPad/Safari).
const VERSION = 2;
const STORES = ["pageDrafts", "pendingAssets", "pendingSaves", "conflicts", "pendingCleanups", "thumbnails"];

function isBlobLike(value) {
  return Boolean(
    value &&
    Number(value.size) >= 0 &&
    typeof value.arrayBuffer === "function" &&
    typeof value.type === "string"
  );
}

export function noteLocalKey(uid, noteId, pageId, suffix = "") {
  if (!uid || !noteId || !pageId) throw new Error("ローカル保存キーが不足しています。");
  return [uid, noteId, pageId, suffix].filter(Boolean).join("|");
}

export function localRecordMatches(current, expected) {
  if (!current) return true;
  if (expected?.mutationId) return current.mutationId === expected.mutationId;
  const expectedTimestamp = expected?.updatedAt || expected?.createdAt;
  return !current.mutationId && Boolean(expectedTimestamp) &&
    (current.updatedAt || current.createdAt) === expectedTimestamp;
}

export function createNoteLocalStore(indexedDb = globalThis.indexedDB, keyRange = globalThis.IDBKeyRange) {
  let connectionPromise;
  async function serializeForStore(storeName, value) {
    if (!value?.uid || !value?.noteId) {
      throw new TypeError(`${storeName}のローカル保存にはuidとnoteIdが必要です。`);
    }
    if (!isBlobLike(value?.blob)) {
      return structuredClone(value);
    }
    const { blob, ...metadata } = value;
    return {
      ...structuredClone(metadata),
      blobBytes: await blob.arrayBuffer(),
      blobType: blob.type
    };
  }

  function restoreFromStore(storeName, value) {
    if (!value || value.blob || !(value.blobBytes instanceof ArrayBuffer)) {
      return value;
    }
    const { blobBytes, blobType, ...metadata } = value;
    return {
      ...metadata,
      blob: new Blob([blobBytes], { type: blobType || "application/octet-stream" })
    };
  }

  function open() {
    if (!indexedDb) return Promise.reject(new Error("IndexedDBを利用できません。"));
    if (connectionPromise) return connectionPromise;
    connectionPromise = new Promise((resolve, reject) => {
      const request = indexedDb.open(DATABASE_NAME, VERSION);
      request.onupgradeneeded = () => {
        STORES.forEach(name => {
          if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: "key" });
        });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return connectionPromise;
  }

  function prefixRange(prefix) {
    if (!keyRange?.bound) throw new Error("IndexedDBの範囲検索を利用できません。");
    return keyRange.bound(prefix, `${prefix}\uffff`);
  }

  async function run(storeName, mode, callback) {
    if (!STORES.includes(storeName)) throw new Error(`不明なIndexedDBストアです: ${storeName}`);
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
      let request;
      try { request = callback(store); } catch (error) { reject(error); return; }
      transaction.oncomplete = () => resolve(request?.result);
      transaction.onerror = () => reject(transaction.error || request?.error);
      transaction.onabort = () => reject(transaction.error || new Error("IndexedDB処理が中断されました。"));
    });
  }

  return {
    async put(store, value) {
      const serialized = await serializeForStore(store, value);
      return run(store, "readwrite", objectStore => objectStore.put(serialized));
    },
    async get(store, key) {
      return restoreFromStore(store, await run(store, "readonly", objectStore => objectStore.get(key)));
    },
    delete: (store, key) => run(store, "readwrite", objectStore => objectStore.delete(key)),
    async putSavePair(draft, pending) {
      if (!draft?.key || draft.key !== pending?.key) {
        throw new TypeError("下書きと保存待ちのキーが一致しません。");
      }
      if (!draft.mutationId || draft.mutationId !== pending.mutationId) {
        throw new TypeError("下書きと保存待ちのmutationIdが一致しません。");
      }
      const [serializedDraft, serializedPending] = await Promise.all([
        serializeForStore("pageDrafts", draft),
        serializeForStore("pendingSaves", pending)
      ]);
      const db = await open();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(["pageDrafts", "pendingSaves"], "readwrite");
        transaction.objectStore("pageDrafts").put(serializedDraft);
        transaction.objectStore("pendingSaves").put(serializedPending);
        transaction.oncomplete = () => resolve(true);
        transaction.onerror = () => reject(transaction.error || new Error("ローカル保存に失敗しました。"));
        transaction.onabort = () => reject(transaction.error || new Error("ローカル保存が中断されました。"));
      });
    },
    async putSavePairIfMatching(draft, pending, expectedMutationId) {
      if (!draft?.key || draft.key !== pending?.key) {
        throw new TypeError("下書きと保存待ちのキーが一致しません。");
      }
      if (!draft.mutationId || draft.mutationId !== pending.mutationId) {
        throw new TypeError("下書きと保存待ちのmutationIdが一致しません。");
      }
      if (!expectedMutationId) {
        throw new TypeError("更新前のmutationIdが必要です。");
      }
      const [serializedDraft, serializedPending] = await Promise.all([
        serializeForStore("pageDrafts", draft),
        serializeForStore("pendingSaves", pending)
      ]);
      const db = await open();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(["pageDrafts", "pendingSaves"], "readwrite");
        const draftStore = transaction.objectStore("pageDrafts");
        const pendingStore = transaction.objectStore("pendingSaves");
        const draftRequest = draftStore.get(draft.key);
        const pendingRequest = pendingStore.get(pending.key);
        let checked = false;
        let stored = false;
        const compareAndPut = () => {
          if (checked || draftRequest.readyState !== "done" || pendingRequest.readyState !== "done") return;
          checked = true;
          const expected = { mutationId: expectedMutationId };
          if (!localRecordMatches(draftRequest.result, expected) ||
              !localRecordMatches(pendingRequest.result, expected)) return;
          draftStore.put(serializedDraft);
          pendingStore.put(serializedPending);
          stored = true;
        };
        draftRequest.onsuccess = compareAndPut;
        pendingRequest.onsuccess = compareAndPut;
        transaction.oncomplete = () => resolve(stored);
        transaction.onerror = () => reject(transaction.error || draftRequest.error || pendingRequest.error);
        transaction.onabort = () => reject(transaction.error || new Error("IndexedDB処理が中断されました。"));
      });
    },
    async deleteSavePairIfUnchanged(key, expected) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(["pageDrafts", "pendingSaves"], "readwrite");
        const draftStore = transaction.objectStore("pageDrafts");
        const pendingStore = transaction.objectStore("pendingSaves");
        const draftRequest = draftStore.get(key);
        const pendingRequest = pendingStore.get(key);
        let checked = false;
        let deleted = false;
        const compareAndDelete = () => {
          if (checked || draftRequest.readyState !== "done" || pendingRequest.readyState !== "done") return;
          checked = true;
          if (!localRecordMatches(draftRequest.result, expected?.draft) ||
              !localRecordMatches(pendingRequest.result, expected?.pending)) return;
          if (draftRequest.result) draftStore.delete(key);
          if (pendingRequest.result) pendingStore.delete(key);
          deleted = true;
        };
        draftRequest.onsuccess = compareAndDelete;
        pendingRequest.onsuccess = compareAndDelete;
        transaction.oncomplete = () => resolve(deleted);
        transaction.onerror = () => reject(transaction.error || draftRequest.error || pendingRequest.error);
        transaction.onabort = () => reject(transaction.error || new Error("IndexedDB処理が中断されました。"));
      });
    },
    async deleteIfUnchanged(storeName, key, updatedAt) {
      if (!STORES.includes(storeName)) throw new Error(`不明なIndexedDBストアです: ${storeName}`);
      const db = await open();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, "readwrite");
        const store = transaction.objectStore(storeName);
        let deleted = false;
        const request = store.get(key);
        request.onsuccess = () => {
          if ((request.result?.updatedAt || request.result?.createdAt) !== updatedAt) return;
          deleted = true;
          store.delete(key);
        };
        transaction.oncomplete = () => resolve(deleted);
        transaction.onerror = () => reject(transaction.error || request.error);
        transaction.onabort = () => reject(transaction.error || new Error("IndexedDB処理が中断されました。"));
      });
    },
    async listForUser(store, uid) {
      if (!uid) throw new Error("ローカル保存のユーザー識別子が不足しています。");
      const prefix = `${uid}|`;
      const values = await run(store, "readonly", objectStore => (
        objectStore.getAll(prefixRange(prefix))
      )) || [];
      return values
        .filter(value => value.uid === uid)
        .map(value => restoreFromStore(store, value));
    },
    async listForNote(store, uid, noteId) {
      if (!uid || !noteId) throw new Error("ローカル保存のノート識別子が不足しています。");
      const prefix = `${uid}|${noteId}|`;
      const values = await run(store, "readonly", objectStore => (
        objectStore.getAll(prefixRange(prefix))
      )) || [];
      return values
        .filter(value => value.uid === uid && value.noteId === noteId)
        .map(value => restoreFromStore(store, value));
    },
    async clearUser(uid) {
      for (const store of STORES) {
        const entries = await this.listForUser(store, uid);
        await Promise.all(entries.map(entry => this.delete(store, entry.key)));
      }
    },
    close: async () => {
      const activeConnection = connectionPromise;
      connectionPromise = undefined;
      if (activeConnection) (await activeConnection).close();
    }
  };
}

export {
  DATABASE_NAME as NOTE_LOCAL_DATABASE,
  STORES as NOTE_LOCAL_STORES,
  VERSION as NOTE_LOCAL_DATABASE_VERSION
};
