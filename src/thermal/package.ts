// Thermal package of a board (FRS-thermal section 15.2): the manifest, the heat-source table and the mesh that a
// board design app writes beside the board's STEP. Pure: runs in a worker and in node.
import { readVtu, ThermalError, type ReadOptions, type ThermalMesh } from "./vtu";

export const FORMATS = ["tubecad-thermal", "mobiuscad-thermal"] as const;
export const VERSION = 1;

export type HeatPath = "board" | "air" | "heatsink" | "chassis";

/** One heat source: a row of the manifest's `parts` (or of the CSV). Missing numbers are undefined. */
export interface ThermalPart {
  id: number;
  designator: string;
  /** STEP solid names of this part. */
  bodies: string[];
  /** Value or model: "470R 5W", "EL84". */
  part: string;
  path?: HeatPath;
  mount?: string;
  /** min x, y, z, max x, y, z (mm). */
  box?: [number, number, number, number, number, number];
  /** W: total, and where it goes. */
  p?: number; pBoard?: number; pAir?: number; pSink?: number;
  /** °C: estimated temperature, what it is of (body, case, junction, bulb), its limit. */
  t?: number; tKind?: string; limit?: number;
  /** K/W junction to case, when the package gives it (FR-TBRD-021). */
  rjc?: number;
  /** limit − t; negative = over. */
  margin?: number;
  /** Electrolytics: estimated life (h); `lifeBy` "computed" when MöbiusCAD worked it out. */
  life?: number; lifeBy?: "package" | "computed";
  /** Rated life (h) at the limit temperature, when the package gives it. */
  ratedLife?: number;
  source?: string;
  /** A material key (of the manifest's `materials`, else a library name) per STEP solid name, and for the bodies not listed. */
  mats?: Record<string, string>;
  mat?: string;
  /** STEP solid names the part's own heat is made in (`heat_bodies`): die, wound core, plate. Absent = all its bodies. */
  heat?: string[];
}

/** A material the package gives for bodies (`materials`): conductivity at least; SI units as written, density in kg/m³. */
export interface PackageMaterial { name: string; k: number; cp?: number; density?: number; emis?: number }

export interface ThermalSettings {
  ambient?: number;
  enclosure?: string;
  orientation?: string;
  operatingPoint?: string;
  grid?: number;
  emissivity?: number;
}

export interface ThermalManifest {
  format: (typeof FORMATS)[number];
  version: number;
  /** True when the package was written by a newer app (version above ours) but has what we need. */
  newer: boolean;
  app: string;
  created: string;
  design: string;
  files: { mesh?: string; sources?: string; picture?: string; step?: string; gerber?: string };
  settings: ThermalSettings;
  /** The board's copper stack, when the writer gives it (`board` {layers, copper_um, coverage}), and its surface emissivity. */
  board?: { layers?: number; copper?: number; cover?: number; emis?: number };
  /** Materials by key (`materials`), which parts name per body in `body_materials` / `material`. */
  materials?: Record<string, PackageMaterial>;
  /** ± °C the writer states. */
  accuracy?: number;
  range?: [number, number];
  parts: ThermalPart[];
}

export interface ThermalPackage {
  /** Name the package goes by (the manifest's file name without "-thermal.json", or the zip's). */
  name: string;
  manifest: ThermalManifest;
  mesh: ThermalMesh;
  /** The design app's own picture. */
  picture?: Uint8Array;
  /** The STEP written with the package, when it is inside. */
  step?: { name: string; data: Uint8Array };
  /** Notes for the user (fixed English texts with params). */
  notes: { text: string; params?: Record<string, string | number> }[];
  /** A heat-source table alone (FR-TPKG-015): no temperatures, the mesh is empty; it gives a study its powers. */
  sourcesOnly?: boolean;
}

const num = (v: unknown): number | undefined => {
  if (v === null || v === undefined || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const str = (v: unknown) => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));
const PATHS: HeatPath[] = ["board", "air", "heatsink", "chassis"];

