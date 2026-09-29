import { drawScannedPage } from "../core/pdf-scanned-page.js";

// Renders one scanned PDF page (see pdf-scanned-page.js) off the main thread:
// the page JPEG is decoded, drawn and re-encoded exactly as on the main thread,
// on an OffscreenCanvas of the page image size. Several of these workers let a
// multi-core device convert pages in parallel.
self.addEventListener("message", async event => {
  const { id, plan, transform, width, height, quality } = event.data || {};
  let canvas = null;
  try {
    canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("PDFページ描画用Canvasを作成できませんでした。");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    await drawScannedPage(context, { transform }, plan);
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
    self.postMessage({ id, blob });
  } catch (error) {
    self.postMessage({ id, error: String(error?.message || error || "スキャンページを変換できませんでした。") });
  } finally {
    if (canvas) {
      canvas.width = 1;
      canvas.height = 1;
    }
  }
});
