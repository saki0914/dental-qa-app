import {
  assertNonEmptyBlob,
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
// Scanned pages convert this many at a time in workers, which uses more CPU
// cores. Each worker holds one page's decoded scan at a time.
export const PDF_SCAN_WORKER_COUNT = 2;
// A worker that has not answered by then counts as failed; the page is then
// rendered on the main thread.
export const PDF_SCAN_WORKER_TIMEOUT_MS = 60_000;
// Starting the workers costs about as much as converting a page, so shorter
// documents are converted on the main thread.
export const PDF_SCAN_WORKER_MIN_PAGES = 3;

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
          await drawScannedPage(context, viewport, scan, decodeImage ? { decodeImage } : undefined);
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

function scanWorkersSupported() {
  return typeof Worker === "function" &&
    typeof OffscreenCanvas === "function" &&
    typeof OffscreenCanvas.prototype?.convertToBlob === "function";
}

function createScanPageWorker() {
  return new Worker(new URL("../workers/pdf-scan-page-worker.js", import.meta.url), { type: "module" });
}

// Workers that convert one scanned page each at a time
// (pdf-scan-page-worker.js). A worker that reports an error, fails to start or
// does not answer in time makes the whole pool unusable: every worker is
// terminated (so none keeps decoding in the background), the pending pages
// reject, and the caller renders them on the main thread.
export function createScanWorkerPool({
  size = PDF_SCAN_WORKER_COUNT,
  createWorker = createScanPageWorker,
  timeoutMs = PDF_SCAN_WORKER_TIMEOUT_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  const workers = [];
  const idle = [];
  const queue = [];
  const jobs = new Map();
  let nextId = 1;
  let failure = null;

  const fail = error => {
    failure ||= error;
    workers.forEach(worker => worker.terminate());
    for (const [id, job] of jobs) {
      jobs.delete(id);
      clearTimer(job.timer);
      job.reject(failure);
    }
    for (const job of queue.splice(0)) job.reject(failure);
  };
  const dispatch = () => {
    while (!failure && idle.length && queue.length) {
      const worker = idle.pop();
      const job = queue.shift();
      const id = nextId;
      nextId += 1;
      jobs.set(id, job);
      job.timer = setTimer(() => fail(new Error("スキャンページの変換が時間内に終わりませんでした。")), timeoutMs);
      try {
        worker.postMessage({ id, ...job.message });
      } catch (error) {
        fail(error);
      }
    }
  };

  for (let index = 0; index < size; index += 1) {
    let worker;
    try {
      worker = createWorker();
    } catch (error) {
      workers.forEach(created => created.terminate());
      throw error;
    }
    worker.addEventListener("message", event => {
      const { id, blob, error } = event.data || {};
      const job = jobs.get(id);
      if (!job) return;
      if (error || !blob) {
        // Rejects this page too: it is still among the running jobs.
        fail(new Error(error || "スキャンページの変換結果を受け取れませんでした。"));
        return;
      }
      jobs.delete(id);
      clearTimer(job.timer);
      idle.push(worker);
      job.resolve(blob);
      dispatch();
    });
    const onError = event => {
      event?.preventDefault?.();
      fail(new Error(event?.message || "スキャンページ変換用のworkerを開始できませんでした。"));
    };
    worker.addEventListener("error", onError);
    worker.addEventListener("messageerror", onError);
    workers.push(worker);
    idle.push(worker);
  }

  return {
    size: workers.length,
    get failed() {
      return Boolean(failure);
    },
    render(message) {
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        queue.push({ message, resolve, reject });
        dispatch();
      });
    },
    close() {
      fail(abortError());
    }
  };
}

// Renders a scanned page in a worker at the same size, and with the same
// drawing and JPEG encoding, as the main thread would. Returns null when
// pdf-lib and pdf.js disagree about the page, which then goes to pdf.js.
async function renderScanPageInWorker({ pdfDoc, pageNumber, plan, pool }) {
  const page = await pdfDoc.getPage(pageNumber);
  try {
    const baseViewport = page.getViewport({ scale: 1 });
    if (!scannedPageMatchesViewport(plan, baseViewport)) return null;
    const pdfRotation = normalizePdfRotation(baseViewport.rotation ?? page.rotate);
    const viewport = page.getViewport({ scale: pdfRenderScale(baseViewport.width, baseViewport.height) });
    const width = Math.max(1, Math.floor(viewport.width));
    const height = Math.max(1, Math.floor(viewport.height));
    const blob = await pool.render({
      pageNumber,
      // Only the page's own JPEG is sent (cloning the typed array would copy
      // the whole PDF buffer it points into).
      plan: {
        jpeg: new Blob([plan.jpeg], { type: "image/jpeg" }),
        imageWidth: plan.imageWidth,
        imageHeight: plan.imageHeight,
        ctm: plan.ctm,
        clips: plan.clips || []
      },
      transform: [...viewport.transform],
      width,
      height,
      quality: PDF_RENDER_JPEG_QUALITY
    });
    assertNonEmptyBlob(blob, `PDF ${pageNumber}ページ目の変換画像`);
    if (blob.type !== "image/jpeg") throw new Error(`PDF ${pageNumber}ページ目の変換画像がJPEGではありません。`);
    return { blob, width, height, pdfRotation, attempts: 1, renderer: "scan", worker: true };
  } finally {
    page.cleanup?.();
  }
}

