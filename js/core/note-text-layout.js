// Shared text layout for the editor overlay, the SVG page renderer and the
// Canvas (thumbnail / PDF) renderer. Every surface must derive line breaks,
// line boxes and baselines from these functions so that what is typed in the
// editor is what is drawn on the page and exported to PDF.

export const NOTE_TEXT_FONT_STACKS = Object.freeze({
  "system-sans": "\"Hiragino Sans\", \"Hiragino Kaku Gothic ProN\", \"Noto Sans JP\", \"Noto Sans CJK JP\", \"Yu Gothic\", YuGothic, Meiryo, sans-serif",
  "system-serif": "\"Hiragino Mincho ProN\", \"Noto Serif JP\", \"Noto Serif CJK JP\", \"Yu Mincho\", YuMincho, serif",
  monospace: "ui-monospace, SFMono-Regular, Menlo, Consolas, \"Noto Sans Mono CJK JP\", monospace"
});

// Tabs are expanded to a fixed width everywhere (editor uses tab-size: 4).
const TAB_REPLACEMENT = "    ";
// Minimum editor font size that keeps iPad Safari from auto-zooming on focus.
export const NOTE_TEXT_EDITOR_MIN_FONT_PX = 16;
// A text box narrower than this (page-width ratio) is treated as an accidental
// drag and created with the default width instead.
export const NOTE_TEXT_MIN_DRAG_WIDTH = 0.04;
export const NOTE_TEXT_MIN_BOX_WIDTH = 0.08;
export const NOTE_TEXT_DEFAULT_BOX = Object.freeze({ width: 0.35, height: 0.12 });

// Characters that must not start a line and characters that must not end
// one: the CSS `line-break: normal` rules for Japanese, which the editor uses
// too (small kana and "ー" may start a line in normal mode, unlike strict,
// which browsers implement inconsistently).
const LINE_START_PROHIBITED = new Set(Array.from(
  "、。，．,.：；:;？！?!゛゜ヽヾゝゞ々〻‐-゠–〜～…‥）］｝〕〉》」』】〙〗〟’”｠»)]}" +
  "・％%‰℃°′″｡､･｣"
));
const LINE_END_PROHIBITED = new Set(Array.from("（［｛〔〈《「『【〘〖〝‘“｟«([{｢￥＄"));

export function noteTextGenericFamily(fontFamily) {
  return fontFamily === "system-serif" ? "serif" : fontFamily === "monospace" ? "monospace" : "sans-serif";
}

export function noteTextFontStack(fontFamily) {
  return NOTE_TEXT_FONT_STACKS[fontFamily] || NOTE_TEXT_FONT_STACKS["system-sans"];
}

export function noteTextCanvasFont(style = {}, fontSizePx = 16) {
  const size = Math.max(0.1, Number(fontSizePx) || 16);
  return `${style.fontStyle === "italic" ? "italic" : "normal"} ${style.fontWeight === "bold" ? "bold" : "normal"} ${size}px ${noteTextFontStack(style.fontFamily)}`;
}

// Prepares a Canvas 2D context to measure or draw note text. Kerning is off on
// every surface (the editor and SVG text use `font-kerning: none`): Chrome's
// DOM kerns some kana pairs that its Canvas never kerns, so leaving it on
// would let the editor wrap differently from the page.
export function setNoteTextCanvasFont(context, style = {}, fontSizePx = 16) {
  context.font = noteTextCanvasFont(style, fontSizePx);
  if ("fontKerning" in context) context.fontKerning = "none";
  return context;
}

let graphemeSegmenter;
function graphemes(text) {
  const value = String(text ?? "");
  if (graphemeSegmenter === undefined) {
    graphemeSegmenter = typeof Intl?.Segmenter === "function"
      ? new Intl.Segmenter("ja", { granularity: "grapheme" })
      : null;
  }
  return graphemeSegmenter
    ? Array.from(graphemeSegmenter.segment(value), part => part.segment)
    : Array.from(value);
}

function isBreakableCjk(grapheme) {
  const code = grapheme.codePointAt(0) || 0;
  return (code >= 0x1100 && code <= 0x11ff) ||
    (code >= 0x2e80 && code <= 0x2fff) ||
    (code >= 0x3000 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa960 && code <= 0xa97f) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xffef) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3ffff);
}

