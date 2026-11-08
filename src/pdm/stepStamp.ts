// FR-PDM-034: STEP files made from vault documents carry the revision as the product definition formation id,
// and the part number as the product id. OCCT writes both empty; the text is patched after writing.

const q = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "''").replace(/[^\x20-\x7e]/g, c => `\\X2\\${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}\\X0\\`);

/**
 * Stamps a STEP file: the product named `name` (or the only product) gets `number` as its id and `description`,
 * and its formations get `revision` as their id. Other products (an assembly's components) are left alone.
 */
export function stampStep(text: string, o: { name?: string; revision?: string; number?: string; description?: string }): string {
  const products = [...text.matchAll(/#(\d+)\s*=\s*PRODUCT\s*\(\s*'((?:[^']|'')*)'\s*,\s*'((?:[^']|'')*)'/g)];
  if (!products.length) return text;
  const unq = (s: string) => s.replace(/''/g, "'");
  const target = products.length === 1 ? products[0] : products.find(p => o.name && (unq(p[3]) === o.name || unq(p[2]) === o.name));
  if (!target) return text;
  const pid = target[1];
  let out = text;
  if (o.number || o.description !== undefined) {
    out = out.replace(new RegExp(`(#${pid}\\s*=\\s*PRODUCT\\s*\\(\\s*)'((?:[^']|'')*)'(\\s*,\\s*'(?:[^']|'')*'\\s*,\\s*)'((?:[^']|'')*)'`), (_m, a, id, b, desc) =>
      `${a}'${o.number ? q(o.number) : id}'${b}'${o.description ? q(o.description) : desc}'`);
  }
  if (o.revision) {
    out = out.replace(new RegExp(`(#\\d+\\s*=\\s*PRODUCT_DEFINITION_FORMATION[A-Z_]*\\s*\\(\\s*)'(?:[^']|'')*'(\\s*,\\s*'(?:[^']|'')*'\\s*,\\s*#${pid}\\b)`, "g"), (_m, a, b) => `${a}'${q(o.revision!)}'${b}`);
  }
  return out;
}

export function stampStepBytes(bytes: Uint8Array, o: Parameters<typeof stampStep>[1]): Uint8Array {
  // Byte for byte: STEP is ASCII, and any other bytes go back as they came.
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const r = stampStep(s, o), out = new Uint8Array(r.length);
  for (let i = 0; i < r.length; i++) out[i] = r.charCodeAt(i) & 0xff;
  return out;
}
