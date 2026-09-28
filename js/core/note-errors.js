const permissionDeniedCodes = new Set([
  "permission-denied",
  "firestore/permission-denied"
]);

export function getStandaloneNoteCreationErrorMessage(error) {
  const code = String(error?.code || "").toLowerCase();
  const detail = String(error?.message || error || "原因不明のエラー");
  const permissionDenied = permissionDeniedCodes.has(code)
    || /missing or insufficient permissions/i.test(detail);

  if (permissionDenied) {
    return [
      "白紙・罫線ノートを作成できませんでした。",
      "Firestoreのアクセス権限により拒否されました。ログイン状態を確認してページを再読み込みしてください。",
      "改善しない場合は、管理者にFirestoreルールが最新版か確認を依頼してください。"
    ].join("\n");
  }

  return `白紙・罫線ノートを作成できませんでした。\n${detail}`;
}
