export async function resolveNoteConflicts(conflicts, { decide, resolve }) {
  if (typeof decide !== "function" || typeof resolve !== "function") {
    throw new TypeError("競合解決処理が不足しています。");
  }
  const queued = Array.isArray(conflicts) ? [...conflicts] : [];
  for (const [index, conflict] of queued.entries()) {
    const context = { index, total: queued.length };
    const useLocal = await decide(conflict, context);
    await resolve(conflict, useLocal === true, context);
  }
  return queued.length;
}
