// Motion study evaluation (FR-FT-122): what every track asks for at a time. Pure, no DOM or kernel:
// the motion manager hands the result to the assembly's mate solver frame by frame.
import { compose, fromPose, rotation, translation } from "../asm/math";
import type { Geo } from "../asm/solver";
import type { Mate, MateType, Tf } from "../asm/types";
import type { V3 } from "../model/types";
import type { CamKey, Interp, Key, MotionStudy, MotorTrack, PoseKey, Track } from "./types";

/** Mates whose value a key track or a motor changes. */
export const VALUE_MATES: ReadonlySet<MateType> = new Set(["distance", "angle"]);
/** Mates whose axis a motor turns or slides the second component about. */
export const AXIS_MATES: ReadonlySet<MateType> = new Set(["concentric", "hinge", "screw"]);

const ease = (u: number, k: Interp | undefined) => (k === "ease" ? (u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2) : u);
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** Where `t` falls among sorted keys: the index of the key that ends its segment and the eased fraction. */
function segment<K extends { t: number; interp?: Interp }>(keys: K[], t: number): { i: number; u: number } {
  if (t <= keys[0].t) return { i: 0, u: 1 };
  const n = keys.length;
  if (t >= keys[n - 1].t) return { i: n - 1, u: 1 };
  let i = 1;
  while (keys[i].t < t) i++;
  const a = keys[i - 1].t, b = keys[i].t;
  return { i, u: ease(b > a ? (t - a) / (b - a) : 1, keys[i].interp) };
}

/** A key track's value at `t`: held before the first key and after the last, interpolated between. */
export function valueAt(keys: Key[], t: number): number | null {
  if (!keys.length) return null;
  const s = sortKeys(keys), { i, u } = segment(s, t);
  if (u >= 1 || i === 0) return s[i].v;
  return s[i - 1].v + (s[i].v - s[i - 1].v) * u;
}

export const sortKeys = <K extends { t: number }>(keys: K[]) => [...keys].sort((a, b) => a.t - b.t);

const lerp3 = (a: V3, b: V3, u: number): V3 => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V3): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** Rotates `v` towards `w` (both unit) by the fraction `u` of the angle between them (slerp). */
function slerp(v: V3, w: V3, u: number): V3 {
  const c = clamp(dot(v, w), -1, 1), a = Math.acos(c);
  if (a < 1e-9) return v;
  let ax = cross(v, w);
  if (len(ax) < 1e-9) ax = Math.abs(v[0]) < 0.9 ? cross(v, [1, 0, 0]) : cross(v, [0, 1, 0]);
  const r = rotation([0, 0, 0], unit(ax), a * u);
  return [r[0] * v[0] + r[1] * v[1] + r[2] * v[2], r[4] * v[0] + r[5] * v[1] + r[6] * v[2], r[8] * v[0] + r[9] * v[1] + r[10] * v[2]];
}

/** The camera at `t`: the target moves straight, the eye swings round it (as the viewer's own view changes do). */
export function cameraAt(keys: CamKey[], t: number): CamKey | null {
  if (!keys.length) return null;
  const s = sortKeys(keys), { i, u } = segment(s, t);
  if (u >= 1 || i === 0) return { ...s[i], t };
  const a = s[i - 1], b = s[i];
  const ra = sub(a.pos, a.target), rb = sub(b.pos, b.target);
  const la = len(ra), lb = len(rb);
  const target = lerp3(a.target, b.target, u);
  const up = a.up && b.up ? unit(lerp3(a.up, b.up, u)) : a.up ?? b.up;
  let dir = slerp(unit(ra), unit(rb), u);
  const l = la + (lb - la) * u;
  // Same up both ends: swing round it like a turntable (azimuth and elevation), so an orbit keeps its height.
  if (a.up && b.up && dot(unit(a.up), unit(b.up)) > 0.9999) {
    const z = unit(a.up), ha = sub(ra, z.map(c => c * dot(ra, z)) as V3), hb = sub(rb, z.map(c => c * dot(rb, z)) as V3);
    if (len(ha) > 1e-9 * la && len(hb) > 1e-9 * lb) {
      const ea = Math.asin(clamp(dot(unit(ra), z), -1, 1)), eb = Math.asin(clamp(dot(unit(rb), z), -1, 1));
      let az = Math.atan2(dot(cross(unit(ha), unit(hb)), z), dot(unit(ha), unit(hb)));
      if (!Number.isFinite(az)) az = 0;
      const r = rotation([0, 0, 0], z, az * u), h = unit(ha);
      const hr: V3 = [r[0] * h[0] + r[1] * h[1] + r[2] * h[2], r[4] * h[0] + r[5] * h[1] + r[6] * h[2], r[8] * h[0] + r[9] * h[1] + r[10] * h[2]];
      const e = ea + (eb - ea) * u;
      dir = [hr[0] * Math.cos(e) + z[0] * Math.sin(e), hr[1] * Math.cos(e) + z[1] * Math.sin(e), hr[2] * Math.cos(e) + z[2] * Math.sin(e)];
    }
  }
  // Orthographic zoom changes by the same factor each second (geometric), as a dolly in perspective feels.
  const za = a.zoom ?? b.zoom, zb = b.zoom ?? a.zoom;
  const zoom = za && zb ? za * (zb / za) ** u : undefined;
  return { t, target, pos: [target[0] + dir[0] * l, target[1] + dir[1] * l, target[2] + dir[2] * l], ...(up ? { up } : {}), ...(zoom ? { zoom } : {}) };
}

