// Hole Wizard panel pictures (FR-FT-051 UX): the callout a hole gets on drawings and a half-section diagram of
// the hole in a plate. Pure: no DOM and no kernel, so the drawing callout and the panel share one wording.

import { holeExits, threadThrough, type HoleFeature, type HoleSink } from "./types";
import { threadClass } from "./holes";

const DRILL = (118 * Math.PI) / 180;

/**
 * Callout lines of a hole feature, ISO style as SolidWorks writes them: drill Ø with its depth (or THRU), the thread
 * for a tapped hole, then ⌴ counterbore / ⌵ countersink lines and the options. `f` formats lengths, `fa` angles and
 * `label` translates THRU, UNDER HEAD and FAR SIDE; `drillThru` says a through drill is no longer than the thread
 * (the drawing knows it from the geometry).
 */
export function holeCallout(H: HoleFeature, f: (v: number) => string, fa: (v: number) => string, label: (s: string) => string, count = 1, drillThru = false): string[] {
  const n = count > 1 ? `${count}× ` : "";
  const depth = H.end === "through" ? ` ${label("THRU")}` : H.end === "blind" ? ` ↧${f(H.depth.v)}` : "";
  const lines: string[] = [];
  lines.push(`${n}Ø${f(H.diameter.v)}${depth}`);
  if (H.kind === "tapped" && H.size) {
    // A thread at least as deep as a through drill is long runs through too.
    const thru = H.end === "through" && (H.threadEnd === "through" || !H.threadDepth || drillThru);
    // Thread end Through all on an Up to next / up to face hole: the thread runs the whole drill, no depth.
    lines.push(`${H.size}-${threadClass(H.size)}${thru ? ` ${label("THRU")}` : H.threadDepth && !threadThrough(H) ? ` ↧${f(H.threadDepth.v)}` : ""}`);
  }
  // Head clearance deepens the counterbore; the callout gives the depth as cut.
  if (H.kind === "cbore" && H.cbDia) lines.push(`⌴Ø${f(H.cbDia.v)}${H.cbDepth ? ` ↧${f(H.cbDepth.v + (H.headClear?.v ?? 0))}` : ""}`);
  const sink = (s: HoleSink, tail: string) => `⌵Ø${f(s.dia.v)} × ${fa(s.angle.v * 180 / Math.PI)}°${tail ? ` ${label(tail)}` : ""}`;
  if (H.kind === "cbore" && H.underCs) lines.push(sink(H.underCs, "UNDER HEAD"));
  if (H.nearCs && H.kind !== "csink" && H.kind !== "insert") lines.push(sink(H.nearCs, ""));
  if (H.kind === "cdrill" && H.cdDia) lines.push(`⌴Ø${f(H.cdDia.v)}${H.cdDepth ? ` ↧${f(H.cdDepth.v)}` : ""} × ${fa((H.cdAngle?.v ?? DRILL) * 180 / Math.PI)}°`);
  if (H.kind === "csink" && H.csDia) lines.push(`⌵Ø${f(H.csDia.v)} × ${fa((H.csAngle?.v ?? Math.PI / 2) * 180 / Math.PI)}°`);
  if (H.farCs && holeExits(H) && H.kind !== "slot" && H.kind !== "insert") lines.push(sink(H.farCs, "FAR SIDE"));
  return lines;
}

/** Half section of a hole: (r, z) from the top rim down (z grows into the material), the plate it sits in and its thread. */
export interface HoleSection {
  /** Outline from the rim on the face to the axis at the bottom (or the far face). */
  prof: [number, number][];
  /** Plate thickness drawn around it. */
  plate: number;
  /** Plate half width. */
  half: number;
  /** Tapped: thread radius and its z range. */
  thread?: { r: number; z0: number; z1: number };
  /** The hole leaves the plate at the bottom. */
  open: boolean;
  /** The depth is not known here (up to a face, vertex or the next face): drawn schematically. */
  rough: boolean;
}