/** A part from a manifest entry or a CSV row (both use the CSV's column names). */
function partOf(r: Record<string, unknown>): ThermalPart | null {
  const id = num(r.part_id);
  if (id === undefined || !Number.isInteger(id) || id < 1) return null;
  const sb = r.step_bodies;
  const bodies = (Array.isArray(sb) ? sb.map(str) : str(sb).split(";")).map(s => s.trim()).filter(Boolean);
  let box: ThermalPart["box"];
  if (Array.isArray(r.bbox_mm) && r.bbox_mm.length === 6 && r.bbox_mm.every(x => num(x) !== undefined)) box = r.bbox_mm.map(Number) as ThermalPart["box"];
  else {
    const c = [num(r.x_mm), num(r.y_mm), num(r.z_mm)], d = [num(r.dx_mm), num(r.dy_mm), num(r.dz_mm)];
    if ([...c, ...d].every(x => x !== undefined)) box = [c[0]! - d[0]! / 2, c[1]! - d[1]! / 2, c[2]! - d[2]! / 2, c[0]! + d[0]! / 2, c[1]! + d[1]! / 2, c[2]! + d[2]! / 2];
  }
  const path = PATHS.find(p => p === str(r.heat_path));
  const p: ThermalPart = {
    id, designator: str(r.designator) || bodies[0] || `#${id}`, bodies, part: str(r.part), path, mount: str(r.mount) || undefined, box,
    p: num(r.p_total_W), pBoard: num(r.p_board_W), pAir: num(r.p_air_W), pSink: num(r.p_sink_W),
    t: num(r.t_body_C), tKind: str(r.t_kind) || undefined, limit: num(r.t_limit_C), margin: num(r.margin_C), rjc: num(r.rjc_KW),
    life: num(r.life_h), ratedLife: num(r.life_rated_h), source: str(r.source) || undefined,
  };
  const list = (v: unknown) => (Array.isArray(v) ? v.map(str) : str(v).split(";")).map(x => x.trim()).filter(Boolean);
  const heat = list(r.heat_bodies);
  if (heat.length) p.heat = heat;
  if (str(r.material).trim()) p.mat = str(r.material).trim();
  const bm = r.body_materials;
  if (bm && typeof bm === "object" && !Array.isArray(bm)) {
    const m: Record<string, string> = {};
    for (const [k, v] of Object.entries(bm as Record<string, unknown>)) if (k.trim() && str(v).trim()) m[k.trim()] = str(v).trim();
    if (Object.keys(m).length) p.mats = m;
  }
  return finishPart(p);
}

/** Electrolytic life by the 10 °C rule: rated hours at the rated temperature, doubled for every 10 °C cooler. */
export function capacitorLife(rated: number, ratedT: number, t: number) {
  return rated * 2 ** ((ratedT - t) / 10);
}

function finishPart(p: ThermalPart): ThermalPart {
  if (p.margin === undefined && p.limit !== undefined && p.t !== undefined) p.margin = p.limit - p.t;
  if (p.life !== undefined) p.lifeBy = "package";
  else if (p.ratedLife !== undefined && p.limit !== undefined && p.t !== undefined) { p.life = Math.round(capacitorLife(p.ratedLife, p.limit, p.t)); p.lifeBy = "computed"; }
  for (const k of Object.keys(p) as (keyof ThermalPart)[]) if (p[k] === undefined) delete p[k];
  return p;
}

