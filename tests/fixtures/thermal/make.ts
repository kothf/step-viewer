// Makes the thermal map fixtures (FRS-thermal 16.1): a small board STEP with named solids and its thermal package,
// as the board design app writes it. Run: node bench/run.mjs tests/fixtures/thermal/make.ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { occ } from "../../unit/occ";
import { Kernel } from "../../../src/kernel/occ";
import { zip } from "../../../src/model/zip";
import { writeVtu, type ThermalMesh } from "../../../src/thermal/vtu";

// the bundle runs from the cache folder, so the place is given from the repository root
const dir = join(process.cwd(), "tests/fixtures/thermal");
const AMBIENT = 40;
type Box = [number, number, number, number, number, number];
interface P { id: number; des: string; part: string; box: Box; round?: boolean; path: string; mount: string; p: number; pb: number; pa: number; ps: number; t: number; kind: string; limit: number; life?: number; color: [number, number, number] }
const BOARD: Box = [0, 0, 0, 120, 80, 1.6];
const PARTS: P[] = [
  { id: 1, des: "V3", part: "EL84", box: [34, 51, 1.6, 56, 73, 61.6], round: true, path: "air", mount: "socket", p: 18.2, pb: 0.6, pa: 17.6, ps: 0, t: 182, kind: "bulb", limit: 250, color: [0.75, 0.8, 0.85] },
  { id: 2, des: "R14", part: "470R 5W", box: [33, 26.75, 2, 57, 33.25, 8.5], path: "board", mount: "lying", p: 3.1, pb: 1.6, pa: 1.5, ps: 0, t: 131, kind: "body", limit: 155, color: [0.85, 0.82, 0.7] },
  { id: 3, des: "Q2", part: "IRF820", box: [100, 4, 1.6, 110.4, 8.6, 16.6], path: "heatsink", mount: "ra-on-heatsink", p: 4.4, pb: 0.2, pa: 0, ps: 4.2, t: 96, kind: "junction", limit: 150, color: [0.15, 0.15, 0.17] },
  { id: 4, des: "C12", part: "47u 450V", box: [66, 47, 1.6, 82, 63, 33.6], round: true, path: "air", mount: "standing", p: 0.05, pb: 0, pa: 0.05, ps: 0, t: 71, kind: "case", limit: 105, life: 19000, color: [0.1, 0.2, 0.5] },
  { id: 5, des: "R20", part: "100R 3W", box: [70, 20, 2, 88, 25, 7], path: "board", mount: "lying", p: 3.4, pb: 1.9, pa: 1.5, ps: 0, t: 162, kind: "body", limit: 155, color: [0.85, 0.82, 0.7] },
  { id: 6, des: "C13", part: "100u 63V", box: [90, 30, 1.6, 100, 40, 14.1], round: true, path: "air", mount: "standing", p: 0.02, pb: 0, pa: 0.02, ps: 0, t: 88, kind: "case", limit: 105, life: 6500, color: [0.1, 0.2, 0.5] },
];

/** Board temperature: ambient plus a bump under each part that heats the board. */
function boardT(x: number, y: number) {
  let t = AMBIENT + 4;
  for (const p of PARTS) {
    const cx = (p.box[0] + p.box[3]) / 2, cy = (p.box[1] + p.box[4]) / 2;
    t += 30 * p.pb * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / 260);
  }
  return t;
}

function mesh(): ThermalMesh {
  const pos: number[] = [], temp: number[] = [], tri: number[] = [], part: number[] = [], face: number[] = [], power: number[] = [], flux: number[] = [];
  const quad = (a: number[][], ts: number[], id: number, f: number, pw: number, fl: number) => {
    const o = pos.length / 3;
    a.forEach((q, i) => { pos.push(...q); temp.push(ts[i]); });
    tri.push(o, o + 1, o + 2, o, o + 2, o + 3);
    for (let k = 0; k < 2; k++) { part.push(id); face.push(f); power.push(pw); flux.push(fl); }
  };
  // board: top and bottom on a 4 mm grid, plain edges
  const g = 4, [x0, y0, z0, x1, y1, z1] = BOARD;
  for (let x = x0; x < x1; x += g) for (let y = y0; y < y1; y += g) {
    const c = [[x, y], [x + g, y], [x + g, y + g], [x, y + g]], ts = c.map(q => boardT(q[0], q[1]));
    const fl = 9 * (boardT(x + g / 2, y + g / 2) - AMBIENT);
    quad(c.map(q => [q[0], q[1], z1]), ts, 0, 1, 0, fl);
    quad([c[0], c[3], c[2], c[1]].map(q => [q[0], q[1], z0]), [ts[0], ts[3], ts[2], ts[1]].map(v => v - 1), 0, 2, 0, fl * 0.8);
  }
  const side = (a: number[], b: number[]) => quad([[a[0], a[1], z0], [b[0], b[1], z0], [b[0], b[1], z1], [a[0], a[1], z1]], [boardT(a[0], a[1]) - 1, boardT(b[0], b[1]) - 1, boardT(b[0], b[1]), boardT(a[0], a[1])], 0, 3, 0, 0);
  side([x0, y0], [x1, y0]); side([x1, y0], [x1, y1]); side([x1, y1], [x0, y1]); side([x0, y1], [x0, y0]);
  // parts: their boxes, cooler at the foot than at the top
  for (const p of PARTS) {
    const [a, b, c, d, e, f] = p.box, lo = p.t - 6, hi = p.t;
    const v = (x: number, y: number, z: number) => [x, y, z];
    const q = (pts: number[][]) => quad(pts, pts.map(w => (w[2] === c ? lo : hi)), p.id, 0, p.p, 0);
    q([v(a, b, c), v(a, e, c), v(d, e, c), v(d, b, c)]);
    q([v(a, b, f), v(d, b, f), v(d, e, f), v(a, e, f)]);
    q([v(a, b, c), v(d, b, c), v(d, b, f), v(a, b, f)]);
    q([v(d, b, c), v(d, e, c), v(d, e, f), v(d, b, f)]);
    q([v(d, e, c), v(a, e, c), v(a, e, f), v(d, e, f)]);
    q([v(a, e, c), v(a, b, c), v(a, b, f), v(a, e, f)]);
  }
  const t = Float32Array.from(temp);
  let lo = Infinity, hi = -Infinity;
  for (const x of t) { lo = Math.min(lo, x); hi = Math.max(hi, x); }
  return { pos: Float32Array.from(pos), temp: t, tri: Uint32Array.from(tri), part: Int32Array.from(part), face: Int8Array.from(face), power: Float32Array.from(power), flux: Float32Array.from(flux), ambient: AMBIENT, gridStep: g, range: [lo, hi] };
}

