export function createNoteHistory({ limit = 100, clone = structuredClone } = {}) {
  const undoStack = [];
  const redoStack = [];

  function push(before, after, label = "編集") {
    if (JSON.stringify(before) === JSON.stringify(after)) return false;
    undoStack.push({ before: clone(before), after: clone(after), label });
    if (undoStack.length > limit) undoStack.splice(0, undoStack.length - limit);
    redoStack.length = 0;
    return true;
  }

  function pushImmutable(before, after, label = "編集") {
    if (before === after) return false;
    undoStack.push({ before, after, label });
    if (undoStack.length > limit) undoStack.splice(0, undoStack.length - limit);
    redoStack.length = 0;
    return true;
  }

  function undo(current) {
    const entry = undoStack.pop();
    if (!entry) return null;
    redoStack.push({ ...entry, after: clone(current) });
    return clone(entry.before);
  }

  function redo(current) {
    const entry = redoStack.pop();
    if (!entry) return null;
    undoStack.push({ ...entry, before: clone(current) });
    return clone(entry.after);
  }

  function clear() {
    undoStack.length = 0;
    redoStack.length = 0;
  }

  return {
    push,
    pushImmutable,
    undo,
    redo,
    clear,
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    sizes: () => ({ undo: undoStack.length, redo: redoStack.length })
  };
}
