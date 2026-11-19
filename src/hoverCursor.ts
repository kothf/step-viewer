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

/**
 * Tool cursors (gap list U4): while a sketch tool is active the canvas shows a pencil with the shape it draws,
 * scissors for Trim, and so on, as other CAD apps do. The canvas carries `data-tool`; its rules come after the
 * hover rules, so the tool's cursor wins over a hover glyph.
 */
export type ToolCursor = "line" | "rect" | "circle" | "arc" | "spline" | "point" | "polygon" | "slot" | "ellipse" | "text" | "trim" | "extend" | "corner" | "offset" | "dim" | "split";

export const TOOL_CURSORS: readonly ToolCursor[] = ["line", "rect", "circle", "arc", "spline", "point", "polygon", "slot", "ellipse", "text", "trim", "extend", "corner", "offset", "dim", "split"];

/** The cursor for a sketch tool name (`SkTool`); null for Select and tools without one. */
export function toolCursorOf(tool: string): ToolCursor | null {
  switch (tool) {
    case "line": case "cline": case "mline": return "line";
    case "rect": case "crect": case "rect3": case "crect3": case "pgram": return "rect";
    case "circle": case "circle3": case "pcircle": return "circle";
    case "arc": case "arc3": case "tarc": return "arc";
    case "spline": case "sspline": case "conic": case "parabola": case "eqn": return "spline";
    case "point": return "point";
    case "polygon": return "polygon";
    case "slot": case "cslot": case "aslot": case "aslot3": return "slot";
    case "ellipse": case "earc": return "ellipse";
    case "text": return "text";
    case "trim": return "trim";
    case "extend": return "extend";
    case "fillet": case "chamfer": return "corner";
    case "offset": return "offset";
    case "dim": case "hord": case "vord": return "dim";
    case "split": case "jog": case "segment": return "split";
    default: return null;
  }
}

/** A pencil whose tip is the hot spot (2, 26). */
const PENCIL = `<path d="M2 26 L4 20 L16 8 L20 12 L8 24 Z" fill="#ffd43b" stroke="#000" stroke-width="1" stroke-linejoin="round"/><path d="M2 26 L4 20 L8 24 Z" fill="#f1e3c8" stroke="#000" stroke-width="1" stroke-linejoin="round"/><path d="M2 26 L3 23 L5 25 Z" fill="#000"/>`;
const STROKE = `fill="none" stroke="#1d4ed8" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"`;
const SHAPES: Record<Exclude<ToolCursor, "text" | "trim" | "extend" | "dim">, string> = {
  line: `<path d="M17 11 L27 2" ${STROKE}/>`,
  rect: `<rect x="18" y="2" width="9" height="7" ${STROKE}/>`,
  circle: `<circle cx="22.5" cy="6" r="4.5" ${STROKE}/>`,
  arc: `<path d="M18 10 A5 5 0 0 1 27 6" ${STROKE}/>`,
  spline: `<path d="M17 9 C19 1, 23 12, 27 3" ${STROKE}/>`,
  point: `<circle cx="23" cy="5" r="2.2" fill="#1d4ed8"/>`,
  polygon: `<path d="M22.5 1 L27 4.5 L25.3 10 L19.7 10 L18 4.5 Z" ${STROKE}/>`,
  slot: `<path d="M20 3 L25 3 A3 3 0 0 1 25 9 L20 9 A3 3 0 0 1 20 3 Z" ${STROKE}/>`,
  ellipse: `<ellipse cx="22.5" cy="6" rx="5" ry="3.2" ${STROKE}/>`,
  corner: `<path d="M18 2 L18 6 A4 4 0 0 0 22 10 L27 10" ${STROKE}/>`,
  offset: `<path d="M17 6 L27 6 M17 10 L27 10" ${STROKE} stroke-dasharray="0"/>`,
  split: `<path d="M17 6 L27 6" ${STROKE}/><path d="M22 2 L22 10" fill="none" stroke="#e03131" stroke-width="1.6" stroke-linecap="round"/>`,
};
const CROSS = `<path d="M8 1 V15 M1 8 H15" stroke="#fff" stroke-width="3"/><path d="M8 1 V15 M1 8 H15" stroke="#000" stroke-width="1"/>`;
const OTHER: Record<"text" | "trim" | "extend" | "dim", string> = {
  text: `${CROSS}<text x="15" y="25" font-family="sans-serif" font-size="12" font-weight="700" fill="#1d4ed8" stroke="#fff" stroke-width="0.6">A</text>`,
  trim: `${CROSS}<circle cx="15" cy="23" r="2.6" fill="none" stroke="#000" stroke-width="1.4"/><circle cx="22" cy="23" r="2.6" fill="none" stroke="#000" stroke-width="1.4"/><path d="M16.5 21 L25 13 M20.5 21 L14 13" stroke="#000" stroke-width="1.4" stroke-linecap="round"/>`,
  extend: `${CROSS}<path d="M13 22 L20 22" ${STROKE}/><path d="M20 22 L26 22 M23 19 L26 22 L23 25" fill="none" stroke="#e03131" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`,
  dim: `${CROSS}<path d="M13 20 V26 M27 20 V26 M13 23 H27 M13 23 L15.5 21.5 M13 23 L15.5 24.5 M27 23 L24.5 21.5 M27 23 L24.5 24.5" fill="none" stroke="#1d4ed8" stroke-width="1.4" stroke-linecap="round"/>`,
};

/** The SVG (28 × 28) of a tool cursor and its hot spot. */
export function toolSvg(kind: ToolCursor): { svg: string; x: number; y: number } {
  const body = kind in SHAPES ? PENCIL + SHAPES[kind as keyof typeof SHAPES] : OTHER[kind as keyof typeof OTHER];
  const hot = kind in SHAPES ? [2, 26] : [8, 8];
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">${body}</svg>`, x: hot[0], y: hot[1] };
}

/** The CSS cursor value of a tool cursor. */
export function toolCursor(kind: ToolCursor): string {
  const { svg, x, y } = toolSvg(kind);
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${x} ${y}, crosshair`;
}

/** Sets or clears the canvas's tool cursor. */
export function setToolCursor(el: HTMLElement, kind: ToolCursor | null) {
  if (kind) { if (el.dataset.tool !== kind) el.dataset.tool = kind; }
  else if (el.dataset.tool) delete el.dataset.tool;
}

let installed = false;

/** Adds the `canvas[data-hover=…]` cursor rules to the page once. */
export function installHoverCursors(doc: Document = document) {
  if (installed) return;
  installed = true;
  const style = doc.createElement("style");
  style.id = "hover-cursors";
  style.textContent = [
    ...HOVER_KINDS.map(k => `canvas[data-hover="${k}"] { cursor: ${hoverCursor(k)}; }`),
    ...TOOL_CURSORS.map(k => `canvas[data-tool="${k}"] { cursor: ${toolCursor(k)}; }`),
  ].join("\n");
  doc.head.appendChild(style);
}

/** Sets or clears the canvas's hover glyph. */
export function setHoverKind(el: HTMLElement, kind: HoverKind | null) {
  if (kind) { if (el.dataset.hover !== kind) el.dataset.hover = kind; }
  else if (el.dataset.hover) delete el.dataset.hover;
}