/** Reads the manifest text. Throws E-TH-PKG / E-TH-VERSION. */
export function readManifest(text: string): ThermalManifest {
  let j: Record<string, unknown>;
  try { j = JSON.parse(text); } catch { throw new ThermalError("E-TH-PKG", "the manifest is not valid JSON"); }
  if (!j || typeof j !== "object" || Array.isArray(j)) throw new ThermalError("E-TH-PKG", "the manifest is not valid JSON");
  const format = FORMATS.find(f => f === j.format);
  if (!format) throw new ThermalError("E-TH-PKG", "its format “{format}” is not a thermal package", { format: str(j.format) });
  const version = num(j.version);
  if (version === undefined || version < 1) throw new ThermalError("E-TH-PKG", "the manifest has no version");
  const files = (j.files && typeof j.files === "object" ? j.files : {}) as Record<string, unknown>;
  if (version > VERSION && !str(files.mesh)) throw new ThermalError("E-TH-VERSION", "This thermal package needs a newer MöbiusCAD (format {format} version {v}).", { format, v: version });
  const s = (j.settings && typeof j.settings === "object" ? j.settings : {}) as Record<string, unknown>;
  const range = Array.isArray(j.range_C) && j.range_C.length === 2 && num(j.range_C[0]) !== undefined && num(j.range_C[1]) !== undefined && +j.range_C[1] > +j.range_C[0] ? [+j.range_C[0], +j.range_C[1]] as [number, number] : undefined;
  const parts: ThermalPart[] = [];
  const seen = new Set<number>();
  for (const r of Array.isArray(j.parts) ? j.parts : []) {
    const p = r && typeof r === "object" ? partOf(r as Record<string, unknown>) : null;
    if (p && !seen.has(p.id)) { seen.add(p.id); parts.push(p); }
  }
  const settings: ThermalSettings = {
    ambient: num(s.ambient_C), enclosure: str(s.enclosure) || undefined, orientation: str(s.orientation) || undefined,
    operatingPoint: str(s.operating_point) || undefined, grid: num(s.grid_mm), emissivity: num(s.emissivity),
  };
  const b = (j.board && typeof j.board === "object" ? j.board : {}) as Record<string, unknown>;
  const layers = num(b.layers), copper = num(b.copper_um), cover = num(b.coverage);
  const board = {
    ...(layers !== undefined && layers >= 1 && layers <= 64 ? { layers: Math.round(layers) } : {}),
    ...(copper !== undefined && copper > 0 && copper <= 500 ? { copper } : {}),
    ...(cover !== undefined && cover >= 0 && cover <= 1 ? { cover } : {}),
    ...(num(b.emissivity) !== undefined && num(b.emissivity)! > 0 && num(b.emissivity)! <= 1 ? { emis: num(b.emissivity)! } : {}),
  };
  // materials by key: an entry needs a conductivity; emissivity in (0, 1]
  const materials: Record<string, PackageMaterial> = {};
  if (j.materials && typeof j.materials === "object" && !Array.isArray(j.materials)) for (const [key, v] of Object.entries(j.materials as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const m = v as Record<string, unknown>, k = num(m.k_WmK), cp = num(m.cp_JkgK), rho = num(m.density_kgm3), e = num(m.emissivity);
    if (!(k !== undefined && k > 0)) continue;
    materials[key] = { name: str(m.name).trim() || key, k, ...(cp !== undefined && cp > 0 ? { cp } : {}), ...(rho !== undefined && rho > 0 ? { density: rho } : {}), ...(e !== undefined && e > 0 && e <= 1 ? { emis: e } : {}) };
  }
  return {
    format, version, newer: version > VERSION, app: str(j.app), created: str(j.created), design: str(j.design),
    files: { mesh: str(files.mesh) || undefined, sources: str(files.sources) || undefined, picture: str(files.picture) || undefined, step: str(files.step) || undefined, gerber: str(files.gerber) || undefined },
    settings, accuracy: num(j.accuracy_C), range, parts, ...(Object.keys(board).length ? { board } : {}), ...(Object.keys(materials).length ? { materials } : {}),
  };
}

/** Splits CSV text into rows of cells (quotes, doubled quotes, CR LF). */
export function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.length > 1 || row[0] !== "") rows.push(row);
  return rows;
}

