// Summary notes (revision 15): pages of other notes placed 2, 4 or 6 to a
// page. A summary page shows its source pages as one image (the background,
// drawn without masks) and their masks as its own note masks, so that they
// can be shown, hidden, moved and underlined there like any other mask.
// These functions hold no state; js/features/study-notes.js reads and writes
// the notes.

export const SUMMARY_VERSION = 1;
// A4 portrait at 300 dpi: the composite stays below the 10 MP that PDF pages
// are converted with (js/core/pdf-converter.js) and keeps a page placed six to
// a page readable when zoomed.
export const SUMMARY_PAGE_SIZE = Object.freeze({ width: 2480, height: 3508 });
export const SUMMARY_PER_PAGE_OPTIONS = Object.freeze([2, 4, 6]);
// The share of each place kept free on its right for handwritten memos.
export const SUMMARY_MEMO_RATIOS = Object.freeze({ none: 0, narrow: 0.25, wide: 0.4 });
export const SUMMARY_DEFAULT_OPTIONS = Object.freeze({ perPage: 4, memo: "narrow" });
export const SUMMARY_MAX_SOURCE_PAGES = 60;

const GRIDS = Object.freeze({
  2: Object.freeze({ columns: 1, rows: 2 }),
  4: Object.freeze({ columns: 2, rows: 2 }),
  6: Object.freeze({ columns: 2, rows: 3 })
});
// Shares of the page width.
const PAGE_MARGIN = 0.03;
const GUTTER = 0.02;
const LABEL_FONT = 0.012;
const LABEL_BAND = LABEL_FONT * 1.7;

const round = value => Math.round(Number(value) * 1e6) / 1e6;
const clamp01 = value => Math.min(1, Math.max(0, Number(value) || 0));

export function normalizeSummaryOptions(options = {}) {
  const perPage = SUMMARY_PER_PAGE_OPTIONS.includes(Number(options.perPage))
    ? Number(options.perPage)
    : SUMMARY_DEFAULT_OPTIONS.perPage;
  const memo = Object.hasOwn(SUMMARY_MEMO_RATIOS, options.memo) ? options.memo : SUMMARY_DEFAULT_OPTIONS.memo;
  return { perPage, memo };
}

export function isSummaryNote(note) {
  return Boolean(note?.summary && typeof note.summary === "object");
}

export function isSummaryPage(page) {
  return Array.isArray(page?.summary?.slots);
}

export function summaryRefKey(noteId, pageId) {
  return `${noteId}/${pageId}`;
}

// The notes and pages that the summary pages show (kept on the summary note,
// so that a source page used by a summary is not deleted).
export function summarySourceRefs(pages = []) {
  const noteIds = new Set();
  const pageRefs = new Set();
  pages.forEach(page => (Array.isArray(page?.summary?.slots) ? page.summary.slots : []).forEach(slot => {
    if (!slot?.noteId || !slot?.pageId) return;
    noteIds.add(slot.noteId);
    pageRefs.add(summaryRefKey(slot.noteId, slot.pageId));
  }));
  return { noteIds: [...noteIds].sort(), pageRefs: [...pageRefs].sort() };
}

