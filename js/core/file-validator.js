export const MAX_NOTE_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_NOTE_IMAGE_WIDTH = 8192;
export const MAX_NOTE_IMAGE_HEIGHT = 8192;
export const MAX_NOTE_IMAGE_PIXELS = 40_000_000;
export const MAX_NOTE_JSON_BYTES = 2 * 1024 * 1024;

export const NOTE_IMAGE_MIME_TYPES = Object.freeze([
  "image/png",
  "image/webp",
  "image/jpeg"
]);

export function assertNonEmptyBlob(blob, label = "ファイル") {
  if (!(blob instanceof Blob)) throw new TypeError(`${label}を読み込めません。`);
  if (!Number.isFinite(blob.size) || blob.size <= 0) {
    throw new Error(`${label}が0バイトです。保存を停止しました。`);
  }
  return blob;
}

export function validateImageBlob(blob, options = {}) {
  const {
    label = "画像ファイル",
    allowedTypes = NOTE_IMAGE_MIME_TYPES,
    maxBytes = MAX_NOTE_IMAGE_BYTES
  } = options;
  assertNonEmptyBlob(blob, label);
  const mimeType = String(blob.type || "").toLowerCase();
  if (!allowedTypes.includes(mimeType)) {
    throw new Error(`${label}の形式に対応していません。PNG、JPEG、WebPを使用してください。`);
  }
  if (blob.size > maxBytes) {
    throw new Error(`${label}が上限${Math.round(maxBytes / 1024 / 1024)}MBを超えています。`);
  }
  return blob;
}

export async function hasPdfSignature(file) {
  assertNonEmptyBlob(file, "PDFファイル");
  const signature = new Uint8Array(await file.slice(0, 5).arrayBuffer());
  return signature.length === 5 && String.fromCharCode(...signature) === "%PDF-";
}

export async function validatePdfFile(file) {
  assertNonEmptyBlob(file, "PDFファイル");
  if (!await hasPdfSignature(file)) {
    throw new Error("選択されたファイルはPDFとして読み込めません。拡張子ではなく内容を確認してください。");
  }
  return file;
}

export function canvasToVerifiedBlob(canvas, type = "image/jpeg", quality = 0.92, label = "画像") {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      try {
        resolve(assertNonEmptyBlob(blob, label));
      } catch (error) {
        reject(error);
      }
    }, type, quality);
  });
}

export function serializeValidatedJson(value, expected = {}, { strict = true } = {}) {
  const json = JSON.stringify(value);
  if (!json) throw new Error("保存用JSONを作成できませんでした。");
  const blob = assertNonEmptyBlob(
    new Blob([json], { type: "application/json" }),
    "ページ内容JSON"
  );
  if (blob.size > MAX_NOTE_JSON_BYTES) {
    throw new Error(`ページ内容JSONが上限${MAX_NOTE_JSON_BYTES / 1024 / 1024}MBを超えています。`);
  }
  const parsed = JSON.parse(json);
  if (!Number.isInteger(parsed.schemaVersion)) throw new Error("ページ内容JSONにschemaVersionがありません。");
  if (expected.noteId && parsed.noteId !== expected.noteId) throw new Error("ページ内容JSONのnoteIdが一致しません。");
  if (expected.pageId && parsed.pageId !== expected.pageId) throw new Error("ページ内容JSONのpageIdが一致しません。");
  if (!Array.isArray(parsed.elements)) throw new Error("ページ内容JSONのelementsが配列ではありません。");
  if (!Array.isArray(parsed.noteMasks)) throw new Error("ページ内容JSONのnoteMasksが配列ではありません。");
  assertFiniteJson(parsed);
  validateNormalizedNoteContent(parsed, { strict });
  return { json, blob, parsed };
}

function assertNormalized(value, path, { positive = false } = {}) {
  if (!Number.isFinite(value) || value < (positive ? Number.EPSILON : 0) || value > 1) {
    throw new Error(`${path}は0〜1の正規化座標で指定してください。`);
  }
}

