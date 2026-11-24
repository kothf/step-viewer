// Simulation results kept with a model (.mcadres): the solved studies of one part or assembly, so they come back
// when the model is opened again. The study set-ups live in the model's own document; this file holds only what the
// solver made, which is large and goes out of date when the model changes. It is written beside the model file
// where MöbiusCAD may write into the folder (an assembly saved into its folder, Pack and Go), else carried inside the
// model file as `results.mcadres`. A ZIP:
//   results.json                manifest: format, version, the model's document id and name, one entry per study
//   <study id>.json / .bin      the study's results: JSON with every typed array moved into the .bin file
//   thermal/<name>-thermal.*    a steady thermal study as a thermal package (the board design app's format), when known
import { unzipLimited, zip } from "../model/zip";

export const RESULTS_EXT = ".mcadres";
/** The entry name inside a part or assembly file. */
export const RESULTS_ENTRY = "results.mcadres";
export const RESULTS_FORMAT = "mobiuscad-results";
export const RESULTS_VERSION = 1;

/** One study's results as kept. `key` fingerprints the model and the study set-up they were solved for. */
export interface SavedStudy {
  id: string;
  name: string;
  kind: string;
  key: string;
  /** When it was solved (ISO time). */
  at: string;
  data: unknown;
}

export interface ResultsManifest {
  format: string;
  version: number;
  /** The part's or assembly's document id: results only go back onto that model. */
  doc: string;
  model: string;
  app: string;
  saved: string;
  studies: { id: string; name: string; kind: string; key: string; at: string; file: string; thermal?: string[] }[];
}

export interface ResultsFile { doc: string; model: string; saved: string; studies: SavedStudy[] }

/** JSON with every object's keys sorted: the same text for a document read from a file (saved with sorted keys) and as built here. */
export function stableJson(v: unknown): string {
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") return Object.fromEntries(Object.keys(x).sort().map(k => [k, walk((x as Record<string, unknown>)[k])]));
    return x;
  };
  return JSON.stringify(walk(v));
}

