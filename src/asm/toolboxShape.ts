// Toolbox pictures (FR-ASM-028): a standard part as a few simple solids in its own axes (Z = the part's
// axis, as `fastenerPart` builds it), used for the panel's side views with dimensions, the cards'
// pictograms, the mass estimate and the see-through preview on a hole. Pure: no DOM, no three.js.
import { fastenerInfo, shapeKind, type FastenerKind } from "./fasteners";

/** A solid of revolution about Z: the closed profile in (r, z), r ≥ 0. */
export interface RevSolid { t: "rev"; pts: [number, number][]; neg?: boolean }
/** A hexagonal prism on Z, `s` across flats (flats square to X), from z0 to z1, with an optional bore radius `ri`. */
export interface HexSolid { t: "hex"; s: number; z0: number; z1: number; ri?: number; neg?: boolean }
/** A box centred on Z: `x` along X, `y` along Y, from z0 to z1. */
export interface BoxSolid { t: "box"; x: number; y: number; z0: number; z1: number }
export type ShapeSolid = RevSolid | HexSolid | BoxSolid;

/** A dimension on the side view (X across, Z up): horizontal between x = a and b at z = at, or vertical between z = a and b at x = at. */
export interface ShapeDim { sym: string; val: number; axis: "h" | "v"; a: number; b: number; at: number }

/** A split ring seen from above (Z): inside/outside radius, the opening's width on +X, and the shaft or bore radius drawn dashed. */
export interface RingPlan { ri: number; ro: number; g: number; rd: number }

export interface ToolShape { solids: ShapeSolid[]; dims: ShapeDim[]; plan?: RingPlan }

const rect = (r0: number, r1: number, z0: number, z1: number): [number, number][] => [[r0, z0], [r1, z0], [r1, z1], [r0, z1]];
const ring = (ro: number, ri: number, z0: number, z1: number): RevSolid => ({ t: "rev", pts: rect(ri, ro, z0, z1) });