/** The heat-source CSV as parts; columns are found by header name, unknown ones ignored. */
export function readSources(text: string): ThermalPart[] {
  const rows = csvRows(text);
  if (rows.length < 2) return [];
  const head = rows[0].map(h => h.trim());
  // a table of powers alone may leave part_id out: rows are numbered then
  const numbered = !head.includes("part_id");
  const out: ThermalPart[] = [];
  const seen = new Set<number>();
  for (const [k, r] of rows.slice(1).entries()) {
    const o: Record<string, unknown> = {};
    head.forEach((h, i) => { o[h] = (r[i] ?? "").trim(); });
    if (numbered) o.part_id = k + 1;
    const p = partOf(o);
    if (p && !seen.has(p.id)) { seen.add(p.id); out.push(p); }
  }
  return out;
}

/**
 * True when CSV text is a heat-source table (FR-TPKG-015): its header names `p_total_W` and a way to find the
 * part (`step_bodies` or `designator`).
 */
export function isSourcesCsv(text: string) {
  const line = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r?\n/, 1)[0] ?? "";
  const head = csvRows(line)[0]?.map(h => h.trim()) ?? [];
  return head.includes("p_total_W") && (head.includes("step_bodies") || head.includes("designator"));
}

const base = (n: string) => n.replace(/^.*[\\/]/, "");
const MANIFEST = /-thermal\.json$/i;

/** True when the names include a thermal manifest (cheap test before reading anything). */
export function hasManifestName(names: Iterable<string>) {
  for (const n of names) if (MANIFEST.test(n)) return true;
  return false;
}

/** The manifest among loose or unzipped files: `*-thermal.json`, else any .json whose format is a thermal one. */
export function findManifest(files: Map<string, Uint8Array>): { name: string; text: string } | null {
  const dec = new TextDecoder();
  const names = [...files.keys()].filter(n => !base(n).startsWith("."));
  const first = names.find(n => MANIFEST.test(n));
  if (first) return { name: first, text: dec.decode(files.get(first)!) };
  for (const n of names.filter(x => /\.json$/i.test(x))) {
    const data = files.get(n)!;
    if (data.length > 64 * 1024 * 1024) continue;
    const text = dec.decode(data);
    if (/"format"\s*:\s*"(?:tubecad|mobiuscad)-thermal"/.test(text)) return { name: n, text };
  }
  return null;
}

/**
 * Reads a package from its files (an unzipped archive, or loose files picked together). The manifest's part table
 * wins over the CSV; the CSV fills parts and fields the manifest lacks. A lone .vtu (no manifest) opens as a map
 * with unnamed parts (FR-TPKG-014).
 */
