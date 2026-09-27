import { randomId } from "./id.js";

export const NOTE_EDITOR_LEASE_TTL_MS = 8_000;
export const NOTE_EDITOR_HEARTBEAT_MS = 2_000;
export const NOTE_EDITOR_CLAIM_CONFIRM_MS = 180;

function parseLease(raw) {
  try {
    const value = JSON.parse(raw || "null");
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

export function compareNoteEditorLeasePriority(left, right) {
  const epochDifference = Number(left?.epoch || 0) - Number(right?.epoch || 0);
  if (epochDifference) return epochDifference;
  const sessionDifference = String(left?.writerSessionId || "").localeCompare(String(right?.writerSessionId || ""));
  if (sessionDifference) return sessionDifference;
  return String(left?.editorTabId || "").localeCompare(String(right?.editorTabId || ""));
}

export function noteEditorLeaseKey(uid, noteId) {
  return `dentalQaNoteEditorLease:${uid}:${noteId}`;
}

export function getOrCreateNoteClientInstanceId(storage, uid) {
  const key = `dentalQaNoteClientInstance:${uid}`;
  let value = storage?.getItem?.(key) || "";
  if (!value) {
    value = randomId();
    storage?.setItem?.(key, value);
  }
  return value;
}

export function createNoteEditorLease({
  uid,
  noteId,
  editorTabId = randomId(),
  clientInstanceId,
  storage = globalThis.localStorage,
  channelFactory = name => typeof BroadcastChannel === "function" ? new BroadcastChannel(name) : null,
  now = () => Date.now(),
  wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  setIntervalFn = globalThis.setInterval?.bind(globalThis),
  clearIntervalFn = globalThis.clearInterval?.bind(globalThis),
  addStorageListener = listener => globalThis.addEventListener?.("storage", listener),
  removeStorageListener = listener => globalThis.removeEventListener?.("storage", listener),
  ttlMs = NOTE_EDITOR_LEASE_TTL_MS,
  heartbeatMs = NOTE_EDITOR_HEARTBEAT_MS,
  claimConfirmMs = NOTE_EDITOR_CLAIM_CONFIRM_MS,
  onOwnershipLost = () => {}
}) {
  if (!uid || !noteId || !clientInstanceId) throw new TypeError("編集ロックの識別子が不足しています。");
  const key = noteEditorLeaseKey(uid, noteId);
  const channel = channelFactory?.(`dental-qa-note-editor:${uid}:${noteId}`) || null;
  let writerSessionId = "";
  let ownedLease = null;
  let timer = null;
  let disposed = false;
  let claiming = false;

  const read = () => parseLease(storage?.getItem?.(key));
  const isLive = lease => Boolean(lease?.expiresAt > now());
  const owns = lease => Boolean(writerSessionId && lease?.writerSessionId === writerSessionId && lease?.editorTabId === editorTabId);

  function publish(type, lease = read()) {
    try { channel?.postMessage?.({ type, lease, sentAt: now() }); }
    catch (error) { console.warn("編集ロック通知に失敗しました。", error); }
  }

  function stopHeartbeat() {
    if (timer !== null) clearIntervalFn?.(timer);
    timer = null;
  }

  function loseOwnership(lease, { notify = true } = {}) {
    if (!writerSessionId) return;
    stopHeartbeat();
    writerSessionId = "";
    ownedLease = null;
    claiming = false;
    if (notify) onOwnershipLost(lease || null);
  }

  function writeLease(lease = ownedLease) {
    if (!lease || disposed || !writerSessionId) return null;
    const current = read();
    if (isLive(current) && !owns(current) && compareNoteEditorLeasePriority(current, lease) > 0) return null;
    const refreshed = {
      ...lease,
      updatedAt: now(),
      expiresAt: now() + ttlMs
    };
    ownedLease = refreshed;
    storage?.setItem?.(key, JSON.stringify(refreshed));
    publish(claiming ? "claim" : "lease", refreshed);
    return owns(read()) ? refreshed : null;
  }

  function observe(lease) {
    if (!writerSessionId || !isLive(lease) || owns(lease)) return;
    if (!ownedLease || compareNoteEditorLeasePriority(lease, ownedLease) > 0) {
      loseOwnership(lease);
      return;
    }
    if (compareNoteEditorLeasePriority(ownedLease, lease) > 0 && !writeLease(ownedLease)) {
      loseOwnership(read());
    }
  }

  const storageListener = event => { if (event.key === key) observe(parseLease(event.newValue)); };
  const channelListener = event => observe(event?.data?.lease);
  addStorageListener?.(storageListener);
  if (channel) channel.addEventListener?.("message", channelListener);

  function startHeartbeat() {
    stopHeartbeat();
    timer = setIntervalFn?.(() => {
      if (disposed || !writerSessionId || !ownedLease) return;
      const current = read();
      if (owns(current) || !isLive(current)) {
        if (!writeLease(ownedLease)) loseOwnership(read());
      } else {
        observe(current);
      }
    }, heartbeatMs);
  }

  async function claim({ force = false } = {}) {
    if (disposed) throw new Error("破棄済みの編集ロックです。");
    const current = read();
    if (!force && isLive(current) && current.editorTabId !== editorTabId) {
      return { acquired: false, lease: current };
    }

    stopHeartbeat();
    writerSessionId = randomId();
    claiming = true;
    ownedLease = {
      schemaVersion: 1,
      uid,
      noteId,
      clientInstanceId,
      editorTabId,
      writerSessionId,
      epoch: Number(current?.epoch || 0) + 1,
      updatedAt: now(),
      expiresAt: now() + ttlMs
    };
    if (!writeLease(ownedLease)) {
      const winner = read();
      loseOwnership(winner, { notify: false });
      return { acquired: false, lease: winner };
    }

    await wait(Math.max(0, claimConfirmMs));
    if (disposed || !writerSessionId) return { acquired: false, lease: read() };
    const confirmed = read();
    if (!owns(confirmed) || compareNoteEditorLeasePriority(confirmed, ownedLease) !== 0) {
      loseOwnership(confirmed, { notify: false });
      return { acquired: false, lease: confirmed };
    }
    claiming = false;
    ownedLease = confirmed;
    startHeartbeat();
    publish("acquired", confirmed);
    return { acquired: true, lease: confirmed };
  }

  function release() {
    stopHeartbeat();
    const current = read();
    if (owns(current)) {
      storage?.removeItem?.(key);
      publish("released", null);
    }
    writerSessionId = "";
    ownedLease = null;
    claiming = false;
  }

  function dispose() {
    if (disposed) return;
    release();
    disposed = true;
    removeStorageListener?.(storageListener);
    channel?.removeEventListener?.("message", channelListener);
    channel?.close?.();
  }

  return {
    claim,
    takeover: () => claim({ force: true }),
    release,
    dispose,
    read,
    isWriter: () => owns(read()),
    getIdentity: () => ({ clientInstanceId, editorTabId, writerSessionId })
  };
}
