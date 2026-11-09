// Motion studies (FR-FT-122): track evaluation, motors on mates through the mate solver, camera keys, GIF writer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { solve, type Geo } from "../../src/asm/solver";
import { IDENTITY, applyDir, applyPoint, compose, invert, translation } from "../../src/asm/math";
import { axisLock, cameraAt, ease, explodeKeys, fadeKeys, frameAt, poseAt, posed, frameCount, exprValue, motorAmount, motorPlotUnit, motorSeries, orbitKeys, parsePoints, parseSegments, playTime, pointsAt, SEG_SHAPES, segmentsAt, segShape, valueAt } from "../../src/motion/evaluate";
import { encodeGif, indexPixels, lzw, palette, unlzw } from "../../src/motion/gif";
import { accels, alertSpans, gapCsv, plotFile, mateCsv, outOfRange, tripFrame, mateMeasures, pathLength, plotSvg, rates, relativeFrames, speeds, traceAngles, traceCsv, tracePoints, traceSeries } from "../../src/motion/trace";
import type { AsmDoc, Mate } from "../../src/asm/types";
import { frameName, frameTimes } from "../../src/motion/frames";
import type { MotionStudy, MotorTrack } from "../../src/motion/types";
import type { PartDoc } from "../../src/model/types";

const close = (a: number, b: number, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);
const stub = { schema: 1, kind: "part", id: "x", name: "x", units: { length: "mm", decimals: 2 }, props: {}, rollback: null, features: [] } as unknown as PartDoc;
const geos: Record<string, Record<string, Geo>> = {
  plate: { top: { k: "plane", p: [0, 0, 5], n: [0, 0, 1] }, hole: { k: "axis", p: [20, 10, 0], d: [0, 0, 1], r: 3 } },
  pin: { shank: { k: "axis", p: [0, 0, 0], d: [0, 0, 1], r: 3 }, under: { k: "plane", p: [0, 0, 10], n: [0, 0, -1] } },
};
const geo = (part: string, face: string) => geos[part]?.[face] ?? null;
const conc: Mate = { id: "m1", name: "Concentric1", type: "concentric", a: { comp: "p", face: "hole" }, b: { comp: "q", face: "shank" } };
const dist: Mate = { id: "m2", name: "Distance1", type: "distance", a: { comp: "p", face: "top" }, b: { comp: "q", face: "under" }, align: "anti", value: 0 };
const doc = (mates: Mate[], pinTf = translation([20, 10, -5])): AsmDoc => ({
  schema: 1, kind: "assembly", id: "a", name: "A", units: { length: "mm", decimals: 2 },
  parts: { plate: { name: "plate", file: "plate.mcadprt", doc: stub }, pin: { name: "pin", file: "pin.mcadprt", doc: stub } },
  components: [{ id: "p", name: "plate<1>", part: "plate", tf: IDENTITY, fixed: true }, { id: "q", name: "pin<1>", part: "pin", tf: pinTf }],
  mates,
});
const study = (tracks: MotionStudy["tracks"], duration = 4): MotionStudy => ({ id: "s", name: "S", duration, fps: 30, tracks });

test("key tracks hold before the first key and after the last, interpolate between, ease on request", () => {
  const keys = [{ t: 1, v: 10 }, { t: 3, v: 30 }, { t: 2, v: 0, interp: "ease" as const }];
  close(valueAt(keys, 0)!, 10);
  close(valueAt(keys, 1.5)!, 5);
  close(valueAt(keys, 2)!, 0);
  close(valueAt(keys, 2.5)!, 15);
  close(valueAt(keys, 9)!, 30);
  // Ease in/out: slower near the keys, the same at the midpoint.
  const e = [{ t: 0, v: 0 }, { t: 1, v: 1, interp: "ease" as const }];
  assert.ok(valueAt(e, 0.1)! < 0.1 && valueAt(e, 0.9)! > 0.9);
  close(valueAt(e, 0.5)!, 0.5);
  assert.equal(valueAt([], 1), null);
  assert.deepEqual(explodeKeys(4).map(k => k.v), [0, 1]);
  assert.deepEqual(explodeKeys(4, true).map(k => k.v), [1, 0]);
});