function lastGrapheme(text) {
  const parts = graphemes(text);
  return parts[parts.length - 1] || "";
}

// Splits a paragraph into units that must stay on one line. Break
// opportunities exist between units: after spaces, around CJK characters and
// after hyphens, except where Japanese line-breaking rules forbid them.
export function textLayoutUnits(paragraph) {
  const units = [];
  let word = "";
  const flushWord = () => {
    if (!word) return;
    units.push({ text: word, kind: "word" });
    word = "";
  };
  for (const grapheme of graphemes(paragraph)) {
    if (grapheme === " ") {
      flushWord();
      const previous = units[units.length - 1];
      if (previous?.kind === "space") previous.text += grapheme;
      else units.push({ text: grapheme, kind: "space" });
      continue;
    }
    if (isBreakableCjk(grapheme)) {
      flushWord();
      units.push({ text: grapheme, kind: "cjk" });
      continue;
    }
    word += grapheme;
    if (grapheme === "-" || grapheme === "‐") flushWord();
  }
  flushWord();
  const merged = [];
  for (const unit of units) {
    const previous = merged[merged.length - 1];
    if (previous && previous.kind !== "space" && unit.kind !== "space" && (
      LINE_START_PROHIBITED.has(graphemes(unit.text)[0]) ||
      LINE_END_PROHIBITED.has(lastGrapheme(previous.text))
    )) {
      previous.text += unit.text;
      previous.kind = "word";
      continue;
    }
    merged.push({ ...unit });
  }
  return merged;
}

function layoutParagraph(paragraph, width, measure) {
  if (!paragraph) return [""];
  // Browsers snap text advances to layout units (1/64 px), so a line that
  // measures a hair over the box in Canvas still fits in the editor.
  const tolerance = Math.max(0.01, width * 5e-5);
  // Trailing spaces hang past the line end (CSS white-space: pre-wrap), so
  // they never force a break.
  const fits = text => measure(text.replace(/ +$/u, "")) <= width + tolerance;
  const lines = [];
  let line = "";
  for (const unit of textLayoutUnits(paragraph)) {
    if (unit.kind === "space") {
      line += unit.text;
      continue;
    }
    const candidate = line + unit.text;
    if (fits(candidate)) {
      line = candidate;
      continue;
    }
    if (line) {
      lines.push(line);
      line = "";
      if (fits(unit.text)) {
        line = unit.text;
        continue;
      }
    }
    // A single unit wider than the box breaks between any graphemes
    // (overflow-wrap: anywhere). Like the browsers' emergency break this
    // ignores kinsoku, so "）" or "、" may start the continuation line.
    for (const grapheme of graphemes(unit.text)) {
      const next = line + grapheme;
      if (line && !fits(next)) {
        lines.push(line);
        line = grapheme;
      } else {
        line = next;
      }
    }
  }
  lines.push(line);
  return lines;
}

// Chrome kerns adjacent fullwidth punctuation (e.g. "」、" becomes 1.5em) in
// Canvas text and in DOM text with the default `text-spacing-trim: normal`.
// The editor and the SVG page use `space-all`, so widths are measured (and
// Canvas draws) per segment split between such pairs. Engines without this
// kerning, such as Safari, measure the same either way.
const PUNCTUATION_SPACING_CHARACTERS = new Set(Array.from(
  "「」『』（）［］｛｝〔〕〈〉《》【】〘〙〖〗〝〟｟｠‘’“”、。，．：；・"
));

export function punctuationSpacingSegments(text) {
  const value = String(text ?? "");
  let segments = null;
  let start = 0;
  for (let index = 1; index < value.length; index += 1) {
    if (PUNCTUATION_SPACING_CHARACTERS.has(value[index]) && PUNCTUATION_SPACING_CHARACTERS.has(value[index - 1])) {
      (segments ||= []).push(value.slice(start, index));
      start = index;
    }
  }
  if (!segments) return [value];
  segments.push(value.slice(start));
  return segments;
}

// Line breaking measures every font size at one reference size and scales
// the result. Glyph advances of small, hinted sizes are not proportional, so
// measuring at the drawn size let the page, its thumbnail, the PDF and the
// (minimum 16px) editor wrap the same text differently.
export const NOTE_TEXT_REFERENCE_FONT_PX = 100;

