const DATABASE_NAME = "dentalQaNoteLocal";
const VERSION = 1;
const STORES = ["pageDrafts", "pendingAssets", "pendingSaves", "conflicts"];

export function noteLocalKey(uid, noteId, pageId, suffix = "") {
  if (!uid || !noteId || !pageId) throw new Error("ローカル保存キーが不足しています。");
  return [uid, noteId, pageId, suffix].filter(Boolean).join("|");
}

export function createNoteLocalStore(indexedDb = globalThis.indexedDB) {
  let connectionPromise;
  async function serializeForStore(storeName, value) {
    if (storeName !== "pendingAssets" || !(value?.blob instanceof Blob)) {
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
    if (storeName !== "pendingAssets" || !value || value.blob || !(value.blobBytes instanceof ArrayBuffer)) {
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
      const values = await run(store, "readonly", objectStore => objectStore.getAll()) || [];
      return values
        .filter(value => value.uid === uid)
        .map(value => restoreFromStore(store, value));
    },
    async clearUser(uid) {
      for (const store of STORES) {
        const entries = await this.listForUser(store, uid);
        await Promise.all(entries.map(entry => this.delete(store, entry.key)));
      }
    },
    close: async () => (await open()).close()
  };
}

export { DATABASE_NAME as NOTE_LOCAL_DATABASE, STORES as NOTE_LOCAL_STORES };
