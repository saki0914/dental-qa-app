// Colors of parts of a text while it is written (revision 12). The editor
// keeps one entry per UTF-16 code unit of its value: a "#rrggbb" color, or
// null for the text's base color (`style.color`). The stored form is the
// `textColors` runs described in note-text-layout.js.
import { NOTE_TEXT_COLOR_PATTERN } from "./note-text-layout.js";

const normalizeColor = value => {
  const color = String(value ?? "");
  return NOTE_TEXT_COLOR_PATTERN.test(color) ? color.toLowerCase() : null;
};

// Where the editor value changed from `before` to `after`: the removed and
// inserted code units at `start`. Typing a character equal to its neighbor
// is ambiguous ("aa" to "aaa"); the caret after the change (`caret`) tells
// where it went.
export function textValueChange(before, after, { caret = null } = {}) {
  const previous = String(before ?? "");
  const next = String(after ?? "");
  const shortest = Math.min(previous.length, next.length);
  let prefix = 0;
  while (prefix < shortest && previous[prefix] === next[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < shortest - prefix && previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix += 1;
  let start = prefix;
  const removed = previous.length - prefix - suffix;
  const inserted = next.length - prefix - suffix;
  if (Number.isInteger(caret) && (inserted > 0 || removed > 0)) {
    const wanted = caret - inserted;
    // The change can slide left over equal characters; keep the place that
    // ends at the caret when it describes the same change.
    if (wanted >= 0 && wanted < start &&
        previous.slice(0, wanted) === next.slice(0, wanted) &&
        previous.slice(wanted + removed) === next.slice(wanted + inserted)) {
      start = wanted;
    }
  }
  return { start, removed, inserted };
}

// The character colors after the editor value changed. Inserted text takes,
// in order: the color chosen for the caret where it is inserted
// (`pendingColor` at `pendingAt`), the color of the first character it
// replaces, the color of the character before it, or the color of the
// character after it (at the very start of the text).
export function applyTextValueChange(colors, before, after, {
  caret = null,
  pendingColor = null,
  pendingAt = -1
} = {}) {
  const current = Array.isArray(colors) ? colors : [];
  const change = textValueChange(before, after, { caret });
  const { start, removed, inserted } = change;
  let color = null;
  let usedPending = false;
  if (inserted > 0) {
    const pending = normalizeColor(pendingColor);
    if (pending && pendingAt === start) {
      color = pending;
      usedPending = true;
    } else if (removed > 0) color = current[start] ?? null;
    else if (start > 0) color = current[start - 1] ?? null;
    else color = current[start] ?? null;
  }
  const next = [
    ...current.slice(0, start),
    ...new Array(inserted).fill(color),
    ...current.slice(start + removed)
  ];
  // Keep the array exactly as long as the value, whatever happened before.
  const length = String(after ?? "").length;
  if (next.length > length) next.length = length;
  while (next.length < length) next.push(null);
  return { colors: next, change, usedPending };
}

// Colors the code units from `start` to `end` (a selection).
export function setTextColorRange(colors, start, end, color) {
  const next = [...(Array.isArray(colors) ? colors : [])];
  const value = normalizeColor(color);
  const from = Math.max(0, Math.min(Number(start) || 0, Number(end) || 0));
  const to = Math.min(next.length, Math.max(Number(start) || 0, Number(end) || 0));
  for (let index = from; index < to; index += 1) next[index] = value;
  return next;
}

// The color at the caret: of the character before it (or after it at the
// start of the text).
export function textColorAtCaret(colors, caret, baseColor) {
  const index = Number(caret) > 0 ? Number(caret) - 1 : 0;
  return normalizeColor(colors?.[index]) || normalizeColor(baseColor) || "#111111";
}

// Consecutive characters of one color, for drawing the text being written.
export function textColorSegments(text, colors, baseColor) {
  const value = String(text ?? "");
  const base = normalizeColor(baseColor) || "#111111";
  const segments = [];
  for (let index = 0; index < value.length; index += 1) {
    const color = normalizeColor(colors?.[index]) || base;
    const last = segments[segments.length - 1];
    if (last && last.color === color) last.text += value[index];
    else segments.push({ text: value[index], color });
  }
  return segments;
}

// The stored form of the colors of `text`: the base color and the runs that
// differ from it. When every character has one color, that color becomes the
// base color and no runs are stored, so a one-color text keeps the form of
// earlier revisions.
export function textColorsForStorage(text, colors, baseColor) {
  const value = String(text ?? "");
  const base = normalizeColor(baseColor) || "#111111";
  const resolved = Array.from({ length: value.length }, (_, index) => normalizeColor(colors?.[index]) || base);
  if (!resolved.length) return { color: base, textColors: null };
  if (resolved.every(color => color === resolved[0])) return { color: resolved[0], textColors: null };
  const runs = [];
  resolved.forEach((color, index) => {
    if (color === base) return;
    const last = runs[runs.length - 1];
    if (last && last.end === index && last.color === color) last.end = index + 1;
    else runs.push({ start: index, end: index + 1, color });
  });
  return { color: base, textColors: { length: value.length, runs } };
}
