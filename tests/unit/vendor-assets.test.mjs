import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const PDF_LIB_SHA256 = "0f9a5cad07941f0826586c94e089d89b918c46e5c17cf2d5a3c6f666e3bc694f";

test("PDF出力用pdf-libを固定したローカルbundleから読み込む", async () => {
  const [bundle, html] = await Promise.all([
    readFile(new URL("../../vendor/pdf-lib/pdf-lib.min.js", import.meta.url)),
    readFile(new URL("../../index.html", import.meta.url), "utf8")
  ]);
  const hash = createHash("sha256").update(bundle).digest("hex");
  assert.equal(hash, PDF_LIB_SHA256);
  assert.ok(html.indexOf("./vendor/pdf-lib/pdf-lib.min.js") < html.indexOf("./js/app.js"));
  assert.doesNotMatch(await readFile(new URL("../../js/core/note-pdf-export.js", import.meta.url), "utf8"), /cdn\.jsdelivr\.net/);
});
