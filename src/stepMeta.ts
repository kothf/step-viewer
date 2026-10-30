// Reads what the tessellation does not carry straight from the STEP text:
// header, schema (AP203/214/242), product revisions, materials and PMI presence.

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

/** Decodes STEP string escapes: \X2\…\X0\ (UTF-16), \X\hh (Latin-1), '' quotes. */
export function decodeStepString(s: string) {
  return s
    .replace(/\\X2\\([0-9A-F]+)\\X0\\/gi, (_, hex: string) => {
      let out = "";
      for (let i = 0; i + 4 <= hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
      return out;
    })
    .replace(/\\X\\([0-9A-F]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/''/g, "'");
}

const PMI_ENTITIES = [
  "DIMENSIONAL_SIZE", "DIMENSIONAL_LOCATION", "GEOMETRIC_TOLERANCE", "FLATNESS_TOLERANCE", "POSITION_TOLERANCE",
  "PERPENDICULARITY_TOLERANCE", "PARALLELISM_TOLERANCE", "PROFILE_OF_SURFACE_TOLERANCE", "CYLINDRICITY_TOLERANCE",
  "DATUM", "DATUM_FEATURE", "DRAUGHTING_CALLOUT", "ANNOTATION_OCCURRENCE", "TESSELLATED_ANNOTATION_OCCURRENCE",
];

export function readStepMeta(bytes: Uint8Array): StepMeta | null {
  const text = new TextDecoder("latin1").decode(bytes);
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
  return {
    schema, protocol,
    fileName: fnS[0] ?? "", timestamp: fnS[1] ?? "", author: fnS[2] ?? "", organization: fnS[3] ?? "",
    system: [fnS[5], fnS[4]].filter(Boolean).join(" / "),
    description: fd[0] ?? "",
    products: [...productById.values()],
    materials, pmi,
    entityCount: (text.match(/^#\d+\s*=/gm) ?? []).length,
  };
}
