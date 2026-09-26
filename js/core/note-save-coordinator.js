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
    if (!states.has(key)) states.set(key, { key, timer: null, running: null, dirty: false, generation: 0, latest: null });
    return states.get(key);
  }

  async function saveLocal(identity, content) {
    const key = noteLocalKey(identity.uid, identity.noteId, identity.pageId);
    await localStore.put("pageDrafts", {
      key,
      ...identity,
      content: structuredClone(content),
      updatedAt: new Date().toISOString()
    });
    await localStore.put("pendingSaves", { key, ...identity, updatedAt: new Date().toISOString() });
    onStatus("local-saved", identity);
  }

  async function execute(identity, state) {
    if (state.running) return state.running;
    const generation = state.generation;
    const content = structuredClone(state.latest);
    state.dirty = false;
    onStatus(globalThis.navigator?.onLine === false ? "offline" : "saving", identity);
    state.running = (async () => {
      try {
        const result = await persist(identity, content);
        if (state.generation === generation) {
          await Promise.all([
            localStore.delete("pageDrafts", state.key),
            localStore.delete("pendingSaves", state.key)
          ]);
          onStatus("saved", identity, result);
        }
        return result;
      } catch (error) {
        state.dirty = true;
        if (error?.name === "NoteConflictError") {
          await localStore.put("conflicts", {
            key: state.key,
            ...identity,
            content,
            error: error.message,
            updatedAt: new Date().toISOString()
          });
          onStatus("conflict", identity, error);
        } else {
          onStatus(globalThis.navigator?.onLine === false ? "offline" : "error", identity, error);
        }
        throw error;
      } finally {
        state.running = null;
        if (state.dirty && state.generation !== generation) void execute(identity, state).catch(() => {});
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
        const [uid, noteId, pageId] = state.key.split("|");
        results.push(await execute({ uid, noteId, pageId }, state).catch(error => error));
      }
    }
    return results;
  }

  return {
    schedule,
    flush,
    flushAll,
    isDirty: identity => stateFor(identity).dirty,
    reset() {
      states.forEach(state => clearTimeout(state.timer));
      states.clear();
    }
  };
}
