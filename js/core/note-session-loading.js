export async function loadSessionBoundBackgroundBlob({
  page,
  session,
  assertUserSession,
  getStorageBlob,
  getMaterialSourcePage,
  fetchImpl = globalThis.fetch
}) {
  assertUserSession(session);
  if (page.background?.type === "pdf-source-page") {
    const blob = await getStorageBlob(page.background.imagePath, { expectedUid: session.uid });
    assertUserSession(session);
    return blob;
  }
  if (page.background?.type === "material-page") {
    const source = getMaterialSourcePage(page);
    if (source?.imagePath || source?.path || source?.storagePath) {
      const blob = await getStorageBlob(source.imagePath || source.path || source.storagePath, { expectedUid: session.uid });
      assertUserSession(session);
      return blob;
    }
    if (source?.imageUrl || source?.url) {
      const response = await fetchImpl(source.imageUrl || source.url);
      assertUserSession(session);
      if (!response.ok) throw new Error("教材背景画像を取得できませんでした。");
      const blob = await response.blob();
      assertUserSession(session);
      return blob;
    }
  }
  throw new Error("背景画像の参照先がありません。");
}

export async function loadSessionBoundMaterialDimensions({
  source,
  session,
  assertUserSession,
  getStorageBlob,
  decodeImageDimensions,
  fetchImpl = globalThis.fetch,
  warn = console.warn
}) {
  try {
    assertUserSession(session);
    let blob;
    if (source.imagePath || source.path || source.storagePath) {
      blob = await getStorageBlob(source.imagePath || source.path || source.storagePath, { expectedUid: session.uid });
      assertUserSession(session);
    } else if (source.imageUrl || source.url) {
      const response = await fetchImpl(source.imageUrl || source.url);
      assertUserSession(session);
      if (response.ok) {
        blob = await response.blob();
        assertUserSession(session);
      }
    }
    if (!blob) return null;
    const dimensions = await decodeImageDimensions(blob);
    assertUserSession(session);
    return dimensions;
  } catch (error) {
    if (error?.name === "NoteSessionChangedError") throw error;
    warn("教材画像の寸法を取得できないため既定比率を使用します。", error);
    return null;
  }
}
