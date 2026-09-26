function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(value) {
  const text = stableJson(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${(hash >>> 0).toString(16).padStart(8, "0")}:${text.length}`;
}

/**
 * The signature intentionally includes the visual content itself, not only the
 * cloud revision. This invalidates cached thumbnails immediately for offline
 * drafts and after conflict resolution, before Firestore increments a revision.
 */
export function createNoteThumbnailSignature({
  noteId = "",
  firstPageId = "",
  page,
  content,
  materialMasks = [],
  maskMode = "all",
  revealedMaskIds = []
}) {
  const revealed = [...revealedMaskIds].map(String).sort();
  return [
    "note-thumbnail-v1",
    noteId,
    firstPageId || page?.pageId || "",
    page?.pageId || "",
    Number(page?.contentRevision || 0),
    Number(content?.revision || 0),
    maskMode,
    fingerprint({
      pageType: page?.pageType || "",
      size: page?.size || null,
      background: page?.background || null,
      elements: content?.elements || [],
      noteMasks: content?.noteMasks || [],
      materialMasks,
      revealed
    })
  ].join("|");
}