/** The part of `kind`, size row `size`, length `L` (screws, pins, keys) as simple solids plus its main dimensions. */
export function fastenerShape(kind: FastenerKind, size: string, L = 0): ToolShape {
  const info = fastenerInfo(kind), r = info.table[size];
  kind = shapeKind(kind);
  const s: ShapeSolid[] = [], dims: ShapeDim[] = [];
  let plan: RingPlan | undefined;
  const hd = (sym: string, val: number, at: number) => dims.push({ sym, val, axis: "h", a: -val / 2, b: val / 2, at });
  const vd = (sym: string, val: number, a: number, b: number, at: number) => dims.push({ sym, val, axis: "v", a, b, at });
  const d = r.d;
  switch (kind) {
    case "iso4762": case "iso4017": case "iso4014": case "iso7380": {
      s.push({ t: "rev", pts: rect(0, d / 2, -L, 0) });
      const k = r.k!;
      if (kind === "iso4017" || kind === "iso4014") s.push({ t: "hex", s: r.s!, z0: 0, z1: k });
      else if (kind === "iso7380") s.push({ t: "rev", pts: [[0, 0], [r.dk! / 2, 0], [Math.max(d / 2, r.dk! / 2 - k * Math.tan((25 * Math.PI) / 180)), k], [0, k]] });
      else s.push({ t: "rev", pts: rect(0, r.dk! / 2, 0, k) });
      if (r.t) s.push({ t: "hex", s: r.s!, z0: k - r.t, z1: k, neg: true });
      const w = kind === "iso4017" || kind === "iso4014" ? r.s! / Math.sqrt(3) : r.dk! / 2;
      hd("d", d, -L);
      if (kind === "iso4017" || kind === "iso4014") hd("s", r.s!, k); else hd("dk", r.dk!, k);
      vd("L", L, -L, 0, w + 0.15 * w);
      vd("k", k, 0, k, -w - 0.15 * w);
      break;
    }
    case "iso10642": {
      s.push({ t: "rev", pts: [[0, 0], [r.dk! / 2, 0], [d / 2, -r.k!], [0, -r.k!]] }, { t: "rev", pts: rect(0, d / 2, -L, -r.k!) },
        { t: "hex", s: r.s!, z0: -r.t!, z1: 0, neg: true });
      hd("dk", r.dk!, 0); hd("d", d, -L);
      vd("L", L, -L, 0, r.dk! / 2 * 1.15);
      break;
    }
    case "iso4026":
      s.push({ t: "rev", pts: rect(0, d / 2, -L, 0) }, { t: "hex", s: r.s!, z0: -r.t!, z1: 0, neg: true });
      hd("d", d, -L); vd("L", L, -L, 0, d * 0.6);
      break;
    case "iso4032": case "iso4035":
      s.push({ t: "hex", s: r.s!, z0: 0, z1: r.m!, ri: d / 2 });
      hd("s", r.s!, 0); vd("m", r.m!, 0, r.m!, r.s! / Math.sqrt(3) * 1.15);
      break;
    case "iso7040":
      s.push({ t: "hex", s: r.s!, z0: 0, z1: r.m!, ri: d / 2 }, ring(r.dc! / 2, d / 2, r.m!, r.m! + r.c!));
      hd("s", r.s!, 0); vd("h", r.m! + r.c!, 0, r.m! + r.c!, r.s! / Math.sqrt(3) * 1.15);
      break;
    case "iso4161":
      s.push(ring(r.dc! / 2, d / 2, 0, r.c!), { t: "hex", s: r.s!, z0: r.c!, z1: r.m!, ri: d / 2 });
      hd("dc", r.dc!, 0); vd("m", r.m!, 0, r.m!, r.dc! / 2 * 1.15);
      break;
    case "iso7089": case "iso7092": case "iso7093":
      s.push(ring(r.d2! / 2, r.d1! / 2, 0, r.h!));
      hd("d2", r.d2!, 0); hd("d1", r.d1!, r.h!); vd("h", r.h!, 0, r.h!, r.d2! / 2 * 1.15);
      break;
    case "din127":
      // Seen from above, with its split.
      s.push(ring(r.d2! / 2, r.d1! / 2, 0, r.h!));
      plan = { ri: r.d1! / 2, ro: r.d2! / 2, g: r.g!, rd: 0 };
      dims.push({ sym: "d2", val: r.d2!, axis: "h", a: -r.d2! / 2, b: r.d2! / 2, at: -r.d2! / 2 }, { sym: "d1", val: r.d1!, axis: "h", a: -r.d1! / 2, b: r.d1! / 2, at: r.d2! / 2 });
      break;
    case "din471": case "din472":
      s.push(ring(r.d2! / 2, r.d1! / 2, -r.h!, 0));
      plan = { ri: r.d1! / 2, ro: r.d2! / 2, g: r.g!, rd: d / 2 };
      // Plan view dimensions (X across, the second axis up): d3 and the shaft or bore d1.
      dims.push({ sym: "d3", val: kind === "din471" ? r.d1! : r.d2!, axis: "h", a: -(kind === "din471" ? r.d1! : r.d2!) / 2, b: (kind === "din471" ? r.d1! : r.d2!) / 2, at: r.d2! / 2 },
        { sym: "d1", val: d, axis: "h", a: -d / 2, b: d / 2, at: -r.d2! / 2 });
      break;
    case "standoff": case "standoffm":
      s.push({ t: "hex", s: r.s!, z0: 0, z1: L, ri: kind === "standoff" ? d / 2 : 0 });
      if (kind === "standoffm") s.push({ t: "rev", pts: rect(0, d / 2, -r.ls!, 0) }, { t: "rev", pts: rect(0, d / 2, L - r.bd!, L), neg: true });
      hd("s", r.s!, L); vd("L", L, 0, L, r.s! / 2 * 1.15);
      if (kind === "standoffm") { hd("d", d, -r.ls!); vd("l", r.ls!, -r.ls!, 0, -r.s! / 2 * 1.15); }
      break;
    case "spacer":
      s.push(ring(r.d2! / 2, r.d1! / 2, 0, L));
      hd("D", r.d2!, L); hd("d", r.d1!, 0); vd("L", L, 0, L, r.d2! / 2 * 1.15);
      break;
    case "iso2338": case "iso8752":
      s.push(r.d1 ? ring(d / 2, r.d1 / 2, -L, 0) : { t: "rev", pts: rect(0, d / 2, -L, 0) });
      hd("d", d, 0); vd("L", L, -L, 0, d * 0.6 + 0.02 * L);
      break;
    case "din6885":
      s.push({ t: "box", x: L, y: r.b!, z0: 0, z1: r.hk! });
      dims.push({ sym: "L", val: L, axis: "h", a: -L / 2, b: L / 2, at: 0 });
      vd("h", r.hk!, 0, r.hk!, L / 2 * 1.08);
      break;
    case "bearing": case "needle":
      s.push(ring(r.D! / 2, d / 2, -r.B!, 0));
      hd("D", r.D!, 0); hd(kind === "needle" ? "Fw" : "d", d, -r.B!); vd(kind === "needle" ? "C" : "B", r.B!, -r.B!, 0, r.D! / 2 * 1.12);
      break;
    case "linear":
      s.push(ring(r.D! / 2, d / 2, -r.B!, 0));
      hd("D", r.D!, 0); hd("dr", d, -r.B!); vd("L", r.B!, -r.B!, 0, r.D! / 2 * 1.12);
      break;
    case "thrust": {
      // Shaft washer below, housing washer above, the cage between them.
      const h = r.B! * 0.35, m = (d + r.D!) / 4, w = (r.D! - d) / 2;
      s.push(ring(r.D! / 2, d / 2, -r.B!, -r.B! + h), ring(m + 0.15 * w, m - 0.15 * w, -r.B! + h, -h), ring(r.D! / 2, d / 2, -h, 0));
      hd("D", r.D!, 0); hd("d", d, -r.B!); vd("H", r.B!, -r.B!, 0, r.D! / 2 * 1.12);
      break;
    }
    case "bearingf":
      s.push(ring(r.D! / 2, d / 2, r.c! - r.B!, 0), ring(r.dc! / 2, d / 2, 0, r.c!));
      hd("D1", r.dc!, r.c!); hd("d", d, r.c! - r.B!); vd("B", r.B!, r.c! - r.B!, r.c!, r.dc! / 2 * 1.12);
      break;
  }
  return { solids: s, dims, ...(plan ? { plan } : {}) };
}