export function chunkSummaryItems(items = [], perPage = SUMMARY_DEFAULT_OPTIONS.perPage) {
  const size = normalizeSummaryOptions({ perPage }).perPage;
  const chunks = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

// Where the `index`th page of a summary page goes, in shares of the summary
// page: `cell` is its place, `label` the line naming it, `rect` the source
// page itself (its aspect ratio kept, in the top left of what the label and
// the memo space leave).
export function summarySlotGeometry({ perPage, memo, index, sourceSize, pageSize = SUMMARY_PAGE_SIZE }) {
  const options = normalizeSummaryOptions({ perPage, memo });
  const grid = GRIDS[options.perPage];
  const width = Number(pageSize?.width) || SUMMARY_PAGE_SIZE.width;
  const height = Number(pageSize?.height) || SUMMARY_PAGE_SIZE.height;
  const margin = PAGE_MARGIN * width;
  const gutter = GUTTER * width;
  const cellWidth = (width - margin * 2 - gutter * (grid.columns - 1)) / grid.columns;
  const cellHeight = (height - margin * 2 - gutter * (grid.rows - 1)) / grid.rows;
  const position = Math.max(0, Math.min(options.perPage - 1, Math.trunc(Number(index) || 0)));
  const column = position % grid.columns;
  const row = Math.floor(position / grid.columns);
  const cellX = margin + column * (cellWidth + gutter);
  const cellY = margin + row * (cellHeight + gutter);
  const labelBand = LABEL_BAND * width;
  const memoRatio = SUMMARY_MEMO_RATIOS[options.memo];
  const availableWidth = cellWidth * (1 - memoRatio) - (memoRatio > 0 ? gutter / 2 : 0);
  const availableHeight = cellHeight - labelBand;
  const sourceWidth = Number(sourceSize?.width) > 0 ? Number(sourceSize.width) : 1240;
  const sourceHeight = Number(sourceSize?.height) > 0 ? Number(sourceSize.height) : 1754;
  const scale = Math.min(availableWidth / sourceWidth, availableHeight / sourceHeight);
  const toShares = (x, y, w, h) => ({ x: round(x / width), y: round(y / height), width: round(w / width), height: round(h / height) });
  return {
    cell: toShares(cellX, cellY, cellWidth, cellHeight),
    label: { x: round(cellX / width), y: round(cellY / height), fontSize: round(LABEL_FONT), band: round(labelBand / height) },
    rect: toShares(cellX, cellY + labelBand, sourceWidth * scale, sourceHeight * scale)
  };
}

// The summary pages for `items` ({ noteId, pageId, size, label }, in order):
// each a list of slots. `createId` names each slot.
export function buildSummaryLayout(items = [], options = {}, { createId, pageSize = SUMMARY_PAGE_SIZE } = {}) {
  if (typeof createId !== "function") throw new TypeError("まとめの配置にはIDの作成関数が必要です。");
  const normalized = normalizeSummaryOptions(options);
  return chunkSummaryItems(items, normalized.perPage).map(chunk => ({
    perPage: normalized.perPage,
    memo: normalized.memo,
    slots: chunk.map((item, index) => {
      const geometry = summarySlotGeometry({ ...normalized, index, sourceSize: item.size, pageSize });
      return {
        slotId: createId(),
        index,
        noteId: String(item.noteId),
        pageId: String(item.pageId),
        label: String(item.label || "").slice(0, 120),
        sourceSize: { width: Number(item.size?.width) || 1240, height: Number(item.size?.height) || 1754 },
        cell: geometry.cell,
        rect: geometry.rect
      };
    })
  }));
}

export function summarySlotLabel(noteTitle, pageNumber) {
  const title = String(noteTitle || "無題ノート").trim() || "無題ノート";
  return Number(pageNumber) > 0 ? `${title}  p.${Number(pageNumber)}` : title;
}

// Bounds given in shares of a source page, in shares of the summary page.
export function placeSourceBounds(bounds, rect) {
  const width = Math.max(1e-6, clamp01(bounds?.width) * Number(rect.width));
  const height = Math.max(1e-6, clamp01(bounds?.height) * Number(rect.height));
  const x = Math.min(clamp01(Number(rect.x) + clamp01(bounds?.x) * Number(rect.width)), 1 - width);
  const y = Math.min(clamp01(Number(rect.y) + clamp01(bounds?.y) * Number(rect.height)), 1 - height);
  return { x: round(Math.max(0, x)), y: round(Math.max(0, y)), width: round(width), height: round(height) };
}

function geometryKey(mask) {
  return [mask.x, mask.y, mask.width, mask.height].map(value => round(value).toFixed(6)).join(",");
}

// The masks of a source page as the summary inherits them: the note's own
// masks and, for a page of an image material, the material's masks.
export function summarySourceMaskEntries(content = {}, materialMasks = []) {
  const entries = [];
  const keys = new Set();
  const add = (mask, kind) => {
    if (!mask || !(Number(mask.width) > 0) || !(Number(mask.height) > 0)) return;
    const id = String(mask.id || "");
    const key = `${kind}:${id || `geo:${geometryKey(mask)}`}`;
    if (keys.has(key)) return;
    keys.add(key);
    entries.push({
      key,
      kind,
      x: clamp01(mask.x),
      y: clamp01(mask.y),
      width: clamp01(mask.width),
      height: clamp01(mask.height),
      weak: mask.weak === true,
      underline: mask.underline === true
    });
  };
  (Array.isArray(materialMasks) ? materialMasks : []).forEach(mask => add(mask, "material"));
  (Array.isArray(content?.noteMasks) ? content.noteMasks : []).forEach(mask => add(mask, "note"));
  return entries;
}

function maskSnapshot(entry) {
  return {
    x: round(entry.x),
    y: round(entry.y),
    width: round(entry.width),
    height: round(entry.height),
    weak: entry.weak === true,
    underline: entry.underline === true
  };
}

function sameSnapshot(left, right) {
  if (!left || !right) return false;
  return ["x", "y", "width", "height"].every(field => round(left[field]) === round(right[field])) &&
    (left.weak === true) === (right.weak === true) &&
    (left.underline === true) === (right.underline === true);
}

// A stable, short fingerprint of a JSON value (two 32-bit FNV-1a hashes).
export function summaryFingerprint(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  let first = 0x811c9dc5;
  let second = 0x01000193 ^ text.length;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x5bd1e995) >>> 0;
    second ^= second >>> 15;
  }
  return `${first.toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

export function summaryMaskId(slotId, key) {
  return `sm-${slotId}-${summaryFingerprint(key)}`;
}

export function createInheritedMask(slot, entry) {
  return {
    id: summaryMaskId(slot.slotId, entry.key),
    ...placeSourceBounds(entry, slot.rect),
    weak: entry.weak === true,
    underline: entry.underline === true,
    origin: { slotId: slot.slotId, key: entry.key, source: maskSnapshot(entry) }
  };
}

export function isInheritedMask(mask) {
  return Boolean(mask?.origin?.slotId && mask.origin.key);
}

// A copy of a mask that is the summary's own (a duplicated or pasted
// inherited mask no longer follows its source).
export function withoutMaskOrigin(mask) {
  if (!mask || typeof mask !== "object" || !("origin" in mask)) return mask;
  const { origin: _origin, ...rest } = mask;
  return rest;
}

// What a summary keeps of an inherited mask it deleted, so that updating
// from the source does not bring it back while the source keeps it as it was.
export function inheritedMaskTombstone(mask) {
  if (!isInheritedMask(mask)) return null;
  return { slotId: mask.origin.slotId, key: mask.origin.key, source: mask.origin.source || null };
}

export function addInheritedMaskTombstones(content, masks = []) {
  const tombstones = masks.map(inheritedMaskTombstone).filter(Boolean);
  if (!tombstones.length) return content;
  const existing = Array.isArray(content.summaryRemovedMasks) ? content.summaryRemovedMasks : [];
  const keys = new Set(tombstones.map(item => `${item.slotId}|${item.key}`));
  content.summaryRemovedMasks = [
    ...existing.filter(item => !keys.has(`${item?.slotId}|${item?.key}`)),
    ...tombstones
  ];
  return content;
}

// The masks of one slot brought up to date with its source page (decision
// of revision 15: the source note wins). A mask whose source did not change
// keeps what the summary did to it (moved, resized, underlined, made weak);
// a mask changed in the source is placed again from the source; a mask
// deleted in the source goes; a new one comes. A mask the summary deleted
// stays deleted until the source changes it. Everything else on the page
// (the summary's own masks and writing) is kept as it is.
export function mergeSummarySlotMasks(content = {}, slot, entries = []) {
  const masks = Array.isArray(content.noteMasks) ? content.noteMasks : [];
  const removed = Array.isArray(content.summaryRemovedMasks) ? content.summaryRemovedMasks : [];
  const sources = new Map(entries.map(entry => [entry.key, entry]));
  const handled = new Set();
  const noteMasks = [];
  masks.forEach(mask => {
    if (mask?.origin?.slotId !== slot.slotId) {
      noteMasks.push(mask);
      return;
    }
    const source = sources.get(mask.origin.key);
    if (!source || handled.has(source.key)) return;
    handled.add(source.key);
    const snapshot = maskSnapshot(source);
    if (sameSnapshot(mask.origin.source, snapshot)) {
      noteMasks.push(mask);
      return;
    }
    // Placed again from the source: what the summary had kept as its own
    // (revision 16) no longer applies.
    const { summaryLocal: _kept, ...placed } = mask;
    noteMasks.push({
      ...placed,
      ...placeSourceBounds(source, slot.rect),
      weak: source.weak === true,
      underline: source.underline === true,
      origin: { ...mask.origin, source: snapshot }
    });
  });
  const summaryRemovedMasks = [];
  removed.forEach(item => {
    if (item?.slotId !== slot.slotId) {
      summaryRemovedMasks.push(item);
      return;
    }
    const source = sources.get(item.key);
    if (!source || handled.has(source.key)) return;
    if (sameSnapshot(item.source, maskSnapshot(source))) {
      handled.add(source.key);
      summaryRemovedMasks.push(item);
    }
  });
  entries.forEach(entry => {
    if (handled.has(entry.key)) return;
    handled.add(entry.key);
    noteMasks.push(createInheritedMask(slot, entry));
  });
  return { ...content, noteMasks, summaryRemovedMasks };
}

// The page without the masks of a slot taken out of the summary.
export function removeSummarySlotFromContent(content = {}, slotId) {
  return {
    ...content,
    noteMasks: (Array.isArray(content.noteMasks) ? content.noteMasks : []).filter(mask => mask?.origin?.slotId !== slotId),
    summaryRemovedMasks: (Array.isArray(content.summaryRemovedMasks) ? content.summaryRemovedMasks : []).filter(item => item?.slotId !== slotId)
  };
}

// ---- Reflecting a summary's changes in its sources (revision 16) ----
//
// The summary's changes to the masks of its source pages are not written
// to the sources until the user reflects them ("元ノートに反映"). A change
// is: an inherited mask moved, resized, underlined or made weak; an
// inherited mask deleted; a mask made in the summary on a source page. Masks
// of image materials are not reflected (they are edited in 教材管理). A
// change the user keeps in the summary ("まとめだけの変更") is not asked
// about again until it changes again.

// Shares of the summary page within which a mask is where its source put it
// (the drag of a mask moves it much further).
const SAME_PLACE = 1e-5;

function sameBounds(left, right, tolerance = SAME_PLACE) {
  return ["x", "y", "width", "height"].every(field => Math.abs(Number(left?.[field] || 0) - Number(right?.[field] || 0)) <= tolerance);
}

function summaryMaskState(mask) {
  return [round(mask?.x), round(mask?.y), round(mask?.width), round(mask?.height), mask?.weak === true, mask?.underline === true];
}

function summaryMaskStateFingerprint(mask) {
  return summaryFingerprint(summaryMaskState(mask));
}

function keptAsSummaryOwn(mask) {
  return typeof mask?.summaryLocal === "string" && mask.summaryLocal === summaryMaskStateFingerprint(mask);
}

// The id of the source mask a key names: a note mask with an id only.
export function summarySourceMaskId(key) {
  const text = String(key || "");
  return text.startsWith("note:") && !text.startsWith("note:geo:") ? text.slice(5) : "";
}

// A summary mask in shares of the source page placed at `rect`: the part of
// it on that page, or null when less than half of it is on the page.
export function summarySourceBounds(mask, rect) {
  const left = Math.max(Number(mask?.x || 0), Number(rect.x));
  const top = Math.max(Number(mask?.y || 0), Number(rect.y));
  const right = Math.min(Number(mask?.x || 0) + Number(mask?.width || 0), Number(rect.x) + Number(rect.width));
  const bottom = Math.min(Number(mask?.y || 0) + Number(mask?.height || 0), Number(rect.y) + Number(rect.height));
  const area = Number(mask?.width || 0) * Number(mask?.height || 0);
  if (!(right > left) || !(bottom > top) || !(area > 0)) return null;
  if ((right - left) * (bottom - top) < area * 0.5) return null;
  const width = clamp01((right - left) / Number(rect.width));
  const height = clamp01((bottom - top) / Number(rect.height));
  return {
    x: round(Math.min(clamp01((left - Number(rect.x)) / Number(rect.width)), 1 - width)),
    y: round(Math.min(clamp01((top - Number(rect.y)) / Number(rect.height)), 1 - height)),
    width: round(width),
    height: round(height)
  };
}

// The slot that more than half of a mask lies on, or null (the memo space).
export function summarySlotUnderMask(slots = [], mask) {
  let best = null;
  let bestShare = 0.5;
  (Array.isArray(slots) ? slots : []).forEach(slot => {
    const bounds = slot?.rect ? summarySourceBounds(mask, slot.rect) : null;
    if (!bounds) return;
    const share = (bounds.width * slot.rect.width * bounds.height * slot.rect.height) / (Number(mask.width) * Number(mask.height));
    if (share >= bestShare) {
      best = slot;
      bestShare = share;
    }
  });
  return best;
}

// How an inherited mask differs from the source state it took, or null.
function inheritedMaskDifference(mask, slot) {
  const source = mask?.origin?.source;
  if (!source || !slot?.rect) return null;
  const place = !sameBounds(mask, placeSourceBounds(source, slot.rect));
  const weak = (mask.weak === true) !== (source.weak === true);
  const underline = (mask.underline === true) !== (source.underline === true);
  return place || weak || underline ? { place, weak, underline } : null;
}

function changeBase(kind, page, slot, identity) {
  return {
    id: `${kind}|${page.pageId}|${slot.slotId}|${identity}`,
    kind,
    pageId: page.pageId,
    slotId: slot.slotId,
    noteId: String(slot.noteId || ""),
    sourcePageId: String(slot.pageId || ""),
    label: String(slot.label || "")
  };
}

// The changes of one summary page not reflected in its sources (and not
// kept as the summary's own), in page order.
export function summaryPendingChanges(page, content = {}) {
  const slots = Array.isArray(page?.summary?.slots) ? page.summary.slots : [];
  if (!slots.length) return [];
  const slotsById = new Map(slots.map(slot => [slot.slotId, slot]));
  const changes = [];
  (Array.isArray(content.noteMasks) ? content.noteMasks : []).forEach(mask => {
    if (!mask || keptAsSummaryOwn(mask)) return;
    if (isInheritedMask(mask)) {
      const slot = slotsById.get(mask.origin.slotId);
      const sourceMaskId = summarySourceMaskId(mask.origin.key);
      if (!slot || !sourceMaskId) return;
      const difference = inheritedMaskDifference(mask, slot);
      if (!difference) return;
      const bounds = difference.place ? summarySourceBounds(mask, slot.rect) : {
        x: round(mask.origin.source.x), y: round(mask.origin.source.y),
        width: round(mask.origin.source.width), height: round(mask.origin.source.height)
      };
      // Moved off its source page: the summary's own place for it.
      if (!bounds) return;
      changes.push({
        ...changeBase("update", page, slot, mask.id),
        maskId: String(mask.id),
        key: mask.origin.key,
        sourceMaskId,
        snapshot: mask.origin.source,
        bounds,
        weak: mask.weak === true,
        underline: mask.underline === true,
        details: difference
      });
      return;
    }
    const slot = summarySlotUnderMask(slots, mask);
    const bounds = slot ? summarySourceBounds(mask, slot.rect) : null;
    if (!slot || !bounds) return;
    changes.push({
      ...changeBase("add", page, slot, mask.id),
      maskId: String(mask.id),
      bounds,
      weak: mask.weak === true,
      underline: mask.underline === true
    });
  });
  (Array.isArray(content.summaryRemovedMasks) ? content.summaryRemovedMasks : []).forEach(tombstone => {
    const slot = slotsById.get(tombstone?.slotId);
    const sourceMaskId = summarySourceMaskId(tombstone?.key);
    if (!slot || !sourceMaskId || tombstone.local === true) return;
    changes.push({
      ...changeBase("delete", page, slot, tombstone.key),
      key: tombstone.key,
      sourceMaskId,
      snapshot: tombstone.source || null
    });
  });
  return changes;
}

export function describeSummaryChange(change) {
  if (change?.kind === "delete") return "マスクを削除";
  if (change?.kind === "add") return "まとめで作ったマスクを追加";
  const parts = [];
  if (change?.details?.place) parts.push("位置・大きさ");
  if (change?.details?.underline) parts.push(change.underline ? "下線を付けた" : "下線を外した");
  if (change?.details?.weak) parts.push(change.weak ? "苦手にした" : "苦手を外した");
  return `マスクを変更（${parts.join("、") || "変更"}）`;
}

// The changes kept as the summary's own: not asked about again until the
// mask changes again (a deletion: until the source changes the mask).
export function keepSummaryChangesLocal(content = {}, changes = []) {
  const next = {
    ...content,
    noteMasks: (Array.isArray(content.noteMasks) ? content.noteMasks : []).map(mask => ({ ...mask })),
    summaryRemovedMasks: (Array.isArray(content.summaryRemovedMasks) ? content.summaryRemovedMasks : []).map(item => ({ ...item }))
  };
  (Array.isArray(changes) ? changes : []).forEach(change => {
    if (change.kind === "delete") {
      next.summaryRemovedMasks.forEach(item => {
        if (item.slotId === change.slotId && item.key === change.key) item.local = true;
      });
      return;
    }
    const mask = next.noteMasks.find(item => String(item.id) === change.maskId);
    if (mask) mask.summaryLocal = summaryMaskStateFingerprint(mask);
  });
  return next;
}

function sourceMaskSnapshot(mask) {
  return maskSnapshot({
    x: clamp01(mask?.x), y: clamp01(mask?.y), width: clamp01(mask?.width), height: clamp01(mask?.height),
    weak: mask?.weak === true, underline: mask?.underline === true
  });
}

// A source page's content with `changes` (of its masks) made. A change to a
// mask that the source changed or deleted since the summary took it is not
// made (the source wins, as in mergeSummarySlotMasks). `applied` gives each
// mask added in the source its id.
export function applySummaryChangesToSource(sourceContent = {}, changes = [], { createId } = {}) {
  if (typeof createId !== "function") throw new TypeError("元ノートへの反映にはIDの作成関数が必要です。");
  const masks = (Array.isArray(sourceContent.noteMasks) ? sourceContent.noteMasks : []).map(mask => ({ ...mask }));
  const applied = [];
  const skipped = [];
  (Array.isArray(changes) ? changes : []).forEach(change => {
    if (change.kind === "add") {
      const id = String(createId());
      masks.push({ id, ...change.bounds, weak: change.weak === true, underline: change.underline === true });
      applied.push({ ...change, sourceMaskId: id });
      return;
    }
    const index = masks.findIndex(mask => String(mask?.id || "") === change.sourceMaskId);
    if (index < 0) {
      if (change.kind === "delete") applied.push(change);
      else skipped.push({ change, reason: "removed" });
      return;
    }
    if (change.snapshot && !sameSnapshot(change.snapshot, sourceMaskSnapshot(masks[index]))) {
      skipped.push({ change, reason: "changed" });
      return;
    }
    if (change.kind === "delete") {
      masks.splice(index, 1);
      applied.push(change);
      return;
    }
    masks[index] = { ...masks[index], ...change.bounds, weak: change.weak === true, underline: change.underline === true };
    applied.push(change);
  });
  return { content: { ...sourceContent, noteMasks: masks }, applied, skipped };
}

// The summary page once `applied` changes were made in their sources: its
// masks follow the sources' new state (a mask added there becomes an
// inherited mask), and reflected deletions are no longer remembered.
export function summaryContentAfterReflect(content = {}, page, applied = []) {
  const slots = new Map((Array.isArray(page?.summary?.slots) ? page.summary.slots : []).map(slot => [slot.slotId, slot]));
  const next = {
    ...content,
    noteMasks: (Array.isArray(content.noteMasks) ? content.noteMasks : []).map(mask => ({ ...mask })),
    summaryRemovedMasks: (Array.isArray(content.summaryRemovedMasks) ? content.summaryRemovedMasks : []).map(item => ({ ...item }))
  };
  (Array.isArray(applied) ? applied : []).forEach(change => {
    const slot = slots.get(change.slotId);
    if (!slot || change.pageId !== page.pageId) return;
    if (change.kind === "delete") {
      next.summaryRemovedMasks = next.summaryRemovedMasks.filter(item => !(item.slotId === change.slotId && item.key === change.key));
      return;
    }
    const mask = next.noteMasks.find(item => String(item.id) === change.maskId);
    if (!mask) return;
    const source = maskSnapshot({ ...change.bounds, weak: change.weak === true, underline: change.underline === true });
    Object.assign(mask, placeSourceBounds(source, slot.rect), { weak: source.weak, underline: source.underline });
    mask.origin = { slotId: slot.slotId, key: change.kind === "add" ? `note:${change.sourceMaskId}` : change.key, source };
    delete mask.summaryLocal;
  });
  return next;
}

// The summary's own changes (kept, or not reflected yet) to the masks of a
// slot that updating from `entries` replaces: masks the summary changed and
// the source changed too (or deleted), and deleted masks the source changed.
export function countSummaryMergeConflicts(content = {}, slot, entries = []) {
  const sources = new Map((Array.isArray(entries) ? entries : []).map(entry => [entry.key, entry]));
  let count = 0;
  (Array.isArray(content.noteMasks) ? content.noteMasks : []).forEach(mask => {
    if (mask?.origin?.slotId !== slot.slotId) return;
    const entry = sources.get(mask.origin.key);
    if (entry && sameSnapshot(mask.origin.source, maskSnapshot(entry))) return;
    if (inheritedMaskDifference(mask, slot)) count += 1;
  });
  (Array.isArray(content.summaryRemovedMasks) ? content.summaryRemovedMasks : []).forEach(item => {
    if (item?.slotId !== slot.slotId) return;
    const entry = sources.get(item.key);
    if (entry && !sameSnapshot(item.source, maskSnapshot(entry))) count += 1;
  });
  return count;
}

const BACKGROUND_KEY_FIELDS = ["type", "paperColor", "ruleType", "ruleSpacingRatio", "ruleColor", "ruleOpacity", "ruleWidthRatio", "imagePath", "sourcePageNumber", "pdfRotation", "materialId", "materialPage"];

function backgroundKey(page) {
  const background = page?.background || {};
  return Object.fromEntries(BACKGROUND_KEY_FIELDS.map(field => [field, background[field] ?? null]));
}

// Changes when anything a slot shows may have changed: read from the page
// document (and the material) only, so that unchanged pages are not loaded.
export function summarySourceKey({ page, materialSource = "", materialMasks = [] } = {}) {
  return summaryFingerprint({
    revision: Number(page?.contentRevision || 0),
    hash: String(page?.contentHash || ""),
    size: { width: Number(page?.size?.width || 0), height: Number(page?.size?.height || 0) },
    background: backgroundKey(page),
    materialSource: String(materialSource || ""),
    materialMasks: (Array.isArray(materialMasks) ? materialMasks : []).map(mask => [String(mask.id || ""), round(mask.x), round(mask.y), round(mask.width), round(mask.height), mask.weak === true])
  });
}

// Changes when the picture of a slot (the page without its masks) changes.
export function summaryInkKey({ page, content, materialSource = "" } = {}) {
  return summaryFingerprint({
    size: { width: Number(page?.size?.width || 0), height: Number(page?.size?.height || 0) },
    background: backgroundKey(page),
    materialSource: String(materialSource || ""),
    elements: Array.isArray(content?.elements) ? content.elements : []
  });
}