async function step(): Promise<Uint8Array> {
  const oc = await occ();
  const solid = (b: Box, round?: boolean) => {
    if (!round) return new oc.BRepPrimAPI_MakeBox_4(new oc.gp_Pnt_3(b[0], b[1], b[2]), new oc.gp_Pnt_3(b[3], b[4], b[5])).Shape();
    const ax = new oc.gp_Ax2_3(new oc.gp_Pnt_3((b[0] + b[3]) / 2, (b[1] + b[4]) / 2, b[2]), new oc.gp_Dir_4(0, 0, 1));
    return new oc.BRepPrimAPI_MakeCylinder_3(ax, (b[3] - b[0]) / 2, b[5] - b[2]).Shape();
  };
  const k = new Kernel(oc);
  k.meshes = [{ shape: solid(BOARD), faces: [], name: "Board", color: [0.1, 0.4, 0.2], solid: true },
    ...PARTS.map(p => ({ shape: solid(p.box, p.round), faces: [], name: p.des, color: p.color, solid: true }))];
  return k.writeStep(k.meshes.map((_, i) => i)).slice();
}

const m = mesh();
const csvHead = "part_id,designator,step_bodies,part,heat_path,mount,x_mm,y_mm,z_mm,dx_mm,dy_mm,dz_mm,volume_mm3,p_total_W,p_board_W,p_air_W,p_sink_W,t_body_C,t_kind,t_limit_C,margin_C,life_h,source";
const csv = [csvHead, ...[...PARTS].sort((a, b) => b.p - a.p).map(p => {
  const [a, b, c, d, e, f] = p.box;
  return [p.id, p.des, p.des, p.part, p.path, p.mount, (a + d) / 2, (b + e) / 2, (c + f) / 2, d - a, e - b, f - c, Math.round((d - a) * (e - b) * (f - c)), p.p, p.pb, p.pa, p.ps, p.t, p.kind, p.limit, p.limit - p.t, p.life ?? "", "dc"].join(",");
})].join("\n") + "\n";
const manifest = (meshFile: string, stepFile?: string) => JSON.stringify({
  format: "tubecad-thermal", version: 1, app: "Tube Amp CAD 3.24.0", created: "2026-11-21T20:00:00Z", design: "EL84 test board",
  units: { length: "mm", temperature: "C", power: "W", flux: "W/m2" },
  frame: "same as the STEP export: x right, y up, z up from the board's bottom face",
  files: { mesh: meshFile, sources: "amp-heat-sources.csv", picture: "amp-thermal.png", ...(stepFile ? { step: stepFile } : {}) },
  settings: { ambient_C: AMBIENT, enclosure: "closed", orientation: "horizontal-up", operating_point: "dc", grid_mm: 4, emissivity: 0.9 },
  accuracy_C: 15, range_C: [AMBIENT, 182],
  parts: PARTS.map(p => ({ part_id: p.id, designator: p.des, step_bodies: [p.des], bbox_mm: p.box, p_total_W: p.p, p_board_W: p.pb, p_air_W: p.pa, p_sink_W: p.ps, t_body_C: p.t, t_kind: p.kind, t_limit_C: p.limit, heat_path: p.path, mount: p.mount, ...(p.life ? { life_h: p.life } : {}), part: p.part, source: "dc" })),
}, null, 1);
// a 1 × 1 PNG
const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), c => c.charCodeAt(0));
const readme = "Thermal map of the EL84 test board (fixture). Open it in MöbiusCAD together with amp.step.\n";
const stp = await step();
writeFileSync(join(dir, "amp.step"), stp);
const ascii = await writeVtu(m, { encoding: "ascii" }), packed = await writeVtu(m, { encoding: "zlib" });
writeFileSync(join(dir, "amp-thermal.zip"), await zip([
  { name: "amp-thermal.vtu", data: ascii }, { name: "amp-heat-sources.csv", data: csv }, { name: "amp-thermal.png", data: png },
  { name: "amp-thermal.json", data: manifest("amp-thermal.vtu") }, { name: "README-thermal.txt", data: readme },
]));
writeFileSync(join(dir, "amp-with-step-thermal.zip"), await zip([
  { name: "amp-thermal.vtu", data: packed }, { name: "amp-heat-sources.csv", data: csv }, { name: "amp-thermal.png", data: png },
  { name: "amp-thermal.json", data: manifest("amp-thermal.vtu", "amp.step") }, { name: "README-thermal.txt", data: readme }, { name: "amp.step", data: stp },
]));
console.log(`points ${m.temp.length}, triangles ${m.part.length}, range ${m.range.map(x => x.toFixed(1)).join("..")} °C, STEP ${stp.length} bytes`);
process.exit(0);
