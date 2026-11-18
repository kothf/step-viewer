import { readFileSync } from "node:fs";
import { Modeller } from "../src/kernel/model";
import * as D from "../src/kernel/drawing";
import { unpackPart } from "../src/model/file";
// @ts-expect-error no types
import init from "opencascade.js/dist/node.js";
const oc0 = await init();
const stat = new Map<string, { n: number; total: number; self: number }>();
const stack: { child: number }[] = [];
const rec = (name: string, dt: number, child: number) => { const s = stat.get(name) ?? { n: 0, total: 0, self: 0 }; s.n++; s.total += dt; s.self += dt - child; stat.set(name, s); };
const wrap = (name: string, fn: Function) => function (this: any, ...a: any[]) {
  const fr = { child: 0 }; stack.push(fr); const t0 = performance.now();
  try { return fn.apply(this, a); } finally { const dt = performance.now() - t0; stack.pop(); if (stack.length) stack[stack.length - 1].child += dt; rec(name, dt, fr.child); }
};
const seen = new Map<any, any>();
const patched = new Set<any>();
const patchProto = (k: string, v: any) => { let p = v.prototype; while (p && p !== Object.prototype && !patched.has(p)) { patched.add(p); for (const m of Object.getOwnPropertyNames(p)) { const d = Object.getOwnPropertyDescriptor(p, m)!; if (m !== "constructor" && typeof d.value === "function" && !/^(delete|isDeleted|isAliasOf|clone|deleteLater)$/.test(m)) p[m] = wrap(`${p.constructor?.name ?? k}#${m}`, d.value); } p = Object.getPrototypeOf(p); } };
const HEAVY = /^(HLR|BRepAlgoAPI|BRepMesh|BRepBuilderAPI_MakeFace|BRepPrimAPI|BOPAlgo|ShapeUpgrade|BRepOffsetAPI|BRepFeat|BRepFilletAPI|BRepClass3d)/;
const oc = new Proxy(oc0, { get(t, k: string) {
  const v = t[k];
  if (typeof v !== "function" || typeof k !== "string" || !/^[A-Z]/.test(k)) return v;
  let w = seen.get(v);
  if (!w) {
    if (HEAVY.test(k)) patchProto(k, v);
    w = new Proxy(v, { construct(tt, a) { const fr = { child: 0 }; stack.push(fr); const t0 = performance.now(); try { return Reflect.construct(tt as any, a); } finally { const dt = performance.now() - t0; stack.pop(); if (stack.length) stack[stack.length - 1].child += dt; rec(`new ${k}`, dt, fr.child); } }, get(tt, kk: string) { const m = (tt as any)[kk]; return typeof m === "function" && kk !== "prototype" && typeof kk === "string" ? wrap(`${k}.${kk}`, m).bind(tt) : m; } });
    seen.set(v, w);
  }
  return w;
} });
const b = readFileSync(process.argv[2]);
const doc = await unpackPart(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const res = new Modeller(oc0).evaluate(doc);
const sh = res.body!.shape;
const V: Record<string, any> = { front: { dir: [0, -1, 0], up: [0, 0, 1] }, top: { dir: [0, 0, 1], up: [0, 1, 0] }, right: { dir: [1, 0, 0], up: [0, 0, 1] }, iso: { dir: [1, -1, 1], up: [0, 0, 1] } };
const what = process.argv[3] ?? "front";
const t0 = performance.now();
let out: any;
if (what === "section") { const info = D.shapeInfo(oc0, sh); const c = info.box[0].map((x: number, i: number) => (x + info.box[1][i]) / 2); out = wrap("TOTAL", () => D.section(oc, sh, V.front, c as any))(); }
else out = wrap("TOTAL", () => D.project(oc, sh, V[what]))();
console.log(what, (performance.now() - t0).toFixed(0), "ms; vis", out.vis.length, "hid", out.hid.length, "faces", res.body!.faces.length);
for (const [k, s] of [...stat].sort((a, b) => b[1].self - a[1].self).slice(0, 16)) console.log(k.padEnd(52), String(s.n).padStart(7), s.total.toFixed(0).padStart(7), s.self.toFixed(0).padStart(7));
