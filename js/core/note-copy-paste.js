// The notes' clipboard (revision 17). 「コピー」 keeps the chosen writing,
// text, shapes, images and masks of a page on this device, so that another
// page, or another note (each note opens in a tab of its own), can paste
// them. The items live in an IndexedDB database of their own; a small marker
// in localStorage tells every open tab at once that there is something to
// paste (its "storage" event). Without IndexedDB the items stay in this tab
// only.

import { clamp, clampBounds, lineEndpoints, normalizeLineElement } from "./note-geometry.js";

export const NOTE_CLIPBOARD_VERSION = 1;
export const NOTE_CLIPBOARD_MAX_ITEMS = 2000;
const DB_NAME = "dentalQaNoteClipboard";
const STORE = "clipboard";
// The share of the page a paste onto the page it was copied from moves by,
// so that the copy does not hide the original.
export const NOTE_CLIPBOARD_SAME_PAGE_OFFSET = 0.025;

export function noteClipboardMarkerKey(uid) {
  return `dentalQaNoteClipboard:${uid}`;
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("端末内のコピーを読み書きできませんでした。"));
  });
}

export function createNoteClipboard({ indexedDB = globalThis.indexedDB, storage = globalThis.localStorage } = {}) {
  let databasePromise = null;
  // What this tab copied last. `shared`: kept on the device with its marker,
  // which then says whether it is still there (another tab may have copied
  // something else, or cleared it); otherwise only this tab has it.
  let memory = null;

  function openDatabase() {
    if (!indexedDB?.open) return Promise.reject(new Error("この端末ではコピーを保存できません。"));
    databasePromise ||= new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("端末内のコピーを開けませんでした。"));
      request.onblocked = () => reject(new Error("端末内のコピーを開けませんでした（別のタブが使用中です）。"));
    }).catch(error => {
      databasePromise = null;
      throw error;
    });
    return databasePromise;
  }

  async function run(mode, operate) {
    const database = await openDatabase();
    const transaction = database.transaction(STORE, mode);
    const done = new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error("端末内のコピーの保存が中断されました。"));
    });
    // A failed request fails the transaction too; its error is the request's.
    done.catch(() => {});
    const result = await requestResult(operate(transaction.objectStore(STORE)));
    await done;
    return result;
  }

  function writeMarker(uid, record) {
    try {
      storage?.setItem?.(noteClipboardMarkerKey(uid), JSON.stringify({
        id: record.id, count: record.items.length, createdAt: record.createdAt, sourceNoteId: record.sourceNoteId
      }));
      return true;
    } catch {
      return false;
    }
  }

  // Keeps `record` as the clipboard of `uid`. Resolves whether other tabs and
  // notes can paste it (false: only this tab).
  async function write(uid, record) {
    if (!uid || !record?.id) throw new TypeError("コピーする内容がありません。");
    memory = { uid, record, shared: false };
    try {
      await run("readwrite", store => store.put(record, uid));
    } catch (error) {
      console.warn("コピーを端末内に保存できなかったため、このタブの中でだけ貼り付けられます。", error);
      try { storage?.removeItem?.(noteClipboardMarkerKey(uid)); } catch {}
      return false;
    }
    const shared = writeMarker(uid, record);
    if (memory?.record === record) memory.shared = shared;
    return shared;
  }

  function storedMarker(uid) {
    try {
      const marker = JSON.parse(storage?.getItem?.(noteClipboardMarkerKey(uid)) || "null");
      return marker?.id && Number(marker.count) > 0 ? marker : null;
    } catch {
      return null;
    }
  }

  // What this or another tab copied last, or null.
  function peek(uid) {
    if (!uid) return null;
    const marker = storedMarker(uid);
    if (marker) return marker;
    if (memory?.uid !== uid || memory.shared) return null;
    return { id: memory.record.id, count: memory.record.items.length, createdAt: memory.record.createdAt, sourceNoteId: memory.record.sourceNoteId };
  }

  async function read(uid) {
    const marker = peek(uid);
    if (!marker) return null;
    if (memory?.uid === uid && memory.record.id === marker.id) return memory.record;
    try {
      const record = await run("readonly", store => store.get(uid));
      return record?.version === NOTE_CLIPBOARD_VERSION && Array.isArray(record.items) && record.items.length ? record : null;
    } catch (error) {
      console.warn("端末内のコピーを読み込めませんでした。", error);
      return null;
    }
  }

  async function clear(uid) {
    if (memory?.uid === uid) memory = null;
    try { storage?.removeItem?.(noteClipboardMarkerKey(uid)); } catch {}
    try {
      await run("readwrite", store => store.delete(uid));
    } catch (error) {
      console.warn("端末内のコピーを消せませんでした。", error);
    }
  }

  return { write, read, peek, clear, markerKey: noteClipboardMarkerKey };
}

