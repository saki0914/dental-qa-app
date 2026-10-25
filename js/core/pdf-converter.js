import {
  canvasToVerifiedBlob,
  validatePdfFile
} from "./file-validator.js";
import { drawScannedPage, openScannedPdfPages, scannedPageMatchesViewport } from "./pdf-scanned-page.js";

export const PDF_RENDER_TARGET_WIDTH = 2200;
export const PDF_RENDER_MIN_SCALE = 1.8;
export const PDF_RENDER_MAX_SCALE = 3.2;
export const PDF_RENDER_JPEG_QUALITY = 0.92;
// iPad Safari refuses canvases above 16,777,216 px and fails further canvas
// allocations once the canvases alive in the tab exceed its memory budget
// (canvas.toBlob() then yields null). Page images stay well inside both; an
// A4 page at the maximum scale is about 5.1M px.
export const PDF_RENDER_MAX_PIXELS = 10_000_000;
// Scanned PDFs embed one full-page photo per page (a 600 dpi A4 scan is about
// 35M px). pdf.js downscales images above this area in its worker, so the page
// canvas never receives, or prescales, a bitmap several times its own size.
export const PDF_IMAGE_MAX_PIXELS = 4096 * 4096;
// Scale factors for successive attempts at a page whose render or JPEG
// encoding failed. Every retry first releases the document's cached resources.
export const PDF_RENDER_RETRY_FACTORS = Object.freeze([1, 0.75, 0.5]);
export const PDF_RENDER_RETRY_DELAY_MS = 250;

const PDF_JS_BASE = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38";

let cachedPdfJsLib = null;

export function normalizePdfRotation(value) {
  const rotation = Number(value);
  if (!Number.isFinite(rotation)) return 0;
  const normalized = ((rotation % 360) + 360) % 360;
  return [0, 90, 180, 270].includes(normalized) ? normalized : 0;
}

// Render scale for a page of `width` x `height` PDF units: about 2200 px wide
// (1.8x to 3.2x), limited so that the canvas stays within
// PDF_RENDER_MAX_PIXELS, then multiplied by the retry factor.
export function pdfRenderScale(width, height, factor = 1) {
  const pageWidth = Number(width);
  const pageHeight = Number(height);
  const retryFactor = Number(factor) > 0 ? Number(factor) : 1;
  if (!(pageWidth > 0) || !(pageHeight > 0)) return PDF_RENDER_MIN_SCALE * retryFactor;
  const preferred = Math.min(
    PDF_RENDER_MAX_SCALE,
    Math.max(PDF_RENDER_MIN_SCALE, PDF_RENDER_TARGET_WIDTH / pageWidth)
  );
  const areaLimit = Math.sqrt(PDF_RENDER_MAX_PIXELS / (pageWidth * pageHeight));
  return Math.min(preferred, areaLimit) * retryFactor;
}

export async function getPdfJsLibForConvert() {
  if (cachedPdfJsLib) return cachedPdfJsLib;
  cachedPdfJsLib = await import(`${PDF_JS_BASE}/pdf.min.mjs`);
  cachedPdfJsLib.GlobalWorkerOptions.workerSrc = `${PDF_JS_BASE}/pdf.worker.min.mjs`;
  return cachedPdfJsLib;
}

function abortError() {
  return new DOMException("PDF読み込みをキャンセルしました。", "AbortError");
}

function releaseCanvas(canvas) {
  if (!canvas) return;
  canvas.width = 1;
  canvas.height = 1;
}