test("motors: constant speed in rpm or mm/s between start and end, oscillating, reversed", () => {
  const m: MotorTrack = { id: "k", kind: "motor", mate: "m1", motion: "rotary", profile: "constant", speed: 60, start: 1, end: 3 };
  close(motorAmount(m, 0), 0);
  close(motorAmount(m, 1.5), Math.PI);
  close(motorAmount(m, 5), 4 * Math.PI);
  close(motorAmount({ ...m, flip: true }, 1.5), -Math.PI);
  close(motorAmount({ ...m, motion: "linear", speed: 4 }, 2), 4);
  const o: MotorTrack = { ...m, profile: "oscillate", amp: 0.5, freq: 0.25, start: 0, end: 10 };
  close(motorAmount(o, 1), 0.5);
  close(motorAmount(o, 2), 0, 1e-12);
  close(motorAmount(o, 3), -0.5);
});

test("frameAt: mate keys set values, a motor on a distance mate adds to them, a motor on an axis mate becomes a turn", () => {
  const mates = new Map([conc, dist].map(m => [m.id, m]));
  const s = study([
    { id: "a", kind: "mate", mate: "m2", keys: [{ t: 0, v: 0 }, { t: 4, v: 8 }] },
    { id: "b", kind: "motor", mate: "m2", motion: "linear", profile: "constant", speed: 1, start: 0, end: 4 },
    { id: "c", kind: "motor", mate: "m1", motion: "rotary", profile: "constant", speed: 15, start: 0, end: 4 },
    { id: "d", kind: "explode", view: "x", keys: [{ t: 0, v: 0 }, { t: 4, v: 2 }] },
    { id: "e", kind: "mate", mate: "m2", keys: [{ t: 0, v: 99 }], off: true },
  ]);
  const f = frameAt(s, 2, mates);
  close(f.values.m2, 4 + 2);
  assert.equal(f.axis.length, 1);
  close(f.axis[0].amount, Math.PI);
  assert.deepEqual(f.explode, [{ id: "x", k: 1 }]);
  assert.equal(f.camera, null);
  assert.equal(frameCount(s), 121);
});

test("a rotary motor on a concentric mate turns the pin about the hole axis through the solver", () => {
  const d = doc([conc, dist]);
  const r0 = solve({ doc: d, geo, size: 100 });
  assert.ok(r0.ok);
  const rest = r0.tfs;
  const rel0 = compose(invert(rest.p), rest.q);
  const lock = axisLock(conc, geos.plate.hole as Extract<Geo, { k: "axis" }>, rel0, "rotary", Math.PI / 2);
  const r = solve({ doc: d, geo, size: 100, extra: [lock], start: rest });
  assert.ok(r.ok, JSON.stringify(r.bad));
  // The pin's own X axis now points along world Y, and its axis stays on the hole.
  const x = applyDir(r.tfs.q, [1, 0, 0]), o = applyPoint(r.tfs.q, [0, 0, 0]);
  close(x[0], 0, 1e-5); close(x[1], 1, 1e-5);
  close(o[0], 20, 1e-5); close(o[1], 10, 1e-5);
  // Distance keys move it along the axis.
  const r2 = solve({ doc: { ...d, mates: [conc, { ...dist, value: 7 }] }, geo, size: 100, start: rest });
  assert.ok(r2.ok);
  close(applyPoint(r2.tfs.q, [0, 0, 10])[2] - 5, 7, 1e-5);
});

test("motors hold only what they drive: a turn leaves the distance keys free, a slide leaves the turn free", () => {
  const d = doc([conc, dist]);
  const rest = solve({ doc: d, geo, size: 100 }).tfs, rel0 = compose(invert(rest.p), rest.q);
  const hole = geos.plate.hole as Extract<Geo, { k: "axis" }>;
  const rot = axisLock(conc, hole, rel0, "rotary", Math.PI / 2);
  assert.equal(rot.keep, "rot");
  const r = solve({ doc: { ...d, mates: [conc, { ...dist, value: 4 }] }, geo, size: 100, extra: [rot], start: rest });
  assert.ok(r.ok, JSON.stringify(r.bad));
  close(applyDir(r.tfs.q, [1, 0, 0])[1], 1, 1e-5);
  close(applyPoint(r.tfs.q, [0, 0, 10])[2] - 5, 4, 1e-5);
  // A linear motor on the concentric mate alone slides the pin 6 mm along the hole.
  const lin = axisLock(conc, hole, rel0, "linear", 6);
  const r2 = solve({ doc: { ...d, mates: [conc] }, geo, size: 100, extra: [lin], start: rest });
  assert.ok(r2.ok, JSON.stringify(r2.bad));
  close(r2.tfs.q[11] - rest.q[11], 6, 1e-5);
});

