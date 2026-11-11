import { test } from "node:test";
import assert from "node:assert/strict";
import { holeCallout, holeDiagram, holeIcon, holeSection, HOLE_KINDS } from "../../src/model/holeView";
import type { HoleFeature } from "../../src/model/types";

const hole = (o: Partial<HoleFeature>): HoleFeature => ({ id: "h", type: "hole", name: "Hole", pts: [[0, 0]], kind: "simple", diameter: { v: 6 }, end: "blind", depth: { v: 10 }, ...o });
const f = (v: number) => String(Math.round(v * 100) / 100), fa = f, label = (s: string) => s;

test("callout: blind, through, tapped, counterbore with head clearance, countersinks", () => {
  assert.deepEqual(holeCallout(hole({}), f, fa, label), ["Ø6 ↧10"]);
  assert.deepEqual(holeCallout(hole({ end: "through" }), f, fa, label, 4), ["4× Ø6 THRU"]);
  assert.deepEqual(holeCallout(hole({ kind: "tapped", size: "M6", diameter: { v: 5 }, threadDepth: { v: 12 }, depth: { v: 15 } }), f, fa, label), ["Ø5 ↧15", "M6-6H ↧12"]);
  assert.deepEqual(holeCallout(hole({ kind: "tapped", size: "M6", diameter: { v: 5 }, end: "through", threadDepth: { v: 12 } }), f, fa, label, 1, true), ["Ø5 THRU", "M6-6H THRU"]);
  assert.deepEqual(holeCallout(hole({ kind: "cbore", cbDia: { v: 11 }, cbDepth: { v: 6 }, headClear: { v: 0.5 }, underCs: { dia: { v: 7 }, angle: { v: Math.PI / 2 } } }), f, fa, label), ["Ø6 ↧10", "⌴Ø11 ↧6.5", "⌵Ø7 × 90° UNDER HEAD"]);
  assert.deepEqual(holeCallout(hole({ end: "through", farCs: { dia: { v: 8 }, angle: { v: Math.PI / 2 } } }), f, fa, label), ["Ø6 THRU", "⌵Ø8 × 90° FAR SIDE"]);
});

test("section: blind hole ends in the drill point, through hole leaves the plate", () => {
  const b = holeSection(hole({}))!;
  assert.equal(b.open, false);
  const tip = b.prof[b.prof.length - 1];
  assert.equal(tip[0], 0);
  assert.ok(Math.abs(tip[1] - (10 + 3 / Math.tan(59 * Math.PI / 180))) < 1e-9);
  assert.ok(b.plate > tip[1]);
  const flat = holeSection(hole({ flat: true }))!;
  assert.equal(flat.prof[flat.prof.length - 1][1], 10);
  const t = holeSection(hole({ end: "through" }))!;
  assert.equal(t.open, true);
  assert.deepEqual(t.prof[t.prof.length - 1], [3, t.plate]);
  assert.equal(holeSection(hole({ end: "next" }))!.rough, true);
});

test("section: counterbore, countersink, thread", () => {
  const c = holeSection(hole({ kind: "cbore", cbDia: { v: 11 }, cbDepth: { v: 6 } }))!;
  assert.deepEqual(c.prof.slice(0, 3), [[5.5, 0], [5.5, 6], [3, 6]]);
  const s = holeSection(hole({ kind: "csink", csDia: { v: 12 }, csAngle: { v: Math.PI / 2 }, end: "through" }))!;
  assert.deepEqual(s.prof[0], [6, 0]);
  assert.ok(Math.abs(s.prof[1][1] - 3) < 1e-9);
  const th = holeSection(hole({ kind: "tapped", size: "M6", major: 6, diameter: { v: 5 }, threadDepth: { v: 8 }, depth: { v: 12 } }))!;
  assert.deepEqual(th.thread, { r: 3, z0: 0, z1: 8 });
  assert.equal(holeSection(hole({ kind: "cbore" })), null);
  const rm = holeSection(hole({ kind: "tapped", size: "M6", major: 6, diameter: { v: 5 }, threadDepth: { v: 8 }, depth: { v: 12 }, threadMode: "remove" }))!;
  assert.deepEqual(rm.prof.slice(0, 3), [[3, 0], [3, 8], [2.5, 8]]);
  assert.equal(rm.thread, undefined);
  assert.deepEqual(holeCallout(hole({ kind: "tapped", size: "M6", diameter: { v: 5 }, threadDepth: { v: 8 }, depth: { v: 12 }, tclass: "6G" }), f, fa, label), ["Ø5 ↧12", "M6-6G ↧8"]);
  assert.equal(holeSection(hole({ diameter: { v: 0 } })), null);
});

test("diagram and icons are SVG for every kind", () => {
  const svg = holeDiagram(holeSection(hole({ end: "next" }))!);
  assert.match(svg, /^<svg class="hole-diagram"/);
  assert.match(svg, /hd-break/);
  for (const k of HOLE_KINDS) assert.match(holeIcon(k), /^<svg class="hole-icon"/, k);
});