// Width function for layoutTextLines backed by a Canvas 2D context. It sets
// the context to the reference font; callers that draw with the same context
// set the drawing font again after layout.
export function createNoteTextMeasure(context, style = {}, fontSizePx = 16) {
  const scale = Math.max(0.1, Number(fontSizePx) || 16) / NOTE_TEXT_REFERENCE_FONT_PX;
  setNoteTextCanvasFont(context, style, NOTE_TEXT_REFERENCE_FONT_PX);
  const referenceFont = context.font;
  const cache = new Map();
  return value => {
    const text = String(value ?? "");
    const cached = cache.get(text);
    if (cached !== undefined) return cached;
    if (context.font !== referenceFont) setNoteTextCanvasFont(context, style, NOTE_TEXT_REFERENCE_FONT_PX);
    let width = 0;
    for (const segment of punctuationSpacingSegments(text)) width += context.measureText(segment).width;
    width *= scale;
    cache.set(text, width);
    return width;
  };
}

export function layoutTextLines(text, maxWidth, measureText) {
  const width = Math.max(1, Number(maxWidth) || 1);
  const measure = typeof measureText === "function" ? measureText : value => String(value).length;
  const normalized = String(text ?? "").replace(/\r\n?/g, "\n").replace(/\t/g, TAB_REPLACEMENT);
  const lines = [];
  for (const paragraph of normalized.split("\n")) lines.push(...layoutParagraph(paragraph, width, measure));
  return lines.length ? lines : [""];
}

// The text as laid out (line breaks normalized, tabs expanded) with, for each
// of its UTF-16 code units, the index of the code unit of `text` it came from.
function laidOutTextWithSourceIndices(text) {
  const source = String(text ?? "");
  let normalized = "";
  const indices = [];
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\r") {
      if (source[index + 1] === "\n") continue;
      normalized += "\n";
      indices.push(index);
    } else if (character === "\t") {
      normalized += TAB_REPLACEMENT;
      for (let count = 0; count < TAB_REPLACEMENT.length; count += 1) indices.push(index);
    } else {
      normalized += character;
      indices.push(index);
    }
  }
  return { normalized, indices };
}

// The same lines as layoutTextLines, each with the index into `text` of every
// code unit of the line (`sourceIndices`), so that parts of a line can be
// traced back to the characters they show (for example their colors).
export function layoutTextLineRanges(text, maxWidth, measureText) {
  const width = Math.max(1, Number(maxWidth) || 1);
  const measure = typeof measureText === "function" ? measureText : value => String(value).length;
  const { normalized, indices } = laidOutTextWithSourceIndices(text);
  const lines = [];
  let offset = 0;
  for (const paragraph of normalized.split("\n")) {
    for (const line of layoutParagraph(paragraph, width, measure)) {
      lines.push({ text: line, sourceIndices: indices.slice(offset, offset + line.length) });
      offset += line.length;
    }
    // The line break itself.
    offset += 1;
  }
  return lines.length ? lines : [{ text: "", sourceIndices: [] }];
}

// Colors of parts of a text (revision 12). A text element may carry
// `textColors: { length, runs: [{ start, end, color }] }`: runs of UTF-16
// offsets into `text`, in order and not overlapping, each with a "#rrggbb"
// color. Characters outside every run have the element's `style.color`. The
// runs apply only while `length` is the length of the text: a build that does
// not know them may change the text, and then the text falls back to its one
// color instead of coloring the wrong characters.
export const NOTE_TEXT_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

export function textElementColorRuns(element) {
  const text = String(element?.text ?? "");
  const colors = element?.textColors;
  if (!colors || typeof colors !== "object" || colors.length !== text.length || !Array.isArray(colors.runs)) return [];
  const runs = [];
  let previousEnd = 0;
  for (const run of colors.runs) {
    const start = Number(run?.start);
    const end = Number(run?.end);
    const color = String(run?.color ?? "");
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < previousEnd || end <= start || end > text.length) continue;
    if (!NOTE_TEXT_COLOR_PATTERN.test(color)) continue;
    runs.push({ start, end, color: color.toLowerCase() });
    previousEnd = end;
  }
  return runs;
}

