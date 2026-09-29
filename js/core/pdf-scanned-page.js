import { loadPdfLib } from "./pdf-lib-loader.js";

// Scanned PDF pages: a scanner (or its app, or macOS re-saving the file)
// writes one page-sized JPEG per page, often with an invisible OCR text layer
// (text render mode 3). pdf.js decodes such JPEGs in JavaScript at full
// resolution and then re-encodes them to downscale; a 600 dpi A4 scan is about
// 35M px, which costs several hundred MB per page and exhausts iPad Safari's
// memory, so a page canvas can no longer be allocated. Pages that paint
// nothing but one such JPEG are therefore drawn from the embedded JPEG with the
// browser's native decoder, at the size the page canvas needs. Every other page
// (and any page whose check fails) still goes through pdf.js.

const IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);
const MAX_CONTENT_BYTES = 8 * 1024 * 1024;
const MAX_STATE_DEPTH = 64;

// Operators that change state but paint nothing.
const NON_PAINTING_OPERATORS = new Set([
  "q", "Q", "cm", "ri", "i", "w", "J", "j", "M", "d",
  "cs", "CS", "sc", "SC", "scn", "SCN", "g", "G", "rg", "RG", "k", "K",
  "BT", "ET", "Tc", "Tw", "Tz", "TL", "Tf", "Tr", "Ts", "Td", "TD", "Tm", "T*",
  "BMC", "BDC", "EMC", "MP", "DP", "BX", "EX"
]);
const TEXT_SHOWING_OPERATORS = new Set(["Tj", "TJ", "'", "\""]);
const INVISIBLE_TEXT_RENDER_MODE = 3;

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);
const isRegular = byte => !WHITESPACE.has(byte) && !DELIMITERS.has(byte);

// PDF matrix product: the result maps a point through `inner`, then `outer`
// (pdf.js Util.transform(outer, inner)).
export function composePdfMatrices(outer, inner) {
  return [
    outer[0] * inner[0] + outer[2] * inner[1],
    outer[1] * inner[0] + outer[3] * inner[1],
    outer[0] * inner[2] + outer[2] * inner[3],
    outer[1] * inner[2] + outer[3] * inner[3],
    outer[0] * inner[4] + outer[2] * inner[5] + outer[4],
    outer[1] * inner[4] + outer[3] * inner[5] + outer[5]
  ];
}

function skipLiteralString(bytes, start) {
  let depth = 1;
  let index = start + 1;
  while (index < bytes.length && depth > 0) {
    const byte = bytes[index];
    if (byte === 0x5c) index += 2;
    else {
      if (byte === 0x28) depth += 1;
      else if (byte === 0x29) depth -= 1;
      index += 1;
    }
  }
  return depth === 0 ? index : -1;
}

function skipHexString(bytes, start) {
  const end = bytes.indexOf(0x3e, start + 1);
  return end < 0 ? -1 : end + 1;
}

// Skips a dictionary operand (<< ... >>), including nested dictionaries and
// strings, and returns the index after it.
function skipDictionary(bytes, start) {
  let depth = 0;
  let index = start;
  while (index < bytes.length) {
    const byte = bytes[index];
    if (byte === 0x3c && bytes[index + 1] === 0x3c) {
      depth += 1;
      index += 2;
    } else if (byte === 0x3e && bytes[index + 1] === 0x3e) {
      depth -= 1;
      index += 2;
      if (depth === 0) return index;
    } else if (byte === 0x28) {
      index = skipLiteralString(bytes, index);
      if (index < 0) return -1;
    } else if (byte === 0x3c) {
      index = skipHexString(bytes, index);
      if (index < 0) return -1;
    } else {
      index += 1;
    }
  }
  return -1;
}

