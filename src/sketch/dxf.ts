// DXF reader for sketches (FR-SK-040, AT-P2-5): LINE, CIRCLE, ARC, LWPOLYLINE and POLYLINE
// (with bulges as arcs) from the ENTITIES section, scaled to millimetres by $INSUNITS.

export type DxfShape =
  | { t: "line"; a: [number, number]; b: [number, number] }
  | { t: "circle"; c: [number, number]; r: number }
  /** Counter-clockwise from a0 to a1 (radians). */
  | { t: "arc"; c: [number, number]; r: number; a0: number; a1: number };

/** Millimetres per drawing unit for $INSUNITS codes (unitless: millimetres). */
const UNITS: Record<number, number> = { 0: 1, 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000, 8: 0.0000254, 9: 0.0254, 10: 914.4, 13: 0.001, 14: 100 };

export interface DxfResult { shapes: DxfShape[]; skipped: number; scale: number }

export function readDxf(text: string): DxfResult {
  const lines = text.split(/\r?\n/);
  const pairs: [number, string][] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([parseInt(lines[i].trim(), 10), lines[i + 1].trim()]);
  let scale = 1;
  const ins = pairs.findIndex(p => p[0] === 9 && p[1] === "$INSUNITS");
  if (ins >= 0 && pairs[ins + 1]?.[0] === 70) scale = UNITS[+pairs[ins + 1][1]] ?? 1;
  // Entities: each starts at a group 0.
  const start = pairs.findIndex((p, i) => p[0] === 2 && p[1] === "ENTITIES" && pairs[i - 1]?.[1] === "SECTION");
  const ents: { type: string; g: [number, string][] }[] = [];
  for (let i = start < 0 ? 0 : start + 1; i < pairs.length; i++) {
    const [c, v] = pairs[i];
    if (c === 0) { if (v === "ENDSEC" && start >= 0) break; ents.push({ type: v, g: [] }); }
    else ents.at(-1)?.g.push([c, v]);
  }
  const shapes: DxfShape[] = [];
  let skipped = 0;
  const num = (g: [number, string][], code: number, d = 0) => { const x = g.find(p => p[0] === code); return x ? parseFloat(x[1]) : d; };
  const deg = Math.PI / 180;
  // A polyline: vertices with bulges (tan of a quarter of the included angle; positive is counter-clockwise).
  const poly = (vs: { x: number; y: number; bulge: number }[], closed: boolean) => {
    const n = vs.length;
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const p = vs[i], q = vs[(i + 1) % n];
      if (Math.hypot(q.x - p.x, q.y - p.y) < 1e-12) continue;
      if (Math.abs(p.bulge) < 1e-12) { shapes.push({ t: "line", a: [p.x, p.y], b: [q.x, q.y] }); continue; }
      const th = 4 * Math.atan(p.bulge);
      const chord = Math.hypot(q.x - p.x, q.y - p.y);
      const r = chord / (2 * Math.sin(Math.abs(th) / 2));
      const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
      const h = r * Math.cos(Math.abs(th) / 2);
      // Centre to the left of p→q for a counter-clockwise bulge under half a turn.
      const ux = -(q.y - p.y) / chord, uy = (q.x - p.x) / chord;
      const side = (p.bulge > 0 ? 1 : -1) * (Math.abs(th) < Math.PI ? 1 : -1);
      const c: [number, number] = [mx + ux * h * side, my + uy * h * side];
      const ap = Math.atan2(p.y - c[1], p.x - c[0]), aq = Math.atan2(q.y - c[1], q.x - c[0]);
      shapes.push(p.bulge > 0 ? { t: "arc", c, r, a0: ap, a1: aq } : { t: "arc", c, r, a0: aq, a1: ap });
    }
  };
  for (let k = 0; k < ents.length; k++) {
    const e = ents[k];
    if (e.type === "LINE") shapes.push({ t: "line", a: [num(e.g, 10), num(e.g, 20)], b: [num(e.g, 11), num(e.g, 21)] });
    else if (e.type === "CIRCLE") shapes.push({ t: "circle", c: [num(e.g, 10), num(e.g, 20)], r: num(e.g, 40) });
    else if (e.type === "ARC") shapes.push({ t: "arc", c: [num(e.g, 10), num(e.g, 20)], r: num(e.g, 40), a0: num(e.g, 50) * deg, a1: num(e.g, 51) * deg });
    else if (e.type === "LWPOLYLINE") {
      const vs: { x: number; y: number; bulge: number }[] = [];
      for (const [c, v] of e.g) {
        if (c === 10) vs.push({ x: parseFloat(v), y: 0, bulge: 0 });
        else if (c === 20 && vs.length) vs.at(-1)!.y = parseFloat(v);
        else if (c === 42 && vs.length) vs.at(-1)!.bulge = parseFloat(v);
      }
      poly(vs, (num(e.g, 70) & 1) === 1);
    } else if (e.type === "POLYLINE") {
      const vs: { x: number; y: number; bulge: number }[] = [];
      while (ents[k + 1]?.type === "VERTEX") { k++; const g = ents[k].g; vs.push({ x: num(g, 10), y: num(g, 20), bulge: num(g, 42) }); }
      if (ents[k + 1]?.type === "SEQEND") k++;
      poly(vs, (num(e.g, 70) & 1) === 1);
    } else if (!["SEQEND", "VERTEX", "ENDSEC", "EOF"].includes(e.type)) skipped++;
  }
  // Scale to millimetres.
  if (scale !== 1) for (const s of shapes) {
    if (s.t === "line") { s.a = [s.a[0] * scale, s.a[1] * scale]; s.b = [s.b[0] * scale, s.b[1] * scale]; }
    else { s.c = [s.c[0] * scale, s.c[1] * scale]; s.r *= scale; }
  }
  return { shapes: shapes.filter(s => s.t === "line" || s.r > 1e-9), skipped, scale };
}
