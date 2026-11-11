import { test } from "node:test";
import assert from "node:assert/strict";
import { ANSI_UNC, ANSI_UNF, HOLE_STANDARDS, ISO_FINE, ISO_METRIC, headPocket, holeSize, majorOf, screwTypes, standardOf, threadClass, threadClasses, ANSI_NPT, ISO_RC, TAPER_STANDARDS, taperSize, taperStandardOf } from "../../src/model/holes";

test("hole sizes: ISO M1.6 to M64 coarse, fine pitches, ANSI inch UNC/UNF, each row consistent (FR-FT-051)", () => {
  assert.equal(ISO_METRIC[0].size, "M1.6");
  assert.equal(ISO_METRIC.at(-1)!.size, "M64");
  for (const [k, list] of Object.entries(HOLE_STANDARDS)) {
    assert.equal(new Set(list.map(h => h.size)).size, list.length, `${k}: repeated size`);
    let last = 0;
    for (const h of list) {
      const d = majorOf(h);
      assert.ok(d >= last, `${h.size}: out of order`);
      last = d;
      assert.ok(h.tap < d && h.tap > d - 1.3 * h.pitch, `${h.size}: tap ${h.tap} for d ${d} P ${h.pitch}`);
      assert.ok(h.clear.close > d && h.clear.close <= h.clear.normal && h.clear.normal < h.clear.loose, `${h.size}: clearance`);
      assert.ok(h.cbore[0] > h.clear.loose && h.cbore[1] >= d, `${h.size}: counterbore`);
      assert.ok(h.csink > h.clear.loose, `${h.size}: countersink`);
      assert.equal(standardOf(h.size), k);
      assert.equal(holeSize(h.size), h);
    }
  }
  const m8 = holeSize("M8x1")!;
  assert.deepEqual([m8.pitch, m8.tap, majorOf(m8), m8.clear.normal], [1, 7, 8, 9]);
  assert.equal(ISO_FINE.length, 20);
  const q = holeSize("1/4-20 UNC")!;
  assert.ok(Math.abs(majorOf(q) - 6.35) < 1e-9 && Math.abs(q.pitch - 1.27) < 1e-9 && Math.abs(q.tap - 5.105) < 1e-3 && q.csAng === 82);
  assert.equal(holeSize("1/4-28 UNF")!.tap, 5.41);
  assert.equal(ANSI_UNC.length, ANSI_UNF.length);
  assert.equal(threadClass("M6"), "6H");
  assert.equal(threadClass("M8x1"), "6H");
  assert.equal(threadClass("#10-32 UNF"), "2B");
  assert.equal(standardOf(undefined), "iso");
});

import { Modeller } from "../../src/kernel/model";
import type { Feature, HoleFeature, PartDoc, SketchFeature, SkEnt } from "../../src/model/types";
import { occ } from "./occ";

const rect = (id: string, w: number, h: number): SketchFeature => {
  const P = (k: string, x: number, y: number): SkEnt => ({ id: `${id}p${k}`, t: "point", x, y });
  return { id, type: "sketch", name: id, plane: { std: "XY" }, rels: [], dims: [], ents: [
    P("1", -w / 2, -h / 2), P("2", w / 2, -h / 2), P("3", w / 2, h / 2), P("4", -w / 2, h / 2),
    { id: `${id}l1`, t: "line", a: `${id}p1`, b: `${id}p2` }, { id: `${id}l2`, t: "line", a: `${id}p2`, b: `${id}p3` },
    { id: `${id}l3`, t: "line", a: `${id}p3`, b: `${id}p4` }, { id: `${id}l4`, t: "line", a: `${id}p4`, b: `${id}p1` }] };
};
const doc = (features: Feature[]): PartDoc => ({ schema: 1, kind: "part", id: "d", name: "t", units: { length: "mm", decimals: 2 }, props: {}, features, rollback: null });

