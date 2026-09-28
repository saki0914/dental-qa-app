import assert from "node:assert/strict";
import test from "node:test";

import { normalizePdfRotation } from "../../js/core/pdf-converter.js";

test("PDF回転角を診断メタデータ用の0/90/180/270度へ正規化する", () => {
  assert.equal(normalizePdfRotation(0), 0);
  assert.equal(normalizePdfRotation(90), 90);
  assert.equal(normalizePdfRotation(270), 270);
  assert.equal(normalizePdfRotation(-90), 270);
  assert.equal(normalizePdfRotation(450), 90);
  assert.equal(normalizePdfRotation(45), 0);
  assert.equal(normalizePdfRotation("invalid"), 0);
});