/** Volume of the solids in mm³ (sockets taken off). */
export function shapeVolume(sh: ToolShape): number {
  let v = 0;
  for (const s of sh.solids) {
    let q = 0;
    if (s.t === "rev") {
      // Pappus: profile area × 2π × centroid radius, by the shoelace sums.
      let a = 0, cr = 0;
      for (let i = 0; i < s.pts.length; i++) {
        const [r0, z0] = s.pts[i], [r1, z1] = s.pts[(i + 1) % s.pts.length], c = r0 * z1 - r1 * z0;
        a += c; cr += (r0 + r1) * c;
      }
      q = Math.abs(a) > 1e-12 ? Math.abs(2 * Math.PI * (cr / 6)) : 0;
    } else if (s.t === "hex") q = ((Math.sqrt(3) / 2) * s.s * s.s - Math.PI * (s.ri ?? 0) ** 2) * Math.abs(s.z1 - s.z0);
    else q = s.x * s.y * Math.abs(s.z1 - s.z0);
    v += s.t !== "box" && s.neg ? -q : q;
  }
  return v;
}

const f = (v: number) => +v.toFixed(2);
const fmt = (v: number) => String(+v.toFixed(2));

/**
 * The side view as SVG (X across, Z up), fitted into `w` × `h`: outlines solid, bores and sockets dashed,
 * and with `dims` the dimensions as arrows with "sym value" texts.
 */
