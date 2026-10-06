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

// iPad Safari can close an IndexedDB connection while the page is in the
// background ("Connection to Indexed Database server lost"). A cached, closed
// connection would make every later draft save fail until reload, so such
// errors drop the cached connection and the operation is retried once.
export function isClosedIndexedDbConnectionError(error) {
  const name = String(error?.name || "");
  const message = String(error?.message || "");
  return name === "InvalidStateError" ||
    /connection (?:to indexed database server )?(?:is )?(?:lost|closing|closed)/i.test(message) ||
    /database connection is closing/i.test(message);
}

export function createNoteLocalStore(indexedDb = globalThis.indexedDB, keyRange = globalThis.IDBKeyRange) {
  let connectionPromise;
  async function serializeForStore(storeName, value) {
    if (!value?.uid || !value?.noteId) {
      throw new TypeError(`${storeName}のローカル保存にはuidとnoteIdが必要です。`);
    }
    if (!isBlobLike(value?.blob)) {
      // IndexedDB structured-clones the value inside put(); an extra clone
      // here only doubled the cost of every draft save.
      return value;
    }
    const { blob, ...metadata } = value;
    return {
      ...metadata,
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
    const pending = new Promise((resolve, reject) => {
      const request = indexedDb.open(DATABASE_NAME, VERSION);
      request.onupgradeneeded = () => {
        STORES.forEach(name => {
          if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: "key" });
        });
      };
      request.onsuccess = () => {
        const database = request.result;
        const forget = () => { if (connectionPromise === pending) connectionPromise = undefined; };
        // A newer schema in another tab must not wait for this tab forever.
        database.onversionchange = () => {
          forget();
          try { database.close(); } catch {}
        };
        database.onclose = forget;
        resolve(database);
      };
      request.onerror = () => {
        // Do not cache a failed open: a later save must be able to retry.
        if (connectionPromise === pending) connectionPromise = undefined;
        reject(request.error || new Error("IndexedDBを開けませんでした。"));
      };
    });
    connectionPromise = pending;
    return pending;
  }

  // `operation(database)` starts its transaction synchronously. A closed
  // cached connection fails before any write is applied, so one retry on a
  // fresh connection cannot duplicate work.
  async function withConnection(operation) {
    for (let attempt = 0; ; attempt += 1) {
      const active = open();
      const database = await active;
      try {
        return await operation(database);
      } catch (error) {
        if (attempt > 0 || !isClosedIndexedDbConnectionError(error)) throw error;
        if (connectionPromise === active) connectionPromise = undefined;
        try { database.close?.(); } catch {}
      }
    }
  }

  function prefixRange(prefix) {
    if (!keyRange?.bound) throw new Error("IndexedDBの範囲検索を利用できません。");
    return keyRange.bound(prefix, `${prefix}￿`);
  }

  async function run(storeName, mode, callback) {
    if (!STORES.includes(storeName)) throw new Error(`不明なIndexedDBストアです: ${storeName}`);
    return withConnection(db => new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
      let request;
      try { request = callback(store); } catch (error) { reject(error); return; }
      transaction.oncomplete = () => resolve(request?.result);
      transaction.onerror = () => reject(transaction.error || request?.error);
      transaction.onabort = () => reject(transaction.error || new Error("IndexedDB処理が中断されました。"));
    }));
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
      return withConnection(db => new Promise((resolve, reject) => {
        const transaction = db.transaction(["pageDrafts", "pendingSaves"], "readwrite");
        transaction.objectStore("pageDrafts").put(serializedDraft);
        transaction.objectStore("pendingSaves").put(serializedPending);
        transaction.oncomplete = () => resolve(true);
        transaction.onerror = () => reject(transaction.error || new Error("ローカル保存に失敗しました。"));
        transaction.onabort = () => reject(transaction.error || new Error("ローカル保存が中断されました。"));
      }));
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
      return withConnection(db => new Promise((resolve, reject) => {
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
      }));
    },
    async deleteSavePairIfUnchanged(key, expected) {
      return withConnection(db => new Promise((resolve, reject) => {
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
      }));
    },
    async deleteIfUnchanged(storeName, key, updatedAt) {
      if (!STORES.includes(storeName)) throw new Error(`不明なIndexedDBストアです: ${storeName}`);
      return withConnection(db => new Promise((resolve, reject) => {
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
      }));
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
    // The keys of a user's records, without reading the records (a cache of
    // page images would otherwise be read in full).
    async listKeysForUser(store, uid) {
      if (!uid) throw new Error("ローカル保存のユーザー識別子が不足しています。");
      const keys = await run(store, "readonly", objectStore => (
        objectStore.getAllKeys(prefixRange(`${uid}|`))
      )) || [];
      return keys.map(String);
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