/** The hole's half section as the kernel cuts it (no lift above the face), null when the values do not make a hole. */
export function holeSection(H: HoleFeature): HoleSection | null {
  const r = H.diameter.v / 2;
  if (!(r > 1e-6)) return null;
  const ok = (x: number | undefined) => x != null && isFinite(x);
  const sinkOf = (s: HoleSink | undefined, inner: number) => {
    if (!s) return null;
    const R = s.dia.v / 2, a = s.angle.v;
    if (!(R > inner) || !(a > 0.1 && a < Math.PI - 0.1)) return null;
    return { R, h: (R - inner) / Math.tan(a / 2) };
  };
  const clear = H.kind === "cbore" || H.kind === "csink" ? Math.max(0, H.headClear?.v ?? 0) : 0;
  const prof: [number, number][] = [];
  const top = (rTop: number) => {
    const s = H.kind === "csink" || H.kind === "insert" ? null : sinkOf(H.nearCs, rTop);
    if (s) prof.push([s.R, 0], [rTop, s.h]); else prof.push([rTop, 0]);
  };
  let outer = r;
  if (H.kind === "cbore") {
    const R = (H.cbDia?.v ?? 0) / 2, d = (H.cbDepth?.v ?? 0) + clear;
    if (!(R > r) || !(d > 0)) return null;
    top(R);
    prof.push([R, d]);
    const u = sinkOf(H.underCs, r);
    if (u && u.R < R) prof.push([u.R, d], [r, d + u.h]); else prof.push([r, d]);
    outer = R;
  } else if (H.kind === "cdrill") {
    const R = (H.cdDia?.v ?? 0) / 2, d = H.cdDepth?.v ?? 0, a = H.cdAngle?.v ?? DRILL;
    if (!(R > r) || !(d > 0) || !(a > 0.1 && a < Math.PI - 0.1)) return null;
    top(R);
    prof.push([R, d], [r, d + (R - r) / Math.tan(a / 2)]);
    outer = R;
  } else if (H.kind === "csink") {
    const R = (H.csDia?.v ?? 0) / 2, a = H.csAngle?.v ?? Math.PI / 2;
    if (!(R > r) || !(a > 0.1 && a < Math.PI - 0.1)) return null;
    const h = (R - r) / Math.tan(a / 2);
    if (clear > 0) prof.push([R, 0], [R, clear], [r, clear + h]); else prof.push([R, 0], [r, h]);
    outer = R;
  } else top(r);
  outer = Math.max(outer, prof[0][0]);
  const head = prof[prof.length - 1][1];
  const blind = H.end === "blind", open = holeExits(H), rough = !blind && H.end !== "through";
  const tipA = H.drillAngle?.v ?? DRILL;
  const tip = blind && !H.flat && tipA > 0.1 && tipA < Math.PI - 0.1 ? r / Math.tan(tipA / 2) : 0;
  // A blind hole has its own depth; the others get a plate deep enough to show the head and some drill.
  const depth = blind ? H.depth.v : Math.max(head + 4 * r, 6 * r);
  if (!ok(depth) || !(depth > head + 1e-6)) return null;
  const plate = open ? depth : depth + tip + Math.max(1.5 * r, 0.25 * depth);
  const fs = open && H.kind !== "slot" && H.kind !== "insert" ? sinkOf(H.farCs, r) : null;
  if (fs && plate - fs.h > head) prof.push([r, plate - fs.h], [fs.R, plate]);
  else if (open) prof.push([r, plate]);
  else prof.push([r, depth], [0, depth + tip]);
  let thread: HoleSection["thread"];
  if (H.kind === "tapped") {
    const M = (H.major ?? 0) / 2 || r * 1.18;
    const z1 = threadThrough(H) || (H.end === "through" && !H.threadDepth) ? plate : Math.min(H.threadDepth?.v ?? 2 * H.diameter.v, open ? plate : depth);
    if (z1 > head) thread = { r: M, z0: head, z1 };
  }
  const half = Math.max(outer, fs?.R ?? 0, thread?.r ?? 0) * 1.7 + r * 0.6;
  return { prof, plate, half, thread, open, rough };
}

/** Number for SVG coordinates. */
const n2 = (v: number) => (Math.round(v * 100) / 100).toString();

/**
 * The section as SVG markup: the plate hatched on both sides of the hole, the hole's outline, its centreline and
 * the thread dashed. Fits `w` × `h` px; colours come from CSS (`.hd-*` classes).
 */