// Renders one page to a JPEG blob. A scanned page (`scan`, see
// pdf-scanned-page.js) is drawn from its embedded JPEG by the browser; every
// other page, and a scanned page whose native drawing fails, is rendered by
// pdf.js. A failed attempt (the render rejects, or the canvas cannot be
// encoded because the tab ran out of canvas memory) is retried smaller after
// the document's cached resources are released.
async function renderPdfPageToJpeg({ pdfDoc, pageNumber, pdfjsLib, createCanvas, wait, signal, scan, decodeImage }) {
  let lastError = null;
  let drawScanNatively = Boolean(scan);
  let scanChecked = false;
  for (const [attempt, factor] of PDF_RENDER_RETRY_FACTORS.entries()) {
    if (signal?.aborted) throw abortError();
    if (attempt > 0) {
      try {
        await pdfDoc.cleanup();
      } catch (error) {
        console.debug("PDFのキャッシュを解放できませんでした。", error);
      }
      await wait(PDF_RENDER_RETRY_DELAY_MS * attempt);
      if (signal?.aborted) throw abortError();
    }
    const page = await pdfDoc.getPage(pageNumber);
    let canvas = null;
    try {
      const baseViewport = page.getViewport({ scale: 1 });
      const pdfRotation = normalizePdfRotation(baseViewport.rotation ?? page.rotate);
      if (drawScanNatively && !scanChecked) {
        // pdf-lib and pdf.js must describe the same page (a damaged page tree
        // could be read differently); otherwise pdf.js draws it.
        scanChecked = true;
        drawScanNatively = scannedPageMatchesViewport(scan, baseViewport);
      }
      const viewport = page.getViewport({
        scale: pdfRenderScale(baseViewport.width, baseViewport.height, factor)
      });
      canvas = createCanvas();
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("PDFページ描画用Canvasを作成できませんでした。");
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      let renderer = "pdfjs";
      if (drawScanNatively) {
        try {
          await drawScannedPage(context, viewport, scan, { createCanvas, ...(decodeImage ? { decodeImage } : {}) });
          renderer = "scan";
        } catch (error) {
          drawScanNatively = false;
          console.warn(`PDF ${pageNumber}ページ目のスキャン画像を直接描画できないため、pdf.jsで変換します。`, error);
          context.setTransform?.(1, 0, 0, 1, 0, 0);
          context.fillStyle = "#ffffff";
          context.fillRect(0, 0, canvas.width, canvas.height);
        }
      }
      if (renderer === "pdfjs") {
        const renderOptions = { canvasContext: context, viewport, background: "white" };
        if (pdfjsLib.AnnotationMode) renderOptions.annotationMode = pdfjsLib.AnnotationMode.ENABLE;
        await page.render(renderOptions).promise;
      }
      // The page's decoded images are no longer needed; free them before the
      // JPEG encoder allocates its buffers.
      page.cleanup?.();
      const blob = await canvasToVerifiedBlob(
        canvas,
        "image/jpeg",
        PDF_RENDER_JPEG_QUALITY,
        `PDF ${pageNumber}ページ目の変換画像`
      );
      return { blob, width: canvas.width, height: canvas.height, pdfRotation, attempts: attempt + 1, renderer };
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      lastError = error;
      console.warn(`PDF ${pageNumber}ページ目の変換に失敗しました（${attempt + 1}回目）。`, error);
    } finally {
      page.cleanup?.();
      releaseCanvas(canvas);
    }
  }
  const detail = lastError?.message || String(lastError || "");
  throw new Error(
    `PDF ${pageNumber}ページ目を画像に変換できませんでした（${PDF_RENDER_RETRY_FACTORS.length}回試行）。` +
    "端末のメモリが不足している可能性があります。ほかのタブやアプリを閉じてから、もう一度お試しください。" +
    (detail ? `（${detail}）` : "")
  );
}

// Fonts embedded in the PDF are drawn from their outlines (revision 17).
// pdf.js normally re-encodes an embedded font and hands it to the browser,
// which draws the text. iPad Safari drew nothing for the CID-keyed CFF fonts
// that pdf.js 4.10.38 re-encodes (Japanese fonts such as Hiragino, as PDFs
// made on Apple devices embed them; that version writes their charset wrong
// for CoreText): a lecture PDF lost all its Japanese text while its numbers,
// arrows, boxes and photos stayed. pdf.js can instead read each glyph's
// outline from the font program itself (the same code in every browser) and
// fill it, as it does when a browser refuses a font: refusing every embedded
// font makes it do so. Fonts that are not embedded have no outlines and keep
// the font the device has. Returns whether the document's fonts are drawn so;
// a pdf.js without this loader is left as it is.
export function drawEmbeddedFontsFromOutlines(pdfDoc) {
  const loader = pdfDoc?._transport?.fontLoader;
  if (!loader || typeof loader.bind !== "function") return false;
  if (loader.bind.embeddedFontsFromOutlines === true) return true;
  const bindNative = loader.bind.bind(loader);
  const bind = async font => {
    if (font?.data && !font.missingFile && !font.systemFontInfo && !font.isType3Font && !font.cssFontInfo) {
      // pdf.js then asks its worker for the outlines of this font's glyphs.
      font.disableFontFace = true;
      throw new Error("PDFに埋め込まれたフォントは輪郭から描きます。");
    }
    return bindNative(font);
  };
  bind.embeddedFontsFromOutlines = true;
  loader.bind = bind;
  return true;
}

// pdf.js reads the byte ranges it needs straight from the file, in chunks of
// this size, instead of holding the whole PDF: a page drawn natively never
// needs pdf.js to read its image.
export const PDF_RANGE_CHUNK_SIZE = 1024 * 1024;