test("hole options: near/far side and under head countersinks, head clearance cut the expected volume (FR-FT-051)", async () => {
  const m = new Modeller(await occ());
  const plate = 100 * 60 * 20, PI = Math.PI;
  const cone = (R: number, r: number, h: number) => (PI * h / 3) * (R * R + R * r + r * r);
  const sink = (d: number) => ({ dia: { v: d }, angle: { v: PI / 2 } });
  const run = (h: Partial<HoleFeature>) => {
    const f = { id: "h", type: "hole", name: "Hole1", plane: { face: { name: "f1:end" } }, pts: [[0, 0]], kind: "simple", diameter: { v: 10 }, end: "through", depth: { v: 10 }, ...h } as Feature;
    const r = m.evaluate(doc([rect("s1", 100, 60), { id: "f1", type: "extrude", name: "E", sketch: "s1", op: "boss", end: "blind", depth: { v: 20 } }, f]));
    assert.ok(r.statuses.every(s => s.ok), JSON.stringify(r.statuses));
    return plate - m.props(r.body!).volume;
  };
  const near = (a: number, b: number, msg: string) => assert.ok(Math.abs(a - b) < 1e-3 * b, `${msg}: ${a} vs ${b}`);
  near(run({ nearCs: sink(14) }), PI * 25 * 18 + cone(7, 5, 2), "near side");
  near(run({ farCs: sink(14) }), PI * 25 * 18 + cone(7, 5, 2), "far side");
  near(run({ nearCs: sink(14), farCs: sink(12) }), PI * 25 * 17 + cone(7, 5, 2) + cone(6, 5, 1), "both sides");
  near(run({ kind: "cbore", cbDia: { v: 18 }, cbDepth: { v: 6 }, headClear: { v: 1 }, underCs: sink(12) }), PI * 81 * 7 + cone(6, 5, 1) + PI * 25 * 12, "counterbore, head clearance, under head");
  near(run({ kind: "cbore", cbDia: { v: 18 }, cbDepth: { v: 6 }, nearCs: sink(20) }), cone(10, 9, 1) + PI * 81 * 5 + PI * 25 * 14, "counterbore with near side");
  near(run({ kind: "csink", csDia: { v: 20 }, csAngle: { v: PI / 2 }, headClear: { v: 2 } }), PI * 100 * 2 + cone(10, 5, 5) + PI * 25 * 13, "countersink head clearance");
  // A far side countersink on an Up to next hole opens where the hole stops.
  near(run({ end: "next", farCs: sink(12) }), PI * 25 * 19 + cone(6, 5, 1), "up to next far side");
  // Drill point angle and the extra end conditions.
  near(run({ end: "blind", depth: { v: 10 }, drillAngle: { v: PI / 2 } }), PI * 25 * 10 + cone(5, 0, 5), "drill angle 90°");
  near(run({ end: "offset", upTo: { std: "XY" }, upToOffset: { v: 5 } }), PI * 25 * 15, "offset from surface");
  near(run({ end: "offset", upTo: { std: "XY" }, upToOffset: { v: 5 }, reverseOffset: true }), PI * 25 * 20, "offset reversed (past the bottom)");
  // Remove thread: M12 (major 12) cut 8 deep over a Ø10 drill; through thread = the whole plate at the major Ø.
  near(run({ kind: "tapped", size: "M12", major: 12, threadDepth: { v: 8 }, threadMode: "remove" }), PI * 36 * 8 + PI * 25 * 12, "remove thread");
  near(run({ kind: "tapped", size: "M12", major: 12, threadEnd: "through", threadMode: "remove" }), PI * 36 * 20, "remove thread through");
  near(run({ kind: "tapped", size: "M12", major: 12, threadDepth: { v: 8 }, threadMode: "none" }), PI * 25 * 20, "no cosmetic thread");
  // Tapered tap: a 1:16 cone (radius 1:32) from the face over the thread length, never narrower than the drill.
  near(run({ kind: "ptap", taperDia: { v: 12 }, threadDepth: { v: 16 } }), cone(6, 5.5, 16) + PI * 25 * 4, "tapered tap");
  near(run({ kind: "ptap", taperDia: { v: 10.5 }, threadDepth: { v: 16 } }), cone(5.25, 5, 8) + PI * 25 * 12, "tapered tap meets the drill");
  near(run({ kind: "ptap", taperDia: { v: 12 }, major: 13, threadDepth: { v: 16 }, threadMode: "remove" }), cone(6.5, 6, 16) + PI * 25 * 4, "tapered tap, remove thread");
  // Counterbored and countersunk slots: the head pocket swept along the slot too (obround area = πρ² + 2ρL).
  const ob = (rho: number) => PI * rho * rho + 2 * rho * 20;
  near(run({ kind: "slot", slotLen: { v: 20 }, slotHead: "cbore", cbDia: { v: 18 }, cbDepth: { v: 6 } }), ob(9) * 6 + ob(5) * 14, "counterbored slot");
  near(run({ kind: "slot", slotLen: { v: 20 }, slotHead: "csink", csDia: { v: 20 }, csAngle: { v: PI / 2 } }), cone(10, 5, 5) + 2 * 20 * 37.5 + ob(5) * 15, "countersunk slot");
  near(run({ end: "vertex", upToVertex: { edge: { faces: ["f1:side:s1l1", "f1:side:s1l2"] }, at: [50, -30, 0] } }), PI * 25 * 20, "up to vertex");
  // Advanced Hole: near side counterbore + countersink over the main hole, far side counterbore + countersink inwards.
  const el = (t: string, d: number, x?: number) => ({ t, dia: { v: d }, ...(t === "csink" ? { angle: { v: PI / 2 } } : x != null ? { depth: { v: x } } : {}) });
  near(run({ kind: "adv", near: [el("cbore", 18, 6), el("csink", 14), el("straight", 10)], far: [el("cbore", 16, 3), el("csink", 12)] } as Partial<HoleFeature>),
    PI * 81 * 6 + cone(7, 5, 2) + PI * 25 * 8 + cone(6, 5, 1) + PI * 64 * 3, "advanced hole through");
  near(run({ kind: "adv", end: "blind", depth: { v: 12 }, drillAngle: { v: PI / 2 }, near: [el("straight", 14, 4), { ...el("tapped", 10, 8), major: 12 }], far: [el("csink", 14)] } as Partial<HoleFeature>),
    PI * 49 * 4 + PI * 25 * 8 + cone(5, 0, 5), "advanced hole blind (far side left out)");
  near(run({ kind: "adv", near: [el("csink", 20), el("straight", 10)], far: [el("csink", 14)] } as Partial<HoleFeature>), cone(10, 5, 5) + PI * 25 * 13 + cone(7, 5, 2), "advanced hole countersunk both sides");
  // Captive screw (M6: tap drill 5, clearance 6.6): thread through the cover; Retracted screw = a short retaining
  // thread over a clearance bore; ring style = a recess for the ring under the cover; head counterbore on top.
  const cap = (o: Partial<HoleFeature>) => ({ kind: "captive", size: "M6", diameter: { v: 6.6 }, major: 6, pitch: 1, ...o } as Partial<HoleFeature>);
  near(run(cap({})), PI * 6.25 * 20, "captive, thread through");
  near(run(cap({ retract: true, capHold: { v: 5 }, capThread: { v: 12 } })), PI * 6.25 * 5 + PI * 10.89 * 15, "captive, retracted screw");
  near(run(cap({ capStyle: "ring", ringDia: { v: 13 }, ringT: { v: 1 } })), PI * 10.89 * 18.8 + PI * 49 * 1.2, "captive, retaining ring");
  near(run(cap({ retract: true, capHold: { v: 5 }, capThread: { v: 8 }, cbDia: { v: 11 }, cbDepth: { v: 6.4 } })), PI * 30.25 * 6.4 + PI * 6.25 * 5 + PI * 10.89 * 8.6, "captive with head counterbore");
  {
    const r = m.evaluate(doc([rect("s1", 100, 60), { id: "f1", type: "extrude", name: "E", sketch: "s1", op: "boss", end: "blind", depth: { v: 20 } },
      { id: "h", type: "hole", name: "Hole1", plane: { face: { name: "f1:end" } }, pts: [[0, 0]], end: "through", depth: { v: 10 }, ...cap({ retract: true, capHold: { v: 5 }, capThread: { v: 16 } }) } as Feature]));
    const st = r.statuses.at(-1)!;
    assert.ok(st.ok && st.code === "warning" && /^The cover is 1\.5 mm too thin/.test(st.warning ?? ""), JSON.stringify(st));
  }
  const badAdv = m.evaluate(doc([rect("s1", 100, 60), { id: "f1", type: "extrude", name: "E", sketch: "s1", op: "boss", end: "blind", depth: { v: 20 } },
    { id: "h", type: "hole", name: "Hole1", plane: { face: { name: "f1:end" } }, pts: [[0, 0]], kind: "adv", diameter: { v: 10 }, end: "through", depth: { v: 10 }, near: [el("csink", 8), el("straight", 10)] } as unknown as Feature]));
  assert.equal(badAdv.statuses.at(-1)?.code, "E-HOLE-ADV");
  // An option countersink narrower than what it opens is refused.
  const bad = m.evaluate(doc([rect("s1", 100, 60), { id: "f1", type: "extrude", name: "E", sketch: "s1", op: "boss", end: "blind", depth: { v: 20 } },
    { id: "h", type: "hole", name: "Hole1", plane: { face: { name: "f1:end" } }, pts: [[0, 0]], kind: "simple", diameter: { v: 10 }, end: "through", depth: { v: 10 }, nearCs: sink(8) } as Feature]));
  assert.equal(bad.statuses.at(-1)?.code, "E-HOLE-OPTCS");
});

