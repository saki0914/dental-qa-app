let pdfLibLoadPromise = null;

// pdf-lib is bundled locally (vendor/, pinned hash) and loaded only when a PDF
// is exported or a scanned PDF is converted.
export async function loadPdfLib(
  missingMessage = "PDFライブラリを読み込めませんでした。ネットワーク接続を確認して再試行してください。"
) {
  if (globalThis.PDFLib?.PDFDocument) return globalThis.PDFLib;
  if (!pdfLibLoadPromise) {
    pdfLibLoadPromise = import("../../vendor/pdf-lib/pdf-lib.min.js")
      .then(() => globalThis.PDFLib)
      .catch(error => {
        pdfLibLoadPromise = null;
        throw error;
      });
  }
  const pdfLib = await pdfLibLoadPromise;
  if (pdfLib?.PDFDocument) return pdfLib;
  pdfLibLoadPromise = null;
  throw new Error(missingMessage);
}