export function holeDiagram(s: HoleSection, w = 220, h = 120, icon = false): string {
  const pad = icon ? 2 : 8, k = Math.min((w - 2 * pad) / (2 * s.half), (h - 2 * pad) / s.plate);
  const cx = w / 2, y0 = (h - s.plate * k) / 2;
  const X = (r: number) => n2(cx + r * k), Y = (z: number) => n2(y0 + z * k);
  // The hole's full outline: right half down, then the left half back up.
  const right = s.prof, left = [...s.prof].reverse().map(([r, z]) => [-r, z] as [number, number]);
  const holeD = [...right, ...left].map(([r, z], i) => `${i ? "L" : "M"}${X(r)} ${Y(z)}`).join("") + "Z";
  const plateD = `M${X(-s.half)} ${Y(0)}H${X(s.half)}V${Y(s.plate)}H${X(-s.half)}Z`;
  const line = (r: number, z0: number, z1: number) => `M${X(r)} ${Y(z0)}V${Y(z1)}`;
  const th = s.thread ? `<path class="hd-thread" d="${line(s.thread.r, s.thread.z0, s.thread.z1)}${line(-s.thread.r, s.thread.z0, s.thread.z1)}"/>` : "";
  // A schematic depth (up to something) gets a wavy break line across the bottom.
  const wave = s.rough ? (() => { const z = s.plate, a = s.plate * 0.04, steps = 8; let d = ""; for (let i = 0; i <= steps; i++) { const r = -s.half + (2 * s.half * i) / steps; d += `${i ? "L" : "M"}${X(r)} ${Y(z + (i % 2 ? a : -a))}`; } return `<path class="hd-break" d="${d}"/>`; })() : "";
  return `<svg class="${icon ? "hole-icon" : "hole-diagram"}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">`
    + (icon ? "" : `<defs><pattern id="hd-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" class="hd-hl"/></pattern></defs>`)
    + `<path class="hd-mat" fill-rule="evenodd" d="${plateD}${holeD}"/>`
    + `<path class="hd-edge" d="${holeD}"/>${th}${wave}`
    + `<path class="hd-axis" d="M${n2(cx)} ${n2(y0 - 4)}V${n2(y0 + s.plate * k + 4)}"/></svg>`;
}

/** Kinds in the order the panel shows them. */
export const HOLE_KINDS: HoleFeature["kind"][] = ["simple", "clear", "cbore", "csink", "cdrill", "tapped", "slot", "insert"];

/** A small pictogram of a hole kind: a typical one of that kind (through or blind), drawn like the section. */
export function holeIcon(kind: HoleFeature["kind"], w = 34, h = 26): string {
  const H: HoleFeature = { id: "", type: "hole", name: "", pts: [], kind, diameter: { v: 3 }, end: "blind", depth: { v: 4.5 } };
  if (kind === "cbore") { H.cbDia = { v: 5.6 }; H.cbDepth = { v: 1.6 }; }
  if (kind === "csink") { H.csDia = { v: 6 }; H.end = "through"; }
  if (kind === "cdrill") { H.cdDia = { v: 4.8 }; H.cdDepth = { v: 1.4 }; }
  if (kind === "clear") H.end = "through";
  if (kind === "tapped") { H.threadDepth = { v: 3.5 }; H.size = "M"; H.major = 3.8; }
  // A slot reads best from above: an obround in a plate.
  if (kind === "slot") return `<svg class="hole-icon" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><path class="hd-mat" fill-rule="evenodd" d="M2 2H${w - 2}V${h - 2}H2ZM${w / 2 - 7} ${h / 2 - 4}H${w / 2 + 7}A4 4 0 0 1 ${w / 2 + 7} ${h / 2 + 4}H${w / 2 - 7}A4 4 0 0 1 ${w / 2 - 7} ${h / 2 - 4}Z"/>`
    + `<path class="hd-edge" d="M${w / 2 - 7} ${h / 2 - 4}H${w / 2 + 7}A4 4 0 0 1 ${w / 2 + 7} ${h / 2 + 4}H${w / 2 - 7}A4 4 0 0 1 ${w / 2 - 7} ${h / 2 - 4}Z"/></svg>`;
  // A heat-set insert: a flat-bottomed hole with the insert's thread in it.
  if (kind === "insert") { H.flat = true; H.kind = "tapped"; H.major = 3.8; H.threadDepth = { v: 5 }; }
  const s = holeSection(H);
  return s ? holeDiagram(s, w, h, true) : "";
}
