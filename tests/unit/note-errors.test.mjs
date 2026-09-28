import assert from "node:assert/strict";
import test from "node:test";

import { getStandaloneNoteCreationErrorMessage } from "../../js/core/note-errors.js";

test("白紙ノート作成の権限拒否にはFirestoreルールの確認手順を案内する", () => {
  const message = getStandaloneNoteCreationErrorMessage({
    code: "permission-denied",
    message: "Missing or insufficient permissions."
  });

  assert.match(message, /白紙・罫線ノートを作成できませんでした/);
  assert.match(message, /ページを再読み込み/);
  assert.match(message, /Firestoreルールが最新版か確認/);
  assert.doesNotMatch(message, /Missing or insufficient permissions/);
});

test("名前空間付きの権限拒否コードも同じ案内へ変換する", () => {
  const message = getStandaloneNoteCreationErrorMessage({
    code: "firestore/permission-denied",
    message: "write denied"
  });

  assert.match(message, /Firestoreのアクセス権限により拒否されました/);
  assert.doesNotMatch(message, /write denied/);
});

test("権限拒否以外では作成操作と元のエラー内容を示す", () => {
  const message = getStandaloneNoteCreationErrorMessage(new Error("ネットワークへ接続できません。"));

  assert.equal(
    message,
    "白紙・罫線ノートを作成できませんでした。\nネットワークへ接続できません。"
  );
});