test("holes on other faces: a flat side face and a curved face, each drilled square to its face (FR-FT-052)", async () => {
  const m = new Modeller(await occ());
  const PI = Math.PI;
  const near = (a: number, b: number, msg: string) => assert.ok(Math.abs(a - b) < 2e-3 * b, `${msg}: ${a} vs ${b}`);
  const plate = m.evaluate(doc([rect("s1", 100, 60), { id: "f1", type: "extrude", name: "E", sketch: "s1", op: "boss", end: "blind", depth: { v: 20 } },
    { id: "h", type: "hole", name: "Hole1", plane: { face: { name: "f1:end" } }, pts: [[0, 0]], spots: [{ face: { name: "f1:side:s1l1" }, p: [20, -30.4, 10] }], kind: "simple", diameter: { v: 10 }, end: "blind", depth: { v: 10 }, flat: true } as Feature]));
  assert.ok(plate.statuses.every(s => s.ok), JSON.stringify(plate.statuses));
  near(100 * 60 * 20 - m.props(plate.body!).volume, 2 * PI * 25 * 10, "top + side face");
  const fr = plate.frames.h;
  assert.ok(fr.sp?.length === 1 && Math.abs(fr.sp[0][0][1] + 30) < 1e-6 && Math.abs(fr.sp[0][1][1] + 1) < 1e-9, JSON.stringify(fr.sp));
  // A Ø6 hole 10 deep into a Ø40 cylinder's side at x = 20: removed = ∫∫ over the disc (√(400 − y²) − 10).
  const circle: SketchFeature = { id: "s1", type: "sketch", name: "s1", plane: { std: "XY" }, rels: [], dims: [], ents: [{ id: "c0", t: "point", x: 0, y: 0 }, { id: "k", t: "circle", c: "c0", r: 20 } as SkEnt] };
  const cyl = m.evaluate(doc([circle, { id: "f1", type: "extrude", name: "E", sketch: "s1", op: "boss", end: "blind", depth: { v: 40 } },
    { id: "h", type: "hole", name: "Hole1", plane: { face: { name: "f1:end" } }, pts: [], spots: [{ face: { name: "f1:side:k" }, p: [20, 0, 20] }], kind: "simple", diameter: { v: 6 }, end: "blind", depth: { v: 10 }, flat: true } as Feature]));
  assert.ok(cyl.statuses.every(s => s.ok), JSON.stringify(cyl.statuses));
  let want = 0;
  const N = 400;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) { const y = -3 + (6 * (i + 0.5)) / N, z = -3 + (6 * (j + 0.5)) / N; if (y * y + z * z < 9) want += (Math.sqrt(400 - y * y) - 10) * (6 / N) ** 2; }
  near(PI * 400 * 40 - m.props(cyl.body!).volume, want, "curved face");
});

