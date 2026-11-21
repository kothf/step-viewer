// Lists the faces of parts (name, kind, area, centre, normal) to choose supports and loads for bench/simval.
import { readFileSync } from "node:fs";
import { Modeller } from "../src/kernel/model";
import { simGeometry } from "../src/kernel/simgeo";
import { unpackPart } from "../src/model/file";
// @ts-expect-error no types
import init from "opencascade.js/dist/node.js";

const oc = await init();
for (const f of process.argv.slice(2)) {
  const b = readFileSync(f);
  const doc = await unpackPart(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  const m = new Modeller(oc);
  const r = m.evaluate({ ...doc, rollback: null });
  if (!r.body) { console.log(f, "no body"); continue; }
  // a multibody part is analysed with its bodies joined, as the app does
  const bond = m.bonded(r.body);
  if (bond.parts > 1) console.log(`  ${bond.parts} bodies joined into ${bond.solids}`);
  r.body = bond.body;
  const geo = simGeometry(oc, r.body.shape, r.body.faces, 0.01, 0.1);
  console.log(`${f}: ${r.body.faces.length} faces, box ${geo.lo.map(v => v.toFixed(2))} .. ${geo.hi.map(v => v.toFixed(2))}, volume ${m.props(r.body).volume.toFixed(1)}, material ${doc.material?.name ?? "-"}`);
  const n = r.body.names.length, area = new Float64Array(n), c = new Float64Array(3 * n), nn = new Float64Array(3 * n);
  for (let t = 0; t < geo.face.length; t++) {
    const p = geo.tris.subarray(9 * t, 9 * t + 9), fi = geo.face[t];
    const u = [p[3] - p[0], p[4] - p[1], p[5] - p[2]], v = [p[6] - p[0], p[7] - p[1], p[8] - p[2]];
    const x = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const a = Math.hypot(...x) / 2;
    area[fi] += a;
    for (let k = 0; k < 3; k++) { c[3 * fi + k] += (a * (p[k] + p[3 + k] + p[6 + k])) / 3; nn[3 * fi + k] += x[k] / 2; }
  }
  for (let i = 0; i < n; i++) {
    const flat = Math.hypot(nn[3 * i], nn[3 * i + 1], nn[3 * i + 2]) / area[i];
    console.log(`  ${i} ${r.body.names[i]}  area ${area[i].toFixed(1)}  at ${[0, 1, 2].map(k => (c[3 * i + k] / area[i]).toFixed(2))}  ${flat > 0.999 ? "flat n " + [0, 1, 2].map(k => (nn[3 * i + k] / area[i]).toFixed(2)) : "curved " + flat.toFixed(2)}`);
  }
}
