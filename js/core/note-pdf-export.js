import { assertNonEmptyBlob, sanitizeDownloadFilename } from "./file-validator.js";
import { noteCanvasToJpeg, renderNotePageToCanvas } from "./note-renderer.js";
import { loadPdfLib } from "./pdf-lib-loader.js";

export const PDF_EXPORT_PRESETS = Object.freeze({
  compact: { label: "軽量", maxLongEdge: 1600, quality: 0.83 },
  standard: { label: "標準", maxLongEdge: 2200, quality: 0.90 },
  high: { label: "高画質", maxLongEdge: 3200, quality: 0.95 }
});

export function parsePdfPageRange(value, pageCount) {
  const input = String(value || "").trim();
  if (!input) throw new Error("ページ範囲を入力してください。");
  const result = [];
  for (const token of input.split(",")) {
    if (/^\d+$/.test(token.trim())) {
      result.push(Number(token));
      continue;
    }
    const match = token.trim().match(/^(\d+)-(\d+)$/);
    if (!match) throw new Error(`ページ範囲の形式が正しくありません: ${token}`);
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (start > end) throw new Error("逆転したページ範囲は指定できません。");
    for (let page = start; page <= end; page += 1) result.push(page);
  }
  const unique = [...new Set(result)];
  if (!unique.length || unique.some(page => page < 1 || page > pageCount)) {
    throw new Error(`ページ番号は1〜${pageCount}で指定してください。`);
  }
  return unique;
}