// The color of each code unit of `text` (null: the base color).
export function textCharacterColors(length, runs = []) {
  const colors = new Array(Math.max(0, Number(length) || 0)).fill(null);
  for (const run of runs) {
    for (let index = Math.max(0, run.start); index < Math.min(colors.length, run.end); index += 1) colors[index] = run.color;
  }
  return colors;
}

// The visible part of a laid-out line (see layoutTextLineRanges) split where
// its color changes. Graphemes are never split.
export function textLineColorSegments(line, characterColors, baseColor) {
  const visible = renderableTextLine(line?.text);
  const segments = [];
  let offset = 0;
  for (const grapheme of graphemes(visible)) {
    const sourceIndex = line.sourceIndices?.[offset];
    const color = characterColors?.[sourceIndex] || baseColor;
    const last = segments[segments.length - 1];
    if (last && last.color === color) last.text += grapheme;
    else segments.push({ text: grapheme, color });
    offset += grapheme.length;
  }
  return segments;
}

// The box of what a text element shows (revision 12): its lines, as wide as
// the widest line (plus a little room, so that the same lines fit again), in
// page ratios. `softWrapped` tells whether the box width broke a line.
export function measureTextContentBox(element, { pageWidth = 1000, pageHeight = 1414, measureText }) {
  const bounds = element?.bounds || { x: 0, y: 0, width: 0, height: 0 };
  const style = element?.style || {};
  const fontSize = Math.max(8, Number(style.fontSizeRatio || .025) * pageHeight);
  const boxWidth = Math.max(1, Number(bounds.width || 0) * pageWidth);
  const measure = typeof measureText === "function" ? measureText : value => String(value).length;
  const lines = layoutTextLines(element?.text, boxWidth, measure);
  const hardLineCount = String(element?.text ?? "").replace(/\r\n?/g, "\n").split("\n").length;
  const widest = lines.reduce((width, line) => Math.max(width, measure(renderableTextLine(line))), 0);
  const contentWidth = Math.min(boxWidth, widest + Math.max(2, fontSize * .1));
  const align = style.textAlign === "center" || style.textAlign === "right" ? style.textAlign : "left";
  const offset = align === "center" ? (boxWidth - contentWidth) / 2 : align === "right" ? boxWidth - contentWidth : 0;
  const lineHeight = fontSize * Number(style.lineHeight || 1.25);
  const y = Number(bounds.y || 0);
  return {
    x: Number(bounds.x || 0) + offset / pageWidth,
    y,
    width: contentWidth / pageWidth,
    height: Math.min(Math.max(.001, 1 - y), lines.length * lineHeight / pageHeight),
    softWrapped: lines.length > hardLineCount
  };
}

// The text element with its box fitted to what it shows, so that its frame
// and the area that picks it are no larger than its text (revision 12). The
// lines break where they did. A rotated text keeps its box (it turns around
// the box's center).
export function fitTextElementToContent(element, options) {
  if (element?.type !== "text" || !element.bounds || !String(element.text ?? "").length) return element;
  if (Math.abs(Number(element.rotation || 0) % 360) > 0.001) return element;
  const content = measureTextContentBox(element, options);
  const bounds = {
    x: Math.min(1, Math.max(0, content.x)),
    y: Math.min(1, Math.max(0, content.y)),
    width: Math.max(.001, Math.min(Number(element.bounds.width), content.width)),
    height: content.height
  };
  bounds.width = Math.min(bounds.width, 1 - bounds.x);
  const same = ["x", "y", "width", "height"].every(key => Math.abs(Number(element.bounds[key]) - bounds[key]) < 1e-6);
  return same ? element : { ...element, bounds, autoHeight: true };
}

// Trailing spaces hang outside the line box; they must not shift centered or
// right-aligned text, so renderers draw lines without them.
export function renderableTextLine(line) {
  return String(line ?? "").replace(/ +$/u, "");
}

export function visibleTextLines(text, { maxWidth, maxHeight, lineHeight, measureText }) {
  const lines = layoutTextLines(text, maxWidth, measureText);
  const maximumLines = Math.max(0, Math.floor((Number(maxHeight) || 0) / Math.max(1, Number(lineHeight) || 1)));
  return lines.slice(0, maximumLines);
}