export async function readPackage(files: Map<string, Uint8Array>, fallbackName = "thermal", opts: ReadOptions = {}): Promise<ThermalPackage> {
  const notes: ThermalPackage["notes"] = [];
  const names = [...files.keys()];
  const pick = (want: string | undefined, ext: RegExp) => {
    if (want) { const hit = names.find(n => n === want) ?? names.find(n => base(n).toLowerCase() === base(want).toLowerCase()); if (hit) return hit; }
    return names.find(n => ext.test(n) && !base(n).startsWith("."));
  };
  const mf = findManifest(files);
  const vtuOnly = !mf ? names.filter(n => /\.vtu$/i.test(n)) : [];
  if (!mf && !vtuOnly.length) {
    const csv = names.find(n => /\.csv$/i.test(n) && !base(n).startsWith(".") && isSourcesCsv(new TextDecoder().decode(files.get(n)!.subarray(0, 4096))));
    if (csv) return sourcesPackage(base(csv), new TextDecoder().decode(files.get(csv)!));
  }
  if (!mf && vtuOnly.length !== 1) throw new ThermalError("E-TH-PKG", "it has no manifest (a file ending in -thermal.json)");
  const manifest: ThermalManifest = mf ? readManifest(mf.text)
    : { format: "tubecad-thermal", version: 1, newer: false, app: "", created: "", design: "", files: { mesh: vtuOnly[0] }, settings: {}, parts: [] };
  if (manifest.newer) notes.push({ text: "This package was written by a newer app: some data may be missing." });
  const meshName = pick(manifest.files.mesh, /\.vtu$/i);
  if (!meshName) throw new ThermalError("E-TH-PKG", "its mesh file {name} is missing", { name: manifest.files.mesh ?? "*.vtu" });
  const mesh = await readVtu(files.get(meshName)!, opts);
  if (mesh.field) notes.push({ text: mesh.kelvin ? "Temperatures read from the array {name} (kelvin, shown in °C)." : "Temperatures read from the array {name}.", params: { name: mesh.field } });
  if (mesh.pieces) notes.push({ text: "The file names no parts: each connected piece of its surfaces is a part ({n}).", params: { n: new Set(mesh.part).size } });
  const dec = new TextDecoder();
  const csvName = pick(manifest.files.sources, /heat-sources\.csv$/i);
  if (csvName) {
    const rows = readSources(dec.decode(files.get(csvName)!));
    const byId = new Map(manifest.parts.map(p => [p.id, p]));
    for (const r of rows) {
      const m = byId.get(r.id);
      if (!m) { manifest.parts.push(r); continue; }
      // The manifest wins; the CSV only fills what it leaves out.
      const life = m.lifeBy === "computed" && r.lifeBy === "package" ? { life: r.life, lifeBy: r.lifeBy } : {};
      Object.assign(m, { ...r, ...m, ...life });
    }
  }
  manifest.parts.sort((a, b) => a.id - b.id);
  // Parts the mesh has but no table names: shown as "Part n".
  const known = new Set(manifest.parts.map(p => p.id));
  const extra = new Set<number>();
  for (let i = 0; i < mesh.part.length; i++) { const id = mesh.part[i]; if (id > 0 && !known.has(id)) extra.add(id); }
  for (const id of [...extra].sort((a, b) => a - b)) manifest.parts.push({ id, designator: `#${id}`, bodies: [], part: "" });
  if (manifest.settings.ambient === undefined && mesh.ambient !== undefined) manifest.settings.ambient = mesh.ambient;
  if (manifest.settings.grid === undefined && mesh.gridStep !== undefined) manifest.settings.grid = mesh.gridStep;
  const picName = pick(manifest.files.picture, /-thermal\.png$/i);
  const stepName = pick(manifest.files.step, /\.(step|stp)$/i);
  const name = mf ? base(mf.name).replace(MANIFEST, "") : base(meshName).replace(/(-thermal)?\.vtu$/i, "");
  return {
    name: name || fallbackName, manifest, mesh, notes,
    picture: picName ? files.get(picName) : undefined,
    step: stepName ? { name: base(stepName), data: files.get(stepName)! } : undefined,
  };
}

/** A heat-source table alone as a package with no map (FR-TPKG-015). Throws E-TH-PKG when no row has a power. */
export function sourcesPackage(fileName: string, text: string): ThermalPackage {
  const parts = readSources(text).sort((a, b) => a.id - b.id);
  if (!parts.some(p => p.p !== undefined)) throw new ThermalError("E-TH-PKG", "its heat-source table names no part with a power");
  const mesh: ThermalMesh = { pos: new Float32Array(0), temp: new Float32Array(0), tri: new Uint32Array(0), part: new Int32Array(0), range: [0, 0] };
  return {
    name: fileName.replace(/(-heat-sources)?\.csv$/i, "") || "heat sources",
    manifest: { format: "mobiuscad-thermal", version: VERSION, newer: false, app: "", created: "", design: "", files: { sources: fileName }, settings: {}, parts },
    mesh, notes: [], sourcesOnly: true,
  };
}

// ---------- what the map says about each part ----------

export interface PartStat {
  /** Triangles of the part in the mesh. */
  tris: number;
  /** Lowest and highest temperature on its surfaces (°C), and where the highest is. */
  min: number; max: number; at: [number, number, number];
  /** Box of its triangles: min x, y, z, max x, y, z. */
  box: [number, number, number, number, number, number];
}