test("camera keys: an orbit keeps its height and distance, swinging a quarter turn per segment", () => {
  const keys = orbitKeys([100, 0, 50], [0, 0, 0], [0, 0, 1], 0, 4);
  assert.equal(keys.length, 5);
  for (const tq of [0.5, 1, 1.7, 2, 3.3]) {
    const c = cameraAt(keys, tq)!;
    close(c.pos[2], 50, 1e-6);
    close(Math.hypot(c.pos[0], c.pos[1]), 100, 1e-6);
  }
  const half = cameraAt(keys, 2)!;
  close(half.pos[0], -100, 1e-6); close(half.pos[1], 0, 1e-6);
  const q = cameraAt(keys, 0.5)!;
  close(Math.atan2(q.pos[1], q.pos[0]), Math.PI / 4, 1e-6);
  // Without an up vector the eye swings on the great circle.
  const s = cameraAt([{ t: 0, pos: [10, 0, 0], target: [0, 0, 0] }, { t: 1, pos: [0, 20, 0], target: [0, 0, 0] }], 0.5)!;
  close(Math.hypot(...s.pos), 15, 1e-9);
});

test("appearance keys: opacity per component, clamped to 0..1, fades ease out and in", () => {
  const study: MotionStudy = { id: "s", name: "S", duration: 2, fps: 10, tracks: [
    { id: "a", kind: "look", comp: "q", keys: fadeKeys(0, 2) },
    { id: "b", kind: "look", comp: "p", keys: [{ t: 0, v: -1 }, { t: 1, v: 3 }] },
    { id: "c", kind: "look", comp: "r", keys: fadeKeys(1, 2, true, 0.5), off: true },
  ] };
  const mates = new Map<string, Mate>();
  let f = frameAt(study, 0, mates);
  assert.deepEqual(f.look, { q: 1, p: 0 });
  f = frameAt(study, 1, mates);
  close(f.look.q, 0.5);
  assert.equal(f.look.p, 1);
  close(frameAt(study, 0.5, mates).look.q, 1 - 0.125);
  assert.equal(frameAt(study, 2, mates).look.q, 0);
  assert.deepEqual(fadeKeys(1, 2, true, 0.5).map(k => k.v), [0, 0.5]);
});

test("placement keys: offsets interpolate, the component turns about its own origin, then moves", () => {
  const keys = [{ t: 0, d: [0, 0, 0] as [number, number, number], r: [0, 0, 0] as [number, number, number] }, { t: 2, d: [0, 0, 20] as [number, number, number], r: [0, 0, 90] as [number, number, number] }];
  const p = poseAt(keys, 1)!;
  assert.deepEqual(p, { d: [0, 0, 10], r: [0, 0, 45] });
  const rest = translation([30, 0, 5]), tf = posed(rest, poseAt(keys, 2)!);
  const o = applyPoint(tf, [0, 0, 0]), x = applyDir(tf, [1, 0, 0]);
  close(o[0], 30); close(o[1], 0); close(o[2], 25);
  close(x[0], 0); close(x[1], 1);
  const study: MotionStudy = { id: "s", name: "S", duration: 2, fps: 10, tracks: [{ id: "p", kind: "pose", comp: "q", keys }] };
  assert.deepEqual(frameAt(study, 1, new Map()).pose.q, { d: [0, 0, 10], r: [0, 0, 45] });
});

test("camera keys: orthographic zoom changes geometrically", () => {
  const k = (t: number, zoom: number) => ({ t, pos: [0, -100, 0] as [number, number, number], target: [0, 0, 0] as [number, number, number], up: [0, 0, 1] as [number, number, number], zoom });
  close(cameraAt([k(0, 1), k(2, 4)], 1)!.zoom!, 2);
  assert.equal(cameraAt([k(0, 1), k(2, 4)], 3)!.zoom, 4);
});

test("playback: once stops at the end, loop wraps, reciprocate comes back", () => {
  assert.deepEqual(playTime(1, { duration: 4 }), { t: 1, done: false });
  assert.deepEqual(playTime(5, { duration: 4 }), { t: 4, done: true });
  close(playTime(5, { duration: 4, play: "loop" }).t, 1);
  close(playTime(5, { duration: 4, play: "reciprocate" }).t, 3);
  close(playTime(9, { duration: 4, play: "reciprocate" }).t, 1);
});

test("GIF: LZW round trip, including dictionary resets", () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (const [bits, n] of [[2, 50], [4, 3000], [8, 40000], [8, 1]] as const) {
    const idx = Uint8Array.from({ length: n }, (_, i) => (i % 97 < 60 ? (i >> 4) % (1 << bits) : Math.floor(rnd() * (1 << bits))));
    const enc = lzw(idx, bits);
    const dec = unlzw(enc);
    assert.equal(dec.end, enc.length);
    assert.deepEqual(dec.indices, [...idx]);
  }
});

