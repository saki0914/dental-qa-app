const state = {
  transactionCount: 0,
  transactionCallCount: 0,
  pageDataForTransaction: () => ({}),
  afterTransactionCommit: () => {},
  noteData: {},
  uploads: [],
  updates: []
};

export function resetFirebaseStubs({
  afterTransactionCommit = () => {},
  pageDataForTransaction = () => ({}),
  noteData = {}
} = {}) {
  state.transactionCount = 0;
  state.transactionCallCount = 0;
  state.pageDataForTransaction = pageDataForTransaction;
  state.afterTransactionCommit = afterTransactionCommit;
  state.noteData = noteData;
  state.uploads = [];
  state.updates = [];
}

export const firebaseStubCalls = () => ({ uploads: [...state.uploads], updates: [...state.updates] });

const reference = parts => ({ path: parts.join("/"), parts });
const snapshotFor = (target, transactionCall = 0) => {
  const isPage = target.parts.includes("pages");
  return {
    exists: () => true,
    data: () => isPage
      ? {
          contentRevision: 0,
          noteMaskCount: 0,
          deletedAt: null,
          ...state.pageDataForTransaction(transactionCall)
        }
      : { status: "ready", pendingStoragePaths: [], noteMaskCount: 0, deletedAt: null, ...state.noteData }
  };
};

export const arrayRemove = (...values) => ({ values });
export const arrayUnion = (...values) => ({ union: values });
export const collection = (_db, ...parts) => reference(parts);
export const doc = (_db, ...parts) => reference(parts);
export const getDoc = async target => snapshotFor(target);
export const getDocs = async () => ({ docs: [] });
export const increment = value => ({ value });
export const query = target => target;
export const serverTimestamp = () => ({ serverTimestamp: true });
export const setDoc = async () => {};
export const updateDoc = async (target, fields) => { state.updates.push({ path: target.path, fields }); };
export const where = (...values) => ({ values });
export const writeBatch = () => ({
  commit: async () => {},
  delete: () => {},
  set: () => {},
  update: () => {}
});

export async function runTransaction(_db, updateFunction) {
  const transactionCall = ++state.transactionCallCount;
  const transaction = {
    get: async target => snapshotFor(target, transactionCall),
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
export const uploadBytes = async target => { state.uploads.push(target.path); };
