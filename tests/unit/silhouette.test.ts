// Silhouette edges (1.637.0): the outline of a round face seen side-on, which sketch dimensions, relations and
// Convert Entities take as an edge, and which the kernel keeps on the face after every rebuild.
import { test } from "node:test";
import assert from "node:assert/strict";
import { silhouettes, type RoundFace } from "../../src/sketch/silhouette";
import { Modeller } from "../../src/kernel/model";
import type { Feature, PartDoc, SketchFeature, SkEnt, V3 } from "../../src/model/types";
import { occ } from "./occ";

const close = (a: number, b: number, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} ≠ ${b}`);

/** A faceted cylinder along Y (centre c, radius r, y0..y1) over angles a0..a1 about Y, measured from +X towards +Z. */
function cylinder(c: V3, r: number, y0: number, y1: number, a0 = 0, a1 = Math.PI * 2, n = 48): number[] {
  const P = (a: number, y: number): V3 => [c[0] + r * Math.cos(a), y, c[2] + r * Math.sin(a)];
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    const a = a0 + ((a1 - a0) * k) / n, b = a0 + ((a1 - a0) * (k + 1)) / n;
    out.push(...P(a, y0), ...P(b, y0), ...P(b, y1), ...P(a, y0), ...P(b, y1), ...P(a, y1));
  }
  return out;
}

test("a pin lying along the plane shows two outline lines; a seam on one side is an edge already", () => {
  const c: V3 = [20, -12.5, 24];
  const face: RoundFace = { kind: "cylinder", axis: [0, 1, 0], center: c, radius: 6, tris: cylinder(c, 6, -25, 0), edges: [] };
  const lines = silhouettes(face, [0, 0, 1]);
  assert.equal(lines.length, 2);
  const xs = lines.map(l => l.start[0]).sort((a, b) => a - b);
  close(xs[0], 14); close(xs[1], 26);
  for (const l of lines) { close(Math.min(l.start[1], l.end[1]), -25); close(Math.max(l.start[1], l.end[1]), 0); close(l.start[2], 24); }
  // The seam at x = 26 is a model edge: only the other outline is added.
  const seam = { type: "line", start: [26, -25, 24] as V3, end: [26, 0, 24] as V3 };
  const one = silhouettes({ ...face, edges: [seam] }, [0, 0, 1]);
  assert.equal(one.length, 1);
  close(one[0].start[0], 14);
  // Seen along the axis there is no outline line (the end circles are its edges).
  assert.equal(silhouettes(face, [0, 1, 0]).length, 0);
});

test("a fillet's outline is its tangent edges; a partial face shows only the outline it covers", () => {
  const c: V3 = [0, 0, 0];
  // A quarter round over angles 90°..180° (top left): seen from above, the outline at x = −6 is on it.
  const q: RoundFace = { kind: "cylinder", axis: [0, 1, 0], center: c, radius: 6, tris: cylinder(c, 6, 0, 10, Math.PI / 2, Math.PI), edges: [] };
  const lines = silhouettes(q, [0, 0, 1]);
  assert.equal(lines.length, 1);
  close(lines[0].start[0], -6, 1e-3);
  // With its tangent edges given (a fillet), that outline is the edge at angle 180°: nothing to add.
  const tangent = { type: "line", start: [-6, 0, 0] as V3, end: [-6, 10, 0] as V3 };
  assert.equal(silhouettes({ ...q, edges: [tangent] }, [0, 0, 1]).length, 0);
  // A face over 30°..150° covers neither outline.
  assert.equal(silhouettes({ ...q, tris: cylinder(c, 6, 0, 10, Math.PI / 6, (5 * Math.PI) / 6) }, [0, 0, 1]).length, 0);
});

test("a cone along the plane: outline lines from radius to radius; a sphere: its circle", () => {
  // Cone along X from x = 0 (r 2) to x = 10 (r 7), faceted.
  const tris: number[] = [], n = 64;
  const P = (a: number, x: number): V3 => { const r = 2 + 0.5 * x; return [x, r * Math.cos(a), r * Math.sin(a)]; };
  for (let k = 0; k < n; k++) { const a = (2 * Math.PI * k) / n, b = (2 * Math.PI * (k + 1)) / n; tris.push(...P(a, 0), ...P(b, 0), ...P(b, 10), ...P(a, 0), ...P(b, 10), ...P(a, 10)); }
  const cone = silhouettes({ kind: "cone", axis: [1, 0, 0], center: [5, 0, 0], tris, edges: [] }, [0, 0, 1]);
  assert.equal(cone.length, 2);
  for (const l of cone) {
    const [a, b] = l.start[0] < l.end[0] ? [l.start, l.end] : [l.end, l.start];
    close(a[0], 0, 1e-6); close(Math.abs(a[1]), 2, 1e-3); close(b[0], 10, 1e-6); close(Math.abs(b[1]), 7, 1e-3);
  }
  // A faceted sphere of radius 5: one outline circle round its centre.
  const st: number[] = [], S = (u: number, v: number): V3 => [5 * Math.cos(v) * Math.cos(u), 5 * Math.cos(v) * Math.sin(u), 5 * Math.sin(v)];
  for (let i = 0; i < 48; i++) for (let j = 0; j < 24; j++) {
    const u0 = (2 * Math.PI * i) / 48, u1 = (2 * Math.PI * (i + 1)) / 48, v0 = -Math.PI / 2 + (Math.PI * j) / 24, v1 = -Math.PI / 2 + (Math.PI * (j + 1)) / 24;
    st.push(...S(u0, v0), ...S(u1, v0), ...S(u1, v1), ...S(u0, v0), ...S(u1, v1), ...S(u0, v1));
  }
  const sph = silhouettes({ kind: "sphere", center: [0, 0, 0], radius: 5, tris: st, edges: [] }, [0, 0, 1]);
  assert.equal(sph.length, 1);
  assert.equal(sph[0].type, "circle");
  close(sph[0].radius!, 5);
});

const doc = (features: Feature[]): PartDoc => ({ schema: 1, kind: "part", id: "d", name: "t", units: { length: "mm", decimals: 2 }, props: {}, features, rollback: null });

test("a sketch line on a pin's outline follows the pin when its radius changes (EdgeRef.sil)", async () => {
  const m = new Modeller(await occ());
  const P = (id: string, x: number, y: number): SkEnt => ({ id, t: "point", x, y });
  const block: SketchFeature = { id: "s1", type: "sketch", name: "s1", plane: { std: "XY" }, rels: [], dims: [], ents: [
    P("a", -50, -30), P("b", 50, -30), P("c", 50, 30), P("d", -50, 30),
    { id: "l1", t: "line", a: "a", b: "b" }, { id: "l2", t: "line", a: "b", b: "c" }, { id: "l3", t: "line", a: "c", b: "d" }, { id: "l4", t: "line", a: "d", b: "a" }] };
  const ex: Feature = { id: "f1", type: "extrude", name: "Extrude1", sketch: "s1", op: "boss", end: "blind", depth: { v: 20 } };
  const pin = (r: number): SketchFeature => ({ id: "s2", type: "sketch", name: "s2", plane: { std: "XZ" }, rels: [], dims: [],
    ents: [P("o", 20, 24), { id: "k", t: "circle", c: "o", r }] });
  const ex2: Feature = { id: "f2", type: "extrude", name: "Pin", sketch: "s2", op: "boss", end: "blind", depth: { v: 25 } };
  const probe = m.evaluate(doc([block, ex, pin(6), ex2]));
  const name = probe.body!.names.find(x => x.startsWith("f2:side"))!;
  assert.ok(name, "the pin's round face is named");
  // On the block's top: a line held on the pin's outline (drawn off it) and one on the block's right edge.
  const sk: SketchFeature = { id: "s3", type: "sketch", name: "s3", plane: { face: { name: "f1:end" } }, dims: [], ents: [
    P("q1", 0, 0), P("q2", 0, 10), { id: "ln", t: "line", a: "q1", b: "q2", cons: true },
    P("e1", 40, 0), P("e2", 40, 10), { id: "edge", t: "line", a: "e1", b: "e2", cons: true }],
    rels: [
      { id: "r1", t: "fix", e: ["ln"], ext: { faces: [name, name], hint: [14, -12.5, 24], sil: true } },
      { id: "r2", t: "fix", e: ["edge"], ext: { faces: ["f1:end", "f1:side:l2"] } },
    ] };
  const gap = (s: SketchFeature) => {
    const pt = (id: string) => s.ents.find(e => e.id === id) as SkEnt & { t: "point" };
    const a = pt("q1"), b = pt("q2"), e = pt("e1"), dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy);
    return { d: Math.abs((e.x - a.x) * dy - (e.y - a.y) * dx) / l, len: l, dangling: s.rels.some(r => r.dangling) };
  };
  for (const r of [6, 7]) {
    const out = m.evaluate(doc([block, ex, pin(r), ex2, sk]));
    const moved = out.sketches.s3;
    assert.ok(moved, "the sketch follows the model");
    const g = gap(moved);
    assert.equal(g.dangling, false);
    close(g.d, 50 - (20 - r), 1e-6);
    // Its length is the pin's: 25 mm along Y.
    close(g.len, 25, 1e-6);
  }
});