export function layoutTextBox(text, {
  maxWidth,
  lineHeight,
  measureText,
  paddingTop = 0,
  paddingBottom = 0
}) {
  const lines = layoutTextLines(text, maxWidth, measureText);
  const normalizedLineHeight = Math.max(1, Number(lineHeight) || 1);
  return {
    lines,
    lineHeight: normalizedLineHeight,
    requiredHeight: Math.max(normalizedLineHeight, Number(paddingTop) + lines.length * normalizedLineHeight + Number(paddingBottom))
  };
}

// Font ascent/descent of the primary font, used to place baselines exactly
// where CSS places them inside a line box (half-leading model).
export function measureTextFontMetrics(context, fontSize) {
  const size = Math.max(0.1, Number(fontSize) || 16);
  let metrics = null;
  try { metrics = context?.measureText?.("M") || null; } catch { metrics = null; }
  const ascent = Number(metrics?.fontBoundingBoxAscent);
  const descent = Number(metrics?.fontBoundingBoxDescent);
  if (Number.isFinite(ascent) && ascent > 0 && Number.isFinite(descent) && descent >= 0 && ascent + descent < size * 4) {
    return { ascent, descent };
  }
  return { ascent: size * 0.88, descent: size * 0.12 };
}

export function textLineBaselineOffset({ lineHeight, ascent, descent }) {
  const height = Math.max(0, Number(lineHeight) || 0);
  return (height - (Number(ascent) + Number(descent))) / 2 + Number(ascent);
}

export function textLineBaselines(lineCount, { top = 0, lineHeight, ascent, descent }) {
  const offset = textLineBaselineOffset({ lineHeight, ascent, descent });
  return Array.from({ length: Math.max(0, lineCount) }, (_, index) => Number(top) + index * Number(lineHeight) + offset);
}

export function ensureTextElementHeight(element, { pageWidth = 1000, pageHeight = 1414, measureText }) {
  if (!element?.bounds || element.type !== "text") return element;
  const style = element.style || {};
  const fontSize = Math.max(8, Number(style.fontSizeRatio || .025) * pageHeight);
  const layout = layoutTextBox(element.text, {
    maxWidth: Math.max(1, Number(element.bounds.width || 0) * pageWidth),
    lineHeight: fontSize * Number(style.lineHeight || 1.25),
    measureText
  });
  const availableHeight = Math.max(0, Math.min(1, 1 - Number(element.bounds.y || 0)));
  const targetHeight = Math.min(
    availableHeight,
    Math.max(Number(element.bounds.height || 0), layout.requiredHeight / pageHeight)
  );
  if (Number(element.bounds.height || 0) === targetHeight) return element;
  return {
    ...element,
    autoHeight: element.autoHeight !== false,
    bounds: { ...element.bounds, height: targetHeight }
  };
}

// Resolves the text box created by a text-tool gesture. A tiny drag (a tap
// with Pencil jitter) keeps the default box instead of producing a box so
// narrow that every character would wrap onto its own line.
export function resolveTextBoxFromGesture(start, end, {
  minimumDragWidth = NOTE_TEXT_MIN_DRAG_WIDTH,
  minimumWidth = NOTE_TEXT_MIN_BOX_WIDTH,
  defaultBox = NOTE_TEXT_DEFAULT_BOX
} = {}) {
  const clampUnit = value => Math.min(1, Math.max(0, Number(value) || 0));
  const startX = clampUnit(start?.x);
  const startY = clampUnit(start?.y);
  const endX = clampUnit(end?.x ?? startX);
  const endY = clampUnit(end?.y ?? startY);
  const dragWidth = Math.abs(endX - startX);
  const dragHeight = Math.abs(endY - startY);
  if (dragWidth < minimumDragWidth) {
    const width = Math.min(1, defaultBox.width);
    const height = Math.min(1, Math.max(defaultBox.height, dragHeight));
    return {
      x: Math.min(startX, 1 - width),
      y: Math.min(Math.min(startY, endY), 1 - height),
      width,
      height,
      dragged: false
    };
  }
  const width = Math.min(1, Math.max(minimumWidth, dragWidth));
  const height = Math.min(1, Math.max(0.04, dragHeight));
  return {
    x: Math.min(Math.min(startX, endX), 1 - width),
    y: Math.min(Math.min(startY, endY), 1 - height),
    width,
    height,
    dragged: true
  };
}
