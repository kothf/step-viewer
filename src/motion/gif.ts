// Animated GIF writer (FR-FT-122 recording): one global 256-colour palette by median cut over sampled
// pixels of all frames, nearest-colour mapping through a 15-bit cache, LZW per GIF89a. Pure, no DOM.

/** Median cut: up to `max` colours (RGB triples) that represent the sampled pixels. */
export function palette(samples: Uint8Array, max = 256): Uint8Array {
  const n = samples.length / 3;
  if (!n) return new Uint8Array(3);
  type Box = { idx: Uint32Array };
  const all = new Uint32Array(n);
  for (let i = 0; i < n; i++) all[i] = i;
  const boxes: Box[] = [{ idx: all }];
  const range = (b: Box) => {
    const lo = [255, 255, 255], hi = [0, 0, 0];
    for (const i of b.idx) for (let c = 0; c < 3; c++) { const v = samples[i * 3 + c]; if (v < lo[c]) lo[c] = v; if (v > hi[c]) hi[c] = v; }
    const r = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
    const ch = r[0] >= r[1] && r[0] >= r[2] ? 0 : r[1] >= r[2] ? 1 : 2;
    return { ch, span: r[ch] };
  };
  while (boxes.length < max) {
    // Split the box with the widest channel span, weighted by its pixel count.
    let best = -1, bestScore = 0, bestCh = 0;
    boxes.forEach((b, k) => { if (b.idx.length < 2) return; const { ch, span } = range(b); const s = span * Math.sqrt(b.idx.length); if (s > bestScore) { bestScore = s; best = k; bestCh = ch; } });
    if (best < 0) break;
    const b = boxes[best], arr = Array.from(b.idx).sort((x, y) => samples[x * 3 + bestCh] - samples[y * 3 + bestCh]);
    const mid = arr.length >> 1;
    boxes.splice(best, 1, { idx: Uint32Array.from(arr.slice(0, mid)) }, { idx: Uint32Array.from(arr.slice(mid)) });
  }
  const out = new Uint8Array(boxes.length * 3);
  boxes.forEach((b, k) => {
    const s = [0, 0, 0];
    for (const i of b.idx) for (let c = 0; c < 3; c++) s[c] += samples[i * 3 + c];
    for (let c = 0; c < 3; c++) out[k * 3 + c] = Math.round(s[c] / Math.max(1, b.idx.length));
  });
  return out;
}

/** Maps RGBA pixels to palette indices (nearest colour, cached per 5-bit-per-channel cell). */
export function indexPixels(rgba: Uint8ClampedArray | Uint8Array, pal: Uint8Array, cache = new Int16Array(32768).fill(-1)): Uint8Array {
  const n = rgba.length / 4, out = new Uint8Array(n), m = pal.length / 3;
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let k = cache[key];
    if (k < 0) {
      let bd = Infinity;
      const cr = (r & 0xf8) | 4, cg = (g & 0xf8) | 4, cb = (b & 0xf8) | 4;
      for (let j = 0; j < m; j++) { const dr = pal[j * 3] - cr, dg = pal[j * 3 + 1] - cg, db = pal[j * 3 + 2] - cb, d = dr * dr * 2 + dg * dg * 4 + db * db * 3; if (d < bd) { bd = d; k = j; } }
      cache[key] = k;
    }
    out[i] = k;
  }
  return out;
}

/** GIF LZW of palette indices with the given minimum code size, as data sub-blocks. */
export function lzw(indices: Uint8Array, minCode: number): Uint8Array {
  const clear = 1 << minCode, eoi = clear + 1;
  const bytes: number[] = [];
  let cur = 0, bits = 0, size = minCode + 1, next = eoi + 1;
  let dict = new Map<number, number>();
  const put = (code: number) => {
    cur |= code << bits; bits += size;
    while (bits >= 8) { bytes.push(cur & 0xff); cur >>>= 8; bits -= 8; }
  };
  put(clear);
  let prefix = indices.length ? indices[0] : 0;
  for (let i = 1; i < indices.length; i++) {
    const c = indices[i], key = (prefix << 8) | c, hit = dict.get(key);
    if (hit !== undefined) { prefix = hit; continue; }
    put(prefix);
    if (next < 4096) {
      dict.set(key, next++);
      if (next > (1 << size) && size < 12) size++;
    } else {
      put(clear);
      dict = new Map(); next = eoi + 1; size = minCode + 1;
    }
    prefix = c;
  }
  if (indices.length) put(prefix);
  put(eoi);
  if (bits > 0) bytes.push(cur & 0xff);
  const out: number[] = [minCode];
  for (let i = 0; i < bytes.length; i += 255) { const chunk = bytes.slice(i, i + 255); out.push(chunk.length, ...chunk); }
  out.push(0);
  return Uint8Array.from(out);
}

