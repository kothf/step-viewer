// VTK XML UnstructuredGrid (.vtu) reader and writer for thermal packages (FRS-thermal FR-TPKG-011, section 15.2).
// Pure: no DOM (a worker and node have no DOMParser), so the few tags a .vtu has are found by scanning the text.
// Read: one <Piece>, DataArrays in ascii or binary (base64) form, UInt32 or UInt64 headers, little-endian,
// plain or vtkZLibDataCompressor blocks; triangles (type 5) and quads (type 9, split a-b-c / a-c-d).

/** A reader error: `reason` is a fixed English text (an i18n key), `params` fill its {placeholders}. */
export class ThermalError extends Error {
  constructor(public code: "E-TH-PKG" | "E-TH-VERSION" | "E-TH-VTU", public reason: string, public params: Record<string, string | number> = {}) {
    super(reason.replace(/\{(\w+)\}/g, (_m, k: string) => String(params[k] ?? "")));
  }
}

/** The surfaces of a thermal map as triangles, with a temperature per point and a part per triangle. */
export interface ThermalMesh {
  /** x, y, z per point (mm, the STEP's frame). */
  pos: Float32Array;
  /** °C per point. */
  temp: Float32Array;
  /** Three point indices per triangle. */
  tri: Uint32Array;
  /** Part of each triangle: 0 = the board, 1…n = `part_id`. */
  part: Int32Array;
  /** 0 part body, 1 board top, 2 board bottom, 3 board edge; absent when the file has no Face array. */
  face?: Int8Array;
  /** W per triangle (the whole part's dissipation). */
  power?: Float32Array;
  /** W/m² per triangle (heat leaving a board face). */
  flux?: Float32Array;
  ambient?: number;
  gridStep?: number;
  /** Lowest and highest temperature of the points. */
  range: [number, number];
}

/** Most points or cells a map may have (a 300 × 200 mm board on a 0.5 mm grid is about 1 M cells). */
export const MAX_POINTS = 20_000_000;

const bad = (reason: string, params: Record<string, string | number> = {}) => new ThermalError("E-TH-VTU", reason, params);

interface Tag { attrs: Record<string, string>; body: string }

function attrsOf(s: string) {
  const a: Record<string, string> = {};
  for (const m of s.matchAll(/([\w:]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) a[m[1]] = m[2] ?? m[3] ?? "";
  return a;
}
/** The first `<name …>…</name>` (or `<name …/>`) of the text. */
function tagOf(text: string, name: string): Tag | null {
  const open = new RegExp(`<${name}\\b([^>]*?)(/?)>`).exec(text);
  if (!open) return null;
  if (open[2]) return { attrs: attrsOf(open[1]), body: "" };
  const from = open.index + open[0].length;
  const end = text.indexOf(`</${name}>`, from);
  if (end < 0) throw bad("the file is cut short (no </{tag}>)", { tag: name });
  return { attrs: attrsOf(open[1]), body: text.slice(from, end) };
}
function arraysOf(text: string): Tag[] {
  const out: Tag[] = [];
  const re = /<DataArray\b([^>]*?)(\/?)>/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[2]) { out.push({ attrs: attrsOf(m[1]), body: "" }); continue; }
    const from = m.index + m[0].length;
    const end = text.indexOf("</DataArray>", from);
    if (end < 0) throw bad("the file is cut short (no </{tag}>)", { tag: "DataArray" });
    out.push({ attrs: attrsOf(m[1]), body: text.slice(from, end) });
    re.lastIndex = end;
  }
  return out;
}

type Num = Float32Array | Float64Array | Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array;
const TYPES: Record<string, { size: number; make: (b: ArrayBuffer) => Num | Float64Array }> = {
  Float32: { size: 4, make: b => new Float32Array(b) },
  Float64: { size: 8, make: b => new Float64Array(b) },
  Int8: { size: 1, make: b => new Int8Array(b) },
  UInt8: { size: 1, make: b => new Uint8Array(b) },
  Int16: { size: 2, make: b => new Int16Array(b) },
  UInt16: { size: 2, make: b => new Uint16Array(b) },
  Int32: { size: 4, make: b => new Int32Array(b) },
  UInt32: { size: 4, make: b => new Uint32Array(b) },
  // 64-bit integers (connectivity of some writers) are read as doubles: exact up to 2^53.
  Int64: { size: 8, make: b => Float64Array.from(new BigInt64Array(b), Number) },
  UInt64: { size: 8, make: b => Float64Array.from(new BigUint64Array(b), Number) },
};

