import { noteLocalKey } from "./note-local-store.js";

export function createNoteSaveCoordinator({
  localStore,
  persist,
  debounceMs = 850,
  onStatus = () => {}
}) {
  const states = new Map();

  function stateFor(identity) {
    const key = noteLocalKey(identity.uid, identity.noteId, identity.pageId);
    if (!states.has(key)) states.set(key, { key, identity: { ...identity }, timer: null, running: null, dirty: false, generation: 0, latest: null });
    const state = states.get(key);
    state.identity = { ...state.identity, ...identity };
    return state;
  }

  async function saveLocal(identity, content) {
    const key = noteLocalKey(identity.uid, identity.noteId, identity.pageId);
    const expectedRevision = Number(identity.expectedRevision ?? content?.revision);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw new TypeError("ローカル下書きの基準リビジョンが不正です。");
    }
    await localStore.put("pageDrafts", {
      key,
      ...identity,
      expectedRevision,
      content: structuredClone(content),
      updatedAt: new Date().toISOString()
    });
    await localStore.put("pendingSaves", { key, ...identity, expectedRevision, updatedAt: new Date().toISOString() });
    onStatus("local-saved", identity);
  }

  async function execute(identity, state) {
    if (state.running) return state.running;
    state.identity = { ...state.identity, ...identity };
    const activeIdentity = { ...state.identity };
    const generation = state.generation;
    const content = structuredClone(state.latest);
    state.dirty = false;
    onStatus(globalThis.navigator?.onLine === false ? "offline" : "saving", activeIdentity);
    state.running = (async () => {
      try {
        const result = await persist(activeIdentity, content);
        if (state.generation === generation) {
          await Promise.all([
            localStore.delete("pageDrafts", state.key),
            localStore.delete("pendingSaves", state.key)
          ]);
          onStatus("saved", activeIdentity, result);
        } else if (Number.isInteger(result?.revision) && result.revision >= 0) {
          state.identity = { ...state.identity, expectedRevision: result.revision };
          await saveLocal(state.identity, state.latest);
        }
        return result;
      } catch (error) {
        if (state.generation === generation) {
          state.dirty = true;
          if (error?.name === "NoteConflictError") {
            await localStore.put("conflicts", {
              key: state.key,
              ...activeIdentity,
              content,
              error: error.message,
              updatedAt: new Date().toISOString()
            });
            onStatus("conflict", activeIdentity, error);
          } else {
            onStatus(globalThis.navigator?.onLine === false ? "offline" : "error", activeIdentity, error);
          }
        }
        throw error;
      } finally {
        state.running = null;
        if (state.dirty && state.latest && state.generation !== generation) void execute(state.identity, state).catch(() => {});
      }
    })();
    return state.running;
  }

  async function schedule(identity, content) {
    const state = stateFor(identity);
    state.latest = structuredClone(content);
    state.dirty = true;
    state.generation += 1;
    clearTimeout(state.timer);
    await saveLocal(identity, content);
    onStatus("editing", identity);
    state.timer = setTimeout(() => execute(identity, state).catch(() => {}), debounceMs);
  }

  async function flush(identity) {
    const state = stateFor(identity);
    clearTimeout(state.timer);
    state.timer = null;
    if (!state.dirty && !state.running) return null;
    if (state.running) await state.running.catch(() => {});
    if (!state.dirty) return null;
    return execute(identity, state);
  }

  async function flushAll() {
    const results = [];
    for (const state of states.values()) {
      clearTimeout(state.timer);
      if (state.running) await state.running.catch(() => {});
      if (state.dirty && state.latest) {
        results.push(await execute(state.identity, state).catch(error => error));
      }
    }
    return results;
  }

  function discard(identity) {
    const key = noteLocalKey(identity.uid, identity.noteId, identity.pageId);
    const state = states.get(key);
    if (!state) return false;
    clearTimeout(state.timer);
    state.timer = null;
    state.dirty = false;
    state.latest = null;
    state.generation += 1;
    states.delete(key);
    return true;
  }

  return {
    schedule,
    flush,
    flushAll,
    discard,
    isDirty: identity => stateFor(identity).dirty,
    reset() {
      states.forEach(state => clearTimeout(state.timer));
      states.clear();
    }
  };
}