function openScanWorkerPool(options) {
  if (options.scanWorkers === false) return null;
  const createWorker = options.createScanWorker;
  if (!createWorker && !scanWorkersSupported()) return null;
  try {
    return createScanWorkerPool({
      size: options.scanWorkerCount ?? PDF_SCAN_WORKER_COUNT,
      ...(createWorker ? { createWorker } : {})
    });
  } catch (error) {
    console.warn("スキャンページ変換用のworkerを使えないため、1ページずつ変換します。", error);
    return null;
  }
}

// `options.onDocument({ pageCount })` runs once the page count is known, before
// the first page is rendered.
export async function convertPdfToImageFiles(pdfFile, onProgress, options = {}) {
  await validatePdfFile(pdfFile);
  const createCanvas = options.createCanvas || (() => document.createElement("canvas"));
  const wait = options.wait || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  // Load the library while the file is read.
  const [pdfjsLib, arrayBuffer] = await Promise.all([
    options.pdfjsLib || getPdfJsLibForConvert(),
    pdfFile.arrayBuffer()
  ]);
  // Check the buffer itself; wrapping it in a Blob would copy the whole file.
  if (!(arrayBuffer?.byteLength > 0)) throw new Error("PDFファイルが0バイトです。保存を停止しました。");
  const bytes = new Uint8Array(arrayBuffer);

  const loadingTask = pdfjsLib.getDocument({
    // pdf.js transfers (detaches) the buffer it receives; the scanned-page
    // reader keeps reading `bytes`.
    data: bytes.slice(),
    useSystemFonts: true,
    disableFontFace: false,
    cMapUrl: `${PDF_JS_BASE}/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${PDF_JS_BASE}/standard_fonts/`,
    canvasMaxAreaInBytes: PDF_IMAGE_MAX_PIXELS * 4
  });
  const files = [];
  let workerPool = null;
  try {
    const pdfDoc = await loadingTask.promise;
    if (!Number.isInteger(pdfDoc.numPages) || pdfDoc.numPages < 1) {
      throw new Error("PDFのページ数を取得できませんでした。");
    }
    await options.onDocument?.({ pageCount: pdfDoc.numPages });
    const scannedPages = options.scannedPages === false
      ? null
      : await (options.openScannedPages || openScannedPdfPages)(bytes, { expectedPageCount: pdfDoc.numPages });
    if (scannedPages && pdfDoc.numPages >= PDF_SCAN_WORKER_MIN_PAGES) workerPool = openScanWorkerPool(options);

    // Scanned pages render ahead in the workers, up to one per worker, and
    // are delivered in page order. Every other page, and a scanned page whose
    // worker render failed, renders on the main thread once no worker render
    // is running, as before (one page image in memory at a time).
    const workerRenders = new Map();
    let scheduledThrough = 0;
    let useWorkers = Boolean(workerPool);
    const scheduleWorkerRenders = currentPage => {
      scheduledThrough = Math.max(scheduledThrough, currentPage - 1);
      while (
        useWorkers &&
        !options.signal?.aborted &&
        scheduledThrough < pdfDoc.numPages &&
        scheduledThrough < currentPage - 1 + workerPool.size
      ) {
        const next = scheduledThrough + 1;
        const plan = scannedPages.planForPage(next);
        if (!plan) break;
        scheduledThrough = next;
        workerRenders.set(next, renderScanPageInWorker({ pdfDoc, pageNumber: next, plan, pool: workerPool })
          .then(value => ({ value }), error => ({ error })));
      }
    };

    for (let pageNumber = 1; pageNumber <= pdfDoc.numPages; pageNumber += 1) {
      if (options.signal?.aborted) throw abortError();
      onProgress?.(pageNumber, pdfDoc.numPages, "converting");
      scheduleWorkerRenders(pageNumber);
      let rendered = null;
      const workerRender = workerRenders.get(pageNumber);
      if (workerRender) {
        workerRenders.delete(pageNumber);
        const result = await workerRender;
        if (options.signal?.aborted) throw abortError();
        rendered = result.value || null;
        if (result.error) {
          useWorkers = false;
          console.warn(`PDF ${pageNumber}ページ目をworkerで変換できないため、以降は1ページずつ変換します。`, result.error);
        }
      }
      if (!rendered) {
        await Promise.all(workerRenders.values());
        rendered = await renderPdfPageToJpeg({
          pdfDoc,
          pageNumber,
          pdfjsLib,
          createCanvas,
          wait,
          signal: options.signal,
          scan: scannedPages?.planForPage(pageNumber) || null,
          decodeImage: options.decodeImage
        });
      }
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
        worker: rendered.worker === true,
        file
      };
      if (options.onPage) await options.onPage(pageInfo);
      else files.push(file);
      onProgress?.(pageNumber, pdfDoc.numPages, "converted");
    }
    return options.onPage ? { pageCount: pdfDoc.numPages, files: [] } : files;
  } finally {
    workerPool?.close();
    await loadingTask.destroy?.();
  }
}
