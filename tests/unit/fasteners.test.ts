// Fastener library (FR-ASM-028): ISO screws, nuts and washers as configured parametric parts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { occ } from "./occ";
import { Modeller } from "../../src/kernel/model";
import { activate } from "../../src/model/configs";
import { refreshExprs } from "../../src/model/params";
import { FASTENERS, defaultLength, detailRow, fastenerInfo, fastenerLengths, fastenerName, fastenerPart, fastenerSizes, lengthFor, searchFasteners, sizeForHole } from "../../src/asm/fasteners";
import { fastenerShape, shapeSvg, shapeVolume } from "../../src/asm/toolboxShape";

const PLAIN = { detail: false };
const close = (a: number, b: number, tol = 1e-3) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} vs ${b}`);

test("FR-ASM-028: sizes, lengths and names", () => {
  assert.deepEqual(fastenerSizes("iso4762"), ["M2", "M2.5", "M3", "M4", "M5", "M6", "M8", "M10", "M12", "M16", "M20"]);
  assert.ok(fastenerLengths("iso4762", "M6").includes(20) && !fastenerLengths("iso4762", "M6").includes(100));
  assert.equal(fastenerName("iso4762", "M6", 20), "ISO 4762 M6 x 20");
  assert.equal(fastenerName("iso4032", "M8"), "ISO 4032 M8");
  assert.equal(FASTENERS.length, 27);
  assert.equal(fastenerName("din6885", "8x7", 32), "DIN 6885 B 8x7 x 32");
  assert.equal(fastenerName("bearing", "6201"), "Ball bearing 6201");
  assert.deepEqual(fastenerLengths("din6885", "6x6"), [14, 16, 18, 20, 22, 25, 28, 32, 36, 40, 45, 50, 56, 63, 70]);
  assert.deepEqual(fastenerLengths("iso4032", "M6"), []);
});

test("FR-ASM-028: the size follows the clicked hole", () => {
  assert.equal(sizeForHole("iso4762", 6.4), "M6");
  assert.equal(sizeForHole("iso4762", 9), "M8");
  assert.equal(sizeForHole("iso4032", 10.5), "M10");
  assert.equal(sizeForHole("iso4762", 40), null);
  assert.equal(sizeForHole("iso2338", 6), "6");
  assert.equal(sizeForHole("iso2338", 7), null);
  assert.equal(sizeForHole("bearing", 32), "6002");
  assert.equal(sizeForHole("bearing", 32, "6201"), "6201");
  assert.equal(sizeForHole("bearing", 35, "6200"), "6202");
  assert.equal(sizeForHole("bearing", 22), "608");
  assert.equal(sizeForHole("din6885", 8), null);
});

test("FR-ASM-028: every fastener builds; volumes match the ISO sizes; sizes switch as configurations", async () => {
  const m = new Modeller(await occ());
  const vol = (pd: ReturnType<typeof fastenerPart>) => {
    const r = m.evaluate(pd);
    assert.ok(r.statuses.every(s => s.ok), JSON.stringify(r.statuses));
    return m.props(r.body!).volume;
  };
  const hex = (s: number) => (Math.sqrt(3) / 2) * s * s;
  // ISO 4762 M6 x 20: Ø6 × 20 shank, Ø10 × 6 head, hex 5 socket 3 deep.
  const cap = fastenerPart("iso4762", "M6", 20, PLAIN);
  assert.equal(cap.config, "M6");
  assert.equal(cap.configs?.length, 11);
  close(vol(cap), Math.PI * 9 * 20 + Math.PI * 25 * 6 - hex(5) * 3);
  // ISO 4017 M8 x 30: hex 13 × 5.3 head.
  close(vol(fastenerPart("iso4017", "M8", 30, PLAIN)), Math.PI * 16 * 30 + hex(13) * 5.3);
  // ISO 4032 M10 nut: hex 16 × 8.4, Ø10 bore.
  close(vol(fastenerPart("iso4032", "M10", undefined, PLAIN)), (hex(16) - Math.PI * 25) * 8.4);
  // ISO 7089 M6 washer: Ø12/Ø6.4 × 1.6.
  close(vol(fastenerPart("iso7089", "M6", undefined, PLAIN)), Math.PI * (36 - 6.4 * 6.4 / 4) * 1.6);
  // ISO 7380 button head builds (drafted head).
  assert.ok(vol(fastenerPart("iso7380", "M5", 12, PLAIN)) > Math.PI * 6.25 * 12);
  // Switch the cap screw to M10 (its default length, 30): the part follows.
  activate(cap, "M10");
  refreshExprs(cap);
  close(vol(cap), Math.PI * 25 * 30 + Math.PI * 64 * 10 - hex(8) * 5);
});

test("FR-ASM-028: the toolbox parts build with the sizes of their standards", async () => {
  const m = new Modeller(await occ());
  const vol = (pd: ReturnType<typeof fastenerPart>) => {
    const r = m.evaluate(pd);
    assert.ok(r.statuses.every(s => s.ok), `${pd.name}: ${JSON.stringify(r.statuses)}`);
    return m.props(r.body!).volume;
  };
  const hex = (s: number) => (Math.sqrt(3) / 2) * s * s, cyl = (d: number, h: number) => (Math.PI * d * d / 4) * h;
  const cone = (d1: number, d2: number, h: number) => (Math.PI * h / 12) * (d1 * d1 + d1 * d2 + d2 * d2);
  // ISO 10642 M6 x 20: 90° cone Ø13.44 → Ø6 over 3.72, shank Ø6 below it to 20, hex 4 socket 2.2 deep.
  close(vol(fastenerPart("iso10642", "M6", 20, PLAIN)), cone(13.44, 6, 3.72) + cyl(6, 20 - 3.72) - hex(4) * 2.2);
  // ISO 4026 M8 x 10: Ø8 × 10 less a hex 4 socket 3 deep.
  close(vol(fastenerPart("iso4026", "M8", 10, PLAIN)), cyl(8, 10) - hex(4) * 3);
  close(vol(fastenerPart("iso4035", "M10", undefined, PLAIN)), (hex(16) - Math.PI * 25) * 5);
  // ISO 7040 M8: hex 13 × 5.5 and a Ø12 × 2.5 collar, Ø8 bore through both.
  close(vol(fastenerPart("iso7040", "M8", undefined, PLAIN)), hex(13) * 5.5 + cyl(12, 2.5) - cyl(8, 8));
  // ISO 4161 M6: Ø14.2 × 1.1 flange under a hex 10 × 6.
  close(vol(fastenerPart("iso4161", "M6", undefined, PLAIN)), cyl(14.2, 1.1) + hex(10) * (6 - 1.1) - cyl(6, 6));
  close(vol(fastenerPart("iso7092", "M6", undefined, PLAIN)), cyl(11, 1.6) - cyl(6.4, 1.6));
  close(vol(fastenerPart("iso7093", "M8", undefined, PLAIN)), cyl(24, 2) - cyl(8.4, 2));
  close(vol(fastenerPart("iso2338", "6", 20, PLAIN)), cyl(6, 20));
  close(vol(fastenerPart("iso8752", "8", 30, PLAIN)), cyl(8, 30) - cyl(5, 30));
  close(vol(fastenerPart("din6885", "8x7", 32, PLAIN)), 8 * 7 * 32);
  const brg = fastenerPart("bearing", "6201", undefined, PLAIN);
  close(vol(brg), cyl(32, 10) - cyl(12, 10));
  // Sizes switch as configurations: the key to 12x8 at its default length, the bearing to 6305.
  const key = fastenerPart("din6885", "8x7", 32, PLAIN);
  activate(key, "12x8");
  refreshExprs(key);
  close(vol(key), 12 * 8 * defaultLength("din6885", "12x8"));
  activate(brg, "6305");
  refreshExprs(brg);
  close(vol(brg), cyl(62, 17) - cyl(25, 17));
});

test("FR-ASM-028: library detail: chamfers, cosmetic threads and bearing shields build in every size", async () => {
  const m = new Modeller(await occ());
  for (const f of FASTENERS) for (const size of fastenerSizes(f.kind)) {
    const r = m.evaluate(fastenerPart(f.kind, size));
    assert.ok(r.statuses.every(s => s.ok && !s.code), `${f.kind} ${size}: ${JSON.stringify(r.statuses.filter(s => !s.ok || s.code))}`);
  }
  // ISO 4762 M6 x 20: tip chamfer 0.7 (0.7 P), head chamfer 0.6, thread b = 24 > 20 so threaded to the head: 20 - 0.7.
  const cap = fastenerPart("iso4762", "M6", 20);
  const th = cap.features.find(x => x.type === "thread") as import("../../src/model/types").ThreadFeature;
  assert.deepEqual([th.size, th.pitch, th.diameter.v, th.length.v, th.internal ?? false], ["M6", 1, 4.77, 19.3, false]);
  assert.deepEqual(th.edge?.faces, ["e1:side:c", "c1:chamfer:0"]);
  // M6 x 60: b = 2d + 12 = 24 from the tip.
  assert.equal(detailRow("iso4762", fastenerInfo("iso4762").table.M6, 60).tl, 23.3);
  // A size switch carries the detail along (M10 x 30: thread 30 - 1.05).
  activate(cap, "M10");
  refreshExprs(cap);
  assert.equal(cap.vars?.find(v => v.name === "ThreadL")?.expr, "28.95");
  assert.ok(m.evaluate(cap).statuses.every(s => s.ok));
  // Nuts: internal thread of the major Ø between the two countersinks.
  const nut = fastenerPart("iso4032", "M8");
  const nt = nut.features.find(x => x.type === "thread") as import("../../src/model/types").ThreadFeature;
  assert.deepEqual([nt.internal, nt.diameter.v, nt.length.v], [true, 8, 5.2]);
});

test("FR-ASM-028: library pictures, mass estimate, search and lengths", () => {
  const hex = (s: number) => (Math.sqrt(3) / 2) * s * s;
  close(shapeVolume(fastenerShape("iso4762", "M6", 20)), Math.PI * 9 * 20 + Math.PI * 25 * 6 - hex(5) * 3);
  close(shapeVolume(fastenerShape("iso4032", "M10")), (hex(16) - Math.PI * 25) * 8.4);
  close(shapeVolume(fastenerShape("bearing", "6201")), Math.PI * (256 - 36) * 10);
  for (const f of FASTENERS) {
    const sz = fastenerSizes(f.kind)[0], svg = shapeSvg(fastenerShape(f.kind, sz, defaultLength(f.kind, sz)), { w: 200, h: 120, dims: true });
    assert.ok(svg.startsWith("<svg") && svg.includes("tb-line") && !svg.includes("NaN"), f.kind);
  }
  assert.ok(shapeSvg(fastenerShape("iso4762", "M6", 20), { w: 200, h: 120, dims: true }).includes(">L 20<"));
  assert.deepEqual(searchFasteners("m6 nut").map(f => f.kind), ["iso4032", "iso4035", "iso7040", "iso4161"]);
  assert.deepEqual(searchFasteners("4762").map(f => f.kind), ["iso4762"]);
  assert.deepEqual(searchFasteners("6201").map(f => f.kind), ["bearing"]);
  assert.deepEqual(searchFasteners("washers").map(f => f.kind), ["iso7089", "iso7092", "iso7093", "din127"]);
  assert.equal(searchFasteners("").length, FASTENERS.length);
  assert.equal(lengthFor("iso4762", "M3", 33), 30);
});

test("FR-ASM-028: spacers, standoffs, spring washers and retaining rings", async () => {
  const m = new Modeller(await occ());
  const vol = (pd: ReturnType<typeof fastenerPart>) => {
    const r = m.evaluate(pd);
    assert.ok(r.statuses.every(s => s.ok && !s.code), `${pd.name}: ${JSON.stringify(r.statuses)}`);
    return m.props(r.body!).volume;
  };
  const hex = (s: number) => (Math.sqrt(3) / 2) * s * s, cyl = (d: number, h: number) => (Math.PI * d * d / 4) * h;
  assert.equal(fastenerName("standoff", "M3", 10), "Standoff F-F M3 x 10");
  assert.equal(fastenerName("din471", "20"), "DIN 471 20");
  assert.deepEqual(fastenerLengths("spacer", "M4").slice(0, 3), [2, 3, 4]);
  close(vol(fastenerPart("standoff", "M3", 10, PLAIN)), (hex(5.5) - Math.PI * 2.25) * 10);
  // M-F M4 x 15: hex 7 × 15 less a Ø4 × 8 bore, plus a Ø4 × 8 stud.
  close(vol(fastenerPart("standoffm", "M4", 15, PLAIN)), hex(7) * 15 - cyl(4, 8) + cyl(4, 8));
  close(vol(fastenerPart("spacer", "M4", 10, PLAIN)), cyl(8, 10) - cyl(4.5, 10));
  // Split rings: the ring less an opening about g × ring width × s (2 % for the curved edges).
  const ring = (d1: number, d2: number, h: number, g: number) => cyl(d2, h) - cyl(d1, h) - g * (d2 - d1) / 2 * h;
  close(vol(fastenerPart("din471", "20", undefined, PLAIN)), ring(18.5, 23.7, 1.2, 2.4), 0.02);
  close(vol(fastenerPart("din472", "32", undefined, PLAIN)), ring(28, 34.4, 1.2, 3.24), 0.02);
  close(vol(fastenerPart("din127", "M8", undefined, PLAIN)), ring(8.2, 14.8, 2, 1.2), 0.02);
  // Retaining rings follow the shaft or the bore; standoffs and spacers the screw.
  assert.equal(sizeForHole("din471", 20), "20");
  assert.equal(sizeForHole("din472", 32), "32");
  assert.equal(sizeForHole("standoff", 3.4), "M3");
  assert.equal(sizeForHole("spacer", 4.5), "M4");
  const mf = fastenerPart("standoffm", "M4", 15);
  assert.deepEqual(mf.features.filter(f => f.type === "thread").map(f => [(f as any).internal ?? false, (f as any).length.v]), [[true, 7.6], [false, 7.51]]);
  close(shapeVolume(fastenerShape("standoff", "M3", 10)), (hex(5.5) - Math.PI * 2.25) * 10);
});

test("FR-ASM-028: bearing series: flanged, needle, linear and thrust", async () => {
  const m = new Modeller(await occ());
  const vol = (pd: ReturnType<typeof fastenerPart>) => {
    const r = m.evaluate(pd);
    assert.ok(r.statuses.every(s => s.ok && !s.code), `${pd.name}: ${JSON.stringify(r.statuses)}`);
    return m.props(r.body!).volume;
  };
  const cyl = (d: number, h: number) => (Math.PI * d * d / 4) * h;
  assert.equal(fastenerName("bearingf", "F608"), "Flanged ball bearing F608");
  assert.equal(fastenerName("linear", "LM8UU"), "Linear bearing LM8UU");
  // F608: ring Ø22 × 5.5 below the seat, flange Ø25 × 1.5 above it, bore Ø8 through both.
  close(vol(fastenerPart("bearingf", "F608", undefined, { detail: false })), cyl(22, 5.5) + cyl(25, 1.5) - cyl(8, 7));
  close(vol(fastenerPart("needle", "HK1010", undefined, { detail: false })), cyl(14, 10) - cyl(10, 10));
  close(vol(fastenerPart("linear", "LM8UU", undefined, { detail: false })), cyl(15, 24) - cyl(8, 24));
  // 51104: the gap between the washers leaves a cage ring 0.3 w wide over 0.3 H.
  const H = 10, mid = (20 + 35) / 2, w = 7.5, gap = (cyl(35, 0.3 * H) - cyl(20, 0.3 * H)) - (cyl(mid + 0.3 * w, 0.3 * H) - cyl(mid - 0.3 * w, 0.3 * H));
  const th = fastenerPart("thrust", "51104");
  assert.ok(th.features.some(f => f.id === "e3"));
  close(vol(fastenerPart("thrust", "51104", undefined, { detail: false })) - gap, cyl(35, H) - cyl(20, H) - gap);
  assert.ok(vol(th) < cyl(35, H) - cyl(20, H) - gap * 0.98);
  // A hole picks the bearing by its outside Ø; the 608 is the 22 mm one picked first.
  assert.equal(sizeForHole("bearing", 22), "608");
  assert.equal(sizeForHole("needle", 14), "HK1010");
  assert.equal(sizeForHole("linear", 15), "LM8UU");
  assert.equal(sizeForHole("bearingf", 22), "F608");
  assert.deepEqual(searchFasteners("lm8").map(f => f.kind), ["linear"]);
  assert.deepEqual(searchFasteners("51104").map(f => f.kind), ["thrust"]);
  assert.equal(fastenerSizes("bearing").length, 56);
  close(shapeVolume(fastenerShape("bearingf", "F608")), cyl(22, 5.5) + cyl(25, 1.5) - cyl(8, 7));
});
