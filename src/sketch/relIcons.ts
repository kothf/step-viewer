/**
 * Sketch relation icons, as other CAD apps draw them: one small line drawing per relation type, in
 * `currentColor`, used on the Add Relations buttons, in the Relations list, in menus, beside the cursor while
 * drawing and as the glyphs on the sketch.
 */
import type { RelKind } from "../model/types";

/** Icon keys: every 2D relation, plus "edge" (a fix that follows a model edge), "merge" and the 3D sketch ones. */
export type RelIconKind = RelKind | "edge" | "merge" | "alongX" | "alongY" | "alongZ" | "parallelPlane" | "onPlane";

const L = (x1: number, y1: number, x2: number, y2: number, extra = "") => `<path d="M${x1} ${y1}L${x2} ${y2}"${extra}/>`;
const dot = (x: number, y: number, r = 1.7) => `<circle cx="${x}" cy="${y}" r="${r}" fill="currentColor" stroke="none"/>`;
const axisText = (c: string) => `<text x="12.6" y="15" font-size="6.5" font-weight="700" font-family="sans-serif" fill="currentColor" stroke="none" text-anchor="middle">${c}</text>`;

/** The drawings, in a 16 × 16 box. */
const BODY: Record<RelIconKind, string> = {
  horizontal: L(2, 8, 14, 8) + L(2, 5.5, 2, 10.5) + L(14, 5.5, 14, 10.5),
  vertical: L(8, 2, 8, 14) + L(5.5, 2, 10.5, 2) + L(5.5, 14, 10.5, 14),
  coincident: L(2, 13, 8, 8) + L(8, 8, 14, 11) + dot(8, 8, 2.3),
  onCurve: `<path d="M2 13Q8 1 14 13"/>` + dot(8, 7, 2),
  parallel: L(2, 11, 9, 3) + L(7, 13, 14, 5),
  perpendicular: L(8, 2.5, 8, 13) + L(2.5, 13, 13.5, 13) + `<path d="M8 10H11V13"/>`,
  collinear: L(1.5, 8, 6, 8) + L(10, 8, 14.5, 8) + dot(6, 8, 1.4) + dot(10, 8, 1.4) + L(1.5, 5.5, 1.5, 10.5) + L(14.5, 5.5, 14.5, 10.5),
  equal: L(3, 5.5, 13, 5.5) + L(3, 10.5, 13, 10.5),
  tangent: `<circle cx="8" cy="9.5" r="4.5"/>` + L(1.5, 5, 14.5, 5),
  concentric: `<circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="3"/>` + dot(8, 8, 0.9),
  midpoint: L(1.5, 9, 14.5, 9) + L(1.5, 6.5, 1.5, 11.5) + L(14.5, 6.5, 14.5, 11.5) + `<path d="M8 5L11 8L8 11L5 8Z" fill="currentColor" stroke="none"/>`,
  fix: `<path d="M5.5 7.5V5.5a2.5 2.5 0 0 1 5 0V7.5"/><rect x="3.5" y="7.5" width="9" height="6.5" rx="1.3" fill="currentColor"/>`,
  symmetric: `<path d="M8 1.5V14.5" stroke-dasharray="2.2 1.6"/>` + `<path d="M5.5 5L2 8L5.5 11Z" fill="currentColor"/><path d="M10.5 5L14 8L10.5 11Z" fill="currentColor"/>`,
  intersection: L(2.5, 3, 13.5, 13) + L(2.5, 13, 13.5, 3) + `<circle cx="8" cy="8" r="2.4" fill="none"/>`,
  curvature: `<path d="M1.5 13C5 13 7 10.5 8 8S11 3 14.5 3"/>` + L(8, 4.5, 8, 11.5, ' stroke-dasharray="1.2 1.2"'),
  pierce: `<path d="M2 11L6 6.5H14L10 11Z"/>` + L(8, 1.5, 8, 6.5) + L(8, 11, 8, 14.5) + dot(8, 8.8, 1.6),
  offset: `<path d="M2 13.5Q8 0.5 14 13.5"/><path d="M5.5 13.5Q8 6.5 10.5 13.5" stroke-dasharray="1.6 1.4"/>`,
  edge: `<rect x="2.5" y="2.5" width="11" height="11" rx="1"/>` + dot(8, 8, 2),
  merge: dot(3.5, 4, 1.8) + dot(3.5, 12, 1.8) + `<path d="M5 5L9 8L5 11M9 8H12"/>` + dot(13, 8, 2),
  alongX: L(2, 8, 11, 8) + `<path d="M8.5 5.5L11 8L8.5 10.5"/>` + axisText("X"),
  alongY: L(2, 8, 11, 8) + `<path d="M8.5 5.5L11 8L8.5 10.5"/>` + axisText("Y"),
  alongZ: L(2, 8, 11, 8) + `<path d="M8.5 5.5L11 8L8.5 10.5"/>` + axisText("Z"),
  parallelPlane: `<path d="M1.5 13L4.5 9.5H14.5L11.5 13Z"/>` + L(3, 6, 12, 6),
  onPlane: `<path d="M1.5 13L4.5 9.5H14.5L11.5 13Z"/>` + dot(8, 11.2),
};

/** A relation's icon as inline SVG (`size` px square), drawn in the text colour; hidden from screen readers. */
export function relIcon(k: RelIconKind, size = 14, cls = "rel-ico"): string {
  return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${BODY[k] ?? ""}</svg>`;
}

/** Every key that has a drawing (tests). */
export const REL_ICON_KINDS = Object.keys(BODY) as RelIconKind[];
