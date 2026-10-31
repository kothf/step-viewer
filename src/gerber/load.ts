// Turns dropped files (single layers or .zip sets) into parsed, classified layers.

import { parseExcellon } from "./excellon";
import { parseGerber } from "./gerber";
import type { Attrs, LayerKind, ParsedLayer, Side } from "./model";

// ---------- zip ----------

export async function unzip(buf: ArrayBuffer): Promise<{ name: string; data: ArrayBuffer }[]> {
  const v = new DataView(buf);
  const u8 = new Uint8Array(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
    if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Not a zip archive.");
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const out: { name: string; data: ArrayBuffer }[] = [];
  const dec = new TextDecoder();
  for (let n = 0; n < count && v.getUint32(p, true) === 0x02014b50; n++) {
    const method = v.getUint16(p + 10, true);
    const csize = v.getUint32(p + 20, true);
    const nlen = v.getUint16(p + 28, true), elen = v.getUint16(p + 30, true), clen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + elen + clen;
    if (name.endsWith("/") || /(^|\/)(__MACOSX|\.)/.test(name)) continue;
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const raw = u8.slice(start, start + csize);
    if (method === 0) out.push({ name, data: raw.buffer });
    else if (method === 8) {
      const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      out.push({ name, data: await new Response(stream).arrayBuffer() });
    }
  }
  return out;
}

// ---------- recognition ----------

export type Sniff = "gerber" | "excellon" | "zip" | null;

export function sniff(data: ArrayBuffer | Uint8Array): Sniff {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (u8[0] === 0x50 && u8[1] === 0x4b && u8[2] === 3 && u8[3] === 4) return "zip";
  const head = new TextDecoder().decode(u8.subarray(0, 8192));
  if (/\0/.test(head)) return null;
  if (/ISO-10303-21|^\s*START\s|\bHEADER;/.test(head)) return null;
  if (/%FS[LTD]?[AI]|%MO(MM|IN)|%ADD\d|%TF\./.test(head) || (/^G04[ #]/m.test(head) && /\*/.test(head))) return "gerber";
  if (/^M48\b|^(METRIC|INCH)\b|^T\d+C[\d.]+|^;\s*DRILL/m.test(head)) return "excellon";
  return null;
}

const GERBER_EXT = /\.(gbr|ger|gbx|pho|art|gtl|gbl|gts|gbs|gto|gbo|gtp|gbp|gko|gm\d*|gml|gpt|gpb|g\d+|gp\d+|gd\d+|gg\d+|cmp|sol|stc|sts|plc|pls|crc|crs|dim|mil|top|bot|smt|smb|sst|ssb|spt|spb|ly\d+|drl|xln|exc|drd|nc|txt|zip)$/i;
/** True when a file name is one this viewer opens as a PCB layer (not a 3D model). */
export const isPcbName = (name: string) => GERBER_EXT.test(name);

interface Kind { kind: LayerKind; side: Side; label: string; rank: number }

function sideOf(s: string): Side {
  if (/\b(top|front|f[._]|cmp|component)/i.test(s)) return "top";
  if (/\b(bot|bottom|back|b[._]|sol|solder side)/i.test(s)) return "bottom";
  return null;
}

/** Layer type from the X2 file function, falling back to the file name. */
export function classify(name: string, attrs: Attrs, format: "gerber" | "excellon"): Kind {
  const base = name.split("/").pop() ?? name;
  const lower = base.toLowerCase();
  const ext = lower.includes(".") ? lower.split(".").pop()! : "";
  const mk = (kind: LayerKind, side: Side, extra = ""): Kind => {
    const sideTxt = side === "top" ? "Top " : side === "bottom" ? "Bottom " : side === "inner" ? "Inner " : "";
    const names: Record<LayerKind, string> = { copper: "copper", mask: "solder mask", silk: "silkscreen", paste: "paste", outline: "Board outline", drill: "Drill", other: "Layer" };
    const label = kind === "outline" || kind === "drill" || kind === "other" ? names[kind] + extra : `${sideTxt}${names[kind]}${extra}`;
    const rank = kind === "copper" ? (side === "top" ? 60 : side === "bottom" ? 30 : 45)
      : kind === "mask" ? (side === "bottom" ? 20 : 70)
      : kind === "paste" ? (side === "bottom" ? 25 : 65)
      : kind === "silk" ? (side === "bottom" ? 10 : 80)
      : kind === "drill" ? 90 : kind === "outline" ? 95 : 50;
    return { kind, side, label: label[0].toUpperCase() + label.slice(1), rank };
  };
  if (format === "excellon") {
    const np = /npth|non.?plated/i.test(base);
    return mk("drill", null, np ? " (NPTH)" : /pth|plated/i.test(base) ? " (PTH)" : "");
  }
  const ff = attrs[".FileFunction"];
  if (ff) {
    const f = ff.split(",");
    const sd = (s?: string): Side => (s === "Top" ? "top" : s === "Bot" ? "bottom" : s === "Inr" ? "inner" : null);
    switch (f[0]) {
      case "Copper": { const s = sd(f[2]); return mk("copper", s, s === "inner" ? ` ${f[1]}` : ""); }
      case "Soldermask": return mk("mask", sd(f[1]));
      case "Legend": return mk("silk", sd(f[1]));
      case "Paste": return mk("paste", sd(f[1]));
      case "Profile": return mk("outline", null);
      case "Plated": case "NonPlated": return mk("drill", null, f[0] === "NonPlated" ? " (NPTH)" : " (PTH)");
    }
  }
  const byExt: Record<string, Kind> = {
    gtl: mk("copper", "top"), cmp: mk("copper", "top"), top: mk("copper", "top"),
    gbl: mk("copper", "bottom"), sol: mk("copper", "bottom"), bot: mk("copper", "bottom"),
    gts: mk("mask", "top"), stc: mk("mask", "top"), smt: mk("mask", "top"),
    gbs: mk("mask", "bottom"), sts: mk("mask", "bottom"), smb: mk("mask", "bottom"),
    gto: mk("silk", "top"), plc: mk("silk", "top"), sst: mk("silk", "top"),
    gbo: mk("silk", "bottom"), pls: mk("silk", "bottom"), ssb: mk("silk", "bottom"),
    gtp: mk("paste", "top"), crc: mk("paste", "top"), spt: mk("paste", "top"),
    gbp: mk("paste", "bottom"), crs: mk("paste", "bottom"), spb: mk("paste", "bottom"),
    gko: mk("outline", null), gm1: mk("outline", null), gml: mk("outline", null), dim: mk("outline", null), mil: mk("outline", null),
  };
  if (byExt[ext]) return byExt[ext];
  const inner = /^g(\d+)$/.exec(ext) ?? /in(\d+)[._-]cu/i.exec(lower);
  if (inner) return mk("copper", "inner", ` ${+inner[1]}`);
  const s = sideOf(lower.replace(/[-_]/g, "."));
  if (/edge[._-]?cuts|outline|profile|board[._-]?edge|\bdim/.test(lower)) return mk("outline", null);
  if (/[._-]cu\b|copper|signal/.test(lower)) return mk("copper", s);
  if (/mask/.test(lower)) return mk("mask", s);
  if (/silk|legend|overlay/.test(lower)) return mk("silk", s);
  if (/paste|cream|stencil/.test(lower)) return mk("paste", s);
  return mk("other", s, ` (${base})`);
}

export const DEFAULT_COLORS: Record<string, { color: string; opacity: number }> = {
  "copper:top": { color: "#e0a040", opacity: 0.9 },
  "copper:bottom": { color: "#4c8dff", opacity: 0.85 },
  "copper:inner": { color: "#b07ae8", opacity: 0.8 },
  "copper:null": { color: "#e0a040", opacity: 0.9 },
  "mask:top": { color: "#2fb862", opacity: 0.35 },
  "mask:bottom": { color: "#2fa3b8", opacity: 0.35 },
  "silk:top": { color: "#f4f4f4", opacity: 0.95 },
  "silk:bottom": { color: "#d8d39a", opacity: 0.9 },
  "paste:top": { color: "#a8b0ba", opacity: 0.7 },
  "paste:bottom": { color: "#8f9aa8", opacity: 0.7 },
  outline: { color: "#ffd43b", opacity: 1 },
  drill: { color: "#d6dae0", opacity: 1 },
  other: { color: "#e86fa5", opacity: 0.8 },
};

export function defaultStyle(kind: LayerKind, side: Side) {
  return DEFAULT_COLORS[`${kind}:${side}`] ?? DEFAULT_COLORS[`${kind}:top`] ?? DEFAULT_COLORS[kind] ?? DEFAULT_COLORS.other;
}

/** Reads files (layers or zips of layers). Files that are neither Gerber nor Excellon are listed in `skipped`. */
export async function loadPcbFiles(files: { name: string; data: ArrayBuffer }[]): Promise<{ layers: ParsedLayer[]; skipped: string[] }> {
  const layers: ParsedLayer[] = [];
  const skipped: string[] = [];
  const dec = new TextDecoder();
  const queue = [...files];
  while (queue.length) {
    const f = queue.shift()!;
    const kind = sniff(f.data);
    if (kind === "zip") { queue.push(...(await unzip(f.data))); continue; }
    if (!kind || /\.gbrjob$/i.test(f.name)) { skipped.push(f.name); continue; }
    const text = dec.decode(f.data);
    const short = f.name.split("/").pop() ?? f.name;
    if (kind === "gerber") {
      const r = parseGerber(text);
      if (!r.objs.length) { skipped.push(f.name); continue; }
      layers.push({ name: short, format: "gerber", ...classify(f.name, r.fileAttrs, "gerber"), objs: r.objs, apertures: r.apertures, fileAttrs: r.fileAttrs, warnings: r.warnings, units: r.units });
    } else {
      const r = parseExcellon(text, f.name);
      if (!r.objs.length) { skipped.push(f.name); continue; }
      const c = classify(f.name, {}, "excellon");
      if (r.plated === false && !c.label.includes("NPTH")) c.label = "Drill (NPTH)";
      layers.push({ name: short, format: "excellon", ...c, objs: r.objs, apertures: {}, fileAttrs: {}, warnings: r.warnings, units: r.units });
    }
  }
  return { layers, skipped };
}
