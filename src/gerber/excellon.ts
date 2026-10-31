// Excellon drill file parser: tools, hits, G85 slots and routed slots (M15/M16).

import type { GObj } from "./model";

export interface ExcellonResult {
  objs: GObj[];
  tools: Record<number, number>;
  warnings: string[];
  units: "mm" | "in";
  plated: boolean | null;
}

export function parseExcellon(text: string, name = ""): ExcellonResult {
  const objs: GObj[] = [];
  const tools: Record<number, number> = {};
  const warnings = new Set<string>();
  let units: "mm" | "in" = "in";
  let zeros: "LZ" | "TZ" = "TZ";
  let fi = 2, fd = 4, fmtSet = false;
  let x = 0, y = 0, tool = 0, incremental = false;
  let routeDown = false, routeMode = false;
  // Plating: KiCad says it in a comment (TF.FileFunction,Plated / NonPlated) or the file name.
  let plated: boolean | null = /npth|non.?plated|unplated/i.test(name) ? false : /\bpth\b|[-_]pth|plated/i.test(name) ? true : null;
  const k = () => (units === "in" ? 25.4 : 1);

  const num = (s: string) => {
    if (s.includes(".")) return parseFloat(s) * k();
    const neg = s.startsWith("-");
    let d = s.replace(/^[+-]/, "");
    // LZ: leading zeros kept, trailing dropped -> pad on the right. TZ: the reverse.
    if (zeros === "LZ") d = d.padEnd(fi + fd, "0");
    return ((neg ? -1 : 1) * parseInt(d || "0", 10)) / 10 ** fd * k();
  };
  const setUnits = (u: "mm" | "in") => {
    units = u;
    if (!fmtSet) { if (u === "mm") { fi = 3; fd = 3; } else { fi = 2; fd = 4; } }
  };

  for (let raw of text.split(/\r?\n/)) {
    raw = raw.trim();
    if (!raw) continue;
    if (raw.startsWith(";")) {
      const ff = /FILE_FORMAT\s*=\s*(\d+):(\d+)/i.exec(raw);
      if (ff) { fi = +ff[1]; fd = +ff[2]; fmtSet = true; }
      if (/TF\.FileFunction,NonPlated|NPTH/i.test(raw)) plated = false;
      else if (/TF\.FileFunction,Plated|\bPTH\b/i.test(raw)) plated ??= true;
      continue;
    }
    const line = raw.toUpperCase();
    if (/^(METRIC|INCH)/.test(line)) {
      setUnits(line.startsWith("METRIC") ? "mm" : "in");
      if (line.includes("LZ")) zeros = line.includes("TZ") ? "TZ" : "LZ";
      else if (line.includes("TZ")) zeros = "TZ";
      const f = /,(0+)\.(0+)/.exec(line);
      if (f) { fi = f[1].length; fd = f[2].length; fmtSet = true; }
      continue;
    }
    if (line === "M71") { setUnits("mm"); continue; }
    if (line === "M72") { setUnits("in"); continue; }
    if (line === "G90") { incremental = false; continue; }
    if (line === "G91") { incremental = true; continue; }
    if (line === "M15") { routeDown = true; continue; }
    if (line === "M16" || line === "M17") { routeDown = false; continue; }
    if (/^M(30|00|48|95)/.test(line) || line === "%" || line === "G05" || /^(FMAT|VER|ICI|DETECT|ATC|AFS|OM48)/.test(line)) { if (line === "G05") routeMode = false; continue; }
    // Tool definition (header) or selection (body): T1C0.8, T01F00S00C0.0300, T1
    const t = /^T(\d+)(.*)$/.exec(line);
    if (t) {
      tool = +t[1];
      const c = /C([\d.]+)/.exec(t[2]);
      if (c) tools[tool] = c[1].includes(".") ? parseFloat(c[1]) * k() : num(c[1]);
      continue;
    }
    // Slot: X..Y..G85X..Y..
    const parts = line.split("G85");
    const pt = (s: string, px: number, py: number): [number, number] | null => {
      const mx = /X([+-]?[\d.]+)/.exec(s), my = /Y([+-]?[\d.]+)/.exec(s);
      if (!mx && !my) return null;
      let nx = mx ? num(mx[1]) : px, ny = my ? num(my[1]) : py;
      if (incremental) { nx = mx ? px + num(mx[1]) : px; ny = my ? py + num(my[1]) : py; }
      return [nx, ny];
    };
    const d = tools[tool] ?? 0;
    if (parts.length === 2) {
      const a = pt(parts[0], x, y);
      if (!a) continue;
      const b = pt(parts[1], a[0], a[1]);
      if (!b) continue;
      objs.push({ t: "slot", x1: a[0], y1: a[1], x2: b[0], y2: b[1], d, tool, plated });
      x = b[0]; y = b[1];
      continue;
    }
    const gm = /^G0?([0-3])/.exec(line);
    if (gm) {
      const code = +gm[1];
      const p = pt(line.slice(gm[0].length), x, y);
      if (code === 0) { routeMode = true; routeDown = false; if (p) { x = p[0]; y = p[1]; } continue; }
      if (code === 1 && p) {
        if (routeDown) objs.push({ t: "slot", x1: x, y1: y, x2: p[0], y2: p[1], d, tool, plated });
        x = p[0]; y = p[1];
        continue;
      }
      if ((code === 2 || code === 3) && p) {
        if (routeDown) { objs.push({ t: "slot", x1: x, y1: y, x2: p[0], y2: p[1], d, tool, plated }); warnings.add("Routed arcs (G02/G03) are drawn as straight slots."); }
        x = p[0]; y = p[1];
        continue;
      }
      continue;
    }
    const p = pt(line, x, y);
    if (p) {
      if (routeMode && routeDown) objs.push({ t: "slot", x1: x, y1: y, x2: p[0], y2: p[1], d, tool, plated });
      else if (!routeMode) objs.push({ t: "hole", x: p[0], y: p[1], d, tool, plated });
      x = p[0]; y = p[1];
    }
  }
  for (const o of objs) if (o.t === "hole" || o.t === "slot") o.plated = plated;
  if (objs.some(o => (o.t === "hole" || o.t === "slot") && !o.d)) warnings.add("Some tools have no diameter.");
  return { objs, tools, warnings: [...warnings], units, plated };
}
