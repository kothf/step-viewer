// Advanced Hole (FR-FT-051, SolidWorks' Advanced Hole): a hole built from elements stacked from the face down
// (near side) and from the far face in (far side). Pure: the kernel, the panel picture and the callout share it.

import type { HoleElem, HoleFeature } from "./types";
import { headPocket, holeSize, majorOf } from "./holes";

/** Element kinds in the order the panel lists them. */
export const ELEM_KINDS: HoleElem["t"][] = ["cbore", "csink", "straight", "tapped"];

/** One thread of an element: tap drill radius `r`, major radius `R`, from z0 to z1 (z grows into the material). */
export interface AdvThread { r: number; R: number; z0: number; z1: number; pitch?: number }

export interface AdvProfile {
  /** (r, z) from the rim on the face to the axis at the bottom, or to the far face's rim when the hole leaves there. */
  prof: [number, number][];
  threads: AdvThread[];
  /** Widest radius. */
  outer: number;
  /** Where the main hole starts and where the far side elements start (z). */
  zMain: number;
  zFar: number;
}

const rad = (e: HoleElem) => e.dia.v / 2;
const ang = (e: HoleElem) => e.angle?.v ?? Math.PI / 2;
const sinkH = (e: HoleElem, inner: number) => (rad(e) - inner) / Math.tan(ang(e) / 2);

/** Why an element stack does not make a hole, as a fixed English message; null when it does. */
export function advProblem(near: HoleElem[] | undefined, far: HoleElem[] | undefined): string | null {
  if (!near?.length) return "Add at least one near side element.";
  const main = near[near.length - 1];
  if (main.t !== "straight" && main.t !== "tapped") return "The last near side element is the main hole: make it straight or tapped.";
  const all = [...near, ...(far ?? [])];
  if (all.some(e => !(e.dia.v > 1e-6))) return "Every element needs a diameter more than 0.";
  for (const e of all) if (e.t === "csink" && !(ang(e) > 0.1 && ang(e) < Math.PI - 0.1)) return "A countersink angle must be between 6° and 174°.";
  if (near.slice(0, -1).some(e => e.t !== "csink" && !((e.depth?.v ?? 0) > 1e-6)) || (far ?? []).some(e => e.t !== "csink" && !((e.depth?.v ?? 0) > 1e-6))) return "Every counterbore, straight and tapped element needs a depth more than 0.";
  const inner = (list: HoleElem[], i: number, after: number) => (i + 1 < list.length ? rad(list[i + 1]) : after);
  for (let i = 0; i < near.length - 1; i++) if (near[i].t === "csink" && !(rad(near[i]) > inner(near, i, rad(main)) + 1e-9)) return "A countersink must be wider than the element after it.";
  const fl = far ?? [];
  for (let j = 0; j < fl.length; j++) if (fl[j].t === "csink" && !(rad(fl[j]) > inner(fl, j, rad(main)) + 1e-9)) return "A countersink must be wider than the element after it.";
  return null;
}

/** Height of each element along the axis (near: all but the main hole; far: all), countersinks by their cone. */
function heights(list: HoleElem[], after: number): number[] {
  return list.map((e, i) => (e.t === "csink" ? sinkH(e, i + 1 < list.length ? rad(list[i + 1]) : after) : e.depth?.v ?? 0));
}

/** The near side elements' length before the main hole, and the far side's. */
export function advStack(near: HoleElem[], far: HoleElem[]): { top: number; bottom: number } {
  const r0 = rad(near[near.length - 1]);
  return { top: heights(near.slice(0, -1), r0).reduce((a, b) => a + b, 0), bottom: heights(far, r0).reduce((a, b) => a + b, 0) };
}

/**
 * The hole's half section: `depth` = blind depth or the far face, `exits` = the hole leaves the material there
 * (far side elements apply), `tip` = drill point height of a blind hole. Throws the `advProblem` message when the
 * elements do not fit (the main hole must keep some length between the near and far side elements).
 */
export function advProfile(near: HoleElem[], far: HoleElem[] | undefined, depth: number, exits: boolean, tip = 0): AdvProfile {
  const bad = advProblem(near, far);
  if (bad) throw new Error(bad);
  const fl = exits ? far ?? [] : [];
  const main = near[near.length - 1], r0 = rad(main);
  const prof: [number, number][] = [], threads: AdvThread[] = [];
  const push = (r: number, z: number) => { const l = prof[prof.length - 1]; if (!l || Math.abs(l[0] - r) > 1e-12 || Math.abs(l[1] - z) > 1e-12) prof.push([r, z]); };
  const thread = (e: HoleElem, z0: number, z1: number) => { if (e.t === "tapped" && e.major && e.major / 2 > rad(e) && z1 > z0) threads.push({ r: rad(e), R: e.major / 2, z0, z1, ...(e.pitch ? { pitch: e.pitch } : {}) }); };
  let z = 0;
  const hn = heights(near.slice(0, -1), r0);
  near.slice(0, -1).forEach((e, i) => {
    const h = hn[i];
    if (e.t === "csink") push(rad(e), z), push(i + 1 < near.length ? rad(near[i + 1]) : r0, z + h);
    else { push(rad(e), z); push(rad(e), z + h); thread(e, z, z + h); }
    z += h;
  });
  const zMain = z;
  const hf = heights(fl, r0), zFar = depth - hf.reduce((a, b) => a + b, 0);
  if (!(zFar > zMain + 1e-6)) throw new Error("The elements are deeper than the hole: make the depth larger or the elements shorter.");
  push(r0, zMain);
  if (main.t === "tapped") thread(main, zMain, Math.min(zFar, zMain + (main.depth?.v ?? zFar - zMain)));
  if (!exits) { push(r0, depth); push(0, depth + tip); }
  else {
    push(r0, zFar);
    let zz = zFar;
    for (let j = fl.length - 1; j >= 0; j--) {
      const e = fl[j], h = hf[j], rin = j + 1 < fl.length ? rad(fl[j + 1]) : r0;
      if (e.t === "csink") { push(rin, zz); push(rad(e), zz + h); }
      else { push(rad(e), zz); push(rad(e), zz + h); thread(e, zz, zz + h); }
      zz += h;
    }
  }
  const outer = Math.max(...prof.map(p => p[0]));
  return { prof, threads, outer, zMain, zFar };
}

