// iPad Safari ends a tab that runs out of memory without any error the page
// could catch, and then reloads it. A PDF note creation therefore records how
// far it got under the creation tab's own key, so that the reloaded tab can
// tell where the previous attempt stopped. The record is removed when the
// creation ends (also by failure or cancellation) and when the tab is left.

const KEY_PREFIX = "dentalQaPdfCreationProgress:";
export const PDF_CREATION_PROGRESS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function storageFrom(getStorage) {
  try {
    return getStorage() || null;
  } catch {
    // Storage can be unavailable (private browsing, blocked site data).
    return null;
  }
}

export function pdfCreationProgressKey(tabId) {
  return `${KEY_PREFIX}${tabId}`;
}

// Records the progress of one PDF note creation in tab `tabId`. Without a tab
// id nothing is recorded. Storage failures are ignored: the record only
// explains an interruption.
export function createPdfCreationProgress({
  tabId,
  storage: getStorage = () => globalThis.localStorage,
  now = () => Date.now()
} = {}) {
  const key = tabId ? pdfCreationProgressKey(tabId) : "";
  let record = null;
  const write = () => {
    if (!key || !record) return;
    try {
      storageFrom(getStorage)?.setItem(key, JSON.stringify(record));
    } catch {}
  };
  return {
    start({ uid, fileName, fileSize }) {
      const time = now();
      record = {
        uid: String(uid || ""),
        fileName: String(fileName || ""),
        fileSize: Number(fileSize) || 0,
        phase: "reading",
        pageNumber: 0,
        pageCount: 0,
        startedAt: time,
        updatedAt: time
      };
      write();
    },
    // `phase`: "reading" (the file), "converting" (page `pageNumber` of
    // `pageCount`) or "saving" (the last page images).
    update({ phase, pageNumber, pageCount }) {
      if (!record) return;
      record = {
        ...record,
        ...(phase ? { phase } : {}),
        ...(Number.isInteger(pageNumber) ? { pageNumber } : {}),
        ...(Number.isInteger(pageCount) ? { pageCount } : {}),
        updatedAt: now()
      };
      write();
    },
    finish() {
      record = null;
      if (!key) return;
      try {
        storageFrom(getStorage)?.removeItem(key);
      } catch {}
    }
  };
}

// The record tab `tabId` left for user `uid` when it ended during a creation,
// or null. Reading removes it, together with the records of other tabs that
// are older than a day.
export function takeInterruptedPdfCreation({
  tabId,
  uid,
  storage: getStorage = () => globalThis.localStorage,
  now = () => Date.now()
} = {}) {
  const storage = storageFrom(getStorage);
  if (!storage || !tabId) return null;
  const ownKey = pdfCreationProgressKey(tabId);
  let found = null;
  try {
    const keys = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (typeof key === "string" && key.startsWith(KEY_PREFIX)) keys.push(key);
    }
    for (const key of keys) {
      let record = null;
      try {
        record = JSON.parse(storage.getItem(key) || "null");
      } catch {}
      const age = now() - Number(record?.updatedAt);
      const recent = age >= 0 && age < PDF_CREATION_PROGRESS_MAX_AGE_MS;
      if (key === ownKey) {
        storage.removeItem(key);
        if (recent && uid && record?.uid === uid) found = record;
      } else if (!recent) {
        storage.removeItem(key);
      }
    }
  } catch {}
  return found;
}

export function interruptedPdfCreationMessage(record) {
  const file = record?.fileName ? `「${record.fileName}」` : "PDF";
  let where = `${file}の読み込み中`;
  if (record?.phase === "converting" && record.pageCount > 0 && record.pageNumber > 0) {
    where = `${file}の${record.pageCount}ページ中${record.pageNumber}ページ目の変換中`;
  } else if (record?.phase === "saving") {
    where = `${file}のページ画像の保存中`;
  }
  return `前回のPDFノート作成は、${where}に終了しました。` +
    "端末のメモリ不足などで、ページが再読み込みされた可能性があります。" +
    "ほかのタブやアプリを閉じてから、もう一度お試しください。";
}