function base64(s: string): Uint8Array {
  let bin: string;
  try { bin = atob(s); } catch { throw bad("a data array is not valid base64"); }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function inflate(data: Uint8Array, expect: number): Promise<Uint8Array> {
  try {
    const s = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate"));
    const reader = s.getReader();
    const out = new Uint8Array(expect);
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // A block that inflates past what its header says is refused at once (zip bombs).
      if (n + value.length > expect) { void reader.cancel(); throw bad("a compressed block is larger than its header says"); }
      out.set(value, n);
      n += value.length;
    }
    if (n !== expect) throw bad("a compressed block is smaller than its header says");
    return out;
  } catch (err) {
    if (err instanceof ThermalError) throw err;
    throw bad("a compressed block could not be read");
  }
}

interface Ctx { header: 4 | 8; zlib: boolean; limit: number }

/** The bytes of a binary DataArray: header(s) and data are separate base64 runs, as VTK writes them. */
async function binaryBytes(text: string, c: Ctx): Promise<Uint8Array> {
  const s = text.replace(/\s+/g, "");
  const ints = (u8: Uint8Array, n: number) => {
    const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), out: number[] = [];
    for (let i = 0; i < n; i++) {
      const x = c.header === 8 ? Number(v.getBigUint64(i * 8, true)) : v.getUint32(i * 4, true);
      out.push(x);
    }
    return out;
  };
  const chars = (bytes: number) => Math.ceil(bytes / 3) * 4;
  if (!c.zlib) {
    const hc = chars(c.header);
    if (s.length < hc) throw bad("a data array is cut short");
    const [n] = ints(base64(s.slice(0, hc)), 1);
    if (n > c.limit) throw bad("a data array is too large");
    // Either two base64 runs (VTK) or one run holding header + data.
    const two = s.slice(0, hc).endsWith("=") || chars(n) === s.length - hc;
    const data = two ? base64(s.slice(hc)) : base64(s).subarray(c.header);
    if (data.length < n) throw bad("a data array is cut short");
    return data.subarray(0, n);
  }
  const h3 = chars(3 * c.header);
  if (s.length < h3) throw bad("a data array is cut short");
  const [blocks, size, last] = ints(base64(s.slice(0, h3)), 3);
  if (!blocks) return new Uint8Array(0);
  if (blocks > 1e6 || size > c.limit) throw bad("a data array is too large");
  const total = (blocks - 1) * size + (last || size);
  if (total > c.limit) throw bad("a data array is too large");
  const hc = chars((3 + blocks) * c.header);
  if (s.length < hc) throw bad("a data array is cut short");
  const sizes = ints(base64(s.slice(0, hc)), 3 + blocks).slice(3);
  const data = base64(s.slice(hc));
  if (sizes.reduce((a, b) => a + b, 0) > data.length) throw bad("a data array is cut short");
  const out = new Uint8Array(total);
  let p = 0, q = 0;
  for (let i = 0; i < blocks; i++) {
    const want = i === blocks - 1 ? (last || size) : size;
    out.set(await inflate(data.subarray(p, p + sizes[i]), want), q);
    p += sizes[i];
    q += want;
  }
  return out;
}

async function values(tag: Tag, c: Ctx): Promise<Num | Float64Array> {
  const type = TYPES[tag.attrs.type ?? "Float32"];
  if (!type) throw bad("unknown data type {type}", { type: tag.attrs.type });
  const format = tag.attrs.format ?? "ascii";
  if (format === "ascii") {
    const parts = tag.body.trim().split(/\s+/);
    const n = parts.length === 1 && parts[0] === "" ? 0 : parts.length;
    if (n * type.size > c.limit) throw bad("a data array is too large");
    const out = type.make(new ArrayBuffer(n * type.size)) as Float64Array;
    for (let i = 0; i < n; i++) out[i] = Number(parts[i]);
    return out;
  }
  if (format !== "binary") throw bad("data arrays in the “{format}” form are not read; write ascii or binary", { format });
  const bytes = await binaryBytes(tag.body, c);
  if (bytes.length % type.size) throw bad("a data array has a broken length");
  // A copy: the typed array needs its own aligned buffer.
  return type.make(bytes.slice().buffer as ArrayBuffer);
}

