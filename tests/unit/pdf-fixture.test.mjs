import assert from "node:assert/strict";
import test from "node:test";

import { PDFDocument } from "pdf-lib";
import { createPdfFixture, PDF_PAGE_GEOMETRY_FIXTURES } from "../helpers/pdf-fixture.mjs";

test("E2E用PDF fixtureを指定ページ数で生成する", async () => {
  const fixture = await createPdfFixture({ pageCount: 3 });
  assert.equal(fixture.subarray(0, 5).toString("ascii"), "%PDF-");

  const document = await PDFDocument.load(fixture);
  assert.equal(document.getPageCount(), 3);
  assert.deepEqual(document.getPages().map(page => page.getSize()), [
    { width: 612, height: 792 },
    { width: 612, height: 792 },
    { width: 612, height: 792 }
  ]);
});

test("E2E用PDF fixtureは不正なページ数を拒否する", async () => {
  await assert.rejects(createPdfFixture({ pageCount: 0 }), /positive integer/);
});

test("縦・横・16:9・90度・270度を混在したPDF fixtureを生成する", async () => {
  const pageDefinitions = [
    PDF_PAGE_GEOMETRY_FIXTURES.a4Portrait,
    PDF_PAGE_GEOMETRY_FIXTURES.a4Landscape,
    PDF_PAGE_GEOMETRY_FIXTURES.widescreen,
    PDF_PAGE_GEOMETRY_FIXTURES.rotated90,
    PDF_PAGE_GEOMETRY_FIXTURES.rotated270
  ];
  const fixture = await createPdfFixture({ pageDefinitions });
  const document = await PDFDocument.load(fixture);
  assert.equal(document.getPageCount(), pageDefinitions.length);
  assert.deepEqual(document.getPages().map(page => ({
    ...page.getSize(),
    rotation: page.getRotation().angle
  })), pageDefinitions);
});

test("PDF fixtureは不正なページ寸法・回転を拒否する", async () => {
  await assert.rejects(
    createPdfFixture({ pageDefinitions: [{ width: 0, height: 100, rotation: 0 }] }),
    /invalid geometry/
  );
  await assert.rejects(
    createPdfFixture({ pageDefinitions: [{ width: 100, height: 100, rotation: 45 }] }),
    /invalid geometry/
  );
});
