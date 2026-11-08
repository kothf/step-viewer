// Component patterns (FR-ASM-022) and exploded views (FR-ASM-023): pure transforms, no kernel.
// Pattern instances are derived from their seeds whenever the assembly is evaluated, so they follow
// the seeds and the direction reference; they are driven (fixed) and are not mate targets.
import { compose, invert, rotation, translation } from "./math";
import type { AsmDoc, CompPattern, Component, ExplodeView, Mate, Tf } from "./types";
import type { Geo } from "./solver";
import type { V3 } from "../model/types";

/** The transforms of instances 1…count−1 of a pattern, applied after the seed's own transform. */
export function patternSteps(p: CompPattern, g: Geo): Tf[] {
  const out: Tf[] = [];
  const n = Math.max(1, Math.floor(p.count));
  const s = p.flip ? -1 : 1;
  const d = g.k === "plane" ? g.n : g.d;
  if (p.kind === "linear") {
    for (let k = 1; k < n; k++) out.push(translation([d[0] * p.spacing * k * s, d[1] * p.spacing * k * s, d[2] * p.spacing * k * s]));
  } else {
    if (g.k !== "axis") return out;
    const step = p.equal ? p.spacing / n : p.spacing;
    for (let k = 1; k < n; k++) out.push(rotation(g.p, g.d, step * k * s));
  }
  return out;
}

export interface Expanded {
  doc: AsmDoc;
  /** Derived component id → its pattern and seed. */
  instances: Map<string, { pattern: string; seed: string; k: number }>;
  /** Patterns that could not be made (missing direction, wrong reference). */
  bad: string[];
}

/** The document with every pattern's instances added as driven components. */
export function expandPatterns(doc: AsmDoc, worldGeo: (ref: { comp: string; face: string }) => Geo | null): Expanded {
  const instances = new Map<string, { pattern: string; seed: string; k: number }>();
  const bad: string[] = [];
  if (!doc.patterns?.length) return { doc, instances, bad };
  const comps: Component[] = [...doc.components];
  const used = new Map<string, number>();
  for (const c of doc.components) used.set(c.part, (used.get(c.part) ?? 0) + 1);
  for (const p of doc.patterns) {
    if (p.suppressed) continue;
    const g = p.dir && worldGeo(p.dir);
    const seeds = p.seeds.map(id => doc.components.find(c => c.id === id)).filter((c): c is Component => !!c && !c.suppressed);
    if (!g || !seeds.length || (p.kind === "circular" && g.k !== "axis")) { bad.push(p.id); continue; }
    patternSteps(p, g).forEach((t, i) => {
      for (const s of seeds) {
        const n = (used.get(s.part) ?? 0) + 1;
        used.set(s.part, n);
        const id = `${p.id}~${s.id}~${i + 1}`;
        const base = s.name.replace(/<\d+>$/, "");
        comps.push({ id, name: `${base}<${n}>`, part: s.part, tf: compose(t, s.tf), fixed: true, ...(s.hidden ? { hidden: true } : {}), ...(s.color ? { color: s.color } : {}), ...(s.opacity !== undefined ? { opacity: s.opacity } : {}) });
        instances.set(id, { pattern: p.id, seed: s.id, k: i + 1 });
      }
    });
  }
  return { doc: { ...doc, components: comps }, instances, bad };
}

/** Each component's offset in an exploded view (the steps add up in order). */
export function explodeOffsets(v: ExplodeView): Map<string, V3> {
  const out = new Map<string, V3>();
  for (const s of v.steps) for (const id of s.comps) {
    const o = out.get(id) ?? [0, 0, 0];
    out.set(id, [o[0] + s.dir[0] * s.dist, o[1] + s.dir[1] * s.dist, o[2] + s.dir[2] * s.dist]);
  }
  return out;
}

/**
 * Offsets of an exploded view at progress k (0 collapsed … 1 exploded). All steps move together, or with `seq`
 * one after another: of n steps, step i runs while k goes from i/n to (i + 1)/n.
 */
export function explodeAt(v: ExplodeView, k: number, seq = false): Map<string, V3> {
  const out = new Map<string, V3>(), n = v.steps.length;
  v.steps.forEach((s, i) => {
    const f = seq ? Math.max(0, Math.min(1, k * n - i)) : k;
    if (f <= 0) return;
    for (const id of s.comps) {
      const o = out.get(id) ?? [0, 0, 0];
      out.set(id, [o[0] + s.dir[0] * s.dist * f, o[1] + s.dir[1] * s.dist * f, o[2] + s.dir[2] * s.dist * f]);
    }
  });
  return out;
}

/**
 * Auto explode: one step per floating component, outward from the assembly centre along the line to
 * its own centre (or +Z when they coincide), by half the assembly size.
 */
