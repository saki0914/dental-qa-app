let documents = new Map();
let reads = [];

export function resetCloudStoreFirebaseStubs(values = {}) {
  documents = new Map(Object.entries(values));
  reads = [];
}

export function getCloudStoreReadPaths() {
  return [...reads];
}

export const doc = (_db, ...parts) => ({ path: parts.join("/") });

export async function getDoc(reference) {
  reads.push(reference.path);
  const value = documents.get(reference.path);
  return {
    exists: () => value !== undefined && value !== null,
    data: () => value
  };
}

export async function runTransaction(_db, updateFunction) {
  return updateFunction({
    get: getDoc,
    set: () => {},
    update: () => {}
  });
}

export const serverTimestamp = () => ({ serverTimestamp: true });
