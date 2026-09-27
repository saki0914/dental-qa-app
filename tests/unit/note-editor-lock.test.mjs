import assert from "node:assert/strict";
import test from "node:test";
import {
  NOTE_EDITOR_CLAIM_CONFIRM_MS,
  NOTE_EDITOR_HEARTBEAT_MS,
  NOTE_EDITOR_LEASE_TTL_MS,
  compareNoteEditorLeasePriority,
  createNoteEditorLease,
  noteEditorLeaseKey
} from "../../js/core/note-editor-lock.js";

function sharedStorage() {
  const values = new Map();
  const listeners = new Set();
  return {
    storage: {
      getItem: key => values.get(key) ?? null,
      setItem(key, value) {
        values.set(key, value);
        listeners.forEach(listener => listener({ key, newValue: value }));
      },
      removeItem(key) {
        values.delete(key);
        listeners.forEach(listener => listener({ key, newValue: null }));
      }
    },
    add: listener => listeners.add(listener),
    remove: listener => listeners.delete(listener),
    values
  };
}

function createLease(environment, options = {}) {
  return createNoteEditorLease({
    uid: "user",
    noteId: "note",
    clientInstanceId: options.clientInstanceId || "client",
    editorTabId: options.editorTabId,
    storage: environment.storage,
    channelFactory: () => null,
    addStorageListener: environment.add,
    removeStorageListener: environment.remove,
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
    claimConfirmMs: 0,
    wait: async () => {},
    ...options
  });
}

test("編集leaseのheartbeat・TTL・claim確認待ちを固定する", () => {
  assert.equal(NOTE_EDITOR_HEARTBEAT_MS, 2_000);
  assert.equal(NOTE_EDITOR_LEASE_TTL_MS, 8_000);
  assert.equal(NOTE_EDITOR_CLAIM_CONFIRM_MS, 180);
  assert.ok(NOTE_EDITOR_LEASE_TTL_MS >= NOTE_EDITOR_HEARTBEAT_MS * 3);
});

test("同じepochのclaimはwriterSessionId、editorTabIdの辞書順で決着する", () => {
  assert.ok(compareNoteEditorLeasePriority(
    { epoch: 3, writerSessionId: "writer-z", editorTabId: "tab-a" },
    { epoch: 3, writerSessionId: "writer-a", editorTabId: "tab-z" }
  ) > 0);
  assert.ok(compareNoteEditorLeasePriority(
    { epoch: 3, writerSessionId: "writer-a", editorTabId: "tab-z" },
    { epoch: 3, writerSessionId: "writer-a", editorTabId: "tab-a" }
  ) > 0);
});

test("既存writerが生存中は通常claimを拒否し、takeoverはepochを進める", async () => {
  const environment = sharedStorage();
  let firstLost = 0;
  const first = createLease(environment, { editorTabId: "tab-a", onOwnershipLost: () => { firstLost += 1; } });
  const second = createLease(environment, { editorTabId: "tab-b" });

  const firstResult = await first.claim();
  assert.equal(firstResult.acquired, true);
  assert.equal(firstResult.lease.epoch, 1);
  assert.equal((await second.claim()).acquired, false);

  const takeover = await second.takeover();
  assert.equal(takeover.acquired, true);
  assert.equal(takeover.lease.epoch, 2);
  assert.equal(first.isWriter(), false);
  assert.equal(firstLost, 1);
  second.dispose();
  first.dispose();
});

test("pagehideなしの強制終了後もTTL失効で別タブがwriterを回収できる", async () => {
  const environment = sharedStorage();
  let clock = 10_000;
  const common = { now: () => clock, ttlMs: 8_000 };
  const abandoned = createLease(environment, { ...common, editorTabId: "abandoned" });
  const replacement = createLease(environment, { ...common, editorTabId: "replacement" });

  assert.equal((await abandoned.claim()).acquired, true);
  assert.equal((await replacement.claim()).acquired, false);
  clock += 8_001;
  const recovered = await replacement.claim();
  assert.equal(recovered.acquired, true);
  assert.equal(recovered.lease.epoch, 2);
  assert.equal(abandoned.isWriter(), false);

  replacement.dispose();
  abandoned.dispose();
  assert.equal(environment.values.has(noteEditorLeaseKey("user", "note")), false);
});

test("claim確認待ち中に高いepochが現れたタブは編集権を確定しない", async () => {
  const environment = sharedStorage();
  let releaseFirst;
  const firstWait = new Promise(resolve => { releaseFirst = resolve; });
  const first = createLease(environment, {
    editorTabId: "tab-a",
    claimConfirmMs: 180,
    wait: () => firstWait
  });
  const second = createLease(environment, { editorTabId: "tab-b" });

  const pendingFirst = first.claim();
  await Promise.resolve();
  const takeover = await second.takeover();
  assert.equal(takeover.acquired, true);
  releaseFirst();
  assert.equal((await pendingFirst).acquired, false);
  assert.equal(first.isWriter(), false);

  second.dispose();
  first.dispose();
});
