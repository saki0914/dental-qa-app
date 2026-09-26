import assert from "node:assert/strict";
import test from "node:test";
import { createNoteSaveCoordinator } from "../../js/core/note-save-coordinator.js";

function memoryStore() {
  const records = new Map();
  return {
    records,
    put: async (store, value) => records.set(`${store}:${value.key}`, structuredClone(value)),
    delete: async (store, key) => records.delete(`${store}:${key}`)
  };
}

test("クラウド保存前に下書きと保存待ちを端末内へ保存する", async () => {
  const localStore = memoryStore();
  const calls = [];
  const coordinator = createNoteSaveCoordinator({ localStore, debounceMs: 9999, persist: async (...args) => calls.push(args) });
  const identity = { uid: "u", noteId: "n", pageId: "p" };
  await coordinator.schedule(identity, { revision: 0, elements: [], noteMasks: [] });
  assert.equal(localStore.records.has("pageDrafts:u|n|p"), true);
  assert.equal(localStore.records.has("pendingSaves:u|n|p"), true);
  assert.equal(localStore.records.get("pageDrafts:u|n|p").expectedRevision, 0);
  assert.equal(localStore.records.get("pendingSaves:u|n|p").expectedRevision, 0);
  await coordinator.flush(identity);
  assert.equal(calls.length, 1);
  assert.equal(localStore.records.has("pageDrafts:u|n|p"), false);
});

test("保存競合時はローカル版をconflictsへ保持する", async () => {
  const localStore = memoryStore();
  const error = Object.assign(new Error("conflict"), { name: "NoteConflictError" });
  const coordinator = createNoteSaveCoordinator({ localStore, debounceMs: 9999, persist: async () => { throw error; } });
  const identity = { uid: "u", noteId: "n", pageId: "p" };
  await coordinator.schedule(identity, { revision: 0, elements: [{ id: "x" }], noteMasks: [] });
  await assert.rejects(coordinator.flush(identity), /conflict/);
  assert.equal(localStore.records.has("conflicts:u|n|p"), true);
});

test("競合解決で破棄した保存状態は後続flushで再送しない", async () => {
  const localStore = memoryStore();
  const calls = [];
  const error = Object.assign(new Error("conflict"), { name: "NoteConflictError" });
  const coordinator = createNoteSaveCoordinator({
    localStore,
    debounceMs: 9999,
    persist: async (...args) => {
      calls.push(args);
      throw error;
    }
  });
  const identity = { uid: "u", noteId: "n", pageId: "p" };
  await coordinator.schedule(identity, { revision: 0, elements: [{ id: "local" }], noteMasks: [] });
  await assert.rejects(coordinator.flush(identity), /conflict/);
  assert.equal(coordinator.discard(identity), true);
  assert.equal(await coordinator.flush(identity), null);
  assert.equal(calls.length, 1);
});

test("実行中の保存を破棄した後は遅れて失敗しても競合を再作成しない", async () => {
  const localStore = memoryStore();
  const error = Object.assign(new Error("conflict"), { name: "NoteConflictError" });
  let releasePersist;
  let notifyStarted;
  const persistStarted = new Promise(resolve => { notifyStarted = resolve; });
  const persistGate = new Promise(resolve => { releasePersist = resolve; });
  const coordinator = createNoteSaveCoordinator({
    localStore,
    debounceMs: 9999,
    persist: async () => {
      notifyStarted();
      await persistGate;
      throw error;
    }
  });
  const identity = { uid: "u", noteId: "n", pageId: "p" };
  await coordinator.schedule(identity, { revision: 0, elements: [{ id: "local" }], noteMasks: [] });
  const flushing = coordinator.flush(identity);
  await persistStarted;
  assert.equal(coordinator.discard(identity), true);
  releasePersist();
  await assert.rejects(flushing, /conflict/);
  assert.equal(localStore.records.has("conflicts:u|n|p"), false);
  assert.equal(await coordinator.flush(identity), null);
});
