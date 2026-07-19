export function classifyStorageError(error) {
  const code = String(error?.code || "");
  const details = [
    code,
    error?.message,
    error?.customData?.serverResponse
  ].filter(Boolean).join(" ");

  if (/quota-exceeded|UserProjectAccountProblem|Spark pricing|billing account|Cloud Storage for Firebase no longer supports/i.test(details)) {
    return "billing";
  }
  if (code === "storage/unauthorized") return "unauthorized";
  if (code === "storage/object-not-found") return "not-found";
  if (code === "storage/retry-limit-exceeded") return "retry-limit";
  return code ? "storage-error" : "image-error";
}

export function getPdfImageLoadFailureMessage(category, pageNumber) {
  const prefix = `${Number(pageNumber || 1)}ページの画像を表示できません。`;

  if (category === "billing") {
    return prefix + " Firebase Storageの課金状態を確認してください。Blazeプランまたは請求先アカウントが無効な可能性があります。";
  }
  if (category === "unauthorized") {
    return prefix + " Firebase Storageルールによりアクセスが拒否されました。ログイン状態とStorageルールを確認してください。";
  }
  if (category === "not-found") {
    return prefix + " Storage上に画像ファイルが見つかりません。ファイルが削除されていないか確認してください。";
  }
  if (category === "retry-limit") {
    return prefix + " Storageとの通信がタイムアウトしました。通信環境を確認して再読み込みしてください。";
  }
  if (category === "storage-error") {
    return prefix + " Firebase StorageからURLを取得できません。Storageの設定とブラウザのコンソールを確認してください。";
  }
  return prefix + " 画像URLへのアクセスに失敗しました。Storageの課金状態、ファイルの存在、権限を確認してください。";
}