/** Temperature range, hottest point and box per part id (0 = the board). */
export function partStats(m: ThermalMesh): Map<number, PartStat> {
  const out = new Map<number, PartStat>();
  for (let k = 0; k < m.part.length; k++) {
    const id = m.part[k];
    let s = out.get(id);
    if (!s) out.set(id, s = { tris: 0, min: Infinity, max: -Infinity, at: [0, 0, 0], box: [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity] });
    s.tris++;
    for (let c = 0; c < 3; c++) {
      const i = m.tri[k * 3 + c], t = m.temp[i], x = m.pos[i * 3], y = m.pos[i * 3 + 1], z = m.pos[i * 3 + 2];
      if (t < s.min) s.min = t;
      if (t > s.max) { s.max = t; s.at = [x, y, z]; }
      if (x < s.box[0]) s.box[0] = x; if (y < s.box[1]) s.box[1] = y; if (z < s.box[2]) s.box[2] = z;
      if (x > s.box[3]) s.box[3] = x; if (y > s.box[4]) s.box[4] = y; if (z > s.box[5]) s.box[5] = z;
    }
  }
  return out;
}

export type ProblemKind = "over" | "life" | "board" | "near";
export interface ThermalProblem {
  kind: ProblemKind;
  /** Part id (0 = the board). */
  id: number;
  /** °C over the limit, hours of life, the board's highest temperature, or (near) mm between the capacitor and the hot part. */
  value: number;
  limit: number;
  /** near: the part over `HOT_POWER` next to the capacitor `id`, and its power (W). */
  hot?: number; p?: number;
  at?: [number, number, number];
}
export interface CheckLimits {
  /** Electrolytic life under this many hours is a problem (default 10,000). */
  life: number;
  /** Highest board temperature allowed (default 105 °C: FR-4's glass transition less a margin). */
  board: number;
}
export const DEFAULT_LIMITS: CheckLimits = { life: 10_000, board: 105 };

/** The temperature a part is judged by: the package's own figure, else the hottest point of its surfaces. */
export function partTemp(p: ThermalPart, stats: Map<number, PartStat>) {
  return p.t ?? stats.get(p.id)?.max;
}
export function partMargin(p: ThermalPart, stats: Map<number, PartStat>) {
  const t = partTemp(p, stats);
  return p.limit !== undefined && t !== undefined ? p.limit - t : undefined;
}

/** Problems of a map (FR-TMAP-021): parts over their limit (worst first), short-lived capacitors, a board too hot. */
export function problems(pk: { manifest: ThermalManifest }, stats: Map<number, PartStat>, lim: CheckLimits = DEFAULT_LIMITS): ThermalProblem[] {
  const out: ThermalProblem[] = [];
  for (const p of pk.manifest.parts) {
    const m = partMargin(p, stats);
    if (m !== undefined && m < 0) out.push({ kind: "over", id: p.id, value: -m, limit: p.limit!, at: stats.get(p.id)?.at });
  }
  out.sort((a, b) => b.value - a.value);
  const life = pk.manifest.parts.filter(p => p.life !== undefined && p.life < lim.life).sort((a, b) => a.life! - b.life!);
  for (const p of life) out.push({ kind: "life", id: p.id, value: p.life!, limit: lim.life, at: stats.get(p.id)?.at });
  const b = stats.get(0);
  if (b && b.max > lim.board) out.push({ kind: "board", id: 0, value: b.max, limit: lim.board, at: b.at });
  const boxOf = (p: ThermalPart) => stats.get(p.id)?.box ?? p.box;
  for (const n of nearHot(pk.manifest.parts.map(p => ({ id: p.id, box: boxOf(p), p: p.p ?? 0, elyt: isElectrolytic(p) }))))
    out.push({ kind: "near", id: n.cap, value: n.gap, limit: NEAR_GAP, hot: n.hot, p: n.p, at: stats.get(n.cap)?.at });
  return out;
}