test("GIF: palette, nearest colours and file structure", () => {
  const w = 8, h = 6, f1 = new Uint8ClampedArray(w * h * 4), f2 = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { f1.set(i < 24 ? [255, 0, 0, 255] : [0, 0, 255, 255], i * 4); f2.set(i % 2 ? [0, 255, 0, 255] : [250, 250, 250, 255], i * 4); }
  const pal = palette(Uint8Array.from([255, 0, 0, 0, 0, 255, 0, 255, 0, 250, 250, 250]), 4);
  assert.equal(pal.length, 12);
  const idx = indexPixels(f2, pal);
  assert.deepEqual([...pal.slice(idx[1] * 3, idx[1] * 3 + 3)], [0, 255, 0]);
  const gif = encodeGif([f1, f2], w, h, 5);
  assert.equal(String.fromCharCode(...gif.slice(0, 6)), "GIF89a");
  assert.equal(gif[6] | (gif[7] << 8), w);
  assert.equal(gif[8] | (gif[9] << 8), h);
  assert.equal(gif[gif.length - 1], 0x3b);
  // Two image descriptors, each followed by data that decodes to w × h pixels of the right colours.
  const gpal = gif.slice(13, 13 + 3 * (2 << (gif[10] & 7)));
  let pos = 13 + gpal.length, frames = 0;
  while (gif[pos] !== 0x3b) {
    if (gif[pos] === 0x21) { pos += 2; while (gif[pos]) pos += gif[pos] + 1; pos++; continue; }
    assert.equal(gif[pos], 0x2c);
    const d = unlzw(gif, pos + 10);
    assert.equal(d.indices.length, w * h);
    const src = frames ? f2 : f1;
    for (const i of [0, 1, 30, 47]) assert.deepEqual([...gpal.slice(d.indices[i] * 3, d.indices[i] * 3 + 3)], [...src.slice(i * 4, i * 4 + 3)]);
    pos = d.end;
    frames++;
  }
  assert.equal(frames, 2);
});

test("key interpolations: snap holds then jumps, ease in/out start and end slowly", () => {
  close(ease(0.5, undefined), 0.5);
  close(ease(0.5, "linear"), 0.5);
  close(ease(0.99, "snap"), 0);
  close(ease(1, "snap"), 1);
  close(ease(0.5, "easein"), 0.25);
  close(ease(0.5, "easeout"), 0.75);
  close(ease(0.5, "ease"), 0.5);
  assert.ok(ease(0.1, "easein") < 0.1 && ease(0.1, "easeout") > 0.1);
  const keys = [{ t: 0, v: 0 }, { t: 2, v: 10, interp: "snap" as const }];
  close(valueAt(keys, 1.999)!, 0);
  close(valueAt(keys, 2)!, 10);
  close(valueAt([{ t: 0, v: 0 }, { t: 2, v: 10, interp: "easein" as const }], 1)!, 2.5);
  const pk = [{ t: 0, d: [0, 0, 0] as [number, number, number], r: [0, 0, 0] as [number, number, number] }, { t: 1, d: [0, 0, 8] as [number, number, number], r: [0, 0, 0] as [number, number, number], interp: "easeout" as const }];
  close(poseAt(pk, 0.5)!.d[2], 6);
});