/** An element of `t` sized for `size` (ISO table): head pockets for the screw, clearance or tap drill for the bore. */
export function elemFor(t: HoleElem["t"], size: string | undefined, depth?: number): HoleElem {
  const h = holeSize(size);
  if (!h) {
    const d = 6;
    if (t === "csink") return { t, dia: { v: 2 * d }, angle: { v: Math.PI / 2 } };
    if (t === "cbore") return { t, dia: { v: 1.7 * d }, depth: { v: d } };
    if (t === "tapped") return { t, dia: { v: 5 }, depth: { v: depth ?? 12 }, major: 6, pitch: 1 };
    return { t, dia: { v: d }, depth: { v: depth ?? d } };
  }
  if (t === "cbore") { const p = headPocket(h.size, undefined, "cbore")!; return { t, size: h.size, dia: { v: p[0] }, depth: { v: p[1] } }; }
  if (t === "csink") { const p = headPocket(h.size, undefined, "csink")!; return { t, size: h.size, dia: { v: p[0] }, angle: { v: (p[1] * Math.PI) / 180 } }; }
  if (t === "tapped") { const M = majorOf(h); return { t, size: h.size, dia: { v: h.tap }, depth: { v: depth ?? Math.round(M * 20) / 10 }, major: M, pitch: h.pitch }; }
  return { t, size: h.size, dia: { v: h.clear.normal }, depth: { v: depth ?? Math.round(h.clear.normal * 10) / 10 } };
}

/** The stack a new Advanced Hole starts with: an M6 socket head counterbore over its clearance hole. */
export function advDefault(size = "M6"): HoleElem[] {
  const main = elemFor("straight", size);
  delete main.depth;
  return [elemFor("cbore", size), main];
}

/** Keeps `diameter` (read by drawings, recognition and the title) on the main hole. */
export function advSync(f: HoleFeature) {
  const main = f.near?.[f.near.length - 1];
  if (main) f.diameter = { v: main.dia.v };
}

/** Callout lines: the main hole first with its end, its thread, then the near side elements top down, then the far side ones. */
export function advCallout(H: HoleFeature, f: (v: number) => string, fa: (v: number) => string, label: (s: string) => string, n: string, end: string): string[] {
  const near = H.near ?? [], far = (H.end === "through" || H.end === "next" || H.end === "upto") ? H.far ?? [] : [];
  const main = near[near.length - 1];
  if (!main) return [`${n}Ø${f(H.diameter.v)}${end}`];
  const tclass = (s: string | undefined) => (s && / UN[CF]$/.test(s) ? "2B" : "6H");
  const tsize = (e: HoleElem) => e.size ?? (e.major ? `M${f(e.major)}` : "");
  const lines = [`${n}Ø${f(main.dia.v)}${end}`];
  if (main.t === "tapped" && tsize(main)) lines.push(`${tsize(main)}-${tclass(main.size)}${main.depth ? ` ↧${f(main.depth.v)}` : ""}`);
  const line = (e: HoleElem, tail: string) => {
    const t = tail ? ` ${label(tail)}` : "";
    if (e.t === "cbore") return [`⌴Ø${f(e.dia.v)}${e.depth ? ` ↧${f(e.depth.v)}` : ""}${t}`];
    if (e.t === "csink") return [`⌵Ø${f(e.dia.v)} × ${fa(ang(e) * 180 / Math.PI)}°${t}`];
    if (e.t === "tapped") return [`Ø${f(e.dia.v)}${e.depth ? ` ↧${f(e.depth.v)}` : ""}${t}`, ...(tsize(e) ? [`${tsize(e)}-${tclass(e.size)}${e.depth ? ` ↧${f(e.depth.v)}` : ""}${t}`] : [])];
    return [`Ø${f(e.dia.v)}${e.depth ? ` ↧${f(e.depth.v)}` : ""}${t}`];
  };
  for (const e of near.slice(0, -1)) lines.push(...line(e, ""));
  for (const e of far) lines.push(...line(e, "FAR SIDE"));
  return lines;
}