function decodeName(raw) {
  return raw.replace(/#([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

// Reads a content stream and returns the single image XObject it paints, the
// transformation it is painted with and the rectangular clips active at that
// point, or null when the page paints anything else (visible text, paths,
// shadings, forms, inline images, graphics-state dictionaries, optional
// content), clips with anything but one rectangle, or cannot be read safely.
export function findScannedPageImage(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_CONTENT_BYTES) return null;
  const stateStack = [];
  let ctm = [...IDENTITY];
  let textRenderMode = 0;
  let clips = [];
  let pathRects = [];
  let clipPending = false;
  let image = null;
  let operands = [];
  let arrayDepth = 0;
  let index = 0;
  while (index < bytes.length) {
    const byte = bytes[index];
    if (WHITESPACE.has(byte)) {
      index += 1;
      continue;
    }
    if (byte === 0x25) {
      while (index < bytes.length && bytes[index] !== 0x0a && bytes[index] !== 0x0d) index += 1;
      continue;
    }
    if (byte === 0x28) {
      index = skipLiteralString(bytes, index);
      if (index < 0) return null;
      if (!arrayDepth) operands.push({ type: "string" });
      continue;
    }
    if (byte === 0x3c) {
      index = bytes[index + 1] === 0x3c ? skipDictionary(bytes, index) : skipHexString(bytes, index);
      if (index < 0) return null;
      if (!arrayDepth) operands.push({ type: "value" });
      continue;
    }
    if (byte === 0x5b) {
      arrayDepth += 1;
      index += 1;
      continue;
    }
    if (byte === 0x5d) {
      if (!arrayDepth) return null;
      arrayDepth -= 1;
      index += 1;
      if (!arrayDepth) operands.push({ type: "array" });
      continue;
    }
    if (byte === 0x2f) {
      let end = index + 1;
      while (end < bytes.length && isRegular(bytes[end])) end += 1;
      const name = decodeName(String.fromCharCode(...bytes.subarray(index + 1, end)));
      index = end;
      if (!arrayDepth) operands.push({ type: "name", value: name });
      continue;
    }
    if (!isRegular(byte)) return null;
    let end = index + 1;
    while (end < bytes.length && isRegular(bytes[end])) end += 1;
    const token = String.fromCharCode(...bytes.subarray(index, end));
    index = end;
    if (arrayDepth) continue;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(token)) {
      operands.push({ type: "number", value: Number(token) });
      continue;
    }
    if (token === "true" || token === "false" || token === "null") {
      operands.push({ type: "value" });
      continue;
    }
    const operator = token;
    const args = operands;
    operands = [];
    // Path objects: only a rectangle used as a clip (re W n / re W* n).
    if (operator === "re") {
      if (args.length !== 4 || args.some(arg => arg.type !== "number")) return null;
      pathRects.push({ rect: args.map(arg => arg.value), ctm: [...ctm] });
      continue;
    }
    if (operator === "W" || operator === "W*") {
      if (!pathRects.length || clipPending) return null;
      clipPending = true;
      continue;
    }
    if (operator === "n") {
      if (clipPending) {
        if (pathRects.length !== 1) return null;
        clips = [...clips, pathRects[0]];
      }
      pathRects = [];
      clipPending = false;
      continue;
    }
    if (pathRects.length) return null;
    if (TEXT_SHOWING_OPERATORS.has(operator)) {
      if (textRenderMode !== INVISIBLE_TEXT_RENDER_MODE) return null;
      continue;
    }
    if (operator === "Do") {
      if (image || args.length !== 1 || args[0].type !== "name") return null;
      image = { name: args[0].value, ctm: [...ctm], clips: clips.map(clip => ({ rect: [...clip.rect], ctm: [...clip.ctm] })) };
      continue;
    }
    if (!NON_PAINTING_OPERATORS.has(operator)) return null;
    if (operator === "q") {
      if (stateStack.length >= MAX_STATE_DEPTH) return null;
      stateStack.push({ ctm, textRenderMode, clips });
    } else if (operator === "Q") {
      const saved = stateStack.pop();
      if (saved) ({ ctm, textRenderMode, clips } = saved);
    } else if (operator === "cm") {
      if (args.length !== 6 || args.some(arg => arg.type !== "number")) return null;
      ctm = composePdfMatrices(ctm, args.map(arg => arg.value));
    } else if (operator === "Tr") {
      if (args.length !== 1 || args[0].type !== "number") return null;
      textRenderMode = args[0].value;
    } else if (operator === "BDC" && args[0]?.type === "name" && args[0].value === "OC") {
      return null;
    }
  }
  if (arrayDepth || pathRects.length || !image) return null;
  const [a, b, c, d] = image.ctm;
  if (!(Math.abs(a * d - b * c) > 1e-9) || !image.ctm.every(Number.isFinite)) return null;
  return image;
}

