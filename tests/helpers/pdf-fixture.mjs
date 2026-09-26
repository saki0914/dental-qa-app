import { PDFDocument, rgb } from "pdf-lib";

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;

export async function createPdfFixture({ pageCount = 2 } = {}) {
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    throw new TypeError("pageCount must be a positive integer");
  }

  const document = await PDFDocument.create();
  document.setTitle("Dental QA PDF conversion fixture");
  document.setCreator("tests/helpers/pdf-fixture.mjs");

  for (let index = 0; index < pageCount; index += 1) {
    const page = document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    const accent = (index + 1) / (pageCount + 1);
    page.drawRectangle({
      x: 0,
      y: 0,
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      color: rgb(1, 1, 1)
    });
    page.drawRectangle({
      x: 72 + index * 8,
      y: 520 - index * 12,
      width: 468 - index * 16,
      height: 160,
      color: rgb(0.15 + accent * 0.35, 0.35, 0.75 - accent * 0.25)
    });
    page.drawRectangle({
      x: 72,
      y: 180 + index * 18,
      width: 120 + index * 40,
      height: 120,
      borderColor: rgb(0.1, 0.1, 0.1),
      borderWidth: 5
    });
  }

  const bytes = await document.save({ useObjectStreams: false });
  const buffer = Buffer.from(bytes);
  if (buffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error("Generated fixture does not have a PDF signature");
  }

  const verified = await PDFDocument.load(buffer);
  if (verified.getPageCount() !== pageCount) {
    throw new Error(`Generated fixture page count mismatch: ${verified.getPageCount()}`);
  }
  return buffer;
}
