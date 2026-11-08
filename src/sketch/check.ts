// Check sketch for feature (FR-SK-073): says before a feature is started whether a sketch suits it,
// and points at every place that does not (all open ends and branch points, not only the first).
import type { SketchFeature, SkEnt, V2 } from "../model/types";
import { loopPolygon, sketchPath, sketchProfile } from "./profile";

/** What the sketch is for: closed regions (extrude, cut, sweep profile), one region (loft profile), revolve, a sweep path, an open contour (rib). */
export type SketchUse = "region" | "single" | "revolve" | "path" | "open";

export const SKETCH_USES: [SketchUse, string][] = [
  ["region", "Extrude / Cut"],
  ["revolve", "Revolve"],
  ["single", "Loft or sweep profile"],
  ["path", "Sweep path"],
  ["open", "Rib"],
];

/** One problem: an English message (a translation key with params) and the sketch items it is about. */
export interface CheckIssue { code: string; message: string; params?: Record<string, string | number>; ents: string[] }
export interface CheckResult { ok: boolean; issues: CheckIssue[]; summary: { message: string; params?: Record<string, string | number> } }

const CURVES = new Set(["line", "arc", "circle", "ellipse", "spline", "text"]);

export function checkSketch(sk: SketchFeature, use: SketchUse): CheckResult {
  const m = new Map(sk.ents.map(e => [e.id, e] as const));
  const P = (id: string): V2 => { const p = m.get(id); return p && p.t === "point" ? [p.x, p.y] : [NaN, NaN]; };
  const curves = sk.ents.filter(e => !e.cons && CURVES.has(e.t));
  const issues: CheckIssue[] = [];
  const done = (summary: CheckResult["summary"]): CheckResult => ({ ok: !issues.length, issues, summary: issues.length ? { message: "{n} problem|{n} problems", params: { n: issues.length } } : summary });
  if (!curves.length) {
    issues.push({ code: "E-SK-NONE", message: "The sketch has no curves (construction geometry does not count).", ents: [] });
    return done({ message: "" });
  }

  let size = 1;
  for (const e of sk.ents) if (e.t === "point") size = Math.max(size, Math.abs(e.x), Math.abs(e.y));
  const tol = size * 1e-7 + 1e-9;

  // Ends of the curves that are not closed on their own, joined by position (as the profile builder does).
  type End = { curve: string; pt: string };
  const ends: [End, End][] = [];
  for (const e of curves) {
    if (e.t === "line" || e.t === "arc") ends.push([{ curve: e.id, pt: e.a }, { curve: e.id, pt: e.b }]);
    else if (e.t === "ellipse" && e.p0 && e.p1) ends.push([{ curve: e.id, pt: e.p0 }, { curve: e.id, pt: e.p1 }]);
    else if (e.t === "spline" && !e.closed && e.pts.length >= 2) ends.push([{ curve: e.id, pt: e.pts[0] }, { curve: e.id, pt: e.pts.at(-1)! }]);
  }
  for (const e of curves) {
    if (e.t !== "line") continue;
    const a = P(e.a), b = P(e.b);
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol * 10) issues.push({ code: "E-SK-ZERO", message: "A line has zero length.", ents: [e.id] });
  }
  const nodes: { at: V2; ends: End[] }[] = [];
  for (const pair of ends) for (const end of pair) {
    const p = P(end.pt);
    const n = nodes.find(q => Math.hypot(q.at[0] - p[0], q.at[1] - p[1]) <= tol * 10);
    if (n) n.ends.push(end); else nodes.push({ at: p, ends: [end] });
  }
  const openEnds = nodes.filter(n => n.ends.length === 1);
  const branches = nodes.filter(n => n.ends.length > 2);
  const wantsClosed = use === "region" || use === "single" || use === "revolve";

  // Lines lying on top of each other, and lines crossing each other.
  const lines = curves.filter((e): e is SkEnt & { t: "line" } => e.t === "line").map(e => ({ id: e.id, a: P(e.a), b: P(e.b) }));
  const same = (p: V2, q: V2) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= tol * 10;
  const o = (p: V2, q: V2, r: V2) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const t2 = tol * tol;
  for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
    const A = lines[i], B = lines[j];
    if ((same(A.a, B.a) && same(A.b, B.b)) || (same(A.a, B.b) && same(A.b, B.a))) {
      issues.push({ code: "E-SK-DUP", message: "Two lines lie on top of each other.", ents: [A.id, B.id] });
      continue;
    }
    const d1 = o(B.a, B.b, A.a), d2 = o(B.a, B.b, A.b), d3 = o(A.a, A.b, B.a), d4 = o(A.a, A.b, B.b);
    if (((d1 > t2 && d2 < -t2) || (d1 < -t2 && d2 > t2)) && ((d3 > t2 && d4 < -t2) || (d3 < -t2 && d4 > t2))) {
      issues.push({ code: "E-SK-SELFX", message: "Two curves cross each other; split them where they cross.", ents: [A.id, B.id] });
    }
  }

  if (wantsClosed) {
    for (const n of openEnds) issues.push({ code: "E-SK-OPEN", message: "Open end: the contour is not closed here.", ents: [n.ends[0].pt, n.ends[0].curve] });
    for (const n of branches) issues.push({ code: "E-SK-BRANCH", message: "{n} curves meet at one point; a region boundary must be a simple loop.", params: { n: n.ends.length }, ents: [n.ends[0].pt, ...n.ends.map(e => e.curve)] });
    if (issues.length) return done({ message: "" });
    const prof = sketchProfile(sk);
    if (prof.error) { issues.push({ code: prof.error.code, message: prof.error.message, ents: [] }); return done({ message: "" }); }
    const n = prof.faces.length;
    if (use === "single" && n !== 1) {
      issues.push({ code: "E-SK-MANY", message: "A loft or sweep profile must be one closed region; this sketch has {n}.", params: { n }, ents: [] });
      return done({ message: "" });
    }
    if (use === "revolve") {
      const cons = sk.ents.filter((e): e is SkEnt & { t: "line" } => e.t === "line" && !!e.cons);
      if (!cons.length && !lines.length) {
        issues.push({ code: "E-REV-AXIS", message: "Revolve needs a line to turn around: draw a centerline.", ents: [] });
        return done({ message: "" });
      }
      // The profile must stay on one side of the axis; with centerlines drawn, one of them has to qualify.
      if (cons.length) {
        const pts = prof.faces.flatMap(f => loopPolygon(f.outer));
        const side = (l: SkEnt & { t: "line" }) => {
          const a = P(l.a), b = P(l.b), len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
          let pos = false, neg = false;
          for (const p of pts) { const s = o(a, b, p) / len; if (s > size * 1e-6) pos = true; else if (s < -size * 1e-6) neg = true; }
          return !(pos && neg);
        };
        if (!cons.some(side)) {
          issues.push({ code: "E-REV-CROSS", message: "The profile lies on both sides of the centerline; it must stay on one side.", ents: cons.map(l => l.id) });
          return done({ message: "" });
        }
      }
    }
    return done({ message: "Ready: {n} closed region|Ready: {n} closed regions", params: { n } });
  }

  // A sweep path or a rib: one chain of curves.
  for (const n of branches) issues.push({ code: "E-SK-BRANCH", message: "{n} curves meet at one point; a path must be one chain.", params: { n: n.ends.length }, ents: [n.ends[0].pt, ...n.ends.map(e => e.curve)] });
  if (issues.length) return done({ message: "" });
  const path = sketchPath(sk);
  if (path.error) { issues.push({ code: path.error.code, message: path.error.message, ents: [] }); return done({ message: "" }); }
  if (use === "open" && path.closed) {
    issues.push({ code: "E-RIB-CLOSED", message: "A rib needs an open contour; this one is closed.", ents: [] });
    return done({ message: "" });
  }
  return done({ message: path.closed ? "Ready: one closed chain of {n} curve|Ready: one closed chain of {n} curves" : "Ready: one open chain of {n} curve|Ready: one open chain of {n} curves", params: { n: path.segs.length } });
}