/** Reads a .vtu. Throws `ThermalError` E-TH-VTU naming what is wrong; never hangs on a damaged file. */
export async function readVtu(data: Uint8Array | string): Promise<ThermalMesh> {
  const text = typeof data === "string" ? data : new TextDecoder().decode(data);
  const file = tagOf(text, "VTKFile");
  if (!file) throw bad("it is not a VTK XML file");
  if ((file.attrs.type ?? "UnstructuredGrid") !== "UnstructuredGrid") throw bad("it is a VTK {type} file, not an UnstructuredGrid", { type: file.attrs.type });
  if ((file.attrs.byte_order ?? "LittleEndian") !== "LittleEndian") throw bad("big-endian files are not read");
  const comp = file.attrs.compressor ?? "";
  if (comp && comp !== "vtkZLibDataCompressor") throw bad("the compressor {name} is not read", { name: comp });
  const c: Ctx = { header: file.attrs.header_type === "UInt64" ? 8 : 4, zlib: !!comp, limit: MAX_POINTS * 12 };
  const piece = tagOf(file.body, "Piece");
  if (!piece) throw bad("it has no <Piece>");
  const np = +piece.attrs.NumberOfPoints, nc = +piece.attrs.NumberOfCells;
  if (!Number.isInteger(np) || !Number.isInteger(nc) || np < 0 || nc < 0) throw bad("the point or cell count is missing");
  if (np > MAX_POINTS || nc > MAX_POINTS) throw bad("the mesh is too large ({n} points)", { n: Math.max(np, nc) });

  const section = (name: string) => arraysOf(tagOf(piece.body, name)?.body ?? "");
  const named = (list: Tag[], name: string) => list.find(a => a.attrs.Name === name);
  const read = async (tag: Tag | undefined, what: string, len: number) => {
    if (!tag) throw bad("the array {name} is missing", { name: what });
    const v = await values(tag, c);
    if (v.length !== len) throw bad("the array {name} has {n} values, expected {m}", { name: what, n: v.length, m: len });
    return v;
  };

  const pts = await read(section("Points")[0], "Points", np * 3);
  const pointData = section("PointData"), cellData = section("CellData"), cells = section("Cells");
  const temp = await read(named(pointData, "Temperature_C"), "Temperature_C", np);
  const partId = await read(named(cellData, "PartId"), "PartId", nc);
  const offs = await read(named(cells, "offsets"), "offsets", nc);
  const types = await read(named(cells, "types"), "types", nc);
  const connTag = named(cells, "connectivity");
  if (!connTag) throw bad("the array {name} is missing", { name: "connectivity" });
  const conn = await values(connTag, c);
  const opt = async (name: string) => { const t = named(cellData, name); return t ? read(t, name, nc) : undefined; };
  const faceIn = await opt("Face"), powerIn = await opt("Power_W"), fluxIn = await opt("HeatFlux_W_m2");

  const pos = pts instanceof Float32Array ? pts : Float32Array.from(pts);
  const t = temp instanceof Float32Array ? temp : Float32Array.from(temp);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < np; i++) {
    const x = t[i];
    if (!Number.isFinite(x)) throw bad("a temperature is not a number (point {i})", { i });
    if (x < lo) lo = x;
    if (x > hi) hi = x;
  }
  for (let i = 0; i < pos.length; i++) if (!Number.isFinite(pos[i])) throw bad("a point is not a number (point {i})", { i: Math.floor(i / 3) });

  // Count the triangles, then fill.
  let nt = 0, prev = 0;
  for (let i = 0; i < nc; i++) {
    const end = offs[i], n = end - prev, ty = types[i];
    if (!(end >= prev) || end > conn.length) throw bad("cell {i} points past the end of the connectivity", { i });
    if (ty === 5 && n === 3) nt += 1;
    else if (ty === 9 && n === 4) nt += 2;
    else throw bad("cell {i} is of type {type} with {n} points; only triangles (5) and quads (9) are read", { i, type: ty, n });
    prev = end;
  }
  const tri = new Uint32Array(nt * 3), part = new Int32Array(nt);
  const face = faceIn ? new Int8Array(nt) : undefined, power = powerIn ? new Float32Array(nt) : undefined, flux = fluxIn ? new Float32Array(nt) : undefined;
  let k = 0;
  prev = 0;
  const put = (a: number, b: number, d: number, cell: number) => {
    if (!(a < np && b < np && d < np) || a < 0 || b < 0 || d < 0) throw bad("cell {i} names a point that does not exist", { i: cell });
    tri[k * 3] = a; tri[k * 3 + 1] = b; tri[k * 3 + 2] = d;
    part[k] = partId[cell];
    if (face) face[k] = faceIn![cell];
    if (power) power[k] = powerIn![cell];
    if (flux) flux[k] = fluxIn![cell];
    k++;
  };
  for (let i = 0; i < nc; i++) {
    const s = prev;
    put(conn[s], conn[s + 1], conn[s + 2], i);
    if (types[i] === 9) put(conn[s], conn[s + 2], conn[s + 3], i);
    prev = offs[i];
  }
  const field = arraysOf(tagOf(file.body, "FieldData")?.body ?? "");
  const one = async (name: string) => { const tg = named(field, name); if (!tg) return undefined; const v = await values(tg, c); return v.length && Number.isFinite(v[0]) ? v[0] : undefined; };
  return { pos, temp: t, tri, part, face, power, flux, ambient: await one("Ambient_C"), gridStep: await one("GridStep_mm"), range: np ? [lo, hi] : [0, 0] };
}