test("screw types size the head pocket; thread classes (FR-FT-051)", () => {
  assert.deepEqual(headPocket("M6", undefined, "cbore"), [11, 6.4]);
  assert.deepEqual(headPocket("M6", "din7984", "cbore"), [11, 4.4]);
  assert.deepEqual(headPocket("M6", "iso7380", "cbore"), [11.5, 3.7]);
  assert.deepEqual(headPocket("M6", "iso1207", "cbore"), [11, 4.3]);
  assert.deepEqual(headPocket("M6", "iso2009", "csink"), [12.6, 90]);
  assert.deepEqual(headPocket("M6", undefined, "csink"), [13.44, 90]);
  assert.deepEqual(headPocket("M10x1.25", "din7984", "cbore"), [18, 6.6]);
  assert.equal(headPocket("M20", "iso1207", "cbore"), null);
  assert.deepEqual(screwTypes("M2", "cbore"), ["iso4762", "iso1207"]);
  assert.deepEqual(screwTypes("M6", "csink"), ["iso10642", "iso2009"]);
  assert.deepEqual(screwTypes("1/4-20 UNC", "cbore"), ["iso4762"]);
  assert.deepEqual(headPocket("1/4-20 UNC", "din7984", "cbore"), headPocket("1/4-20 UNC", undefined, "cbore"));
  assert.equal(threadClasses("M6")[0], "6H");
  assert.equal(threadClasses("1/4-20 UNC")[0], "2B");
});

test("tapered pipe threads: NPT and Rc rows (FR-FT-051 Tapered Tap)", () => {
  for (const list of [ANSI_NPT, ISO_RC]) {
    assert.equal(list.length, 10);
    for (const h of list) {
      assert.ok(h.major > h.minor && h.minor > h.tap && h.len > 0 && h.pitch > 0, JSON.stringify(h));
      assert.equal(taperSize(h.size), h);
    }
  }
  // 1/4-18 NPT: E0 0.47739 + L2 0.4018/16, ±0.8p; Rc 1/4: gauge Ø13.157, thread 0.640327p deep.
  const n = taperSize("1/4-18 NPT")!;
  assert.ok(Math.abs(n.major - 13.891) < 0.01 && Math.abs(n.minor - 11.633) < 0.01 && Math.abs(n.len - 10.206) < 0.01, JSON.stringify(n));
  const rc = taperSize("Rc 1/4")!;
  assert.ok(Math.abs(rc.minor - 11.445) < 0.01 && rc.tap === 11.2, JSON.stringify(rc));
  assert.equal(taperStandardOf("Rc 1/2"), "bspt");
  assert.equal(taperStandardOf("1/2-14 NPT"), "npt");
  assert.equal(TAPER_STANDARDS.bspt, ISO_RC);
});
