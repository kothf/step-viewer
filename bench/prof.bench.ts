// Self/total time per Modeller method and per OpenCASCADE class, for one part.
import { readFileSync } from "node:fs";
import { Modeller } from "../src/kernel/model";
import { unpackPart } from "../src/model/file";
// @ts-expect-error no types
import init from "opencascade.js/dist/node.js";
const oc0 = await init();
const stat = new Map<string, { n: number; total: number; self: number }>();
const stack: { child: number }[] = [];
const wrap = (name: string, fn: Function) => function (this: any, ...a: any[]) {
  const fr = { child: 0 }; stack.push(fr);
  const t0 = performance.now();
  try { return new.target ? Reflect.construct(fn, a, new.target) : fn.apply(this, a); }
  finally {
    const dt = performance.now() - t0; stack.pop();
    if (stack.length) stack[stack.length - 1].child += dt;
    const s = stat.get(name) ?? { n: 0, total: 0, self: 0 }; s.n++; s.total += dt; s.self += dt - fr.child; stat.set(name, s);
  }
};
const P = Modeller.prototype as any;
for (const k of Object.getOwnPropertyNames(P)) { const d = Object.getOwnPropertyDescriptor(P, k)!; if (k !== "constructor" && typeof d.value === "function") P[k] = wrap(`M.${k}`, d.value); }
// OpenCASCADE: constructors and methods via a proxy
const seen = new Map<any, any>();
const oc = new Proxy(oc0, { get(t, k: string) {
  const v = t[k];
  if (typeof v !== "function" || !/^[A-Z]/.test(k)) return v;
  let w = seen.get(v);
  if (!w) {
    w = new Proxy(v, { construct(tt, a, nt) { return wrap(`new ${k}`, tt as any).call(null, ...a) ?? Reflect.construct(tt, a); }, get(tt, kk: string) { const m = (tt as any)[kk]; return typeof m === "function" && kk !== "prototype" ? wrap(`${k}.${kk}`, m).bind(tt) : m; } });
    // construct via wrap needs new.target handling:
    w = new Proxy(v, { construct(tt, a) { const fr = { child: 0 }; stack.push(fr); const t0 = performance.now(); try { return Reflect.construct(tt as any, a); } finally { const dt = performance.now() - t0; stack.pop(); if (stack.length) stack[stack.length - 1].child += dt; const s = stat.get(`new ${k}`) ?? { n: 0, total: 0, self: 0 }; s.n++; s.total += dt; s.self += dt; stat.set(`new ${k}`, s); } }, get(tt, kk: string) { const m = (tt as any)[kk]; return typeof m === "function" && kk !== "prototype" && typeof kk === "string" ? wrap(`${k}.${kk}`, m).bind(tt) : m; } });
    seen.set(v, w);
  }
  return w;
} });
// instance methods of a few heavy classes
for (const [cls, ms] of Object.entries({ BRepAlgoAPI_Cut_3: ["Build"], BRepAlgoAPI_Fuse_3: ["Build"], BRepAlgoAPI_BuilderAlgo: ["Build"], BRepBuilderAPI_MakeShape: ["Build"], BRepAlgoAPI_BooleanOperation: ["Build"], ShapeUpgrade_UnifySameDomain: ["Build"], BRepPrimAPI_MakeRevol: ["Build"] })) {
  for (const m of ms) { const pr = oc0[cls]?.prototype; if (pr && Object.prototype.hasOwnProperty.call(pr, m)) pr[m] = wrap(`${cls}#${m}`, pr[m]); }
}
import { Kernel } from "../src/kernel/occ";
import { analyzeMesh } from "../src/topology";
import { applyPatch, probe } from "../src/kernel/patch";
const KP = Kernel.prototype as any;
for (const k of Object.getOwnPropertyNames(KP)) { const d = Object.getOwnPropertyDescriptor(KP, k)!; if (k !== "constructor" && typeof d.value === "function") KP[k] = wrap(`K.${k}`, d.value); }
const b = readFileSync(process.argv[2]);
const doc = await unpackPart(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const m = new Modeller(oc);
const kernel = new Kernel(oc);
const request = wrap("REQUEST", (d: any) => {
  const res = wrap("1 evaluate", () => m.evaluate(d))();
  if (!res.body) throw new Error("no body");
  const info = wrap("6 bodyInfo", () => m.bodyInfo(res.body!, d))();
  const mesh = wrap("2 mesh", () => m.mesh(res.body!, "x", [1, 1, 1], 1))();
  const data = wrap("3 analyzeMesh", () => analyzeMesh(mesh as any))();
  kernel.meshes = [{ shape: res.body.shape, faces: res.body.faces, name: "x", color: [1, 1, 1], solid: true }] as any;
  wrap("4 exact+patch", () => applyPatch(data, kernel.exact(0, probe(data))))();
  wrap("5 props", () => m.props(res.body!))();
});
const show = (title: string) => {
  console.log(`---- ${title}`);
  const rows = [...stat].sort((a, b) => b[1].self - a[1].self).slice(0, +(process.argv[3] ?? 22));
  for (const k of [...stat.keys()].filter(k => /^[0-9R]/.test(k)).sort()) console.log(k.padEnd(52), String(stat.get(k)!.n).padStart(7), stat.get(k)!.total.toFixed(0).padStart(7));
  for (const [k, s] of rows) if (!/^[0-9R]/.test(k)) console.log(k.padEnd(52), String(s.n).padStart(7), s.total.toFixed(0).padStart(7), s.self.toFixed(0).padStart(7));
  stat.clear();
};
request(doc); show("open");
let li = doc.features.length - 1; while ((doc.features[li] as any).type === "sketch") li--;
const fs = doc.features.map((f, i) => i === li ? { ...f, _bench: 1 } : f);
request({ ...doc, features: fs }); show(`edit of the last feature (${doc.features[li].type})`);
request({ ...doc, features: fs }); show("same again (no change)");
