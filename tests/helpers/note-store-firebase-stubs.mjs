const state = {
  transactionCount: 0,
  afterTransactionCommit: () => {}
};

export function resetFirebaseStubs({ afterTransactionCommit = () => {} } = {}) {
  state.transactionCount = 0;
  state.afterTransactionCommit = afterTransactionCommit;
}

const reference = parts => ({ path: parts.join("/"), parts });
const snapshotFor = target => {
  const isPage = target.parts.includes("pages");
  return {
    exists: () => true,
    data: () => isPage
      ? { contentRevision: 0, noteMaskCount: 0, deletedAt: null }
      : { status: "ready", pendingStoragePaths: [], noteMaskCount: 0, deletedAt: null }
  };
};

export const arrayRemove = (...values) => ({ values });
export const collection = (_db, ...parts) => reference(parts);
export const doc = (_db, ...parts) => reference(parts);
export const getDoc = async target => snapshotFor(target);
export const getDocs = async () => ({ docs: [] });
export const increment = value => ({ value });
export const query = target => target;
export const serverTimestamp = () => ({ serverTimestamp: true });
export const setDoc = async () => {};
export const updateDoc = async () => {};
export const where = (...values) => ({ values });
export const writeBatch = () => ({
  commit: async () => {},
  delete: () => {},
  set: () => {},
  update: () => {}
});

export async function runTransaction(_db, updateFunction) {
  const transaction = {
    get: async target => snapshotFor(target),
    set: () => {},
    update: () => {}
  };
  const result = await updateFunction(transaction);
  state.transactionCount += 1;
  state.afterTransactionCommit(state.transactionCount);
  return result;
}

export const deleteObject = async () => {};
export const getBlob = async () => new Blob(["{}"], { type: "application/json" });
export const ref = (_storage, path) => ({ path });
export const uploadBytes = async () => {};
