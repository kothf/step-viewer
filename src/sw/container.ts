// SolidWorks part and assembly files (.sldprt, .sldasm): the container.
//
// Since SolidWorks 2015 a file is a list of sections, each one a 6-byte
// marker, a small header, its name (each byte's nibbles swapped) and raw
// deflate data. Older files are OLE compound files with the same streams.
// What we use from it:
//   Contents/Config-<n>-Partition   the model as a Parasolid transmit file
//                                   (zlib chunks, see parasolidStreams)
//   PreviewPNG                      the thumbnail SolidWorks shows
//   swXmlContents/COMPINSTANCETREE  an assembly's components and placements
// Nothing here is documented by Dassault; the layout comes from the files.

const MARKER = [0x14, 0x00, 0x06, 0x00, 0x08, 0x00];
/** Header of each zlib chunk in a partition stream (the 16 bytes before its sizes). */
const CHUNK_ID = [0x23, 0x1d, 0xd5, 0x71, 0xda, 0x81, 0x48, 0xa2, 0xa8, 0x58, 0x98, 0xb2, 0x1b, 0x89, 0xef, 0x99];

export type Sections = Map<string, Uint8Array>;

export function isSolidWorksName(name: string) { return /\.(sldprt|sldasm)$/i.test(name); }

async function inflate(data: Uint8Array, format: "deflate" | "deflate-raw"): Promise<Uint8Array> {
  const ds = new DecompressionStream(format);
  const out = new Blob([data]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

const u32 = (b: Uint8Array, i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
const u16 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);

function find(b: Uint8Array, pat: number[], from: number) {
  outer: for (let i = from; i <= b.length - pat.length; i++) {
    if (b[i] !== pat[0]) continue;
    for (let k = 1; k < pat.length; k++) if (b[i + k] !== pat[k]) continue outer;
    return i;
  }
  return -1;
}

/** All named streams of a SolidWorks file, decompressed. */
export async function readSections(bytes: Uint8Array): Promise<Sections> {
  if (u32(bytes, 0) === 0xe011cfd0 && u32(bytes, 4) === 0xe11ab1a1) return readCompoundFile(bytes);
  const out: Sections = new Map();
  let i = find(bytes, MARKER, 0);
  while (i >= 0 && i + 26 <= bytes.length) {
    const csize = u32(bytes, i + 14), usize = u32(bytes, i + 18), nlen = u32(bytes, i + 22);
    const start = i + 26 + nlen;
    let next = i + 6;
    if (nlen > 0 && nlen < 1024 && start + csize <= bytes.length) {
      let name = "";
      for (let k = i + 26; k < start; k++) { const c = bytes[k]; name += String.fromCharCode(((c >> 4) | (c << 4)) & 0xff); }
      if (/^[\x20-\x7e]+$/.test(name)) {
        if (csize === 0 && usize === 0) { if (!out.has(name)) out.set(name, new Uint8Array(0)); }
        else if (csize > 0) {
          try {
            const data = await inflate(bytes.subarray(start, start + csize), "deflate-raw");
            if (data.length === usize) { out.set(name, data); next = start + csize; }
          } catch { /* not a section after all (the index at the end repeats the names) */ }
        }
      }
    }
    i = find(bytes, MARKER, next);
  }
  if (!out.size) throw new Error("Not a SolidWorks file, or a version this viewer can't read");
  return out;
}

// ---------- OLE compound file (SolidWorks 2014 and older) ----------

function readCompoundFile(b: Uint8Array): Sections {
  const shift = u16(b, 30), sec = 1 << shift, miniSec = 1 << u16(b, 32);
  const nFat = u32(b, 44), dirStart = u32(b, 48), miniCutoff = u32(b, 56), miniFatStart = u32(b, 60);
  let difStart = u32(b, 68), nDif = u32(b, 72);
  const off = (s: number) => (s + 1) * sec;
  const fatSectors: number[] = [];
  for (let k = 0; k < 109 && fatSectors.length < nFat; k++) fatSectors.push(u32(b, 76 + k * 4));
  while (nDif-- > 0 && difStart < 0xfffffffa && fatSectors.length < nFat) {
    const o = off(difStart);
    for (let k = 0; k < sec / 4 - 1 && fatSectors.length < nFat; k++) fatSectors.push(u32(b, o + k * 4));
    difStart = u32(b, o + sec - 4);
  }
  const fat: number[] = [];
  for (const s of fatSectors) for (let k = 0; k < sec / 4; k++) fat.push(u32(b, off(s) + k * 4));
  const chain = (start: number, table: number[]) => {
    const out: number[] = [];
    for (let s = start, guard = 0; s < 0xfffffffa && guard < table.length + 1; s = table[s], guard++) out.push(s);
    return out;
  };
  const readChain = (start: number, size: number) => {
    const out = new Uint8Array(size);
    let p = 0;
    for (const s of chain(start, fat)) {
      const n = Math.min(sec, size - p);
      if (n <= 0) break;
      out.set(b.subarray(off(s), off(s) + n), p);
      p += n;
    }
    return out;
  };
  // Directory entries (128 bytes each).
  const dirChain = chain(dirStart, fat);
  const dir = new Uint8Array(dirChain.length * sec);
  dirChain.forEach((s, k) => dir.set(b.subarray(off(s), off(s) + sec), k * sec));
  type Entry = { name: string; type: number; left: number; right: number; child: number; start: number; size: number };
  const entries: Entry[] = [];
  for (let o = 0; o + 128 <= dir.length; o += 128) {
    const nl = u16(dir, o + 64);
    let name = "";
    for (let k = 0; k + 2 < nl; k += 2) name += String.fromCharCode(u16(dir, o + k));
    entries.push({ name, type: dir[o + 66], left: u32(dir, o + 68), right: u32(dir, o + 72), child: u32(dir, o + 76), start: u32(dir, o + 116), size: u32(dir, o + 120) });
  }
  const root = entries[0];
  const ministream = root ? readChain(root.start, root.size) : new Uint8Array(0);
  const minifat: number[] = [];
  if (miniFatStart < 0xfffffffa) {
    const mf = readChain(miniFatStart, chain(miniFatStart, fat).length * sec);
    for (let k = 0; k + 4 <= mf.length; k += 4) minifat.push(u32(mf, k));
  }
  const readMini = (start: number, size: number) => {
    const out = new Uint8Array(size);
    let p = 0;
    for (const s of chain(start, minifat)) {
      const n = Math.min(miniSec, size - p);
      if (n <= 0) break;
      out.set(ministream.subarray(s * miniSec, s * miniSec + n), p);
      p += n;
    }
    return out;
  };
  const out: Sections = new Map();
  const walk = (id: number, prefix: string, depth: number) => {
    if (id >= entries.length || id === 0xffffffff || depth > 64) return;
    const e = entries[id];
    walk(e.left, prefix, depth + 1);
    walk(e.right, prefix, depth + 1);
    const path = prefix + e.name;
    if (e.type === 2) out.set(path, e.size < miniCutoff ? readMini(e.start, e.size) : readChain(e.start, e.size));
    else if (e.type === 1) walk(e.child, path + "/", depth + 1);
  };
  if (root) walk(root.child, "", 0);
  if (!out.size) throw new Error("Not a SolidWorks file, or a version this viewer can't read");
  return out;
}

// ---------- what is inside ----------

/** The Parasolid transmit files in a stream: zlib chunks, each after CHUNK_ID and two sizes. */
export async function parasolidStreams(data: Uint8Array): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  if (data[0] === 0x50 && data[1] === 0x53) return [data]; // stored as is
  let i = find(data, CHUNK_ID, 0);
  while (i >= 0) {
    const usize = u32(data, i + 16), csize = u32(data, i + 20), start = i + 24;
    let next = i + 16;
    if (start + csize <= data.length && data[start] === 0x78) {
      try {
        const raw = await inflate(data.subarray(start, start + csize), "deflate");
        if (raw.length === usize || usize === 0) out.push(raw);
        next = start + csize;
      } catch { /* not a chunk */ }
    }
    i = find(data, CHUNK_ID, next);
  }
  return out;
}

const ascii = (b: Uint8Array, from: number, to: number) => {
  let s = "";
  for (let k = from; k < Math.min(to, b.length); k++) s += String.fromCharCode(b[k]);
  return s;
};

/** "partition", "deltas" or "" (a plain transmit file) from a Parasolid header. */
export function transmitKind(ps: Uint8Array) {
  const head = ascii(ps, 0, 120);
  return /\(partition\)/.test(head) ? "partition" : /\(deltas\)/.test(head) ? "deltas" : "";
}

export interface SolidWorksFile {
  name: string;
  kind: "part" | "assembly";
  /** Parasolid partitions of the part, by configuration number (configuration 0 first). */
  partitions: { config: number; data: Uint8Array }[];
  /** Plain Parasolid bodies stored outside the partition (used when the partition has none). */
  bodies: Uint8Array[];
  preview: Uint8Array | null;
  /** The assembly's component tree (XML), for assemblies. */
  tree: string | null;
  sections: string[];
}

export async function readSolidWorks(bytes: Uint8Array, name: string): Promise<SolidWorksFile> {
  const s = await readSections(bytes);
  const partitions: SolidWorksFile["partitions"] = [];
  const bodies: Uint8Array[] = [], featureBodies: Uint8Array[] = [];
  for (const [key, data] of s) {
    const m = /(?:^|\/)Config-(\d+)-Partition$/.exec(key);
    if (m) {
      for (const ps of await parasolidStreams(data)) if (transmitKind(ps) === "partition") partitions.push({ config: +m[1], data: ps });
    } else if (/LocalBodies|FeatureBodies/i.test(key)) {
      for (const ps of await parasolidStreams(data)) if (transmitKind(ps) === "") bodies.push(ps);
    } else if (/(?:^|\/)Config-0-ResolvedFeatures$/.test(key)) {
      // An imported body (a part made from a STEP file) lives with its feature.
      for (const ps of await parasolidStreams(data)) if (transmitKind(ps) === "") featureBodies.push(ps);
    }
  }
  if (!bodies.length) bodies.push(...featureBodies);
  partitions.sort((a, b) => a.config - b.config);
  const treeBytes = s.get("swXmlContents/COMPINSTANCETREE");
  const tree = treeBytes ? new TextDecoder().decode(treeBytes) : null;
  const preview = s.get("PreviewPNG") ?? null;
  const kind = /\.sldasm$/i.test(name) || (tree && !partitions.length) ? "assembly" : "part";
  return { name, kind, partitions, bodies, preview: preview?.length ? preview : null, tree, sections: [...s.keys()] };
}

// ---------- assemblies ----------

export interface SwComponent {
  /** Instance name as SolidWorks shows it, e.g. "wheel-1". */
  name: string;
  /** File name of the referenced part or sub-assembly (without folders). */
  file: string;
  /** Full path as saved on the author's computer. */
  path: string;
  config: string;
  /** Column-major 4x4 placement in millimetres, or null for identity. */
  matrix: number[] | null;
  suppressed: boolean;
  hidden: boolean;
  children: SwComponent[];
}

/**
 * The components of an assembly from its COMPINSTANCETREE: one swReference per
 * placed component, under swModel entries; swFile gives the file paths.
 */
export function parseComponentTree(xml: string): { name: string; components: SwComponent[] } {
  const doc = new DOMParserLike(xml);
  const files = new Map<string, string>();
  for (const f of doc.all("swFile")) files.set(f.attrs.id, f.attrs.swPath ?? "");
  const models = new Map<string, { attrs: Record<string, string>; refs: { attrs: Record<string, string> }[] }>();
  for (const m of doc.models()) models.set(m.attrs.id, m);
  // The top model is the one no reference points to.
  const referenced = new Set<string>();
  for (const m of models.values()) for (const r of m.refs) referenced.add(r.attrs.swModelRef);
  const top = [...models.values()].find(m => !referenced.has(m.attrs.id) && m.refs.length) ?? [...models.values()].find(m => m.refs.length);
  const build = (m: typeof top, depth: number): SwComponent[] => {
    if (!m || depth > 32) return [];
    return m.refs.map(r => {
      const a = r.attrs, sub = models.get(a.swModelRef);
      const path = sub ? files.get(sub.attrs.swFileRef) ?? "" : "";
      const t = (a.swTransform ?? "").trim().split(/\s+/).map(Number);
      // A 4x4 matrix, column by column, translation in metres in the last column.
      const matrix = t.length === 16 && t.every(Number.isFinite) ? [
        t[0], t[1], t[2], t[3],
        t[4], t[5], t[6], t[7],
        t[8], t[9], t[10], t[11],
        t[12] * 1000, t[13] * 1000, t[14] * 1000, t[15],
      ] : null;
      return {
        name: `${a.swName ?? "component"}-${a.swReferenceNumber ?? "1"}`,
        file: path.split(/[\\/]/).pop() ?? "",
        path,
        config: a.swConfigurationName ?? "",
        matrix,
        suppressed: a.swSuppressed === "YES",
        hidden: a.swHidden === "YES",
        children: sub?.refs.length ? build(sub, depth + 1) : [],
      };
    });
  };
  return { name: top?.attrs.swName ?? "", components: build(top, 0) };
}

/** Just enough XML for COMPINSTANCETREE (no DOMParser in workers). */
class DOMParserLike {
  private tags: { name: string; attrs: Record<string, string>; close: boolean; self: boolean }[] = [];
  constructor(xml: string) {
    const re = /<(\/?)([A-Za-z_][\w.-]*)([^>]*?)(\/?)>/g;
    for (let m; (m = re.exec(xml));) {
      const attrs: Record<string, string> = {};
      for (const a of m[3].matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) attrs[a[1]] = unescapeXml(a[2]);
      this.tags.push({ name: m[2], attrs, close: m[1] === "/", self: m[4] === "/" });
    }
  }
  all(name: string) { return this.tags.filter(t => t.name === name && !t.close); }
  /** swModel elements with their direct swReference children. */
  models() {
    const out: { attrs: Record<string, string>; refs: { attrs: Record<string, string> }[] }[] = [];
    let cur: (typeof out)[number] | null = null, depth = 0;
    for (const t of this.tags) {
      if (t.name === "swModel" && !t.close) {
        cur = { attrs: t.attrs, refs: [] };
        out.push(cur);
        depth = 0;
        if (t.self) cur = null;
      } else if (t.name === "swModel" && t.close) cur = null;
      else if (cur && t.name === "swReference" && !t.close) {
        if (depth === 0) cur.refs.push({ attrs: t.attrs });
        if (!t.self) depth++;
      } else if (cur && t.name === "swReference" && t.close) depth--;
    }
    return out;
  }
}

function unescapeXml(s: string) {
  return s.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-f]+);/gi, (_, e: string) =>
    e === "lt" ? "<" : e === "gt" ? ">" : e === "quot" ? '"' : e === "apos" ? "'" : e === "amp" ? "&"
      : String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)));
}
