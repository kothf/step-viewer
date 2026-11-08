// Alternate position views (FR-DRW-015): the move of a component in view axes, its request key, phantom lines.
import { test } from "node:test";
import assert from "node:assert/strict";
import { viewAxes, type Projection, type V3 } from "../../src/kernel/drawing";
import { altPrims, placement } from "../../src/drawing/compose";
import { sheetDxf, svgBody } from "../../src/drawing/output";
import { altReq, altTf, viewDir } from "../../src/drawing/views";
import type { DrawingView, Sheet } from "../../src/drawing/types";

const near = (a: number, b: number, e = 1e-9) => assert.ok(Math.abs(a - b) < e, `${a} ≠ ${b}`);
const apply = (t: number[], p: V3): V3 => [0, 1, 2].map(i => t[4 * i] * p[0] + t[4 * i + 1] * p[1] + t[4 * i + 2] * p[2] + t[4 * i + 3]) as V3;
const sheet = { id: "s", name: "Sheet1", size: "A3", scale: [1, 1], projection: "first", views: [] } as unknown as Sheet;
const view = (extra: Partial<DrawingView>): DrawingView => ({ id: "v", name: "Top", orient: "top", x: 200, y: 150, ...extra });

test("altTf turns about the view normal through c, then moves along the view axes", () => {
  const v = view({});
  const { x, y, n } = viewAxes(viewDir(sheet, v));
  const at = (u: number, w: number, d = 0): V3 => [0, 1, 2].map(i => x[i] * u + y[i] * w + n[i] * d) as V3;
  const t = altTf(x, y, n, { du: 5, dv: -3, ang: 90, c: [10, 0] });
  // The pivot only moves by (du, dv); a point 1 mm right of it ends up 1 mm above it; depth is kept.
  const c = apply(t, at(10, 0)), q = apply(t, at(11, 0, 7));
  const P = (p: V3) => [p[0] * x[0] + p[1] * x[1] + p[2] * x[2], p[0] * y[0] + p[1] * y[1] + p[2] * y[2], p[0] * n[0] + p[1] * n[1] + p[2] * n[2]];
  const [cu, cv] = P(c), [qu, qv, qd] = P(q);
  near(cu, 15); near(cv, -3);
  near(qu, 15); near(qv, -2); near(qd, 7);
  // Without a turn it is a plain move.
  const m = altTf(x, y, n, { du: 2, dv: 4 });
  const [mu, mv] = P(apply(m, at(1, 1)));
  near(mu, 3); near(mv, 5);
});

test("altReq: none without moves or on a section; a detail takes its parent's; the key follows the move", () => {
  const top = view({ alt: [{ comp: "c2", du: 0, dv: 30 }] });
  const det = view({ id: "d", kind: "detail", parent: "v", c: [0, 0], r: 10 });
  const s = { ...sheet, views: [top, det] } as Sheet;
  assert.equal(altReq(s, view({})), null);
  assert.equal(altReq(s, view({ kind: "section", alt: top.alt })), null);
  const r = altReq(s, top)!;
  assert.equal(r.moves.length, 1);
  assert.equal(r.moves[0].comp, "c2");
  assert.equal(altReq(s, det)!.key, r.key);
  assert.notEqual(altReq(s, view({ alt: [{ comp: "c2", du: 0, dv: 31 }] }))!.key, r.key);
});

test("phantom lines: thin long-dash double-dot in SVG, own DXF layer and linetype", () => {
  const v = view({});
  const proj = { vis: [{ k: "a", c: 0, o: [30, 30], r: 4, a0: 0, a1: 2 * Math.PI }, { k: "l", c: 0, p: [0, 0, 10, 0] }], hid: [{ k: "l", c: 0, p: [0, 1, 10, 1] }], box: [0, 0, 34, 34] } as unknown as Projection;
  const pl = placement(sheet, v, proj, null);
  const prims = altPrims(v, proj, pl);
  assert.equal(prims.length, 2);
  assert.ok(prims.every(p => "pen" in p && p.pen === "phantom" && p.layer === "PHANTOM"));
  assert.match(svgBody(prims, 297), /stroke-dasharray="12 1\.5 1\.5 1\.5 1\.5 1\.5"/);
  const dxf = sheetDxf(prims, 420, 297);
  assert.match(dxf, /PHANTOM/);
  assert.match(dxf, /\n8\nPHANTOM\n/);
});
