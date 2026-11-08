// Repairs names that OpenCASCADE decoded with the wrong character set.
//
// STEP strings should carry non-ASCII text as \X2\…\X0\ escapes, but many Russian CAD
// exports (KOMPAS, older SolidWorks, Inventor with a Russian locale) write raw Windows-1251
// bytes. OCCT reads every raw byte as one Latin-1 character, so "ПЛ31а-п_черн" arrives as
// "ÏË31à-ï_÷åðí". That mapping is lossless (byte b → U+00b), so the bytes can be recovered
// and decoded again. The same holds for UTF-8 written through \X\ escapes ("Ð\u009fÐ\u009b"),
// and for UTF-16LE code units written as bytes ("\"\u0004" = "Т").
//
// Whether the text is Windows-1251 or genuine Latin-1 ("Müller", "Instalação") is decided
// once for the whole file: a Cyrillic file has many letters in 0xC0–0xFF next to each other,
// a Western one has a few accented letters among plain ASCII ones.

const HIGH = /[\u0080-ÿ]/;
const WIDE = /[^\u0000-ÿ]/;

let cp1251: TextDecoder | null | undefined;
function win1251(bytes: Uint8Array): string | null {
  if (cp1251 === undefined) {
    try { cp1251 = new TextDecoder("windows-1251"); } catch { cp1251 = null; }
  }
  return cp1251 ? cp1251.decode(bytes) : null;
}

const latinBytes = (s: string) => Uint8Array.from(s, c => c.charCodeAt(0));

/** UTF-8 decode of Latin-1 characters, or null when they are not valid UTF-8 with at least one multi-byte character. */
function asUtf8(s: string): string | null {
  if (!/[Â-ô][\u0080-¿]/.test(s)) return null;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(latinBytes(s)); } catch { return null; }
}

/** UTF-16 code units that were written as byte pairs: every second character is a high byte below 0x20 (0x04 = Cyrillic). */
function asUtf16(s: string): string | null {
  if (s.length < 2 || s.length % 2 || WIDE.test(s)) return null;
  for (const lo of [0, 1]) {
    let ok = true, ctrl = false;
    for (let i = 1 - lo; i < s.length; i += 2) {
      const c = s.charCodeAt(i);
      if (c >= 0x20) { ok = false; break; }
      if (c) ctrl = true;
    }
    if (!ok || !ctrl) continue;
    let out = "";
    for (let i = 0; i < s.length; i += 2) {
      out += String.fromCharCode(lo === 0 ? s.charCodeAt(i) | (s.charCodeAt(i + 1) << 8) : (s.charCodeAt(i) << 8) | s.charCodeAt(i + 1));
    }
    return /[\u0000-\u001f]/.test(out) ? null : out;
  }
  return null;
}

/** True when the Latin-1 characters of these names look like Windows-1251 Cyrillic. */
export function looksCp1251(names: Iterable<string>): boolean {
  let high = 0, ascii = 0, run = 0, best = 0, c1 = 0;
  for (const s of names) {
    if (!s || WIDE.test(s) || !HIGH.test(s)) continue;
    run = 0;
    for (const ch of s) {
      const c = ch.charCodeAt(0);
      if (c >= 0xc0 || c === 0xa8 || c === 0xb8) { high++; best = Math.max(best, ++run); continue; }
      run = 0;
      if (c >= 0x80 && c < 0xa0) c1++;
      else if (/[A-Za-z]/.test(ch)) ascii++;
    }
  }
  if (!high) return false;
  // C1 controls (0x80–0x9F) never appear in real Latin-1 names; in Windows-1251 they are Ђ…џ, quotes and dashes.
  return best >= 3 || high >= ascii || (c1 > 0 && high >= 2);
}

/**
 * Returns a function that repairs one name, deciding the code page once for all `names`
 * (the names of one file). Names that are fine (plain ASCII, real Unicode) pass through.
 */
export function nameFixer(names: Iterable<string>): (s: string) => string {
  const list = [...names];
  const cyr = looksCp1251(list);
  return (s: string) => {
    if (!s || WIDE.test(s)) return s;
    const u16 = asUtf16(s);
    if (u16) return u16;
    if (!HIGH.test(s)) return s;
    const u8 = asUtf8(s);
    if (u8) return u8;
    if (cyr) return win1251(latinBytes(s)) ?? s;
    return s;
  };
}

/** Repairs `name` fields in place throughout an occt-import-js result (tree and meshes). */
export function fixResultNames(res: { root?: unknown; meshes?: { name?: string }[] }) {
  const nodes: { name?: string; children?: unknown[] }[] = [];
  const walk = (n: unknown) => {
    if (!n || typeof n !== "object") return;
    const o = n as { name?: string; children?: unknown[] };
    nodes.push(o);
    o.children?.forEach(walk);
  };
  walk(res.root);
  const holders = [...nodes, ...(res.meshes ?? [])];
  const fix = nameFixer(holders.map(h => h.name ?? ""));
  for (const h of holders) if (typeof h.name === "string") h.name = fix(h.name);
}
