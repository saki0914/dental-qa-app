import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const PDF_LIB_SHA256 = "0f9a5cad07941f0826586c94e089d89b918c46e5c17cf2d5a3c6f666e3bc694f";

test("PDF出力・スキャンPDF変換用pdf-libを固定したローカルbundleから必要時だけ読み込む", async () => {
  const [bundle, html, loader, exporter, scannedPages] = await Promise.all([
    readFile(new URL("../../vendor/pdf-lib/pdf-lib.min.js", import.meta.url)),
    readFile(new URL("../../index.html", import.meta.url), "utf8"),
    readFile(new URL("../../js/core/pdf-lib-loader.js", import.meta.url), "utf8"),
    readFile(new URL("../../js/core/note-pdf-export.js", import.meta.url), "utf8"),
    readFile(new URL("../../js/core/pdf-scanned-page.js", import.meta.url), "utf8")
  ]);
  const hash = createHash("sha256").update(bundle).digest("hex");
  assert.equal(hash, PDF_LIB_SHA256);
  assert.doesNotMatch(html, /vendor\/pdf-lib\/pdf-lib\.min\.js/);
  assert.match(loader, /import\("\.\.\/\.\.\/vendor\/pdf-lib\/pdf-lib\.min\.js"\)/);
  for (const source of [loader, exporter, scannedPages]) {
    assert.doesNotMatch(source, /cdn\.jsdelivr\.net/);
    assert.doesNotMatch(source, /^import .*pdf-lib\.min\.js/m, "起動時には読み込まない");
  }
  assert.match(exporter, /from "\.\/pdf-lib-loader\.js"/);
  assert.match(scannedPages, /from "\.\/pdf-lib-loader\.js"/);
});

test("専用ノートエディタは問題管理と教材管理を必要になるまで読み込まない", async () => {
  const app = await readFile(new URL("../../js/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(app, /^import \{ createQuestionManager \} from/m);
  assert.doesNotMatch(app, /^import \{ createImageMemory \} from/m);
  assert.match(app, /if \(!noteEditorRoute\) \{[\s\S]*import\("\.\/features\/question-manager\.js"\)/);
  assert.match(app, /ensureDedicatedImageMemory[\s\S]*import\("\.\/features\/image-memory\.js"\)/);
});
