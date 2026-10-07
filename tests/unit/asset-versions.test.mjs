import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ASSET_VERSIONS_END,
  ASSET_VERSIONS_START,
  assetVersion,
  assetVersionProblems,
  computeAssetVersions,
  stampIndexHtml
} from "../../scripts/lib/asset-versions.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));

test("index.htmlは全てのJSモジュールとCSSを現在の内容の版付きURLで読み込む", () => {
  const assets = computeAssetVersions(root);
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  assert.deepEqual(assetVersionProblems(html, assets), [], "npm run stamp を実行していない変更がない");
  assert.ok(assets.modules.includes("js/features/study-notes.js"));
  assert.ok(assets.modules.includes("js/core/note-text-colors.js"));
  assert.match(html, /<script type="importmap">/);
  assert.ok(html.indexOf("<script type=\"importmap\">") < html.indexOf("<script type=\"module\""), "import mapはモジュールより前");
});

test("版の書込みは何度行っても同じ結果になり、内容が変わったファイルだけ版が変わる", () => {
  const versions = new Map([["js/app.js", "aaaaaaaaaa"], ["js/core/x.js", "bbbbbbbbbb"], ["css/app.css", "cccccccccc"]]);
  const assets = { modules: ["js/app.js", "js/core/x.js"], styles: ["css/app.css"], versions, build: "dddddddddd" };
  const html = [
    "<head>",
    "  <title>t</title>",
    "  <link rel=\"stylesheet\" href=\"./css/app.css\">",
    "</head>",
    "<body><script type=\"module\" src=\"./js/app.js\"></script></body>"
  ].join("\n");
  const stamped = stampIndexHtml(html, assets);
  assert.equal(stampIndexHtml(stamped, assets), stamped, "2回目は変わらない");
  assert.deepEqual(assetVersionProblems(stamped, assets), []);
  assert.ok(stamped.includes(ASSET_VERSIONS_START) && stamped.includes(ASSET_VERSIONS_END));
  assert.ok(stamped.includes("\"./js/core/x.js\": \"./js/core/x.js?v=bbbbbbbbbb\""));
  assert.ok(stamped.includes("<link rel=\"stylesheet\" href=\"./css/app.css?v=cccccccccc\">"));
  assert.ok(stamped.includes("<script type=\"module\" src=\"./js/app.js?v=aaaaaaaaaa\"></script>"));
  // A changed module: the old stamp no longer matches.
  const changed = { ...assets, versions: new Map([...versions, ["js/core/x.js", "eeeeeeeeee"]]), build: "ffffffffff" };
  const problems = assetVersionProblems(stamped, changed);
  assert.ok(problems.some(problem => problem.startsWith("js/core/x.js")));
  assert.ok(problems.some(problem => problem.startsWith("app-build")));
  assert.deepEqual(assetVersionProblems(stampIndexHtml(stamped, changed), changed), []);
  // A new module that index.html does not know yet.
  const added = { ...assets, modules: [...assets.modules, "js/core/y.js"], versions: new Map([...versions, ["js/core/y.js", "1111111111"]]) };
  assert.ok(assetVersionProblems(stamped, added).some(problem => problem.startsWith("js/core/y.js")));
});

test("版は内容のSHA-256の先頭10文字", () => {
  assert.equal(assetVersion("abc"), "ba7816bf8f");
});
