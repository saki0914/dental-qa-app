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
    noteMasks.push({
      ...mask,
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