export function autoExplode(comps: { id: string; centre: V3; fixed?: boolean }[], size: number): ExplodeView["steps"] {
  if (!comps.length) return [];
  const c: V3 = [0, 0, 0];
  for (const x of comps) for (let k = 0; k < 3; k++) c[k] += x.centre[k] / comps.length;
  const steps: ExplodeView["steps"] = [];
  for (const x of comps) {
    if (x.fixed) continue;
    let d: V3 = [x.centre[0] - c[0], x.centre[1] - c[1], x.centre[2] - c[2]];
    const l = Math.hypot(d[0], d[1], d[2]);
    d = l > size * 1e-6 ? [d[0] / l, d[1] / l, d[2] / l] : [0, 0, 1];
    steps.push({ comps: [x.id], dir: d, dist: Math.round(size * 0.5 * 1000) / 1000 });
  }
  return steps;
}

/**
 * Sub-assemblies flattened (FR-ASM-001/006, rigid): every component whose part entry holds an assembly
 * is replaced by that assembly's components (its own sub-assemblies and patterns' stored transforms
 * included), placed by the parent component; ids and part keys are prefixed with the parent's.
 */
export function flattenSubs(doc: AsmDoc, depth = 0): AsmDoc {
  if (depth > 8 || !Object.values(doc.parts).some(p => p.asm)) return doc;
  const parts: AsmDoc["parts"] = {};
  const comps: Component[] = [];
  const flat = new Map<string, AsmDoc>();
  for (const [k, p] of Object.entries(doc.parts)) {
    if (!p.asm) { parts[k] = p; continue; }
    const sub = flattenSubs(p.asm, depth + 1);
    flat.set(k, sub);
    for (const [sk, sp] of Object.entries(sub.parts)) parts[`${k}/${sk}`] = sp;
  }
  for (const c of doc.components) {
    const sub = flat.get(c.part);
    if (!sub) { comps.push(c); continue; }
    for (const sc of sub.components) {
      const own = c.flexible ? c.subTfs?.[sc.id] : undefined;
      comps.push({
        id: `${c.id}/${sc.id}`, name: sc.name, part: `${c.part}/${sc.part}`, tf: compose(c.tf, own ?? sc.tf), fixed: true,
        ...(c.hidden || sc.hidden ? { hidden: true } : {}), ...(c.suppressed || sc.suppressed ? { suppressed: true } : {}),
        ...((c.color ?? sc.color) ? { color: c.color ?? sc.color } : {}),
        ...((c.opacity ?? sc.opacity) !== undefined ? { opacity: c.opacity ?? sc.opacity } : {}),
      });
    }
  }
  return { ...doc, parts, components: comps };
}

/**
 * The document the mate solver sees (FR-ASM-006). A flexible sub-assembly stays as an anchor component
 * (no geometry) and its own components join the solve as `<comp>/<child>`: the ones fixed inside it are
 * locked to the anchor, the others float under the sub-assembly's mates and any mates the parent puts on them.
 */
export function solveView(doc: AsmDoc): AsmDoc {
  const flex = doc.components.filter(c => c.flexible && doc.parts[c.part]?.asm && !c.suppressed);
  if (!flex.length) return doc;
  const comps: Component[] = [...doc.components];
  const mates: Mate[] = [...(doc.mates ?? [])];
  const parts = { ...doc.parts };
  for (const c of flex) {
    const sub = flattenSubs(doc.parts[c.part].asm!);
    const top = new Set(doc.parts[c.part].asm!.components.map(x => x.id));
    for (const [sk, sp] of Object.entries(sub.parts)) parts[`${c.part}/${sk}`] = sp;
    for (const sc of sub.components) {
      if (sc.suppressed) continue;
      const rel = c.subTfs?.[sc.id] ?? sc.tf;
      const id = `${c.id}/${sc.id}`;
      comps.push({ id, name: sc.name, part: `${c.part}/${sc.part}`, tf: compose(c.tf, rel) });
      // Fixed in the sub-assembly (or inside a rigid sub-sub-assembly): it moves with the anchor.
      if (sc.fixed || !top.has(sc.id)) mates.push({ id: `${id}~anchor`, name: "", type: "lock", a: { comp: c.id, face: "" }, b: { comp: id, face: "" }, rel });
    }
    for (const m of sub.mates ?? []) {
      const r = <T extends { comp: string } | undefined>(x: T): T => (x ? { ...x, comp: `${c.id}/${x.comp}` } : x);
      mates.push({ ...m, id: `${c.id}/${m.id}`, a: r(m.a), b: r(m.b), c: r(m.c), d: r(m.d) });
    }
  }
  return { ...doc, components: comps, mates, parts };
}

/** Writes solved transforms back: top components take theirs, flexible sub-assemblies store their children relative to themselves. */
export function applySolved(doc: AsmDoc, tfs: Record<string, Tf>) {
  for (const c of doc.components) {
    if (tfs[c.id]) c.tf = tfs[c.id];
    if (!c.flexible || !doc.parts[c.part]?.asm) continue;
    const inv = invert(c.tf), sub: Record<string, Tf> = {};
    for (const sc of doc.parts[c.part].asm!.components) { const t = tfs[`${c.id}/${sc.id}`]; if (t) sub[sc.id] = compose(inv, t); }
    if (Object.keys(sub).length) c.subTfs = sub; else delete c.subTfs;
  }
}

/** The top-level component a shown (flattened or pattern) id belongs to. */
export const topOf = (id: string) => id.split("/")[0];
