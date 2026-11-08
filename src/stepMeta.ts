// Reads what the tessellation does not carry straight from the STEP text:
// header, schema (AP203/214/242), product revisions, materials and PMI presence.

import { nameFixer } from "./names";

export interface StepMeta {
  schema: string;
  protocol: string;
  fileName: string;
  timestamp: string;
  author: string;
  organization: string;
  system: string;
  description: string;
  products: { id: string; name: string; revision: string }[];
  materials: string[];
  pmi: Record<string, number>;
  entityCount: number;
}

/** Decodes STEP string escapes: \X2\…\X0\ (UTF-16), \X4\…\X0\ (UTF-32), \X\hh and \S\c (Latin-1), \P?\ (dropped), '' quotes. */
export function decodeStepString(s: string) {
  return s
    .replace(/\\X2\\([0-9A-F]+)\\X0\\/gi, (_, hex: string) => {
      let out = "";
      for (let i = 0; i + 4 <= hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
      return out;
    })
    .replace(/\\X4\\([0-9A-F]+)\\X0\\/gi, (_, hex: string) => {
      let out = "";
      for (let i = 0; i + 8 <= hex.length; i += 8) out += String.fromCodePoint(parseInt(hex.slice(i, i + 8), 16));
      return out;
    })
    .replace(/\\X\\([0-9A-F]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\S\\([\s\S])/g, (_, c: string) => String.fromCharCode(c.charCodeAt(0) + 0x80))
    .replace(/\\P[A-I]\\/g, "")
    .replace(/''/g, "'");
}

const PMI_ENTITIES = [
  "DIMENSIONAL_SIZE", "DIMENSIONAL_LOCATION", "GEOMETRIC_TOLERANCE", "FLATNESS_TOLERANCE", "POSITION_TOLERANCE",
  "PERPENDICULARITY_TOLERANCE", "PARALLELISM_TOLERANCE", "PROFILE_OF_SURFACE_TOLERANCE", "CYLINDRICITY_TOLERANCE",
  "DATUM", "DATUM_FEATURE", "DRAUGHTING_CALLOUT", "ANNOTATION_OCCURRENCE", "TESSELLATED_ANNOTATION_OCCURRENCE",
];

/** Byte b → U+00b (TextDecoder's "latin1" is really Windows-1252, which would hide 0x80–0x9F from the name repair). */
function latin1(bytes: Uint8Array) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return out;
}

export function readStepMeta(bytes: Uint8Array): StepMeta | null {
  const text = latin1(bytes);
  if (!/ISO-10303-21/.test(text.slice(0, 200))) return null;
  const header = text.slice(0, text.indexOf("ENDSEC") + 6);
  const strings = (block: string) => [...block.matchAll(/'((?:[^']|'')*)'/g)].map(m => decodeStepString(m[1]));

  const fn = header.match(/FILE_NAME\s*\(([\s\S]*?)\);/)?.[1] ?? "";
  const fnS = strings(fn);
  const fd = strings(header.match(/FILE_DESCRIPTION\s*\(([\s\S]*?)\);/)?.[1] ?? "");
  const schema = strings(header.match(/FILE_SCHEMA\s*\(([\s\S]*?)\);/)?.[1] ?? "").join(", ");
  const up = schema.toUpperCase();
  const protocol = up.includes("AP242") || up.includes("MANAGED_MODEL_BASED_3D_ENGINEERING") ? "AP242"
    : up.includes("AUTOMOTIVE_DESIGN") ? "AP214"
    : up.includes("CONFIG_CONTROL_DESIGN") || up.includes("AP203") ? "AP203" : schema || "unknown";

  const productById = new Map<string, { id: string; name: string; revision: string }>();
  for (const m of text.matchAll(/#(\d+)\s*=\s*PRODUCT\s*\(\s*'((?:[^']|'')*)'\s*,\s*'((?:[^']|'')*)'/g)) {
    productById.set(m[1], { id: decodeStepString(m[2]), name: decodeStepString(m[3]), revision: "" });
  }
  for (const m of text.matchAll(/=\s*PRODUCT_DEFINITION_FORMATION(?:_WITH_SPECIFIED_SOURCE)?\s*\(\s*'((?:[^']|'')*)'\s*,\s*'(?:[^']|'')*'\s*,\s*#(\d+)/g)) {
    const p = productById.get(m[2]);
    if (p && m[1] && m[1] !== "ANY" && m[1] !== "") p.revision = decodeStepString(m[1]);
  }
  const materials = [...new Set([...text.matchAll(/MATERIAL_DESIGNATION\s*\(\s*'((?:[^']|'')*)'/g)].map(m => decodeStepString(m[1])))];
  const pmi: Record<string, number> = {};
  for (const e of PMI_ENTITIES) {
    const n = (text.match(new RegExp(`=\\s*${e}\\s*\\(`, "g")) ?? []).length;
    if (n) pmi[e] = n;
  }
  // Raw Windows-1251 bytes come through the Latin-1 decode above as mojibake: repair them.
  const products = [...productById.values()];
  const fix = nameFixer([...fnS, ...fd, ...materials, ...products.flatMap(p => [p.id, p.name, p.revision])]);
  for (const p of products) { p.id = fix(p.id); p.name = fix(p.name); p.revision = fix(p.revision); }
  return {
    schema, protocol,
    fileName: fix(fnS[0] ?? ""), timestamp: fnS[1] ?? "", author: fix(fnS[2] ?? ""), organization: fix(fnS[3] ?? ""),
    system: [fnS[5], fnS[4]].filter(Boolean).map(fix).join(" / "),
    description: fix(fd[0] ?? ""),
    products,
    materials: materials.map(fix), pmi,
    entityCount: (text.match(/^#\d+\s*=/gm) ?? []).length,
  };
}
