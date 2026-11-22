// MöbiusCAD's own thermal package (FRS-thermal FR-TREP-010): a study's surface temperatures written in the layout
// of section 15.2 with `format: "mobiuscad-thermal"`, so the result opens in ParaView, PyVista and FreeCAD FEM and
// back in MöbiusCAD as a board thermal map. Pure: no DOM, runs in node.
import { writeVtu, type ThermalMesh, type VtuOptions } from "./vtu";
import { VERSION, type HeatPath } from "./package";

/** One part of the exported package: a heat load, a package part or a component. */
export interface ExportPart {
  /** 1…n; 0 is the board and is not a part. */
  id: number;
  designator: string;
  /** STEP solid names (component names), so the map matches the model again. */
  bodies: string[];
  part?: string;
  path?: HeatPath;
  mount?: string;
  /** min x, y, z, max x, y, z (mm). */
  box?: [number, number, number, number, number, number];
  volume?: number;
  /** W made in it. */
  p?: number;
  /** Highest temperature of its bodies in the solve, °C. */
  t?: number;
  limit?: number;
}

export interface ExportInput {
  /** File stem: "<name>-thermal.json" and so on. */
  name: string;
  design: string;
  app: string;
  created: string;
  mesh: ThermalMesh;
  parts: ExportPart[];
  settings: { ambient?: number; enclosure?: string; orientation?: string; emissivity?: number };
  /** ± °C stated in the manifest, when known. */
  accuracy?: number;
  /** The study's name and kind, kept in the manifest for whoever reads it. */
  study?: { name: string; kind: string; time?: number };
  picture?: Uint8Array;
  vtu?: VtuOptions;
}

export const CSV_HEAD = "part_id,designator,step_bodies,part,heat_path,mount,x_mm,y_mm,z_mm,dx_mm,dy_mm,dz_mm,volume_mm3,p_total_W,p_board_W,p_air_W,p_sink_W,t_body_C,t_kind,t_limit_C,margin_C,life_h,source";