// Where copied items go on a page (shares of that page). On any other page
// they keep their place and their shape: a page of another aspect ratio keeps
// the items' width share and scales their height share so that circles stay
// circles; items that would not fit are made smaller as a whole and kept
// inside the page. On the page they came from they move a little, and so do
// further pastes onto the same page (`repeat`: the pastes made there before),
// so that a copy does not hide what is under it.
export function clipboardPlacement(bounds, { sourceSize, targetSize, samePage = false, repeat = 0 } = {}) {
  const box = {
    x: clamp(bounds?.x), y: clamp(bounds?.y),
    width: Math.max(0.001, Number(bounds?.width) || 0.001), height: Math.max(0.001, Number(bounds?.height) || 0.001)
  };
  const sourceWidth = Number(sourceSize?.width) > 0 ? Number(sourceSize.width) : 1;
  const sourceHeight = Number(sourceSize?.height) > 0 ? Number(sourceSize.height) : 1;
  const targetWidth = Number(targetSize?.width) > 0 ? Number(targetSize.width) : sourceWidth;
  const targetHeight = Number(targetSize?.height) > 0 ? Number(targetSize.height) : sourceHeight;
  let aspect = samePage ? 1 : (sourceHeight / sourceWidth) / (targetHeight / targetWidth);
  // The same paper (A4 portrait and A4 portrait in other pixels) is the same.
  if (Math.abs(aspect - 1) < 0.005) aspect = 1;
  const fit = Math.min(1, 1 / box.width, 1 / (box.height * aspect));
  const width = box.width * fit;
  const height = box.height * aspect * fit;
  const pastes = Math.max(0, Math.trunc(Number(repeat) || 0));
  const steps = samePage ? (pastes % 4) + 1 : pastes % 4;
  const offset = NOTE_CLIPBOARD_SAME_PAGE_OFFSET * steps;
  return {
    from: box,
    x: clamp(box.x + offset, 0, Math.max(0, 1 - width)),
    y: clamp(box.y + offset, 0, Math.max(0, 1 - height)),
    scaleX: fit,
    scaleY: aspect * fit,
    fit,
    aspect,
    sourceSize: { width: sourceWidth, height: sourceHeight }
  };
}

function placePoint(point, placement) {
  return {
    ...point,
    x: clamp(placement.x + (Number(point.x) - placement.from.x) * placement.scaleX),
    y: clamp(placement.y + (Number(point.y) - placement.from.y) * placement.scaleY)
  };
}

function placeBounds(bounds, placement) {
  const center = placePoint({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }, placement);
  const width = Math.min(1, bounds.width * placement.scaleX);
  const height = Math.min(1, bounds.height * placement.scaleY);
  return clampBounds({ x: center.x - width / 2, y: center.y - height / 2, width, height });
}

const scaled = (value, factor, fallback) => Number(value ?? fallback) * factor;

// One copied item (an element or a note mask) placed by `placement` on a page
// of `targetSize`. Line widths follow the page width and font sizes the page
// height, as the renderer draws them.
export function placeClipboardItem(item, placement, targetSize) {
  const copy = structuredClone(item);
  if (!copy?.type) {
    const bounds = placeBounds({ x: Number(copy.x), y: Number(copy.y), width: Number(copy.width), height: Number(copy.height) }, placement);
    return { ...copy, ...bounds };
  }
  if (copy.type === "shape" && ["line", "arrow"].includes(copy.shapeType)) {
    const [start, end] = lineEndpoints(copy, placement.sourceSize || targetSize).map(point => placePoint(point, placement));
    const line = normalizeLineElement({ ...copy, start, end }, targetSize);
    if (line.style && line.style.strokeWidthRatio != null) line.style.strokeWidthRatio = scaled(line.style.strokeWidthRatio, placement.fit, 0.002);
    return line;
  }
  if (["stroke", "highlighter"].includes(copy.type) && Array.isArray(copy.points)) {
    copy.points = copy.points.map(point => placePoint(point, placement));
    if (copy.style?.widthRatio != null) copy.style.widthRatio = scaled(copy.style.widthRatio, placement.fit, 0.0025);
    return copy;
  }
  if (copy.bounds) {
    copy.bounds = placeBounds(copy.bounds, placement);
    if (copy.type === "text" && copy.style?.fontSizeRatio != null) {
      copy.style.fontSizeRatio = Math.min(1, scaled(copy.style.fontSizeRatio, placement.scaleY, 0.025));
    }
    if (copy.type === "shape" && copy.style?.strokeWidthRatio != null) {
      copy.style.strokeWidthRatio = scaled(copy.style.strokeWidthRatio, placement.fit, 0.002);
    }
  }
  return copy;
}