/** A short fingerprint of a long key text (two 32-bit hashes and the length). */
export function keyHash(s: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${s.length.toString(36)}-${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}`;
}

type Typed = Float32Array | Float64Array | Int32Array | Uint32Array | Int8Array | Uint8Array | Int16Array | Uint16Array;
const KINDS: Record<string, { new(b: ArrayBuffer, o: number, n: number): Typed; BYTES_PER_ELEMENT: number }> = {
  f32: Float32Array, f64: Float64Array, i32: Int32Array, u32: Uint32Array, i8: Int8Array, u8: Uint8Array, i16: Int16Array, u16: Uint16Array,
};
const kindOf = (v: unknown): string | null => {
  if (v instanceof Float32Array) return "f32";
  if (v instanceof Float64Array) return "f64";
  if (v instanceof Int32Array) return "i32";
  if (v instanceof Uint32Array) return "u32";
  if (v instanceof Int8Array) return "i8";
  if (v instanceof Uint8Array) return "u8";
  if (v instanceof Int16Array) return "i16";
  if (v instanceof Uint16Array) return "u16";
  return null;
};
// markers no real key starts with
const TA = "\u0000ta", NUM = "\u0000n";

/** Any value of plain objects, arrays, numbers, strings, booleans and typed arrays as JSON text plus binary. */
export function encodeValue(value: unknown): { json: string; bin: Uint8Array } {
  const chunks: { v: Typed; o: number }[] = [];
  let size = 0;
  const walk = (v: unknown): unknown => {
    if (typeof v === "number") return Number.isFinite(v) ? v : { [NUM]: Number.isNaN(v) ? "NaN" : v > 0 ? "Inf" : "-Inf" };
    if (v === null || typeof v !== "object") return v;
    const k = kindOf(v);
    if (k) {
      const t = v as Typed;
      size = Math.ceil(size / 8) * 8;
      chunks.push({ v: t, o: size });
      const at = size;
      size += t.byteLength;
      return { [TA]: k, o: at, n: t.length };
    }
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, unknown> = {};
    for (const [key, x] of Object.entries(v as Record<string, unknown>)) if (x !== undefined && typeof x !== "function") out[key] = walk(x);
    return out;
  };
  const json = JSON.stringify(walk(value));
  const bin = new Uint8Array(size);
  for (const c of chunks) bin.set(new Uint8Array(c.v.buffer, c.v.byteOffset, c.v.byteLength), c.o);
  return { json, bin };
}

export function decodeValue(json: string, bin: Uint8Array): unknown {
  // an own copy, aligned for every array kind
  const buf = bin.slice().buffer;
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(walk);
    const o = v as Record<string, unknown>;
    if (typeof o[TA] === "string") {
      const K = KINDS[o[TA] as string], at = Number(o.o), n = Number(o.n);
      if (!K || !(at >= 0) || !(n >= 0) || at + n * K.BYTES_PER_ELEMENT > buf.byteLength) throw new Error("The results file is damaged.");
      return new K(buf, at, n);
    }
    if (typeof o[NUM] === "string") return o[NUM] === "NaN" ? NaN : o[NUM] === "Inf" ? Infinity : -Infinity;
    const out: Record<string, unknown> = {};
    for (const [key, x] of Object.entries(o)) out[key] = walk(x);
    return out;
  };
  return walk(JSON.parse(json));
}

const safeName = (s: string) => s.replace(/[^\w.-]+/g, "_").slice(0, 60) || "study";

/** The results file of one model. `thermal` = extra files per study id (a thermal package), put under thermal/. */
export async function packResults(r: ResultsFile, app: string, thermal: Map<string, { name: string; data: Uint8Array | string }[]> = new Map()): Promise<Uint8Array> {
  const files: { name: string; data: Uint8Array | string }[] = [];
  const used = new Set<string>();
  const mf: ResultsManifest = { format: RESULTS_FORMAT, version: RESULTS_VERSION, doc: r.doc, model: r.model, app, saved: r.saved, studies: [] };
  for (const s of r.studies) {
    let base = safeName(s.id), k = 2;
    while (used.has(base)) base = `${safeName(s.id)}-${k++}`;
    used.add(base);
    const { json, bin } = encodeValue(s.data);
    files.push({ name: `${base}.json`, data: json }, { name: `${base}.bin`, data: bin });
    const extra = thermal.get(s.id) ?? [];
    for (const f of extra) files.push({ name: `thermal/${f.name}`, data: f.data });
    mf.studies.push({ id: s.id, name: s.name, kind: s.kind, key: s.key, at: s.at, file: base, ...(extra.length ? { thermal: extra.map(f => `thermal/${f.name}`) } : {}) });
  }
  files.unshift({ name: "results.json", data: `${JSON.stringify(mf, null, 2)}\n` });
  return zip(files);
}

export class ResultsError extends Error {}

export async function unpackResults(bytes: Uint8Array | ArrayBuffer): Promise<ResultsFile> {
  const buf = bytes instanceof Uint8Array ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer : bytes;
  const files = await unzipLimited(buf, 1024 ** 3);
  const head = files.get("results.json");
  if (!head) throw new ResultsError("Not a MöbiusCAD results file.");
  const dec = new TextDecoder();
  const mf = JSON.parse(dec.decode(head)) as ResultsManifest;
  if (mf.format !== RESULTS_FORMAT) throw new ResultsError("Not a MöbiusCAD results file.");
  if (mf.version > RESULTS_VERSION) throw new ResultsError("These results were saved by a newer MöbiusCAD. Update the app to read them.");
  const studies: SavedStudy[] = [];
  for (const s of mf.studies ?? []) {
    const j = files.get(`${s.file}.json`), b = files.get(`${s.file}.bin`);
    if (!j || !b) continue;
    studies.push({ id: s.id, name: s.name, kind: s.kind, key: s.key, at: s.at, data: decodeValue(dec.decode(j), b) });
  }
  return { doc: mf.doc, model: mf.model, saved: mf.saved, studies };
}

/** Only the manifest: which model the results belong to (cheap: the study data is not decoded). */
export async function resultsHead(bytes: Uint8Array | ArrayBuffer): Promise<ResultsManifest | null> {
  try {
    const buf = bytes instanceof Uint8Array ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer : bytes;
    const head = (await unzipLimited(buf, 1024 ** 3)).get("results.json");
    const mf = head ? JSON.parse(new TextDecoder().decode(head)) as ResultsManifest : null;
    return mf?.format === RESULTS_FORMAT ? mf : null;
  } catch { return null; }
}

/** "Bracket.mcadprt" → "Bracket.mcadres". */
export const resultsName = (modelFile: string) => `${modelFile.replace(/\.[^./]+$/, "")}${RESULTS_EXT}`;

/**
 * The bridge between the simulation and the model controllers: they pack and read results files without knowing
 * the simulation's state. The simulation sets it up when it starts.
 */
export interface ResultsHub {
  /** The results file of a document (by its document), null when it has no results. */
  pack(doc: { id: string; name: string; studies?: { id: string }[] }): Promise<Uint8Array | null>;
  /** A results file read with a document: its studies' results come back when it is shown. */
  take(docId: string, bytes: Uint8Array): Promise<number>;
}
let hub: ResultsHub | null = null;
export const setResultsHub = (h: ResultsHub | null) => { hub = h; };
export async function resultsOf(doc: { id: string; name: string; studies?: { id: string }[] }): Promise<Uint8Array | null> {
  if (!hub || !doc.studies?.length) return null;
  try { return await hub.pack(doc); } catch { return null; }
}
export async function takeResults(docId: string, bytes: Uint8Array | null | undefined): Promise<number> {
  if (!hub || !bytes?.length) return 0;
  try { return await hub.take(docId, bytes); } catch { return 0; }
}