/** A pose track's offset at `t`: moves and angles interpolated like key values. */
export function poseAt(keys: PoseKey[], t: number): { d: V3; r: V3 } | null {
  if (!keys.length) return null;
  const s = sortKeys(keys), { i, u } = segment(s, t);
  if (u >= 1 || i === 0) return { d: [...s[i].d] as V3, r: [...s[i].r] as V3 };
  return { d: lerp3(s[i - 1].d, s[i].d, u), r: lerp3(s[i - 1].r, s[i].r, u) };
}

/** Where a pose puts a component that rests at `rest`: turned about its own origin, then moved. */
export function posed(rest: Tf, p: { d: V3; r: V3 }): Tf {
  const o: V3 = [rest[3], rest[7], rest[11]];
  const turn = fromPose([0, 0, 0], p.r);
  const out = compose(turn, rest);
  out[3] = o[0] + p.d[0]; out[7] = o[1] + p.d[1]; out[11] = o[2] + p.d[2];
  return out;
}

/** How far a motor has driven at `t`: radians (rotary) or mm (linear). */
export function motorAmount(m: MotorTrack, t: number): number {
  const dt = clamp(t, m.start, Math.max(m.start, m.end)) - m.start;
  const s = m.flip ? -1 : 1;
  if (m.profile === "oscillate") return s * (m.amp ?? 0) * Math.sin(2 * Math.PI * (m.freq ?? 1) * dt);
  return s * (m.motion === "rotary" ? (m.speed * 2 * Math.PI) / 60 : m.speed) * dt;
}

/** What a study asks for at `t`. */
export interface Frame {
  /** Mate id → value (mm or rad) for distance and angle mates. */
  values: Record<string, number>;
  /** Motors on axis mates: how far each has turned (rad) or slid (mm). */
  axis: { mate: string; motion: "rotary" | "linear"; amount: number }[];
  /** Exploded view progress by view id. */
  explode: { id: string; k: number }[];
  /** Component id → opacity (0 hidden … 1 opaque) for components with appearance keys. */
  look: Record<string, number>;
  /** Component id → offset for components with placement keys. */
  pose: Record<string, { d: V3; r: V3 }>;
  camera: CamKey | null;
}

/** Evaluates every track that is on at `t`; `mates` are the assembly's, by id (for base values and types). */
export function frameAt(study: MotionStudy, t: number, mates: Map<string, Mate>): Frame {
  const f: Frame = { values: {}, axis: [], explode: [], look: {}, pose: {}, camera: null };
  const on = study.tracks.filter(k => !k.off);
  for (const k of on) {
    if (k.kind === "mate") { const v = valueAt(k.keys, t); if (v != null && mates.has(k.mate)) f.values[k.mate] = v; }
    else if (k.kind === "explode") { const v = valueAt(k.keys, t); if (v != null) f.explode.push({ id: k.view, k: clamp(v, 0, 1) }); }
    else if (k.kind === "look") { const v = valueAt(k.keys, t); if (v != null) f.look[k.comp] = clamp(v, 0, 1); }
    else if (k.kind === "pose") { const p = poseAt(k.keys, t); if (p) f.pose[k.comp] = p; }
    else if (k.kind === "camera") f.camera = cameraAt(k.keys, t);
  }
  for (const k of on) {
    if (k.kind !== "motor") continue;
    const m = mates.get(k.mate);
    if (!m) continue;
    const a = motorAmount(k, t);
    if (VALUE_MATES.has(m.type)) f.values[m.id] = (f.values[m.id] ?? m.value ?? 0) + a;
    else if (AXIS_MATES.has(m.type)) f.axis.push({ mate: m.id, motion: k.motion, amount: a });
  }
  return f;
}

