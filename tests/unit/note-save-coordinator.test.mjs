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
  await coordinator.schedule(identity, { elements: [], noteMasks: [] });
  assert.equal(localStore.records.has("pageDrafts:u|n|p"), true);
  assert.equal(localStore.records.has("pendingSaves:u|n|p"), true);
  await coordinator.flush(identity);
  assert.equal(calls.length, 1);
  assert.equal(localStore.records.has("pageDrafts:u|n|p"), false);
});

test("保存競合時はローカル版をconflictsへ保持する", async () => {
  const localStore = memoryStore();
  const error = Object.assign(new Error("conflict"), { name: "NoteConflictError" });
  const coordinator = createNoteSaveCoordinator({ localStore, debounceMs: 9999, persist: async () => { throw error; } });
  const identity = { uid: "u", noteId: "n", pageId: "p" };
  await coordinator.schedule(identity, { elements: [{ id: "x" }], noteMasks: [] });
  await assert.rejects(coordinator.flush(identity), /conflict/);
  assert.equal(localStore.records.has("conflicts:u|n|p"), true);
});