// ---------- writer (MöbiusCAD's own export, FR-TREP-010, and test fixtures) ----------

export interface VtuOptions {
  /** "ascii" (default), "binary" (base64) or "zlib" (base64 + vtkZLibDataCompressor). */
  encoding?: "ascii" | "binary" | "zlib";
  /** Header integers: 64-bit (default, as the board design app writes) or 32-bit. */
  header?: 4 | 8;
  /** Bytes per compressed block (default 32768). */
  block?: number;
}

function b64(u8: Uint8Array) {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}
async function deflate(u8: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([u8 as BlobPart]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/** Writes a thermal mesh as a .vtu (triangles only). */
export async function writeVtu(m: ThermalMesh, o: VtuOptions = {}): Promise<string> {
  const enc = o.encoding ?? "ascii", hs = o.header ?? 8, block = o.block ?? 32768;
  const np = m.temp.length, nt = m.part.length;
  const head = (list: number[]) => {
    const b = new ArrayBuffer(list.length * hs), v = new DataView(b);
    list.forEach((x, i) => (hs === 8 ? v.setBigUint64(i * 8, BigInt(x), true) : v.setUint32(i * 4, x, true)));
    return new Uint8Array(b);
  };
  const body = async (a: Num, dec: number) => {
    if (enc === "ascii") {
      const out: string[] = [];
      for (let i = 0; i < a.length; i++) out.push(dec && !Number.isInteger(a[i]) ? String(+a[i].toFixed(dec)) : String(a[i]));
      return out.join(" ");
    }
    const raw = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    if (enc === "binary") return b64(head([raw.length])) + b64(raw);
    const parts: Uint8Array[] = [];
    for (let p = 0; p < raw.length; p += block) parts.push(await deflate(raw.subarray(p, p + block)));
    const last = raw.length % block;
    const all = new Uint8Array(parts.reduce((s, x) => s + x.length, 0));
    let q = 0;
    for (const x of parts) { all.set(x, q); q += x.length; }
    return b64(head([parts.length, block, last, ...parts.map(x => x.length)])) + b64(all);
  };
  const arr = async (name: string, type: string, a: Num, comps = 0, dec = 4, tuples = 0) =>
    `<DataArray type="${type}" Name="${name}"${comps ? ` NumberOfComponents="${comps}"` : ""}${tuples ? ` NumberOfTuples="${tuples}"` : ""} format="${enc === "ascii" ? "ascii" : "binary"}">${await body(a, dec)}</DataArray>`;
  const offsets = new Int32Array(nt), types = new Uint8Array(nt).fill(5);
  for (let i = 0; i < nt; i++) offsets[i] = (i + 1) * 3;
  const cell: string[] = [await arr("PartId", "Int32", m.part)];
  if (m.face) cell.push(await arr("Face", "Int8", m.face));
  if (m.power) cell.push(await arr("Power_W", "Float32", m.power));
  if (m.flux) cell.push(await arr("HeatFlux_W_m2", "Float32", m.flux));
  const field: string[] = [];
  if (m.ambient !== undefined) field.push(await arr("Ambient_C", "Float32", new Float32Array([m.ambient]), 0, 4, 1));
  if (m.gridStep !== undefined) field.push(await arr("GridStep_mm", "Float32", new Float32Array([m.gridStep]), 0, 4, 1));
  return [
    `<?xml version="1.0"?>`,
    `<VTKFile type="UnstructuredGrid" version="1.0" byte_order="LittleEndian" header_type="${hs === 8 ? "UInt64" : "UInt32"}"${enc === "zlib" ? ` compressor="vtkZLibDataCompressor"` : ""}>`,
    `<UnstructuredGrid>`,
    ...(field.length ? [`<FieldData>`, ...field, `</FieldData>`] : []),
    `<Piece NumberOfPoints="${np}" NumberOfCells="${nt}">`,
    `<Points>`, await arr("Points", "Float32", m.pos, 3), `</Points>`,
    `<Cells>`, await arr("connectivity", "Int32", new Int32Array(m.tri)), await arr("offsets", "Int32", offsets), await arr("types", "UInt8", types), `</Cells>`,
    `<PointData Scalars="Temperature_C">`, await arr("Temperature_C", "Float32", m.temp, 0, 3), `</PointData>`,
    `<CellData>`, ...cell, `</CellData>`,
    `</Piece>`, `</UnstructuredGrid>`, `</VTKFile>`, ``,
  ].join("\n");
}