function readUint16(bytes, offset, littleEndian = false) {
  return littleEndian
    ? bytes[offset] | (bytes[offset + 1] << 8)
    : (bytes[offset] << 8) | bytes[offset + 1];
}

function exifOrientation(bytes, start, length) {
  // "Exif\0\0" followed by a TIFF header.
  const end = start + length;
  if (length < 14 || String.fromCharCode(...bytes.subarray(start, start + 4)) !== "Exif") return 1;
  const tiff = start + 6;
  const littleEndian = bytes[tiff] === 0x49;
  const ifdOffset = littleEndian
    ? (bytes[tiff + 4] | (bytes[tiff + 5] << 8) | (bytes[tiff + 6] << 16) | (bytes[tiff + 7] << 24)) >>> 0
    : ((bytes[tiff + 4] << 24) | (bytes[tiff + 5] << 16) | (bytes[tiff + 6] << 8) | bytes[tiff + 7]) >>> 0;
  const ifd = tiff + ifdOffset;
  if (ifd + 2 > end) return 1;
  const entries = readUint16(bytes, ifd, littleEndian);
  for (let entry = 0; entry < entries; entry += 1) {
    const offset = ifd + 2 + entry * 12;
    if (offset + 12 > end) break;
    if (readUint16(bytes, offset, littleEndian) === 0x0112) return readUint16(bytes, offset + 8, littleEndian);
  }
  return 1;
}

// Size, components and EXIF orientation from a JPEG header, or null when the
// data is not a baseline or progressive 8-bit JPEG.
export function inspectJpegHeader(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let orientation = 1;
  let index = 2;
  while (index + 4 <= bytes.length) {
    if (bytes[index] !== 0xff) return null;
    const marker = bytes[index + 1];
    if (marker === 0xff) {
      index += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      index += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = readUint16(bytes, index + 2);
    if (length < 2 || index + 2 + length > bytes.length) return null;
    if (marker === 0xe1) orientation = exifOrientation(bytes, index + 4, length - 2);
    const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isFrame) {
      if (![0xc0, 0xc1, 0xc2].includes(marker)) return null;
      return {
        precision: bytes[index + 4],
        height: readUint16(bytes, index + 5),
        width: readUint16(bytes, index + 7),
        components: bytes[index + 9],
        orientation
      };
    }
    index += 2 + length;
  }
  return null;
}

function numberValue(object) {
  const value = object?.asNumber?.();
  return Number.isFinite(value) ? value : null;
}

function nameValue(object) {
  const text = object?.asString?.();
  return typeof text === "string" && text.startsWith("/") ? decodeName(text.slice(1)) : null;
}

function imageColorComponents(colorSpace, lookup, PDFArray, PDFName) {
  const space = lookup(colorSpace);
  const name = nameValue(space);
  if (name === "DeviceRGB") return 3;
  if (name === "DeviceGray") return 1;
  if (space instanceof PDFArray && space.size() === 2 && nameValue(space.get(0)) === "ICCBased") {
    const profile = lookup(space.get(1));
    const components = numberValue(profile?.dict?.get(PDFName.of("N")));
    return components === 1 || components === 3 ? components : null;
  }
  return null;
}