/**
 * The partial lock that drives an axis mate (concentric, hinge, screw): the second component's orientation
 * turned about the first one's axis `axis` (in the first component's own coordinates) by `amount` (rotary), or
 * its travel along that axis moved by `amount` mm (linear), from `rel0` = the second's transform relative to the
 * first's at rest. The other motions stay with the mates (a screw couples them by its pitch).
 */
export function axisLock(m: Mate, axis: Extract<Geo, { k: "axis" }>, rel0: Tf, motion: "rotary" | "linear", amount: number): Mate {
  const d = unit(axis.d);
  const move = motion === "rotary" ? rotation(axis.p, d, amount) : translation([d[0] * amount, d[1] * amount, d[2] * amount]);
  return { id: `${m.id}~motor`, name: "", type: "lock", a: { comp: m.a.comp, face: "" }, b: { comp: m.b.comp, face: "" }, rel: compose(move, rel0), keep: motion === "rotary" ? "rot" : "slide", along: d };
}

/** Appearance keys that fade a component out over [t0, t1] (or in, with `fadeIn`), from and to `full` opacity. */
export function fadeKeys(t0: number, t1: number, fadeIn = false, full = 1): Key[] {
  return fadeIn ? [{ t: t0, v: 0 }, { t: t1, v: full, interp: "ease" }] : [{ t: t0, v: full }, { t: t1, v: 0, interp: "ease" }];
}

/** Number of frames a study is solved at, both ends included. */
export const frameCount = (s: MotionStudy) => Math.max(1, Math.round(s.duration * s.fps)) + 1;

/** The study time for `elapsed` seconds of playback; `done` when a play-once study has reached its end. */
export function playTime(elapsed: number, s: Pick<MotionStudy, "duration" | "play">): { t: number; done: boolean } {
  const d = Math.max(1e-6, s.duration);
  if (s.play === "loop") return { t: elapsed % d, done: false };
  if (s.play === "reciprocate") { const p = elapsed % (2 * d); return { t: p <= d ? p : 2 * d - p, done: false }; }
  return elapsed >= d ? { t: d, done: true } : { t: elapsed, done: false };
}

/** Tracks a study needs re-solving for (camera and explode keys do not move the mates). */
export const movesMates = (k: Track) => k.kind === "mate" || k.kind === "motor";

/** A study that explodes (or collapses) a view over its length, as SolidWorks' animation wizard does. */
export function explodeKeys(duration: number, collapse = false): Key[] {
  return collapse ? [{ t: 0, v: 1 }, { t: duration, v: 0, interp: "ease" }] : [{ t: 0, v: 0 }, { t: duration, v: 1, interp: "ease" }];
}

/** Camera keys that orbit the model once about `up` through `target`, in quarter turns (the wizard's Rotate model). */
export function orbitKeys(pos: V3, target: V3, up: V3, t0: number, t1: number): CamKey[] {
  const u = unit(up), keys: CamKey[] = [];
  for (let q = 0; q <= 4; q++) {
    const r = rotation(target, u, (q * Math.PI) / 2);
    const p: V3 = [r[0] * pos[0] + r[1] * pos[1] + r[2] * pos[2] + r[3], r[4] * pos[0] + r[5] * pos[1] + r[6] * pos[2] + r[7], r[8] * pos[0] + r[9] * pos[1] + r[10] * pos[2] + r[11]];
    keys.push({ t: t0 + ((t1 - t0) * q) / 4, pos: p, target: [...target] as V3, up: u });
  }
  return keys;
}
