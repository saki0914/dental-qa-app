const BACKGROUND_FIELDS = [
  "type",
  "paperColor",
  "ruleType",
  "ruleSpacingRatio",
  "ruleColor",
  "ruleOpacity",
  "ruleWidthRatio",
  "imagePath",
  "sourcePageNumber",
  "pdfRotation",
  "materialId",
  "materialPage"
];

export function createNoteBackgroundSignature(page, noteId = "", resolvedSource = "") {
  const background = page?.background || {};
  return JSON.stringify({
    noteId: String(noteId || ""),
    pageId: String(page?.pageId || ""),
    width: Number(page?.size?.width || 0),
    height: Number(page?.size?.height || 0),
    resolvedSource: String(resolvedSource || ""),
    background: Object.fromEntries(BACKGROUND_FIELDS.map(field => [field, background[field] ?? null]))
  });
}