// The JPEG of a scanner-style image XObject, or null when the image needs
// pdf.js (masks, decode arrays, other filters or color spaces, EXIF rotation).
function scannedJpeg(stream, { PDFArray, PDFName, PDFRawStream, lookup }) {
  if (!(stream instanceof PDFRawStream)) return null;
  const dict = stream.dict;
  const get = key => dict.get(PDFName.of(key));
  if (nameValue(lookup(get("Subtype"))) !== "Image") return null;
  if (lookup(get("ImageMask"))?.asBoolean?.() === true) return null;
  if (get("Mask") || get("SMask") || get("Decode") || get("DecodeParms") || get("DP")) return null;
  if (numberValue(lookup(get("BitsPerComponent"))) !== 8) return null;
  const filter = lookup(get("Filter"));
  const filters = filter instanceof PDFArray ? filter.asArray().map(item => nameValue(lookup(item))) : [nameValue(filter)];
  if (filters.length !== 1 || filters[0] !== "DCTDecode") return null;
  const components = imageColorComponents(get("ColorSpace"), lookup, PDFArray, PDFName);
  const width = numberValue(lookup(get("Width")));
  const height = numberValue(lookup(get("Height")));
  const jpeg = stream.contents;
  const header = inspectJpegHeader(jpeg);
  if (!components || !header || header.precision !== 8 || header.orientation !== 1) return null;
  if (header.components !== components || header.width !== width || header.height !== height) return null;
  return { jpeg, width, height };
}

const LETTER_SIZE_MEDIABOX = Object.freeze([0, 0, 612, 792]);

function normalizedBox(array) {
  const values = array?.asArray?.().map(item => numberValue(item));
  if (!values || values.length !== 4 || values.some(value => value === null)) return null;
  const box = [
    Math.min(values[0], values[2]), Math.min(values[1], values[3]),
    Math.max(values[0], values[2]), Math.max(values[1], values[3])
  ];
  return box[2] - box[0] > 0 && box[3] - box[1] > 0 ? box : null;
}

// Page size in PDF units as pdf.js computes it (CropBox within MediaBox,
// /Rotate, /UserUnit), used to confirm that pdf-lib and pdf.js describe the
// same page before drawing it natively.
function pdfJsPageSize(node, lookup, PDFName) {
  const mediaBox = normalizedBox(lookup(node.MediaBox?.())) || LETTER_SIZE_MEDIABOX;
  const cropBox = normalizedBox(lookup(node.CropBox?.()));
  let view = mediaBox;
  if (cropBox) {
    const intersection = [
      Math.max(cropBox[0], mediaBox[0]), Math.max(cropBox[1], mediaBox[1]),
      Math.min(cropBox[2], mediaBox[2]), Math.min(cropBox[3], mediaBox[3])
    ];
    if (intersection[2] - intersection[0] > 0 && intersection[3] - intersection[1] > 0) view = intersection;
  }
  let rotate = numberValue(lookup(node.Rotate?.())) || 0;
  rotate = rotate % 90 === 0 ? ((rotate % 360) + 360) % 360 : 0;
  const userUnitValue = numberValue(lookup(node.get(PDFName.of("UserUnit"))));
  const userUnit = userUnitValue > 0 ? userUnitValue : 1;
  const width = (view[2] - view[0]) * userUnit;
  const height = (view[3] - view[1]) * userUnit;
  return rotate === 90 || rotate === 270 ? { width: height, height: width } : { width, height };
}

// True when a pdf.js viewport at scale 1 has the size pdf-lib expects.
export function scannedPageMatchesViewport(plan, viewport) {
  const size = plan?.pageSize;
  return Boolean(size) &&
    Math.abs(size.width - Number(viewport?.width)) < 0.5 &&
    Math.abs(size.height - Number(viewport?.height)) < 0.5;
}

function concatenate(parts) {
  if (parts.length === 1) return parts[0];
  const total = parts.reduce((sum, part) => sum + part.length + 1, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
    joined[offset] = 0x0a;
    offset += 1;
  }
  return joined;
}

