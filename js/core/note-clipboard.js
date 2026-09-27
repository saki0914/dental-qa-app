const MIME_PRIORITY = ["image/png", "image/webp", "image/jpeg"];

export function isTextEditingTarget(target) {
  if (!target?.closest) return false;
  return Boolean(target.closest("input, textarea, [contenteditable='true'], [contenteditable=''], [data-note-text-editor='true']"));
}

export function chooseClipboardImage(items = []) {
  const candidates = [...items].filter(item => String(item.type || "").startsWith("image/") && item.type !== "image/svg+xml");
  return candidates.sort((a, b) => {
    const aRank = MIME_PRIORITY.indexOf(a.type);
    const bRank = MIME_PRIORITY.indexOf(b.type);
    return (aRank < 0 ? 99 : aRank) - (bRank < 0 ? 99 : bRank);
  })[0] || null;
}

export function imageFileFromPasteEvent(event) {
  const item = chooseClipboardImage(event?.clipboardData?.items || []);
  if (item?.getAsFile) return item.getAsFile();
  return chooseClipboardImage(event?.clipboardData?.files || []);
}

export async function readClipboardImage(navigatorObject = globalThis.navigator) {
  if (!navigatorObject?.clipboard?.read) throw new Error("Clipboard APIを利用できません。");
  const clipboardItems = await navigatorObject.clipboard.read();
  const availableTypes = [...new Set(clipboardItems.flatMap(item => item.types || []))];
  const type = MIME_PRIORITY.find(candidate => availableTypes.includes(candidate)) ||
    availableTypes.find(candidate => candidate.startsWith("image/") && candidate !== "image/svg+xml");
  if (!type) throw new Error("クリップボードに対応画像がありません。");
  const source = clipboardItems.find(item => item.types.includes(type));
  return source.getType(type);
}