export function shapeSvg(sh: ToolShape, o: { w: number; h: number; dims?: boolean; cls?: string; label?: string }): string {
  // Outlines in model units: each solid's silhouette seen along Y.
  const solid: [number, number][][] = [], hidden: [number, number][][] = [];
  if (sh.plan) {
    // Seen from above: the ring as one closed outline round the opening on +X, the shaft or bore dashed.
    const { ri, ro, g, rd } = sh.plan, ai = Math.asin(Math.min(1, g / 2 / ri)), ao = Math.asin(Math.min(1, g / 2 / ro)), n = 72;
    const arc = (r: number, a0: number, a1: number) => Array.from({ length: n + 1 }, (_, i) => { const a = a0 + ((a1 - a0) * i) / n; return [r * Math.cos(a), r * Math.sin(a)] as [number, number]; });
    solid.push([...arc(ro, ao, 2 * Math.PI - ao), ...arc(ri, 2 * Math.PI - ai, ai)]);
    if (rd) hidden.push(arc(rd, 0, 2 * Math.PI));
  }
  for (const s of sh.plan ? [] : sh.solids) {
    if (s.t === "rev") {
      const pts = s.pts.filter(p => p[0] > 1e-9);
      const rmin = Math.min(...s.pts.map(p => p[0]));
      const sil = [...s.pts.map(([r, z]) => [r, z] as [number, number]), ...[...s.pts].reverse().map(([r, z]) => [-r, z] as [number, number])];
      if (rmin > 1e-9) {
        // A ring: outside outline plus the bore drawn hidden.
        const z0 = Math.min(...s.pts.map(p => p[1])), z1 = Math.max(...s.pts.map(p => p[1])), ro = Math.max(...s.pts.map(p => p[0]));
        solid.push([[-ro, z0], [ro, z0], [ro, z1], [-ro, z1]]);
        hidden.push([[-rmin, z0], [-rmin, z1]], [[rmin, z0], [rmin, z1]]);
      } else if (s.neg) hidden.push(sil); else if (pts.length) solid.push(sil);
    } else if (s.t === "hex") {
      // Seen along Y (flats square to X): width s, the corner edge in the middle.
      const h = s.s / 2, q: [number, number][] = [[-h, s.z0], [h, s.z0], [h, s.z1], [-h, s.z1]];
      if (s.neg) hidden.push(q);
      else {
        solid.push(q, [[0, s.z0], [0, s.z1]]);
        if (s.ri) hidden.push([[-s.ri, s.z0], [-s.ri, s.z1]], [[s.ri, s.z0], [s.ri, s.z1]]);
      }
    } else solid.push([[-s.x / 2, s.z0], [s.x / 2, s.z0], [s.x / 2, s.z1], [-s.x / 2, s.z1]]);
  }
  const all = [...solid, ...hidden].flat();
  const x0 = Math.min(...all.map(p => p[0])), x1 = Math.max(...all.map(p => p[0]));
  const z0 = Math.min(...all.map(p => p[1])), z1 = Math.max(...all.map(p => p[1]));
  const vdims = o.dims ? sh.dims.filter(d => d.axis === "v") : [], hdims = o.dims ? sh.dims.filter(d => d.axis === "h") : [];
  // Pixel room for the dimensions: texts beside vertical ones, a row above or below for horizontal ones.
  const left = vdims.some(d => d.at < 0) ? 44 : o.dims ? 10 : 2, right = vdims.some(d => d.at >= 0) ? 52 : o.dims ? 10 : 2;
  const below = (d: ShapeDim) => d.at <= (z0 + z1) / 2;
  const top = hdims.some(d => !below(d)) ? 22 : o.dims ? 6 : 2, bottom = hdims.some(below) ? 24 : o.dims ? 6 : 2;
  const sc = Math.min((o.w - left - right) / Math.max(x1 - x0, 1e-6), (o.h - top - bottom) / Math.max(z1 - z0, 1e-6));
  const ox = left + (o.w - left - right - (x1 - x0) * sc) / 2, oz = bottom + (o.h - top - bottom - (z1 - z0) * sc) / 2;
  const X = (x: number) => f(ox + (x - x0) * sc), Y = (z: number) => f(o.h - oz - (z - z0) * sc);
  const path = (p: [number, number][], closed: boolean) => `M${p.map(([x, z]) => `${X(x)} ${Y(z)}`).join("L")}${closed ? "Z" : ""}`;
  let out = `<svg class="${o.cls ?? "tb-svg"}" viewBox="0 0 ${o.w} ${o.h}" width="${o.w}" height="${o.h}" translate="no"${o.label ? ` role="img" aria-label="${o.label}"` : ` aria-hidden="true"`}>`;
  out += `<path class="tb-fill" d="${solid.filter(p => p.length > 2).map(p => path(p, true)).join("")}"/>`;
  out += `<path class="tb-line" d="${solid.map(p => path(p, p.length > 2)).join("")}"/>`;
  if (hidden.length) out += `<path class="tb-hid" d="${hidden.map(p => path(p, p.length > 2)).join("")}"/>`;
  if (o.dims) {
    const ah = 4;
    for (const dm of sh.dims) {
      const txt = `${dm.sym} ${fmt(dm.val)}`;
      if (dm.axis === "h") {
        const dn = below(dm), y = Y(dm.at) + (dn ? 8 : -8);
        const xa = X(dm.a), xb = X(dm.b);
        out += `<path class="tb-dim" d="M${xa} ${Y(dm.at)}V${y}M${xb} ${Y(dm.at)}V${y}M${xa} ${y}H${xb}M${xa + ah} ${y - ah / 2}L${xa} ${y}L${xa + ah} ${y + ah / 2}M${xb - ah} ${y - ah / 2}L${xb} ${y}L${xb - ah} ${y + ah / 2}"/>`;
        out += `<text class="tb-dt" x="${f((xa + xb) / 2)}" y="${f(dn ? y + 12 : y - 4)}" text-anchor="middle">${txt}</text>`;
      } else {
        const x = f(dm.at >= 0 ? X(x1) + 10 : X(x0) - 10), ya = Y(dm.a), yb = Y(dm.b), right = dm.at >= 0;
        const e0 = f(right ? X(x1) + 2 : X(x0) - 2), e1 = f(right ? x + 3 : x - 3);
        out += `<path class="tb-ext" d="M${e0} ${ya}H${e1}M${e0} ${yb}H${e1}"/>`;
        out += `<path class="tb-dim" d="M${x} ${ya}V${yb}M${x - ah / 2} ${ya - ah}L${x} ${ya}L${x + ah / 2} ${ya - ah}M${x - ah / 2} ${yb + ah}L${x} ${yb}L${x + ah / 2} ${yb + ah}"/>`;
        out += `<text class="tb-dt" x="${f(x + (right ? 4 : -4))}" y="${f((ya + yb) / 2 + 4)}" text-anchor="${right ? "start" : "end"}">${txt}</text>`;
      }
    }
  }
  return out + "</svg>";
}
