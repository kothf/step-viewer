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

test("tapered tap: callout without a class, 1:16 cone in the section, tapered cosmetic thread", () => {
  const H = hole({ kind: "ptap", size: "1/4-18 NPT", diameter: { v: 11.11 }, taperDia: { v: 11.63 }, major: 13.89, threadDepth: { v: 10.2 }, depth: { v: 16 } });
  assert.deepEqual(holeCallout(H, f, fa, label), ["Ø11.11 ↧16", "1/4-18 NPT ↧10.2"]);
  const s = holeSection(H)!;
  assert.deepEqual(s.prof[0], [11.63 / 2, 0]);
  // The cone narrows 1:32 on the radius until it meets the drill.
  const zc = (11.63 / 2 - 11.11 / 2) * 32;
  assert.ok(s.prof.some(([r, z]) => Math.abs(r - 11.11 / 2) < 1e-9 && Math.abs(z - zc) < 1e-9), JSON.stringify(s.prof));
  assert.ok(s.thread && s.thread.r1! < s.thread.r && Math.abs(s.thread.z1 - 10.2) < 1e-9);
  assert.ok(holeIcon("ptap").includes("hd-thread"));
  assert.ok(HOLE_KINDS.includes("ptap"));
  // Remove thread: the cone starts at the major diameter, and no cosmetic thread is drawn.
  const rm = holeSection({ ...H, threadMode: "remove" })!;
  assert.deepEqual(rm.prof[0], [13.89 / 2, 0]);
  assert.equal(rm.thread, undefined);
});

test("counterbored and countersunk slots get the head pocket in the callout and the section", () => {
  const cb = hole({ kind: "slot", slotLen: { v: 20 }, slotHead: "cbore", cbDia: { v: 11 }, cbDepth: { v: 6 }, end: "through" });
  assert.deepEqual(holeCallout(cb, f, fa, label), ["Ø6 THRU", "⌴Ø11 ↧6"]);
  assert.deepEqual(holeSection(cb)!.prof.slice(0, 3), [[5.5, 0], [5.5, 6], [3, 6]]);
  const cs = hole({ kind: "slot", slotLen: { v: 20 }, slotHead: "csink", csDia: { v: 12 }, end: "through" });
  assert.deepEqual(holeCallout(cs, f, fa, label), ["Ø6 THRU", "⌵Ø12 × 90°"]);
  // A straight slot keeps the plain profile even with stale pocket values.
  assert.deepEqual(holeCallout(hole({ kind: "slot", cbDia: { v: 11 }, cbDepth: { v: 6 } }), f, fa, label), ["Ø6 ↧10"]);
});

test("Advanced Hole: callout lists the main hole then each element, the section stacks them, the icon draws (FR-FT-051)", async () => {
  const { advProfile, advDefault, elemFor, advProblem } = await import("../../src/model/advHole");
  const H = hole({ kind: "adv", end: "through", diameter: { v: 6.6 }, near: advDefault("M6"), far: [elemFor("csink", "M6")] });
  assert.deepEqual(holeCallout(H, f, fa, label, 2), ["2× Ø6.6 THRU", "⌴Ø11 ↧6.4", "⌵Ø13.44 × 90° FAR SIDE"]);
  const T = hole({ kind: "adv", near: [elemFor("csink", "M8"), elemFor("tapped", "M6")], depth: { v: 20 } });
  assert.deepEqual(holeCallout(T, f, fa, label), ["Ø5 ↧20", "M6-6H ↧12", `⌵Ø${f(elemFor("csink", "M8").dia.v)} × 90°`]);
  const s = holeSection(H)!;
  assert.equal(s.open, true);
  assert.deepEqual(s.prof[0], [5.5, 0]);
  assert.deepEqual(s.prof[s.prof.length - 1], [6.72, s.plate]);
  const ts = holeSection(T)!;
  assert.equal(ts.threads?.length, 1);
  assert.equal(ts.threads![0].r, 3);
  // Profile: the far countersink cone starts on the main hole and opens onto the far face.
  const a = advProfile(H.near!, H.far, 20, true);
  const [p1, p2] = a.prof.slice(-2);
  assert.ok(p1[0] === 3.3 && Math.abs(p1[1] - (20 - 3.42)) < 1e-9 && p2[0] === 6.72 && p2[1] === 20, JSON.stringify(a.prof));
  assert.throws(() => advProfile(H.near!, H.far, 8, true), /deeper than the hole/);
  assert.equal(advProblem([elemFor("cbore", "M6")], []), "The last near side element is the main hole: make it straight or tapped.");
  assert.ok(HOLE_KINDS.includes("adv") && holeIcon("adv").includes("<svg"));
});
