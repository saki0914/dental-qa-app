import assert from "node:assert/strict";
import test from "node:test";

import {
  deleteQuestionImageFiles,
  isQuestionImagePathForUser,
  restoreFailedQuestionDeletes
} from "../../js/core/question-image-delete.js";

test("問題画像パスはログインユーザーのquestions配下だけを許可する", () => {
  assert.equal(
    isQuestionImagePathForUser("users/alice/questions/q1/image.png", "alice"),
    true
  );
  assert.equal(
    isQuestionImagePathForUser("users/bob/questions/q1/image.png", "alice"),
    false
  );
  assert.equal(
    isQuestionImagePathForUser("users/alice/imageMaterials/q1/image.png", "alice"),
    false
  );
  assert.equal(
    isQuestionImagePathForUser(" users/alice/questions/q1/image.png", "alice"),
    false
  );
  assert.equal(
    isQuestionImagePathForUser("users/alice/questions/", "alice"),
    false
  );
});

test("問題画像を対象ごとに削除し、画像なしはStorageへ送らない", async () => {
  const deletedPaths = [];
  const targets = [
    { id: "q1", imagePath: "users/alice/questions/q1/image.png" },
    { id: "q2", imagePath: "" }
  ];

  const results = await deleteQuestionImageFiles(targets, {
    userId: "alice",
    deleteByPath: async path => deletedPaths.push(path)
  });

  assert.deepEqual(deletedPaths, ["users/alice/questions/q1/image.png"]);
  assert.deepEqual(results.map(result => result.status), ["deleted", "no-image"]);
});

test("Storage削除失敗は失敗した問題だけを特定する", async () => {
  const targets = [
    { id: "q1", imagePath: "users/alice/questions/q1/image.png" },
    { id: "q2", imagePath: "users/alice/questions/q2/image.png" }
  ];

  const results = await deleteQuestionImageFiles(targets, {
    userId: "alice",
    deleteByPath: async path => {
      if (path.includes("/q2/")) throw new Error("forced failure");
    }
  });

  assert.equal(results[0].status, "deleted");
  assert.equal(results[1].status, "failed");
  assert.equal(results[1].question.id, "q2");
  assert.equal(results[1].reason, "delete-failed");
});

test("不正な画像パスはStorage削除を呼ばず失敗対象にする", async () => {
  let deleteCalls = 0;
  const [result] = await deleteQuestionImageFiles([
    { id: "q1", imagePath: "users/bob/questions/q1/image.png" }
  ], {
    userId: "alice",
    deleteByPath: async () => {
      deleteCalls += 1;
    }
  });

  assert.equal(deleteCalls, 0);
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "invalid-path");
});

test("Storage上ですでに消えている画像は削除成功として扱う", async () => {
  const [result] = await deleteQuestionImageFiles([
    { id: "q1", imagePath: "users/alice/questions/q1/image.png" }
  ], {
    userId: "alice",
    deleteByPath: async () => {
      throw { code: "storage/object-not-found" };
    }
  });

  assert.equal(result.status, "already-missing");
});

test("失敗対象だけを元の並び順へ復元し、処理中の追加も保持する", () => {
  const original = [
    { id: "q1", question: "first" },
    { id: "q2", question: "failed" },
    { id: "q3", question: "third" }
  ];
  const current = [
    { id: "q1", question: "updated first" },
    { id: "q3", question: "third" },
    { id: "q4", question: "added while deleting" }
  ];

  const restored = restoreFailedQuestionDeletes(current, original, new Set(["q2"]));

  assert.deepEqual(restored.map(question => question.id), ["q1", "q2", "q3", "q4"]);
  assert.equal(restored[0].question, "updated first");
});
