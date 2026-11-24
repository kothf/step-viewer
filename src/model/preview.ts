// The display mesh of a part kept in its file (`preview.bin` in a .mcadprt): shown the moment the file opens, before
// the kernel has rebuilt the features, and replaced by the real body when that comes. Old app versions ignore the
// entry. Positions and edge points are 16-bit numbers inside the part's box (under 0.02 mm on a 1 m part), the
// triangles 16- or 32-bit indices; the ZIP deflates the rest.
import type { PartData } from "../topology";

export const PREVIEW_FILE = "preview.bin";
/** Larger meshes are not kept (the file would grow past a few MB). */
export const PREVIEW_MAX_TRIS = 400_000;
const MAGIC = 0x4d435056; // "MCPV"

interface Head { v: 1; color: [number, number, number]; min: [number, number, number]; max: [number, number, number]; verts: number; tris: number; segs: number; sharp?: number; colors: boolean }

/** The bytes kept for `d`, or null when it is empty or too large. */
export function encodePreview(d: PartData | null | undefined): Uint8Array | null {
  if (!d || !d.index.length || d.index.length / 3 > PREVIEW_MAX_TRIS) return null;
  const verts = d.positions.length / 3, tris = d.index.length / 3, segs = d.edgeSegs.length / 3;
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const grow = (a: Float32Array) => { for (let i = 0; i < a.length; i++) { const k = i % 3; if (a[i] < min[k]) min[k] = a[i]; if (a[i] > max[k]) max[k] = a[i]; } };
  grow(d.positions); grow(d.edgeSegs);
  if (!Number.isFinite(min[0])) return null;
  const head: Head = { v: 1, color: [d.color[0], d.color[1], d.color[2]], min, max, verts, tris, segs, colors: !!d.colors };
  if (d.sharpSegs !== undefined) head.sharp = d.sharpSegs;
  const hj = new TextEncoder().encode(JSON.stringify(head));
  const wide = verts > 65535;
  const hLen = 8 + hj.length + ((4 - ((8 + hj.length) % 4)) % 4);
  const size = hLen + verts * 6 + segs * 6 + (verts * 6 + segs * 6) % 4 + tris * 3 * (wide ? 4 : 2) + (d.colors ? verts * 3 : 0) + 4;
  const buf = new ArrayBuffer(size), dv = new DataView(buf), u8 = new Uint8Array(buf);
  dv.setUint32(0, MAGIC, true); dv.setUint32(4, hj.length, true);
  u8.set(hj, 8);
  let o = hLen;
  const quant = (a: Float32Array) => {
    const q = new Uint16Array(buf, o, a.length);
    for (let i = 0; i < a.length; i++) { const k = i % 3, s = max[k] - min[k]; q[i] = s > 0 ? Math.round(((a[i] - min[k]) / s) * 65535) : 0; }
    o += a.length * 2;
  };
  quant(d.positions); quant(d.edgeSegs);
  o += o % 4;
  if (wide) { new Uint32Array(buf, o, d.index.length).set(d.index); o += d.index.length * 4; }
  else { new Uint16Array(buf, o, d.index.length).set(d.index); o += d.index.length * 2; }
  if (d.colors) { const c = new Uint8Array(buf, o, verts * 3); for (let i = 0; i < c.length; i++) c[i] = Math.round(Math.min(1, Math.max(0, d.colors[i])) * 255); o += c.length; }
  return new Uint8Array(buf, 0, o);
}

/**
 * A `PartData` to show from kept bytes: triangles, normals (averaged per vertex; B-rep faces have their own
 * vertices, so edges stay sharp) and edge lines. No faces or edges to pick and no mass values: it stands in for
 * the body until the kernel's comes. Null when the bytes are not a preview.
 */
export function decodePreview(bytes: Uint8Array, name: string): PartData | null {
  try {
    const buf = bytes.byteOffset % 4 ? bytes.slice().buffer : bytes.buffer;
    const base = bytes.byteOffset % 4 ? 0 : bytes.byteOffset;
    const dv = new DataView(buf, base, bytes.byteLength);
    if (dv.getUint32(0, true) !== MAGIC) return null;
    const hl = dv.getUint32(4, true);
    const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, base + 8, hl))) as Head;
    if (head.v !== 1) return null;
    let o = base + 8 + hl + ((4 - ((8 + hl) % 4)) % 4);
    const { min, max, verts, tris, segs } = head;
    const unq = (n: number) => {
      const q = new Uint16Array(buf, o, n), a = new Float32Array(n);
      for (let i = 0; i < n; i++) { const k = i % 3; a[i] = min[k] + (q[i] / 65535) * (max[k] - min[k]); }
      o += n * 2;
      return a;
    };
    const positions = unq(verts * 3), edgeSegs = unq(segs * 3);
    o += (o - base) % 4;
    const index = new Uint32Array(tris * 3);
    if (verts > 65535) { index.set(new Uint32Array(buf, o, tris * 3)); o += tris * 12; }
    else { index.set(new Uint16Array(buf, o, tris * 3)); o += tris * 6; }
    let colors: Float32Array | null = null;
    if (head.colors) { const c = new Uint8Array(buf, o, verts * 3); colors = new Float32Array(c.length); for (let i = 0; i < c.length; i++) colors[i] = c[i] / 255; }
    const normals = vertexNormals(positions, index);
    const d: PartData = {
      name, color: head.color, positions, normals, colors, index, faces: [], edges: [], edgeSegs,
      closed: false, volume: 0, area: 0, com: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2], bboxMin: min, bboxMax: max,
    };
    if (head.sharp !== undefined) d.sharpSegs = head.sharp;
    return d;
  } catch { return null; }
}

function vertexNormals(p: Float32Array, idx: Uint32Array): Float32Array {
  const n = new Float32Array(p.length);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
    for (const i of [a, b, c]) { n[i] += x; n[i + 1] += y; n[i + 2] += z; }
  }
  for (let i = 0; i < n.length; i += 3) { const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1; n[i] /= l; n[i + 1] /= l; n[i + 2] /= l; }
  return n;
}
