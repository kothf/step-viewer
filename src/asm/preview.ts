// Display meshes kept in an assembly file (`preview.bin` in a .mcadasm): one per part, in the part's own axes, so
// a part used many times is kept once. On open every component is drawn from them at its place at once, while the
// kernel builds the parts; the built assembly then replaces them. Old app versions ignore the entry.
import type { PartData } from "../topology";
import type { Tf } from "./types";
import { invert } from "./math";
import { decodePreview, encodePreview, PREVIEW_MAX_TRIS } from "../model/preview";

/** All the parts' triangles together past this are not kept (the file would grow past ~10 MB). */
export const ASM_PREVIEW_MAX_TRIS = 1_500_000;
const MAGIC = 0x4d434150; // "MCAP"

interface Placed { id: string; part: string; tf: Tf }

/** A copy of `d` with every point and normal moved by `t` (3 × 4, row-major). */
export function movedData(d: PartData, t: Tf, name = d.name): PartData {
  const mv = (a: Float32Array, dir: boolean) => {
    const o = new Float32Array(a.length);
    for (let i = 0; i < a.length; i += 3) {
      const x = a[i], y = a[i + 1], z = a[i + 2];
      o[i] = t[0] * x + t[1] * y + t[2] * z + (dir ? 0 : t[3]);
      o[i + 1] = t[4] * x + t[5] * y + t[6] * z + (dir ? 0 : t[7]);
      o[i + 2] = t[8] * x + t[9] * y + t[10] * z + (dir ? 0 : t[11]);
    }
    return o;
  };
  const positions = mv(d.positions, false), edgeSegs = mv(d.edgeSegs, false);
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i++) { const k = i % 3; min[k] = Math.min(min[k], positions[i]); max[k] = Math.max(max[k], positions[i]); }
  return { ...d, name, positions, normals: mv(d.normals, true), edgeSegs, faces: [], edges: [], bboxMin: min, bboxMax: max, com: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2] };
}

/**
 * The bytes to keep: for each part key the first shown component's mesh moved back into the part's axes.
 * `shown` = the built meshes (world) by shown component id; `comps` = the expanded document's components.
 */
export function encodeAsmPreview(comps: Placed[], shown: { id: string; data: PartData }[]): Uint8Array | null {
  const byId = new Map(comps.map(c => [c.id, c]));
  const kept = new Map<string, Uint8Array>();
  let tris = 0;
  for (const s of shown) {
    const c = byId.get(s.id);
    if (!c || kept.has(c.part)) continue;
    const n = s.data.index.length / 3;
    if (n > PREVIEW_MAX_TRIS || tris + n > ASM_PREVIEW_MAX_TRIS) continue;
    const b = encodePreview(movedData(s.data, invert(c.tf)));
    if (b) { kept.set(c.part, b); tris += n; }
  }
  if (!kept.size) return null;
  const index = new TextEncoder().encode(JSON.stringify([...kept].map(([key, b]) => [key, b.length])));
  const pad = (n: number) => (4 - (n % 4)) % 4;
  let size = 8 + index.length + pad(8 + index.length);
  for (const b of kept.values()) size += b.length + pad(b.length);
  const out = new Uint8Array(size), dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true); dv.setUint32(4, index.length, true);
  out.set(index, 8);
  let o = 8 + index.length + pad(8 + index.length);
  for (const b of kept.values()) { out.set(b, o); o += b.length + pad(b.length); }
  return out;
}

/** The kept meshes by part key (still encoded; `decodePreview` each when drawn). */
export function readAsmPreview(bytes: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  try {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (dv.getUint32(0, true) !== MAGIC) return out;
    const n = dv.getUint32(4, true);
    const index = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + n))) as [string, number][];
    const pad = (k: number) => (4 - (k % 4)) % 4;
    let o = 8 + n + pad(8 + n);
    for (const [key, len] of index) { out.set(key, bytes.slice(o, o + len)); o += len + pad(len); }
  } catch { out.clear(); }
  return out;
}

/** Every component that has a kept mesh, placed: what to draw while the kernel builds. */
export function placedPreview(comps: (Placed & { name?: string })[], kept: Map<string, Uint8Array>): { id: string; data: PartData }[] {
  const decoded = new Map<string, PartData | null>();
  const out: { id: string; data: PartData }[] = [];
  for (const c of comps) {
    if (!decoded.has(c.part)) { const b = kept.get(c.part); decoded.set(c.part, b ? decodePreview(b, c.part) : null); }
    const d = decoded.get(c.part);
    if (d) out.push({ id: c.id, data: movedData(d, c.tf, c.name ?? c.id) });
  }
  return out;
}
