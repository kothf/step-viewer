// Minimal ZIP writer and reader for MöbiusCAD files (FRS 12.1). Entries are
// deflated with the browser's CompressionStream; the reader refuses archives
// that would inflate past a limit (NFR-SEC-002).

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
export function crc32(u8: Uint8Array) {
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflate(u8: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === "undefined") return u8;
  const s = new Blob([u8]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

export async function zip(files: { name: string; data: Uint8Array | string }[]): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const f of files) {
    const raw = typeof f.data === "string" ? enc.encode(f.data) : f.data;
    const name = enc.encode(f.name);
    const packed = await deflate(raw);
    const method = packed === raw ? 0 : 8;
    const crc = crc32(raw);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
    local.setUint16(8, method, true); local.setUint16(10, dosTime, true); local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true); local.setUint32(18, packed.length, true); local.setUint32(22, raw.length, true);
    local.setUint16(26, name.length, true); local.setUint16(28, 0, true);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, method, true); cd.setUint16(12, dosTime, true); cd.setUint16(14, dosDate, true);
    cd.setUint32(16, crc, true); cd.setUint32(20, packed.length, true); cd.setUint32(24, raw.length, true);
    cd.setUint16(28, name.length, true); cd.setUint32(42, offset, true);
    parts.push(new Uint8Array(local.buffer), name, packed);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + packed.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, c) => s + c.length, 0));
  let p = 0;
  for (const c of all) { out.set(c, p); p += c.length; }
  return out;
}

export const MAX_UNZIPPED = 2 * 1024 ** 3;

export async function unzipLimited(buf: ArrayBuffer, limit = MAX_UNZIPPED): Promise<Map<string, Uint8Array>> {
  const v = new DataView(buf);
  const u8 = new Uint8Array(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("Not a MöbiusCAD file (not a zip archive).");
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array>();
  const dec = new TextDecoder();
  let total = 0;
  for (let n = 0; n < count && v.getUint32(p, true) === 0x02014b50; n++) {
    const method = v.getUint16(p + 10, true);
    const csize = v.getUint32(p + 20, true), usize = v.getUint32(p + 24, true);
    const nlen = v.getUint16(p + 28, true), elen = v.getUint16(p + 30, true), clen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + elen + clen;
    // No absolute paths or parent references.
    if (name.startsWith("/") || name.split("/").includes("..")) throw new Error("The file contains an unsafe path.");
    total += usize;
    if (total > limit || (csize && usize / csize > 200 && usize > 10 * 1024 ** 2)) throw new Error("The file is too large to open.");
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const raw = u8.slice(start, start + csize);
    if (method === 0) out.set(name, raw);
    else if (method === 8) {
      const s = new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      const data = new Uint8Array(await new Response(s).arrayBuffer());
      if (data.length !== usize) throw new Error("The file is damaged.");
      out.set(name, data);
    }
  }
  return out;
}
