// Benchmark: opening a STEP/IGES/BREP file, as the app does it: occt-import-js reads and meshes it (import worker),
// the topology is rebuilt from the mesh, the full kernel reads it again and measures every face and edge exactly.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { analyzeMesh } from "../src/topology";
import { fixResultNames } from "../src/names";
import { Kernel } from "../src/kernel/occ";
import { probe } from "../src/kernel/patch";
// @ts-expect-error no types
import init from "opencascade.js/dist/node.js";
const require = createRequire(import.meta.url);
const files = process.argv.slice(2);
const t = () => performance.now();
const occt = await require("occt-import-js")();
const oc = await init();
const params = { linearUnit: "millimeter", linearDeflectionType: "bounding_box_ratio", linearDeflection: 0.0008, angularDeflection: 0.25 };
console.log("file".padEnd(22), "  read  topol  kload  exact  faces  tris");
for (const f of files) for (let rep = 0; rep < 2; rep++) {
  const bytes = new Uint8Array(readFileSync(f));
  const row: number[] = [];
  let a = t();
  const res = occt.ReadStepFile(bytes, params); fixResultNames(res);
  row.push(t() - a); a = t();
  const parts = res.meshes.map((m: any) => analyzeMesh(m));
  row.push(t() - a); a = t();
  const k = new Kernel(oc);
  k.load(bytes, f);
  row.push(t() - a); a = t();
  parts.forEach((p: any, i: number) => k.exact(i, probe(p)));
  row.push(t() - a);
  const faces = parts.reduce((s: number, p: any) => s + p.faces.length, 0), tris = parts.reduce((s: number, p: any) => s + p.index.length / 3, 0);
  console.log(f.split("/").pop()!.padEnd(22), ...row.map(x => x.toFixed(0).padStart(6)), String(faces).padStart(6), String(tris).padStart(6));
}
