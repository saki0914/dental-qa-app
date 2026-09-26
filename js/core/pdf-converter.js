import {
  assertNonEmptyBlob,
  canvasToVerifiedBlob,
  validatePdfFile
} from "./file-validator.js";

export const PDF_RENDER_TARGET_WIDTH = 2200;
export const PDF_RENDER_MIN_SCALE = 1.8;
export const PDF_RENDER_MAX_SCALE = 3.2;
export const PDF_RENDER_JPEG_QUALITY = 0.92;

let cachedPdfJsLib = null;

export async function getPdfJsLibForConvert() {
  if (cachedPdfJsLib) return cachedPdfJsLib;
  cachedPdfJsLib = await import("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs");
  cachedPdfJsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs";
  return cachedPdfJsLib;
}

export async function convertPdfToImageFiles(pdfFile, onProgress, options = {}) {
  await validatePdfFile(pdfFile);
  const pdfjsLib = await getPdfJsLibForConvert();
  const arrayBuffer = await pdfFile.arrayBuffer();
  assertNonEmptyBlob(new Blob([arrayBuffer], { type: "application/pdf" }), "PDFファイル");

  const loadingTask = pdfjsLib.getDocument({
    data: arrayBuffer,
    useSystemFonts: true,
    disableFontFace: false,
    cMapUrl: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/standard_fonts/"
  });
  const files = [];
  try {
    const pdfDoc = await loadingTask.promise;
    if (!Number.isInteger(pdfDoc.numPages) || pdfDoc.numPages < 1) {
      throw new Error("PDFのページ数を取得できませんでした。");
    }

    for (let pageNumber = 1; pageNumber <= pdfDoc.numPages; pageNumber += 1) {
      if (options.signal?.aborted) throw new DOMException("PDF読み込みをキャンセルしました。", "AbortError");
      onProgress?.(pageNumber, pdfDoc.numPages, "converting");
      const page = await pdfDoc.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = Math.min(
        PDF_RENDER_MAX_SCALE,
        Math.max(PDF_RENDER_MIN_SCALE, PDF_RENDER_TARGET_WIDTH / baseViewport.width)
      );
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("PDFページ描画用Canvasを作成できませんでした。");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      const renderOptions = { canvasContext: context, viewport, background: "white" };
      if (pdfjsLib.AnnotationMode) renderOptions.annotationMode = pdfjsLib.AnnotationMode.ENABLE;

      try {
        await page.render(renderOptions).promise;
        const blob = await canvasToVerifiedBlob(
          canvas,
          "image/jpeg",
          PDF_RENDER_JPEG_QUALITY,
          `PDF ${pageNumber}ページ目の変換画像`
        );
        const baseName = (pdfFile.name || "converted.pdf").replace(/\.pdf$/i, "");
        const file = new File(
          [blob],
          `${baseName}_page_${String(pageNumber).padStart(3, "0")}.jpg`,
          { type: "image/jpeg" }
        );
        const pageInfo = {
          pageNumber,
          totalPages: pdfDoc.numPages,
          width: canvas.width,
          height: canvas.height,
          file
        };
        if (options.onPage) await options.onPage(pageInfo);
        else files.push(file);
        onProgress?.(pageNumber, pdfDoc.numPages, "converted");
      } finally {
        page.cleanup?.();
        canvas.width = 1;
        canvas.height = 1;
      }
    }
    return options.onPage ? { pageCount: pdfDoc.numPages, files: [] } : files;
  } finally {
    await loadingTask.destroy?.();
  }
}
