import { PDFDocument, degrees, rgb } from "pdf-lib";

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;

export const PDF_PAGE_GEOMETRY_FIXTURES = Object.freeze({
  a4Portrait: Object.freeze({ width: 595.28, height: 841.89, rotation: 0 }),
  a4Landscape: Object.freeze({ width: 841.89, height: 595.28, rotation: 0 }),
  widescreen: Object.freeze({ width: 960, height: 540, rotation: 0 }),
  rotated90: Object.freeze({ width: 595.28, height: 841.89, rotation: 90 }),
  rotated270: Object.freeze({ width: 595.28, height: 841.89, rotation: 270 })
});

function normalizePageDefinitions(pageCount, pageDefinitions) {
  if (pageDefinitions !== undefined) {
    if (!Array.isArray(pageDefinitions) || pageDefinitions.length < 1) {
      throw new TypeError("pageDefinitions must be a non-empty array");
    }
    return pageDefinitions.map((definition, index) => {
      const width = Number(definition?.width);
      const height = Number(definition?.height);
      const rotation = Number(definition?.rotation || 0);
      if (!(width > 0) || !(height > 0) || ![0, 90, 180, 270].includes(rotation)) {
        throw new TypeError(`pageDefinitions[${index}] has invalid geometry`);
      }
      return { width, height, rotation };
    });
  }
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    throw new TypeError("pageCount must be a positive integer");
  }
  return Array.from({ length: pageCount }, () => ({ width: PAGE_WIDTH, height: PAGE_HEIGHT, rotation: 0 }));
}

export async function createPdfFixture({ pageCount = 2, pageDefinitions } = {}) {
  const definitions = normalizePageDefinitions(pageCount, pageDefinitions);

  const document = await PDFDocument.create();
  document.setTitle("Dental QA PDF conversion fixture");
  document.setCreator("tests/helpers/pdf-fixture.mjs");

  for (const [index, definition] of definitions.entries()) {
    const { width, height, rotation } = definition;
    const page = document.addPage([width, height]);
    if (rotation) page.setRotation(degrees(rotation));
    const accent = (index + 1) / (definitions.length + 1);
    page.drawRectangle({
      x: 0,
      y: 0,
      width,
      height,
      color: rgb(1, 1, 1)
    });
    page.drawRectangle({
      x: width * .12,
      y: height * .62,
      width: width * .76,
      height: height * .2,
      color: rgb(0.15 + accent * 0.35, 0.35, 0.75 - accent * 0.25)
    });
    page.drawRectangle({
      x: width * .12,
      y: height * .22,
      width: width * (.2 + Math.min(index, 3) * .04),
      height: height * .15,
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
  if (verified.getPageCount() !== definitions.length) {
    throw new Error(`Generated fixture page count mismatch: ${verified.getPageCount()}`);
  }
  return buffer;
}