// Opens the PDF with pdf-lib and returns a function that describes page
// `pageNumber` (1-based) as { jpeg, imageWidth, imageHeight, ctm } when it can
// be drawn natively, or null. Returns null when pdf-lib cannot read the file,
// the file is encrypted, or its page count differs from pdf.js's.
export async function openScannedPdfPages(bytes, { expectedPageCount, pdfLib } = {}) {
  let lib = pdfLib;
  let document;
  try {
    lib ||= await loadPdfLib();
    document = await lib.PDFDocument.load(bytes, {
      ignoreEncryption: true,
      updateMetadata: false,
      throwOnInvalidObject: false
    });
  } catch (error) {
    console.debug("スキャンPDFの直接描画を使わず、pdf.jsで変換します。", error);
    return null;
  }
  if (document.isEncrypted) return null;
  const pages = document.getPages();
  if (Number.isInteger(expectedPageCount) && pages.length !== expectedPageCount) return null;
  const { PDFArray, PDFDict, PDFName, PDFRawStream, PDFRef, decodePDFRawStream } = lib;
  const lookup = object => (object instanceof PDFRef ? document.context.lookup(object) : object);
  return {
    pageCount: pages.length,
    planForPage(pageNumber) {
      try {
        const node = pages[pageNumber - 1]?.node;
        if (!node) return null;
        const annotations = lookup(node.get(PDFName.of("Annots")));
        if (annotations instanceof PDFArray && annotations.size() > 0) return null;
        const contents = lookup(node.get(PDFName.of("Contents")));
        const streams = contents instanceof PDFArray ? contents.asArray().map(lookup) : [contents];
        if (!streams.length || streams.some(stream => !(stream instanceof PDFRawStream))) return null;
        const content = concatenate(streams.map(stream => decodePDFRawStream(stream).decode()));
        const painted = findScannedPageImage(content);
        if (!painted) return null;
        const resources = node.Resources();
        const xobjects = resources instanceof PDFDict ? lookup(resources.get(PDFName.of("XObject"))) : null;
        if (!(xobjects instanceof PDFDict)) return null;
        const image = scannedJpeg(lookup(xobjects.get(PDFName.of(painted.name))), { PDFArray, PDFName, PDFRawStream, lookup });
        if (!image) return null;
        return {
          jpeg: image.jpeg,
          imageWidth: image.width,
          imageHeight: image.height,
          ctm: painted.ctm,
          clips: painted.clips,
          pageSize: pdfJsPageSize(node, lookup, PDFName)
        };
      } catch (error) {
        console.debug(`PDF ${pageNumber}ページ目はpdf.jsで変換します。`, error);
        return null;
      }
    }
  };
}

// Draws a planned scanned page onto `context`, whose canvas matches `viewport`
// (a pdf.js PageViewport for the page), on top of the white page background.
export async function drawScannedPage(context, viewport, plan, {
  decodeImage = (blob, options) => globalThis.createImageBitmap(blob, options)
} = {}) {
  // Image space: unit square, first JPEG row at the top (y = 1 in PDF terms).
  const matrix = composePdfMatrices(
    composePdfMatrices(viewport.transform, plan.ctm),
    [1, 0, 0, -1, 0, 1]
  );
  const drawnWidth = Math.max(1, Math.round(Math.hypot(matrix[0], matrix[1])));
  const drawnHeight = Math.max(1, Math.round(Math.hypot(matrix[2], matrix[3])));
  // Decode at the drawn size when that is smaller than the scan, which lets
  // the browser skip most of the full-resolution work and memory.
  const resize = drawnWidth < plan.imageWidth && drawnHeight < plan.imageHeight
    ? { resizeWidth: drawnWidth, resizeHeight: drawnHeight, resizeQuality: "high" }
    : undefined;
  const blob = new Blob([plan.jpeg], { type: "image/jpeg" });
  let bitmap;
  let resized = Boolean(resize);
  try {
    bitmap = await decodeImage(blob, resize);
  } catch (error) {
    // A browser without ImageBitmap resize options decodes at full size.
    if (!resize) throw error;
    bitmap = await decodeImage(blob, undefined);
    resized = false;
  }
  context.save();
  try {
    for (const clip of plan.clips || []) {
      const clipMatrix = composePdfMatrices(viewport.transform, clip.ctm);
      context.setTransform(clipMatrix[0], clipMatrix[1], clipMatrix[2], clipMatrix[3], clipMatrix[4], clipMatrix[5]);
      context.beginPath();
      context.rect(clip.rect[0], clip.rect[1], clip.rect[2], clip.rect[3]);
      context.clip();
    }
    context.setTransform(matrix[0], matrix[1], matrix[2], matrix[3], matrix[4], matrix[5]);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, 1, 1);
  } finally {
    context.restore();
    bitmap.close?.();
  }
  return { drawnWidth, drawnHeight, resized };
}
