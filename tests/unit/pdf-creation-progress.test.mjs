import assert from "node:assert/strict";
import test from "node:test";

import {
  PDF_CREATION_PROGRESS_MAX_AGE_MS,
  createPdfCreationProgress,
  interruptedPdfCreationMessage,
  pdfCreationProgressKey,
  takeInterruptedPdfCreation
} from "../../js/core/pdf-creation-progress.js";

// The parts of the Web Storage interface the module uses.
function memoryStorage(entries = {}) {
  const map = new Map(Object.entries(entries));
  return {
    map,
    get length() { return map.size; },
    key: index => [...map.keys()][index] ?? null,
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: key => { map.delete(key); }
  };
}

test("PDFノート作成の進み具合をタブごとに記録し、終わったら消す", () => {
  const storage = memoryStorage();
  let time = 1_000;
  const progress = createPdfCreationProgress({ tabId: "tab-1", storage: () => storage, now: () => time });
  progress.start({ uid: "user-1", fileName: "scan.pdf", fileSize: 56_300_000 });
  const key = pdfCreationProgressKey("tab-1");
  assert.deepEqual(JSON.parse(storage.getItem(key)), {
    uid: "user-1", fileName: "scan.pdf", fileSize: 56_300_000,
    phase: "reading", pageNumber: 0, pageCount: 0, startedAt: 1_000, updatedAt: 1_000
  });
  time = 2_000;
  progress.update({ phase: "converting", pageNumber: 18, pageCount: 41 });
  assert.deepEqual(JSON.parse(storage.getItem(key)), {
    uid: "user-1", fileName: "scan.pdf", fileSize: 56_300_000,
    phase: "converting", pageNumber: 18, pageCount: 41, startedAt: 1_000, updatedAt: 2_000
  });
  progress.update({ phase: "saving" });
  assert.equal(JSON.parse(storage.getItem(key)).pageNumber, 18, "変わらない項目は残す");
  progress.finish();
  assert.equal(storage.getItem(key), null);
  progress.update({ phase: "converting", pageNumber: 1, pageCount: 1 });
  assert.equal(storage.getItem(key), null, "終わった後の更新は書かない");
});

test("タブIDがない、または保存領域が使えない場合は何も記録せずに続ける", () => {
  const storage = memoryStorage();
  const withoutTab = createPdfCreationProgress({ tabId: null, storage: () => storage });
  withoutTab.start({ uid: "user-1", fileName: "a.pdf", fileSize: 1 });
  withoutTab.update({ phase: "converting", pageNumber: 1, pageCount: 2 });
  withoutTab.finish();
  assert.equal(storage.length, 0);

  const throwing = {
    get length() { throw new Error("blocked"); },
    key() { throw new Error("blocked"); },
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("quota"); },
    removeItem() { throw new Error("blocked"); }
  };
  const blocked = createPdfCreationProgress({ tabId: "tab-1", storage: () => throwing });
  assert.doesNotThrow(() => {
    blocked.start({ uid: "user-1", fileName: "a.pdf", fileSize: 1 });
    blocked.update({ phase: "saving" });
    blocked.finish();
  });
  const unavailable = createPdfCreationProgress({ tabId: "tab-1", storage: () => { throw new Error("SecurityError"); } });
  assert.doesNotThrow(() => unavailable.start({ uid: "user-1", fileName: "a.pdf", fileSize: 1 }));
  assert.equal(takeInterruptedPdfCreation({ tabId: "tab-1", uid: "user-1", storage: () => throwing }), null);
  assert.equal(takeInterruptedPdfCreation({ tabId: "tab-1", uid: "user-1", storage: () => null }), null);
});

test("再読み込みされたタブは自分の記録を一度だけ受け取り、古い記録は片付ける", () => {
  const now = 10 * PDF_CREATION_PROGRESS_MAX_AGE_MS;
  const record = (fields = {}) => JSON.stringify({
    uid: "user-1", fileName: "scan.pdf", fileSize: 1, phase: "converting",
    pageNumber: 18, pageCount: 41, startedAt: now - 60_000, updatedAt: now - 30_000, ...fields
  });
  const storage = memoryStorage({
    [pdfCreationProgressKey("own")]: record(),
    [pdfCreationProgressKey("other-running")]: record(),
    [pdfCreationProgressKey("other-old")]: record({ updatedAt: now - PDF_CREATION_PROGRESS_MAX_AGE_MS - 1 }),
    [pdfCreationProgressKey("broken")]: "{",
    unrelated: "keep"
  });
  const found = takeInterruptedPdfCreation({ tabId: "own", uid: "user-1", storage: () => storage, now: () => now });
  assert.equal(found.pageNumber, 18);
  assert.equal(found.fileName, "scan.pdf");
  assert.deepEqual([...storage.map.keys()].sort(), [pdfCreationProgressKey("other-running"), "unrelated"].sort(),
    "自分の記録と古い・壊れた記録を消し、ほかのタブで進行中の記録は残す");
  assert.equal(takeInterruptedPdfCreation({ tabId: "own", uid: "user-1", storage: () => storage, now: () => now }), null, "二度目は出さない");

  const otherUser = memoryStorage({ [pdfCreationProgressKey("own")]: record() });
  assert.equal(takeInterruptedPdfCreation({ tabId: "own", uid: "user-2", storage: () => otherUser, now: () => now }), null, "別のユーザーの記録は出さない");
  assert.equal(otherUser.length, 0);
  const stale = memoryStorage({ [pdfCreationProgressKey("own")]: record({ updatedAt: now - PDF_CREATION_PROGRESS_MAX_AGE_MS }) });
  assert.equal(takeInterruptedPdfCreation({ tabId: "own", uid: "user-1", storage: () => stale, now: () => now }), null, "1日以上前の記録は出さない");
  assert.equal(stale.length, 0);
});

test("中断の案内には、ファイル名と止まった段階を含める", () => {
  assert.equal(
    interruptedPdfCreationMessage({ fileName: "20260801_Z章微生物学.pdf", phase: "converting", pageNumber: 18, pageCount: 41 }),
    "前回のPDFノート作成は、「20260801_Z章微生物学.pdf」の41ページ中18ページ目の変換中に終了しました。" +
      "端末のメモリ不足などで、ページが再読み込みされた可能性があります。ほかのタブやアプリを閉じてから、もう一度お試しください。"
  );
  assert.match(interruptedPdfCreationMessage({ fileName: "a.pdf", phase: "reading" }), /「a\.pdf」の読み込み中に終了しました/);
  assert.match(interruptedPdfCreationMessage({ fileName: "a.pdf", phase: "saving" }), /「a\.pdf」のページ画像の保存中に終了しました/);
  assert.match(interruptedPdfCreationMessage({ phase: "converting", pageNumber: 0, pageCount: 0 }), /PDFの読み込み中に終了しました/);
});