/** Writes an animated GIF from RGBA frames of one size; `delay` in hundredths of a second, looping forever. */
export function encodeGif(frames: (Uint8ClampedArray | Uint8Array)[], w: number, h: number, delay: number): Uint8Array {
  // Palette from about 60 000 pixels sampled over every frame keeps the median cut quick.
  const px = frames.reduce((s, f) => s + f.length / 4, 0), step = Math.max(1, Math.floor(px / 60000)) | 1, samp: number[] = [];
  for (const f of frames) for (let i = 0; i < f.length / 4; i += step) samp.push(f[i * 4], f[i * 4 + 1], f[i * 4 + 2]);
  const pal0 = palette(Uint8Array.from(samp), 256);
  let bitsPer = 1;
  while (1 << bitsPer < pal0.length / 3) bitsPer++;
  const pal = new Uint8Array(3 << bitsPer);
  pal.set(pal0);
  const parts: Uint8Array[] = [];
  const u16 = (v: number) => [v & 0xff, (v >> 8) & 0xff];
  parts.push(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, ...u16(w), ...u16(h), 0xf0 | (bitsPer - 1), 0, 0]), pal);
  // NETSCAPE2.0: loop forever.
  parts.push(Uint8Array.from([0x21, 0xff, 0x0b, ...Array.from("NETSCAPE2.0", c => c.charCodeAt(0)), 0x03, 0x01, 0, 0, 0]));
  const cache = new Int16Array(32768).fill(-1), minCode = Math.max(2, bitsPer);
  for (const f of frames) {
    parts.push(Uint8Array.from([0x21, 0xf9, 0x04, 0x04, ...u16(Math.max(2, Math.round(delay))), 0, 0]));
    parts.push(Uint8Array.from([0x2c, 0, 0, 0, 0, ...u16(w), ...u16(h), 0]));
    parts.push(lzw(indexPixels(f, pal0, cache), minCode));
  }
  parts.push(Uint8Array.of(0x3b));
  const total = parts.reduce((s, p) => s + p.length, 0), out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Decodes a GIF LZW data stream back to indices (tests check the writer with it). */
export function unlzw(data: Uint8Array, pos = 0): { indices: number[]; end: number } {
  const minCode = data[pos++];
  const bytes: number[] = [];
  while (data[pos]) { const n = data[pos++]; for (let i = 0; i < n; i++) bytes.push(data[pos++]); }
  pos++;
  const clear = 1 << minCode, eoi = clear + 1;
  let size = minCode + 1, dict: number[][] = [], prev: number[] | null = null, bit = 0;
  const reset = () => { dict = []; for (let i = 0; i < clear; i++) dict[i] = [i]; dict[clear] = []; dict[eoi] = []; size = minCode + 1; prev = null; };
  reset();
  const out: number[] = [];
  for (;;) {
    let code = 0;
    for (let i = 0; i < size; i++, bit++) code |= ((bytes[bit >> 3] >> (bit & 7)) & 1) << i;
    if (bit > bytes.length * 8) break;
    if (code === clear) { reset(); continue; }
    if (code === eoi) break;
    let entry: number[];
    if (code < dict.length) entry = dict[code];
    else if (prev) entry = [...prev, prev[0]];
    else break;
    out.push(...entry);
    if (prev && dict.length < 4096) { dict.push([...prev, entry[0]]); if (dict.length === 1 << size && size < 12) size++; }
    prev = entry;
  }
  return { indices: out, end: pos };
}
