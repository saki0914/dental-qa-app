import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const appJs = readFileSync(new URL("../../js/app.js", import.meta.url), "utf8");

// Browsers may reuse the previous deploy's JS/CSS for up to 10 minutes
// (GitHub Pages sends max-age=600), while a dedicated editor tab always
// fetches its HTML because its URL is new every time. Right after a deploy the
// new HTML therefore runs with the previous release's app.js.
test("前版のapp.jsが無条件に参照する要素を非表示の互換要素として残す", () => {
  const element = html.match(/<div id="pdfLockBanner"[^>]*><\/div>/)?.[0];
  assert.ok(element, "#pdfLockBanner（改訂3以前のapp.jsがログイン状態の反映ごとに更新する）");
  assert.match(element, /\shidden[\s>]/);
  assert.match(element, /style="display:none"/, "旧JSがhiddenクラスを外しても表示しない");
  assert.doesNotMatch(element, /class=/, "バナーの見た目を持たせない");
  assert.doesNotMatch(appJs, /pdfLockBanner/, "現行JSは互換要素を使わない");
});

test("専用エディタの起動画面から再読み込みできる", () => {
  assert.match(html, /<button type="button" data-startup-action="reload">ページを再読み込み<\/button>/);
});
