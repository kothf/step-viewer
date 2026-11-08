// Motion studies (FR-FT-122): track evaluation, motors on mates through the mate solver, camera keys, GIF writer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { solve, type Geo } from "../../src/asm/solver";
import { IDENTITY, applyDir, applyPoint, compose, invert, translation } from "../../src/asm/math";
import { axisLock, cameraAt, explodeKeys, frameAt, frameCount, motorAmount, orbitKeys, playTime, valueAt } from "../../src/motion/evaluate";
import { encodeGif, indexPixels, lzw, palette, unlzw } from "../../src/motion/gif";
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
