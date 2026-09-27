export function normalizeMaterialMask(mask) {
  return {
    id: String(mask?.id || ""),
    x: Number(mask?.x || 0) / 100,
    y: Number(mask?.y || 0) / 100,
    width: Number(mask?.width || 0) / 100,
    height: Number(mask?.height || 0) / 100,
    weak: mask?.weak === true,
    readOnly: true,
    source: "material"
  };
}

export function maskVisibilityKey(mask, source = mask?.readOnly === true || mask?.source === "material" ? "material" : "note") {
  return `${source === "material" ? "material" : "note"}:${String(mask?.id || "")}`;
}

export function getMaterialPageMasks(material, pageNumber) {
  return (Array.isArray(material?.masks) ? material.masks : [])
    .filter(mask => Number(mask.page) === Number(pageNumber))
    .map(normalizeMaterialMask);
}
