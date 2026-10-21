// A red line under a mask (revision 15): it marks the hidden words. It runs
// along the mask's bottom edge, just below it (inside, the mask's edge would
// cover it), and shows while the mask is open: when editing, when the mask
// is opened in study mode and in a PDF without masks. A closed mask hides
// it. It belongs to its mask: it moves and resizes with it and is deleted
// with it.
export const MASK_UNDERLINE_COLOR = "#dc2626";
// Shares of the page width, and of the mask height for a short mask (a mask
// on a page placed six to a summary page gets a line as thin as its words).
const WIDTH_SHARE = 0.0022;
const HEIGHT_SHARE = 0.12;

export function hasMaskUnderline(mask) {
  return mask?.underline === true;
}

// The line's thickness in pixels of a page drawn `width` x `height`.
export function maskUnderlineThickness(mask, width, height) {
  return Math.max(1, Math.min(Number(width) * WIDTH_SHARE, Number(mask?.height || 0) * Number(height) * HEIGHT_SHARE));
}

// The line just below the bottom edge of the mask (above it at the bottom
// of the page), in pixels of that page.
export function maskUnderlineRect(mask, width, height) {
  const thickness = maskUnderlineThickness(mask, width, height);
  const bottom = (Number(mask?.y || 0) + Number(mask?.height || 0)) * Number(height);
  return {
    x: Number(mask?.x || 0) * Number(width),
    y: Math.max(0, Math.min(bottom, Number(height) - thickness)),
    width: Number(mask?.width || 0) * Number(width),
    height: thickness
  };
}