const r3 = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? "" : String(+v.toFixed(3)));
const cell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
const safe = (s: string) => s.replace(/[\\/:*?"<>|]+/g, "_").trim() || "study";

/** The heat-source table: one row per part, sorted by power (largest first), as the board design app writes it. */
export function sourcesCsv(parts: ExportPart[]): string {
  const rows = [...parts].sort((a, b) => (b.p ?? 0) - (a.p ?? 0) || a.id - b.id).map(p => {
    const b = p.box, c = b ? [0, 1, 2].map(i => (b[i] + b[i + 3]) / 2) : [], d = b ? [0, 1, 2].map(i => b[i + 3] - b[i]) : [];
    const margin = p.limit !== undefined && p.t !== undefined ? p.limit - p.t : undefined;
    return [String(p.id), cell(p.designator), cell(p.bodies.join(";")), cell(p.part ?? ""), p.path ?? "", p.mount ?? "",
      r3(c[0]), r3(c[1]), r3(c[2]), r3(d[0]), r3(d[1]), r3(d[2]), r3(p.volume), r3(p.p), "", "", "", r3(p.t), p.t === undefined ? "" : "body", r3(p.limit), r3(margin), "", "dc"].join(",");
  });
  return [CSV_HEAD, ...rows].join("\n") + "\n";
}

/** Box of each part's triangles on the mesh (mm), by part id. */
export function partBoxes(m: ThermalMesh): Map<number, [number, number, number, number, number, number]> {
  const out = new Map<number, [number, number, number, number, number, number]>();
  for (let t = 0; t < m.part.length; t++) {
    const id = m.part[t];
    let b = out.get(id);
    if (!b) out.set(id, (b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]));
    for (let k = 0; k < 3; k++) {
      const o = 3 * m.tri[3 * t + k];
      for (let a = 0; a < 3; a++) { const v = m.pos[o + a]; if (v < b[a]) b[a] = v; if (v > b[a + 3]) b[a + 3] = v; }
    }
  }
  return out;
}

/** The manifest's JSON text. */
export function manifestText(inp: ExportInput, files: Record<string, string>): string {
  const lo = inp.mesh.range[0], hi = inp.mesh.range[1];
  const parts = inp.parts.map(p => ({
    part_id: p.id, designator: p.designator, step_bodies: p.bodies, ...(p.part ? { part: p.part } : {}),
    ...(p.box ? { bbox_mm: p.box.map(v => +v.toFixed(3)) } : {}), ...(p.volume !== undefined ? { volume_mm3: +p.volume.toFixed(3) } : {}),
    ...(p.p !== undefined ? { p_total_W: +p.p.toFixed(6) } : {}), ...(p.t !== undefined ? { t_body_C: +p.t.toFixed(3), t_kind: "body" } : {}),
    ...(p.limit !== undefined ? { t_limit_C: p.limit } : {}), ...(p.limit !== undefined && p.t !== undefined ? { margin_C: +(p.limit - p.t).toFixed(3) } : {}),
    ...(p.path ? { heat_path: p.path } : {}), ...(p.mount ? { mount: p.mount } : {}),
  }));
  const s = inp.settings;
  return JSON.stringify({
    format: "mobiuscad-thermal", version: VERSION, app: inp.app, created: inp.created, design: inp.design,
    units: { length: "mm", temperature: "C", power: "W", flux: "W/m2" },
    frame: "the model's frame: millimetres, as the STEP the study was made from",
    files,
    settings: { ...(s.ambient !== undefined ? { ambient_C: s.ambient } : {}), ...(s.enclosure ? { enclosure: s.enclosure } : {}), ...(s.orientation ? { orientation: s.orientation } : {}), ...(s.emissivity !== undefined ? { emissivity: s.emissivity } : {}), operating_point: "dc" },
    ...(inp.accuracy !== undefined ? { accuracy_C: inp.accuracy } : {}),
    range_C: [+lo.toFixed(3), +hi.toFixed(3)],
    ...(inp.study ? { study: { name: inp.study.name, kind: inp.study.kind, ...(inp.study.time !== undefined ? { time_s: inp.study.time } : {}) } } : {}),
    parts,
  }, null, 2) + "\n";
}

export function readmeText(inp: ExportInput, files: Record<string, string>): string {
  return [
    `Thermal package written by ${inp.app} on ${inp.created}.`,
    `Design: ${inp.design}${inp.study ? `, study "${inp.study.name}"` : ""}.`,
    "",
    `${files.mesh}  surface temperatures (VTK XML UnstructuredGrid): point array Temperature_C (°C), cell arrays PartId (0 = board, 1… = part_id) and Power_W (W).`,
    `${files.sources}  one row per heat source or component, largest power first; t_body_C is the highest temperature of its bodies in the study.`,
    `${files.picture ? `${files.picture}  the view when the package was written.\n` : ""}${inp.name}-thermal.json  manifest (format mobiuscad-thermal, version ${VERSION}).`,
    "",
    "Coordinates are millimetres in the model's frame. Open the .vtu in ParaView, PyVista or FreeCAD FEM, or drop the zip on the model in MöbiusCAD to see it as a thermal map.",
    "Results are engineering estimates: they depend on the heat sources and the cooling set in the study.",
    "",
  ].join("\n");
}

/** Every file of the package, ready for `zip`. */
export async function packageFiles(inp: ExportInput): Promise<{ name: string; data: Uint8Array | string }[]> {
  const n = safe(inp.name);
  const files: Record<string, string> = { mesh: `${n}-thermal.vtu`, sources: `${n}-heat-sources.csv`, ...(inp.picture ? { picture: `${n}-thermal.png` } : {}) };
  const out: { name: string; data: Uint8Array | string }[] = [
    { name: files.mesh, data: await writeVtu(inp.mesh, inp.vtu ?? { encoding: "zlib" }) },
    { name: files.sources, data: sourcesCsv(inp.parts) },
  ];
  if (inp.picture) out.push({ name: files.picture, data: inp.picture });
  out.push({ name: `${n}-thermal.json`, data: manifestText(inp, files) }, { name: "README-thermal.txt", data: readmeText(inp, files) });
  return out;
}