function validateBounds(bounds, path, { allowZeroSize = false } = {}) {
  if (!bounds || typeof bounds !== "object") throw new Error(`${path}がありません。`);
  assertNormalized(bounds.x, `${path}.x`);
  assertNormalized(bounds.y, `${path}.y`);
  assertNormalized(bounds.width, `${path}.width`, { positive: !allowZeroSize });
  assertNormalized(bounds.height, `${path}.height`, { positive: !allowZeroSize });
  if (bounds.x + bounds.width > 1.000001 || bounds.y + bounds.height > 1.000001) {
    throw new Error(`${path}がページ範囲を超えています。`);
  }
}

export function validateNormalizedNoteContent(content, { strict = false } = {}) {
  content.elements.forEach((element, elementIndex) => {
    const path = `elements[${elementIndex}]`;
    if (!["stroke", "highlighter", "shape", "text", "image"].includes(element?.type)) {
      throw new Error(`${path}.typeが不正です。`);
    }
    if (["stroke", "highlighter"].includes(element.type)) {
      if (!Array.isArray(element.points)) throw new Error(`${path}.pointsが配列ではありません。`);
      element.points.forEach((point, pointIndex) => {
        assertNormalized(point.x, `${path}.points[${pointIndex}].x`);
        assertNormalized(point.y, `${path}.points[${pointIndex}].y`);
        if (point.pressure != null) assertNormalized(point.pressure, `${path}.points[${pointIndex}].pressure`);
      });
      if (element.style?.widthRatio != null) assertNormalized(element.style.widthRatio, `${path}.style.widthRatio`, { positive: true });
    } else if (element.type === "shape" && ["line", "arrow"].includes(element.shapeType)) {
      if (strict && (!element.start || !element.end)) {
        throw new Error(`${path}に保存形式のstart/endがありません。`);
      }
      const canonicalPoints = element.start && element.end
        ? [element.start, element.end]
        : Array.isArray(element.points) && element.points.length >= 2
          ? element.points.slice(0, 2)
          : null;
      if (!canonicalPoints && !element.bounds) {
        throw new Error(`${path}に直線のstart/endまたは互換boundsがありません。`);
      }
      canonicalPoints?.forEach((point, pointIndex) => {
        assertNormalized(point.x, `${path}.${pointIndex ? "end" : "start"}.x`);
        assertNormalized(point.y, `${path}.${pointIndex ? "end" : "start"}.y`);
      });
      if (element.bounds) validateBounds(element.bounds, `${path}.bounds`, { allowZeroSize: true });
    } else {
      validateBounds(element.bounds, `${path}.bounds`);
    }
    if (element.type === "image") {
      if (!element.assetId) throw new Error(`${path}.assetIdがありません。`);
      validateBounds(element.crop || { x: 0, y: 0, width: 1, height: 1 }, `${path}.crop`);
    }
    if (element.type === "text" && element.style?.fontSizeRatio != null) {
      assertNormalized(element.style.fontSizeRatio, `${path}.style.fontSizeRatio`, { positive: true });
    }
  });
  content.noteMasks.forEach((mask, index) => validateBounds(mask, `noteMasks[${index}]`));
  return content;
}

export function assertFiniteJson(value, path = "root") {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error(`${path}にNaNまたはInfinityが含まれています。`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertFiniteJson(item, `${path}[${index}]`));
  } else if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, item]) => assertFiniteJson(item, `${path}.${key}`));
  }
  return value;
}

export async function decodeImageDimensions(blob) {
  validateImageBlob(blob, { maxBytes: Number.MAX_SAFE_INTEGER });
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    await image.decode();
    const naturalWidth = image.naturalWidth;
    const naturalHeight = image.naturalHeight;
    if (!naturalWidth || !naturalHeight) throw new Error("画像の自然サイズを取得できませんでした。");
    if (
      naturalWidth > MAX_NOTE_IMAGE_WIDTH ||
      naturalHeight > MAX_NOTE_IMAGE_HEIGHT ||
      naturalWidth * naturalHeight > MAX_NOTE_IMAGE_PIXELS
    ) {
      return { naturalWidth, naturalHeight, oversized: true };
    }
    return { naturalWidth, naturalHeight, oversized: false };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function sanitizeDownloadFilename(value, fallback = "note") {
  const normalized = String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/[. ]+$/g, "")
    .slice(0, 180)
    .replace(/[. ]+$/g, "");
  return normalized || fallback;
}