export function createPdfFilename(title, purpose = "ai", date = new Date()) {
  const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}_${String(date.getHours()).padStart(2, "0")}${String(date.getMinutes()).padStart(2, "0")}`;
  const suffix = purpose === "ai" ? "_AI共有用" : "";
  return sanitizePdfFilename(`${title || "学習ノート"}${suffix}_${stamp}.pdf`);
}

export function sanitizePdfFilename(value, fallback = "学習ノート.pdf") {
  const fallbackValue = String(fallback).trim().replace(/[. ]+$/g, "");
  const fallbackStem = sanitizeDownloadFilename(fallbackValue.replace(/(?:\.pdf)+$/i, ""), "学習ノート");
  const normalizedValue = String(value || "").trim().replace(/[. ]+$/g, "");
  const stem = sanitizeDownloadFilename(normalizedValue.replace(/(?:\s*\.pdf)+$/i, ""), fallbackStem)
    .slice(0, 116)
    .replace(/[. ]+$/g, "") || fallbackStem;
  return `${stem}.pdf`;
}

function getPdfLib() {
  return loadPdfLib("PDF出力ライブラリを読み込めませんでした。ネットワーク接続を確認して再試行してください。");
}

export function getPdfPageLayout(width, height, pageNumbers = false) {
  const pointsPerPixel = 72 / 150;
  const bodyWidth = Math.max(1, Number(width)) * pointsPerPixel;
  const bodyHeight = Math.max(1, Number(height)) * pointsPerPixel;
  const footerHeight = pageNumbers ? 22 : 0;
  return {
    bodyWidth,
    bodyHeight,
    footerHeight,
    pageWidth: bodyWidth,
    pageHeight: bodyHeight + footerHeight
  };
}

export function pdfMaskMode(purpose) {
  if (purpose === "ai") return "none";
  if (purpose === "study") return "all";
  return "screen";
}

export function pdfScreenHiddenMaskIds(purpose, {
  studyMode = false,
  revealedMaskIds = new Set(),
  editingHiddenMaskIds = new Set()
} = {}) {
  if (purpose !== "screen") return new Set();
  return new Set(studyMode ? revealedMaskIds : editingHiddenMaskIds);
}

export async function exportNotePdf({
  note,
  pages,
  getPageContent,
  getMaterialMasks = () => [],
  resolveBackgroundBlob,
  resolveAssetBlob,
  purpose = "ai",
  quality = "standard",
  pageNumbers = true,
  pageIndexes = pages.map((_, index) => index),
  revealedMaskIds = new Set(),
  onProgress = () => {},
  onStage = () => {},
  signal
}) {
  const preset = PDF_EXPORT_PRESETS[quality] || PDF_EXPORT_PRESETS.standard;
  const { PDFDocument, StandardFonts } = await getPdfLib();
  const pdf = await PDFDocument.create();
  const footerFont = pageNumbers && StandardFonts
    ? await pdf.embedFont(StandardFonts.Helvetica)
    : null;
  for (let outputIndex = 0; outputIndex < pageIndexes.length; outputIndex += 1) {
    if (signal?.aborted) throw new DOMException("PDF生成をキャンセルしました。", "AbortError");
    const pageIndex = pageIndexes[outputIndex];
    const page = pages[pageIndex];
    const content = await getPageContent(page);
    if (signal?.aborted) throw new DOMException("PDF生成をキャンセルしました。", "AbortError");
    const sourceWidth = Number(page.size?.width || 1240);
    const sourceHeight = Number(page.size?.height || 1754);
    const ratio = Math.min(1, preset.maxLongEdge / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * ratio));
    const height = Math.max(1, Math.round(sourceHeight * ratio));
    const canvas = await renderNotePageToCanvas({
      page,
      content,
      materialMasks: getMaterialMasks(page),
      resolveBackgroundBlob,
      resolveAssetBlob,
      width,
      height,
      maskMode: pdfMaskMode(purpose),
      revealedMaskIds,
      signal
    });
    const jpegBlob = await noteCanvasToJpeg(canvas, preset.quality, signal);
    if (signal?.aborted) throw new DOMException("PDF生成をキャンセルしました。", "AbortError");
    const image = await pdf.embedJpg(await jpegBlob.arrayBuffer());
    const { bodyWidth, bodyHeight, footerHeight, pageWidth, pageHeight } = getPdfPageLayout(width, height, pageNumbers);
    const pdfPage = pdf.addPage([pageWidth, pageHeight]);
    pdfPage.drawImage(image, { x: 0, y: footerHeight, width: bodyWidth, height: bodyHeight });
    if (pageNumbers) {
      const label = String(pageIndex + 1);
      const fontSize = 9;
      const textWidth = footerFont?.widthOfTextAtSize(label, fontSize) || label.length * fontSize * 0.6;
      pdfPage.drawText(label, {
        x: bodyWidth - textWidth - 12,
        y: 7,
        size: fontSize,
        ...(footerFont ? { font: footerFont } : {})
      });
    }
    canvas.width = 1; canvas.height = 1;
    onProgress({ current: outputIndex + 1, total: pageIndexes.length, percent: Math.round((outputIndex + 1) / pageIndexes.length * 100) });
  }
  if (signal?.aborted) throw new DOMException("PDF生成をキャンセルしました。", "AbortError");
  onStage("finalizing");
  const bytes = await pdf.save({ useObjectStreams: true });
  const blob = new Blob([bytes], { type: "application/pdf" });
  assertNonEmptyBlob(blob, "生成PDF");
  return { blob, filename: createPdfFilename(note.title, purpose), byteSize: blob.size };
}

export function downloadPdfBlob(blob, filename) {
  assertNonEmptyBlob(blob, "生成PDF");
  const safeName = sanitizePdfFilename(filename, "note.pdf");
  const file = new File([blob], safeName, { type: "application/pdf" });
  const url = URL.createObjectURL(file);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.setAttribute("download", safeName);
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  setTimeout(() => {
    anchor.remove();
    URL.revokeObjectURL(url);
  }, 1000);
}

export async function sharePdfBlob(blob, filename, title, navigatorObject = navigator) {
  assertNonEmptyBlob(blob, "生成PDF");
  const file = new File([blob], sanitizePdfFilename(filename, "note.pdf"), { type: "application/pdf" });
  if (!navigatorObject.share || !navigatorObject.canShare?.({ files: [file] })) {
    throw new Error("この端末ではPDFファイル共有を利用できません。ダウンロードを使用してください。");
  }
  await navigatorObject.share({ files: [file], title });
}
