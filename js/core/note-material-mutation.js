export const LINKED_NOTE_BATCH_SIZE = 500;
export const MATERIAL_ARCHIVING_STATUS = "archiving";
export const MATERIAL_READY_STATUS = "ready";
export const MATERIAL_NOTE_DELETE_REASONS = Object.freeze({
  replacement: "material-replaced",
  deletion: "material-deleted"
});

export function normalizeMaterialIds(materialIds = []) {
  if (!Array.isArray(materialIds)) throw new TypeError("教材IDは配列で指定してください。");
  const normalized = [...new Set(materialIds.map(value => String(value || "").trim()).filter(Boolean))];
  if (normalized.some(materialId => materialId.includes("/"))) {
    throw new TypeError("教材IDに使用できない文字が含まれています。");
  }
  return normalized;
}

export function isMaterialArchiving(material) {
  return material?.status === MATERIAL_ARCHIVING_STATUS;
}

export function markMaterialArchiving(material, operation, startedAt = new Date().toISOString()) {
  if (!material || typeof material !== "object") throw new TypeError("教材が見つかりません。");
  if (!Object.hasOwn(MATERIAL_NOTE_DELETE_REASONS, operation)) {
    throw new TypeError("教材のアーカイブ操作が不正です。");
  }
  material.status = MATERIAL_ARCHIVING_STATUS;
  material.archivingOperation = operation;
  material.archivingStartedAt = startedAt;
  return material;
}

export function markMaterialReady(material) {
  if (!material || typeof material !== "object") throw new TypeError("教材が見つかりません。");
  material.status = MATERIAL_READY_STATUS;
  delete material.archivingOperation;
  delete material.archivingStartedAt;
  return material;
}

export function splitLinkedNoteWrites(items, batchSize = LINKED_NOTE_BATCH_SIZE) {
  if (!Array.isArray(items)) throw new TypeError("連携ノートは配列で指定してください。");
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > LINKED_NOTE_BATCH_SIZE) {
    throw new TypeError(`batchSizeは1〜${LINKED_NOTE_BATCH_SIZE}で指定してください。`);
  }
  const chunks = [];
  for (let index = 0; index < items.length; index += batchSize) {
    chunks.push(items.slice(index, index + batchSize));
  }
  return chunks;
}

export function isMaterialDeletedReason(reason) {
  return Object.values(MATERIAL_NOTE_DELETE_REASONS).includes(reason);
}
