// Motion studies (FR-FT-122): track evaluation, motors on mates through the mate solver, camera keys, GIF writer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { solve, type Geo } from "../../src/asm/solver";
import { IDENTITY, applyDir, applyPoint, compose, invert, translation } from "../../src/asm/math";
import { axisLock, cameraAt, ease, explodeKeys, fadeKeys, frameAt, poseAt, posed, frameCount, motorAmount, orbitKeys, playTime, valueAt } from "../../src/motion/evaluate";
import { encodeGif, indexPixels, lzw, palette, unlzw } from "../../src/motion/gif";
import { accels, mateCsv, mateMeasures, pathLength, plotSvg, rates, relativeFrames, speeds, traceAngles, traceCsv, tracePoints, traceSeries } from "../../src/motion/trace";
import type { AsmDoc, Mate } from "../../src/asm/types";
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