/** An electrolytic capacitor: one with a life figure, or named so. */
export function isElectrolytic(p: Pick<ThermalPart, "life" | "ratedLife" | "part">) {
  return p.life !== undefined || p.ratedLife !== undefined || /electrolytic|\belko\b|e-?cap/i.test(p.part ?? "");
}
/** A part dissipating more than this (W) heats what stands next to it (FR-TBRD-023). */
export const HOT_POWER = 1;
/** An electrolytic this close (mm, between the boxes) to a hot part sits in its temperature gradient (FR-TBRD-023). */
export const NEAR_GAP = 10;
type Box6 = readonly [number, number, number, number, number, number] | number[];
/** Shortest distance between two boxes (0 when they touch or overlap), mm. */
export function boxGap(a: Box6, b: Box6) {
  let s = 0;
  for (let i = 0; i < 3; i++) { const d = Math.max(0, a[i] - b[i + 3], b[i] - a[i + 3]); s += d * d; }
  return Math.sqrt(s);
}
/**
 * Electrolytics next to a part over `hot` W (FR-TBRD-023): each capacitor with the nearest such part within `gap` mm.
 * Heat from the hot part runs across the capacitor, so one side of it ages faster than its own temperature says.
 */
export function nearHot(items: { id: number; box?: Box6; p: number; elyt: boolean }[], gap = NEAR_GAP, hot = HOT_POWER) {
  const hots = items.filter(x => x.p > hot && x.box), out: { cap: number; hot: number; gap: number; p: number }[] = [];
  for (const c of items) {
    if (!c.elyt || !c.box) continue;
    let best: { hot: number; gap: number; p: number } | null = null;
    for (const h of hots) {
      if (h.id === c.id) continue;
      const g = boxGap(c.box, h.box!);
      if (g <= gap && (!best || g < best.gap)) best = { hot: h.id, gap: g, p: h.p };
    }
    if (best) out.push({ cap: c.id, ...best });
  }
  return out.sort((a, b) => a.gap - b.gap || a.cap - b.cap);
}

/** Parts in the order the list shows them: the least margin first, parts without a limit after, hottest first. */
export function byMargin(parts: ThermalPart[], stats: Map<number, PartStat>): ThermalPart[] {
  const key = (p: ThermalPart) => { const m = partMargin(p, stats); return m === undefined ? [1, -(partTemp(p, stats) ?? -Infinity)] : [0, m]; };
  return [...parts].sort((a, b) => { const x = key(a), y = key(b); return x[0] - y[0] || x[1] - y[1] || a.id - b.id; });
}

export interface ThermalSummary {
  /** Hottest part (by its judged temperature) and the hottest point of the whole map. */
  hottest?: { id: number; t: number };
  peak: { id: number; t: number; at: [number, number, number] };
  over: number;
  /** Shortest capacitor life. */
  life?: { id: number; h: number };
  board?: number;
  /** Total heat (W) and its split. */
  power: number; split: Record<HeatPath, number>;
}
export function summary(pk: { manifest: ThermalManifest }, stats: Map<number, PartStat>): ThermalSummary {
  let hottest: ThermalSummary["hottest"], life: ThermalSummary["life"], over = 0, power = 0;
  const split: Record<HeatPath, number> = { board: 0, air: 0, heatsink: 0, chassis: 0 };
  for (const p of pk.manifest.parts) {
    const t = partTemp(p, stats);
    if (t !== undefined && (!hottest || t > hottest.t)) hottest = { id: p.id, t };
    const m = partMargin(p, stats);
    if (m !== undefined && m < 0) over++;
    if (p.life !== undefined && (!life || p.life < life.h)) life = { id: p.id, h: p.life };
    power += p.p ?? 0;
    split.board += p.pBoard ?? 0;
    split.air += p.pAir ?? 0;
    if (p.pSink) split[p.path === "chassis" ? "chassis" : "heatsink"] += p.pSink;
  }
  let peak: ThermalSummary["peak"] = { id: 0, t: -Infinity, at: [0, 0, 0] };
  for (const [id, s] of stats) if (s.max > peak.t) peak = { id, t: s.max, at: s.at };
  return { hottest, peak, over, life, board: stats.get(0)?.max, power, split };
}