function fileRangeTransport(pdfjsLib, file, onError) {
  const Transport = pdfjsLib.PDFDataRangeTransport;
  if (typeof Transport !== "function") return null;
  const transport = new Transport(file.size, null);
  transport.requestDataRange = (begin, end) => {
    file.slice(begin, end).arrayBuffer().then(
      buffer => transport.onDataRange(begin, new Uint8Array(buffer)),
      onError
    );
  };
  return transport;
}

// `options.onDocument({ pageCount })` runs once the page count is known, before
// the first page is rendered.
export async function convertPdfToImageFiles(pdfFile, onProgress, options = {}) {
  await validatePdfFile(pdfFile);
  const createCanvas = options.createCanvas || (() => document.createElement("canvas"));
  const wait = options.wait || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  // Load the library while the file is read.
  const pdfjsLibReady = Promise.resolve(options.pdfjsLib || getPdfJsLibForConvert());
  pdfjsLibReady.catch(() => {});
  // The whole file is read once, to plan the scanned pages. The plans refer
  // to the page images by their place in the file, so the buffer is released
  // before any page is drawn.
  let scannedPages = null;
  if (options.scannedPages !== false) {
    let bytes = new Uint8Array(await pdfFile.arrayBuffer());
    // Check the buffer itself; wrapping it in a Blob would copy the whole file.
    if (!(bytes.byteLength > 0)) throw new Error("PDFファイルが0バイトです。保存を停止しました。");
    scannedPages = await (options.openScannedPages || openScannedPdfPages)(bytes, { source: pdfFile });
    bytes = null;
  }
  const pdfjsLib = await pdfjsLibReady;

  let readError = null;
  let loadingTask = null;
  const range = fileRangeTransport(pdfjsLib, pdfFile, error => {
    readError ||= error;
    void loadingTask?.destroy?.();
  });
  loadingTask = pdfjsLib.getDocument({
    ...(range
      ? { range, rangeChunkSize: PDF_RANGE_CHUNK_SIZE, disableAutoFetch: true, disableStream: true }
      : { data: new Uint8Array(await pdfFile.arrayBuffer()) }),
    useSystemFonts: true,
    disableFontFace: false,
    cMapUrl: `${PDF_JS_BASE}/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${PDF_JS_BASE}/standard_fonts/`,
    canvasMaxAreaInBytes: PDF_IMAGE_MAX_PIXELS * 4
  });
  const files = [];
  try {
    const pdfDoc = await loadingTask.promise;
    if (!Number.isInteger(pdfDoc.numPages) || pdfDoc.numPages < 1) {
      throw new Error("PDFのページ数を取得できませんでした。");
    }
    // Before any page loads a font.
    if (!drawEmbeddedFontsFromOutlines(pdfDoc) && pdfDoc._transport) {
      console.warn("PDFの埋め込みフォントを輪郭から描けないため、ブラウザのフォント機能で描きます。");
    }
    // pdf-lib and pdf.js must see the same pages to draw any natively.
    if (scannedPages && scannedPages.pageCount !== pdfDoc.numPages) scannedPages = null;
    await options.onDocument?.({ pageCount: pdfDoc.numPages });

    // One page at a time: iPad Safari has room for only one decoded
    // full-page scan (a 600 dpi A4 scan is about 138 MB decoded).
    for (let pageNumber = 1; pageNumber <= pdfDoc.numPages; pageNumber += 1) {
      if (options.signal?.aborted) throw abortError();
      onProgress?.(pageNumber, pdfDoc.numPages, "converting");
      const rendered = await renderPdfPageToJpeg({
        pdfDoc,
        pageNumber,
        pdfjsLib,
        createCanvas,
        wait,
        signal: options.signal,
        scan: scannedPages?.planForPage(pageNumber) || null,
        decodeImage: options.decodeImage
      });
      if (readError) throw readError;
      const baseName = (pdfFile.name || "converted.pdf").replace(/\.pdf$/i, "");
      const file = new File(
        [rendered.blob],
        `${baseName}_page_${String(pageNumber).padStart(3, "0")}.jpg`,
        { type: "image/jpeg" }
      );
      const pageInfo = {
        pageNumber,
        totalPages: pdfDoc.numPages,
        width: rendered.width,
        height: rendered.height,
        pdfRotation: rendered.pdfRotation,
        renderer: rendered.renderer,
        file
      };
      if (options.onPage) await options.onPage(pageInfo);
      else files.push(file);
      onProgress?.(pageNumber, pdfDoc.numPages, "converted");
    }
    return options.onPage ? { pageCount: pdfDoc.numPages, files: [] } : files;
  } catch (error) {
    if (readError && error?.name !== "AbortError") {
      throw new Error(`PDFファイルを読み込めませんでした。${readError.message || readError}`);
    }
    throw error;
  } finally {
    await loadingTask.destroy?.();
  }
}
