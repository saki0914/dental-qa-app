export function moveImageMemoryFile(files, fromIndex, toIndex) {
  const reordered = Array.isArray(files) ? [...files] : [];
  if (
    !Number.isInteger(fromIndex) ||
    !Number.isInteger(toIndex) ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= reordered.length ||
    toIndex >= reordered.length ||
    fromIndex === toIndex
  ) {
    return reordered;
  }

  const [file] = reordered.splice(fromIndex, 1);
  reordered.splice(toIndex, 0, file);
  return reordered;
}
