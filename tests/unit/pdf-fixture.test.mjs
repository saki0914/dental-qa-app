import assert from "node:assert/strict";
import test from "node:test";

import { PDFDocument } from "pdf-lib";
import { createPdfFixture } from "../helpers/pdf-fixture.mjs";

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
