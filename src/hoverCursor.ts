/**
 * Hover cursor glyphs (FR-SEL-012): the pointer over the graphics area shows a small icon for the kind of
 * entity under it (face, edge, vertex, other snap point, plane, sketch entity), as a CAD app does beside
 * its arrow. The canvas carries `data-hover`; CSS rules (installed once) map it to an SVG cursor. A cursor
 * set inline (grab, pointer, crosshair…) still wins, so drag handles and tools keep theirs.
 */

export type HoverKind = "face" | "edge" | "vertex" | "point" | "plane" | "sketch";

export const HOVER_KINDS: readonly HoverKind[] = ["face", "edge", "vertex", "point", "plane", "sketch"];

/** The glyph for a snap kind of `Snapper` (and the section cap). */
export function hoverKindOfSnap(kind: string | null | undefined): HoverKind | null {
  switch (kind) {
    case "onFace": case "onCap": return "face";
    case "onEdge": return "edge";
    case "vertex": return "vertex";
    case "midpoint": case "quadrant": case "intersection": case "circleCenter": case "faceCenter": return "point";
    default: return null;
  }
}

/** The glyph for a sketch editor hit kind: points and the origin are points, dimensions and relations none. */
export function hoverKindOfSketch(kind: string | null | undefined): HoverKind | null {
  if (!kind) return null;
  if (kind === "point" || kind === "origin") return "point";
  if (kind === "dim" || kind === "rel") return null;
  return "sketch";
}

const ARROW = `<path d="M1 1 L1 15 L4.6 11.6 L7 17 L9.2 16 L6.9 10.7 L11.6 10.7 Z" fill="#fff" stroke="#000" stroke-width="1" stroke-linejoin="round"/>`;

/** The small icon drawn right below the arrow tip, in a 12 × 12 box at (12, 14). */
const ICONS: Record<HoverKind, string> = {
  face: `<path d="M13 18 L20 15 L25 19 L18 22 Z" fill="#4dabf7" stroke="#000" stroke-width="1" stroke-linejoin="round"/>`,
  edge: `<path d="M13 23 L24 15" stroke="#fff" stroke-width="4" stroke-linecap="round"/><path d="M13 23 L24 15" stroke="#1c7ed6" stroke-width="2" stroke-linecap="round"/>`,
  vertex: `<path d="M12 24 L18 19 L25 21" fill="none" stroke="#000" stroke-width="1"/><circle cx="18" cy="19" r="3" fill="#f08c00" stroke="#000" stroke-width="1"/>`,
  point: `<circle cx="19" cy="20" r="3" fill="#fff" stroke="#000" stroke-width="1"/><circle cx="19" cy="20" r="1.2" fill="#000"/>`,
  plane: `<path d="M12 22 L16 16 L26 16 L22 22 Z" fill="#69db7c" fill-opacity="0.75" stroke="#000" stroke-width="1" stroke-linejoin="round"/>`,
  sketch: `<path d="M13 23 C15 15, 20 25, 25 16" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round"/><path d="M13 23 C15 15, 20 25, 25 16" fill="none" stroke="#1d4ed8" stroke-width="2" stroke-linecap="round"/>`,
};

/** The SVG (28 × 28, hot spot 1, 1) for a kind. */
export function hoverSvg(kind: HoverKind): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">${ARROW}${ICONS[kind]}</svg>`;
}

/** The CSS cursor value for a kind. */
export function hoverCursor(kind: HoverKind): string {
  return `url("data:image/svg+xml,${encodeURIComponent(hoverSvg(kind))}") 1 1, default`;
}

let installed = false;

/** Adds the `canvas[data-hover=…]` cursor rules to the page once. */
export function installHoverCursors(doc: Document = document) {
  if (installed) return;
  installed = true;
  const style = doc.createElement("style");
  style.id = "hover-cursors";
  style.textContent = HOVER_KINDS.map(k => `canvas[data-hover="${k}"] { cursor: ${hoverCursor(k)}; }`).join("\n");
  doc.head.appendChild(style);
}

/** Sets or clears the canvas's hover glyph. */
export function setHoverKind(el: HTMLElement, kind: HoverKind | null) {
  if (kind) { if (el.dataset.hover !== kind) el.dataset.hover = kind; }
  else if (el.dataset.hover) delete el.dataset.hover;
}