test("trace paths: points through the frames, speed, series, length, CSV and plot", () => {
  // A component turning 90° about Z over 3 frames: the point (10, 0, 0) runs a quarter circle.
  const frames = [0, 1, 2].map(k => ({ a: compose(translation([0, 0, k]), [Math.cos(k * Math.PI / 4), -Math.sin(k * Math.PI / 4), 0, 0, Math.sin(k * Math.PI / 4), Math.cos(k * Math.PI / 4), 0, 0, 0, 0, 1, 0]) }));
  const pts = tracePoints(frames, "a", [10, 0, 0]);
  assert.equal(pts.length, 3);
  assert.ok(Math.abs(pts[2][0]) < 1e-9 && Math.abs(pts[2][1] - 10) < 1e-9 && Math.abs(pts[2][2] - 2) < 1e-9);
  // Missing component: the last point repeats.
  assert.deepEqual(tracePoints([...frames, {}], "a", [10, 0, 0])[3], pts[2]);
  const line = [[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0]] as [number, number, number][];
  assert.deepEqual(speeds(line, 10), [10, 10, 10, 10]);
  assert.deepEqual(traceSeries(line, 10, "dist"), [0, 1, 2, 3]);
  assert.deepEqual(traceSeries(line, 10, "x"), [0, 1, 2, 3]);
  assert.equal(pathLength(line), 3);
  const csv = traceCsv(line, 10).trim().split("\n");
  assert.equal(csv.length, 5);
  assert.equal(csv[0], "t (s),x (mm),y (mm),z (mm),speed (mm/s),accel (mm/s^2)");
  assert.equal(csv[2], "0.1,1,0,0,10,0");
  // Acceleration: uniform speed has none; x = t² at 10 fps accelerates at 2 mm/s² … here x = k² mm per frame → 2·fps².
  assert.deepEqual(accels(line, 10), [0, 0, 0, 0]);
  const sq = [0, 1, 4, 9].map(v => [v, 0, 0] as [number, number, number]);
  assert.deepEqual(accels(sq, 10), [200, 200, 200, 200]);
  assert.deepEqual(traceSeries(sq, 10, "accel"), [200, 200, 200, 200]);
  // Component angle: 45° per frame about Z, unwrapped past 180°; about -Z the sign is kept along the turn's own axis.
  const turn = (a: number) => [Math.cos(a), -Math.sin(a), 0, 5, Math.sin(a), Math.cos(a), 0, 0, 0, 0, 1, 0];
  const spin = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(k => ({ a: turn(k * Math.PI / 4) }));
  const ang = traceAngles(spin, "a");
  ang.forEach((v, k) => assert.ok(Math.abs(Math.abs(v) - 45 * k) < 1e-6, `angle ${k}: ${v}`));
  assert.ok(ang.every((v, k) => k === 0 || Math.sign(v) === Math.sign(ang[1])));
  assert.ok(Math.abs(Math.abs(rates(ang, 10)[3]) - 450) < 1e-6);
  assert.deepEqual(traceSeries(sq, 10, "angle", [0, 1, 2, 3]), [0, 1, 2, 3]);
  assert.deepEqual(traceAngles(frames, "missing"), [0, 0, 0]);
  const csv2 = traceCsv(line, 10, [0, 5, 10, 15]).trim().split("\n");
  assert.ok(csv2[0].endsWith(",angle (deg)") && csv2[2].endsWith(",5"));
  // Relative to a component: a point riding on a turning, moving base stays put in the base's coordinates, and
  // spinning together means no relative turn; a frame without the base keeps its last transform.
  const tr = (a: number, x: number) => { const m = turn(a); m[3] = x; return m; };
  const ride = [0, 1, 2, 3].map(k => ({ base: tr(k * 0.3, k * 5), pin: compose(tr(k * 0.3, k * 5), [1, 0, 0, 2, 0, 1, 0, 3, 0, 0, 1, 4]) }));
  const rel = relativeFrames(ride, "base");
  tracePoints(rel, "pin", [0, 0, 0]).forEach(p => assert.ok(Math.hypot(p[0] - 2, p[1] - 3, p[2] - 4) < 1e-9, String(p)));
  traceAngles(rel, "pin").forEach(v => assert.ok(Math.abs(v) < 1e-6));
  assert.ok(Math.abs(traceAngles(ride, "pin")[3]) > 50);
  const gap = relativeFrames([...ride, { pin: ride[3].pin }], "base");
  assert.ok(Math.hypot(...tracePoints(gap, "pin", [0, 0, 0])[4].map((v, k) => v - [2, 3, 4][k])) < 1e-9);
  assert.equal(relativeFrames([{ pin: ride[0].pin }], "base")[0].pin, ride[0].pin);
  // Mate values: a plane sliding 5 mm per frame along its normal from a fixed plane, signed; a crank plane turning
  // 60° per frame about Z against a fixed plane keeps counting past 180°; two crossing axes give the gap between the lines.
  const P = { k: "plane" as const, p: [0, 0, 0] as [number, number, number], n: [1, 0, 0] as [number, number, number] };
  const slide = [0, 1, 2, 3].map(k => ({ g: IDENTITY, s: translation([10 - 5 * k, 0, 0]) }));
  const sv = mateMeasures(slide, "g", "s", P, P);
  assert.deepEqual(sv.dist, [10, 5, 0, -5]);
  assert.deepEqual(sv.angle, [0, 0, 0, 0]);
  const crank = [0, 1, 2, 3, 4, 5, 6].map(k => ({ g: IDENTITY, c: turn(k * Math.PI / 3) }));
  const cv = mateMeasures(crank, "g", "c", P, P);
  cv.angle.forEach((v, k) => assert.ok(Math.abs(Math.abs(v) - 60 * k) < 1e-6, `crank ${k}: ${v}`));
  const ax = (p: [number, number, number], d: [number, number, number]) => ({ k: "axis" as const, p, d, r: 1 });
  const xv = mateMeasures([{ g: IDENTITY, s: IDENTITY }], "g", "s", ax([0, 0, 0], [1, 0, 0]), ax([0, 3, 7], [0, 0, 1]));
  assert.ok(Math.abs(xv.dist[0] - 3) < 1e-9 && Math.abs(Math.abs(xv.angle[0]) - 90) < 1e-9);
  const pv = mateMeasures([{ g: IDENTITY, s: IDENTITY }, {}], "g", "s", ax([0, 4, 0], [0, 1, 0]), ax([0, 0, 2], [0, 1, 0]));
  assert.deepEqual(pv.dist, [4, 4].map(() => pv.dist[0]));
  assert.ok(Math.abs(pv.dist[0] - 2) < 1e-9);
  const mc = mateCsv([10, 5], [0, 45], 10).trim().split("\n");
  assert.equal(mc[0], "t (s),distance (mm),angle (deg)");
  assert.equal(mc[2], "0.1,5,45");
  const svg = plotSvg([0, 1, 2, 3], 10, 0.15, "mm", "#f00", "Distance");
  assert.match(svg, /<polyline points="[^"]+"/);
  assert.equal((svg.match(/<polyline points="([^"]+)"/)![1].split(" ")).length, 4);
});

test("motion interference over a study: per-frame pairs become spans per pair; pairs touching at the start can be left out (FR-FT-122)", async () => {
  const { clashItems, clashCsv, pairKey } = await import("../../src/motion/interfere");
  const per: [string, string][][] = [[["p", "q"]], [["p", "q"]], [["b", "a"], ["p", "q"]], [["a", "b"]], [], [["b", "a"]]];
  const all = clashItems(per, 10);
  assert.deepEqual(all.map(x => x.key), ["p|q", "a|b"]);
  assert.deepEqual(all[1].frames, [2, 3, 5]);
  assert.deepEqual(all[1].spans, [[0.2, 0.3], [0.5, 0.5]]);
  assert.deepEqual(all[0].spans, [[0, 0.2]]);
  const moving = clashItems(per, 10, new Set([pairKey("q", "p")]));
  assert.deepEqual(moving.map(x => x.key), ["a|b"]);
  const csv = clashCsv(moving, id => (id === "a" ? "Pin, 1" : "Plate")).trim().split("\n");
  assert.equal(csv[0], "component 1,component 2,from (s),to (s)");
  assert.deepEqual(csv.slice(1), ['"Pin, 1",Plate,0.2,0.3', '"Pin, 1",Plate,0.5,0.5']);
  assert.deepEqual(clashItems([], 30), []);
});

test("explode steps one after another (animation wizard) or all at once (FR-FT-122)", async () => {
  const { explodeAt } = await import("../../src/asm/patterns");
  const v = { id: "x", name: "E", steps: [{ comps: ["a"], dir: [1, 0, 0] as [number, number, number], dist: 10 }, { comps: ["b", "a"], dir: [0, 0, 1] as [number, number, number], dist: 20 }] };
  assert.deepEqual(explodeAt(v, 0.5).get("a"), [5, 0, 10]);
  assert.deepEqual(explodeAt(v, 0.25, true).get("a"), [5, 0, 0]);
  assert.equal(explodeAt(v, 0.25, true).has("b"), false);
  assert.deepEqual(explodeAt(v, 0.75, true).get("b"), [0, 0, 10]);
  assert.deepEqual(explodeAt(v, 1, true).get("a"), [10, 0, 20]);
  assert.equal(explodeAt(v, 0, true).size, 0);
  const s: MotionStudy = { id: "s", name: "S", duration: 2, fps: 10, tracks: [{ id: "t", kind: "explode", view: "x", keys: [{ t: 0, v: 0 }, { t: 2, v: 1 }], seq: true }] };
  assert.deepEqual(frameAt(s, 1, new Map()).explode, [{ id: "x", k: 0.5, seq: true }]);
});

test("result sensors: out-of-range frames, spans and the frame where they trip", () => {
  const v = [0, 2, 5, 6, 3, 1, 7, 8];
  assert.deepEqual(outOfRange(v, { max: 4.5 }), [false, false, true, true, false, false, true, true]);
  assert.deepEqual(outOfRange(v, {}), v.map(() => false));
  assert.deepEqual(alertSpans(v, 2, { max: 4.5 }), [[1, 1.5], [3, 3.5]]);
  assert.deepEqual(alertSpans(v, 1, { min: 1.5, max: 6.5 }), [[0, 0], [5, 7]]);
  assert.equal(tripFrame(v, { max: 4.5 }, 0, 7), 2);
  assert.equal(tripFrame(v, { max: 4.5 }, 2, 7), 6, "already out at the start of the step: trips only when it comes back in and out again");
  assert.equal(tripFrame(v, { max: 4.5 }, 3, 5), -1);
  assert.equal(tripFrame(v, { min: -1 }, 0, 7), -1);
});

test("proximity CSV: one row per frame", () => {
  assert.equal(gapCsv([1, 0.5, 0.25], 2), "t (s),distance (mm)\n0,1\n0.5,0.5\n1,0.25\n");
});

test("image sequence: frame names sort in order and times cover the study", () => {
  assert.equal(frameName("a", 0, 31), "a_0001.png");
  assert.equal(frameName("a", 30, 31), "a_0031.png");
  assert.equal(frameName("a", 0, 12000), "a_00001.png");
  const ts = frameTimes(1, 30);
  assert.equal(ts.length, 31);
  assert.equal(ts[0], 0);
  assert.equal(ts[30], 1);
  assert.deepEqual(frameTimes(0, 24), [0, 0]);
});

test("plot export: stand-alone SVG with title, inline styles and no playhead", () => {
  const f = plotFile(plotSvg([0, 1, 2, 3], 10, 0.15, "mm", "#f00", "Distance"), "Study <1>: Distance");
  assert.ok(f.startsWith("<?xml"));
  assert.match(f, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(f, /<polyline points=/);
  assert.match(f, /Study &lt;1&gt;: Distance/);
  assert.ok(!f.includes("mo-ph"));
  assert.match(f, /width="900" height="336"/);
});

test("motor distance and data point profiles", () => {
  const base: MotorTrack = { id: "m", kind: "motor", mate: "x", motion: "linear", profile: "distance", speed: 0, dist: 20, start: 1, end: 3 };
  assert.equal(motorAmount(base, 0), 0);
  assert.equal(motorAmount(base, 2), 10);
  assert.equal(motorAmount(base, 3), 20);
  assert.equal(motorAmount(base, 5), 20);
  assert.ok(motorAmount(base, 1.2) < 0.1 * 20, "starts smoothly");
  assert.equal(motorAmount({ ...base, flip: true }, 3), -20);
  const pts = parsePoints("# t, v\n0, 0\n1; 2,5\n2 10\n", 2);
  assert.deepEqual(pts, [[0, 0], [1, 5], [2, 20]]);
  assert.equal(parsePoints("0 0"), null);
  assert.equal(parsePoints("0 0\n0 1"), null);
  assert.equal(parsePoints("0 0\nx 1"), null);
  assert.equal(pointsAt(pts!, 0.5), 2.5);
  assert.equal(pointsAt(pts!, 1.5), 12.5);
  assert.equal(pointsAt(pts!, 9), 20);
  const m: MotorTrack = { ...base, profile: "points", pts: pts!, start: 1, end: 3 };
  assert.equal(motorAmount(m, 2.5), 12.5);
  assert.equal(motorAmount(m, 0), 0);
});

test("motor data points: cubic spline and Akima", () => {
  const near = (a: number, b: number, tol = 1e-9) => assert.ok(Math.abs(a - b) < tol, `${a} vs ${b}`);
  // Both pass through every row and hold the ends.
  const rows: [number, number][] = [[0, 0], [1, 2], [2, 1], [4, 5]];
  for (const fit of ["cubic", "akima"] as const) {
    for (const [t0, v] of rows) near(pointsAt(rows, t0, fit), v);
    near(pointsAt(rows, -1, fit), 0); near(pointsAt(rows, 9, fit), 5);
  }
  // Points on a line stay on the line.
  const line: [number, number][] = [[0, 1], [1, 3], [3, 7], [4, 9]];
  for (const fit of ["cubic", "akima"] as const) near(pointsAt(line, 2.3, fit), 1 + 2 * 2.3);
  // The natural cubic spline through (0,0), (1,1), (2,0): slope 1.5 at 0, curvature 0 at the ends; value at 0.5 = 0.6875.
  const hump: [number, number][] = [[0, 0], [1, 1], [2, 0]];
  near(pointsAt(hump, 0.5, "cubic"), 0.6875);
  near(pointsAt(hump, 0.5, "cubic"), pointsAt(hump, 1.5, "cubic"));
  // A step: the cubic spline overshoots into the flat runs, Akima keeps them flat.
  const step: [number, number][] = [[0, 0], [1, 0], [2, 0], [3, 10], [4, 10], [5, 10]];
  assert.ok(pointsAt(step, 1.5, "cubic") < -0.1, "cubic undershoots before the step");
  near(pointsAt(step, 1.5, "akima"), 0);
  near(pointsAt(step, 4.5, "akima"), 10);
  const mid = pointsAt(step, 2.5, "akima");
  assert.ok(mid > 0 && mid < 10);
  // The motor uses the track's fit; absent = linear.
  const m: MotorTrack = { id: "m", kind: "motor", mate: "x", motion: "linear", profile: "points", speed: 0, pts: hump, start: 1, end: 3 };
  near(motorAmount(m, 1.5), 0.5);
  near(motorAmount({ ...m, fit: "cubic" }, 1.5), 0.6875);
  // Two rows fall back to a straight line.
  near(pointsAt([[0, 0], [2, 4]], 1, "akima"), 2);
});

test("motor expression profile", () => {
  const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
  near(exprValue("30*sin(2*pi*t)", 0.25), 30);
  near(exprValue("10*t^2", 2), 40);
  assert.throws(() => exprValue("sin(", 0));
  const m: MotorTrack = { id: "m", kind: "motor", mate: "x", motion: "rotary", profile: "expr", speed: 0, expr: "90*t", start: 1, end: 3 };
  near(motorAmount(m, 2), Math.PI / 2);
  near(motorAmount(m, 0), 0);
  near(motorAmount({ ...m, motion: "linear", flip: true }, 3), -180);
  assert.equal(motorAmount({ ...m, expr: "oops(" }, 2), 0);
});

test("motor segments: shapes, chaining and parsing", () => {
  const near = (a: number, b: number, e = 1e-9) => assert.ok(Math.abs(a - b) < e, `${a} ≉ ${b}`);
  for (const k of SEG_SHAPES) { near(segShape(k, 0), 0); near(segShape(k, 1), 1); near(segShape(k, 0.5), 0.5); }
  near(segShape("cubic", 0.25), 0.15625);
  near(segShape("harmonic", 1 / 3), 0.25);
  near(segShape("cycloid", 0.25), 0.25 - 1 / (2 * Math.PI));
  // Rise 0 → 10 by 1 s (cycloid), dwell to 2 s, return by 3 s (linear), then held.
  const segs = parseSegments("1, 10, cycloidal\n2; 10\n3, 0, l # back");
  assert.deepEqual(segs, [[1, 10, "cycloid"], [2, 10, "linear"], [3, 0, "linear"]]);
  near(segmentsAt(segs!, 0.5), 5); near(segmentsAt(segs!, 1.5), 10); near(segmentsAt(segs!, 2.5), 5);
  near(segmentsAt(segs!, 9), 0); near(segmentsAt(segs!, -1), 0);
  assert.equal(parseSegments("1, 5, spiral"), null);
  assert.equal(parseSegments("1, 5\n1, 6"), null);
  assert.equal(parseSegments("0, 5"), null);
  assert.equal(parseSegments(""), null);
  assert.deepEqual(parseSegments("2, 90, h", Math.PI / 180), [[2, Math.PI / 2, "harmonic"]]);
  const m = { id: "m", kind: "motor", mate: "x", motion: "linear", profile: "segments", speed: 0, start: 1, end: 4, segs, flip: true } as const;
  near(motorAmount({ ...m, segs: segs! }, 1.5), -5);
});

test("motor plot: displacement, velocity and acceleration series", () => {
  const near = (a: number, b: number, e = 1e-3) => assert.ok(Math.abs(a - b) < e, `${a} ≉ ${b}`);
  // 60 rpm from 0 to 2 s in a 3 s study at 10 fps: 360°/s, 720° at the end, held after.
  const m = { id: "m", kind: "motor", mate: "x", motion: "rotary", profile: "constant", speed: 60, start: 0, end: 2 } as const;
  const d = motorSeries(m, 3, 10, "disp"), v = motorSeries(m, 3, 10, "vel");
  assert.equal(d.length, 31);
  near(d[10], 360); near(d[30], 720); near(v[10], 360, 1e-2); near(v[25], 0);
  assert.equal(motorPlotUnit(m, "vel"), "°/s");
  // Linear distance motor 10 mm over 0..1 s (3u² − 2u³): velocity 15 mm/s and no acceleration at the middle, 60 mm/s² at the start.
  const l = { id: "l", kind: "motor", mate: "x", motion: "linear", profile: "distance", dist: 10, speed: 0, start: 0, end: 1 } as const;
  near(motorSeries(l, 1, 10, "vel")[5], 15, 1e-3);
  near(motorSeries(l, 1, 10, "acc")[5], 0, 1e-1);
  near(motorSeries(l, 1, 10, "acc")[1], 60 - 120 * 0.1, 1e-1);
  assert.equal(motorPlotUnit(l, "acc"), "mm/s²");
});
