import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyStorageError,
  getPdfImageLoadFailureMessage
} from "../../js/core/storage-errors.js";

test("Storageエラーを課金・権限・ファイル不在へ分類する", () => {
  assert.equal(classifyStorageError({ message: "Spark pricing plan is no longer supported" }), "billing");
  assert.equal(classifyStorageError({ code: "storage/unauthorized" }), "unauthorized");
  assert.equal(classifyStorageError({ code: "storage/object-not-found" }), "not-found");
  assert.equal(classifyStorageError({ code: "storage/retry-limit-exceeded" }), "retry-limit");
  assert.equal(classifyStorageError({ code: "storage/unknown" }), "storage-error");
  assert.equal(classifyStorageError(new Error("画像読込失敗")), "image-error");
});

test("画像読込エラーにページ番号と復旧案を含める", () => {
  const billingMessage = getPdfImageLoadFailureMessage("billing", 3);
  assert.match(billingMessage, /^3ページの画像を表示できません。/);
  assert.match(billingMessage, /Blazeプラン/);

  const missingMessage = getPdfImageLoadFailureMessage("not-found", 2);
  assert.match(missingMessage, /Storage上に画像ファイルが見つかりません/);
});
