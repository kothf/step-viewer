// RS-274X / Gerber X2 parser. Produces flashes, tracks, arcs and regions in
// board millimetres, with apertures (standard templates and macros) resolved
// to shape primitives and X2 attributes (file, aperture, object) kept.

import type { ApDef, Attrs, CV, GObj, Prim } from "./model";

// ---------- primitive helpers ----------

export function polyArea(pts: number[]) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i += 2) {
    const j = (i + 2) % n;
    a += pts[i] * pts[j + 1] - pts[j] * pts[i + 1];
  }
  return a / 2;
}

/** Makes a polygon counter-clockwise and drops a repeated closing vertex. */
export function ccw(pts: number[]): number[] {
  const n = pts.length;
  if (n >= 4 && Math.abs(pts[0] - pts[n - 2]) < 1e-12 && Math.abs(pts[1] - pts[n - 1]) < 1e-12) pts = pts.slice(0, n - 2);
  if (polyArea(pts) >= 0) return pts;
  const out: number[] = [];
  for (let i = pts.length - 2; i >= 0; i -= 2) out.push(pts[i], pts[i + 1]);
  return out;
}

const rotPt = (x: number, y: number, deg: number): [number, number] => {
  if (!deg) return [x, y];
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return [x * c - y * s, x * s + y * c];
};
const rotPts = (pts: number[], deg: number) => {
  if (!deg) return pts;
  const out: number[] = [];
  for (let i = 0; i < pts.length; i += 2) out.push(...rotPt(pts[i], pts[i + 1], deg));
  return out;
};
const rect = (cx: number, cy: number, w: number, h: number) =>
  [cx - w / 2, cy - h / 2, cx + w / 2, cy - h / 2, cx + w / 2, cy + h / 2, cx - w / 2, cy + h / 2];
const circ = (x: number, y: number, r: number): Prim => ({ k: "c", ax: x, ay: y, bx: x, by: y, r });
const regPoly = (cx: number, cy: number, r: number, n: number, rotDeg: number) => {
  const pts: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = ((rotDeg + (360 * i) / n) * Math.PI) / 180;
    pts.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  return pts;
};

export function translatePrim(p: Prim, dx: number, dy: number): Prim {
  if (p.k === "c") return { k: "c", ax: p.ax + dx, ay: p.ay + dy, bx: p.bx + dx, by: p.by + dy, r: p.r };
  const pts = p.pts.slice();
  for (let i = 0; i < pts.length; i += 2) { pts[i] += dx; pts[i + 1] += dy; }
  return { k: "p", pts };
}

// ---------- aperture macros ----------

/** Evaluates a macro arithmetic expression ($n variables, + - x / and parentheses). */
export function evalExpr(src: string, vars: Record<number, number>): number {
  const s = src.replace(/\s+/g, "");
  let i = 0;
  const num = (): number => {
    if (s[i] === "(") { i++; const v = add(); i++; return v; }
    if (s[i] === "-") { i++; return -num(); }
    if (s[i] === "+") { i++; return num(); }
    if (s[i] === "$") { i++; const m = /^\d+/.exec(s.slice(i))!; i += m[0].length; return vars[+m[0]] ?? 0; }
    const m = /^(\d+\.?\d*|\.\d+)/.exec(s.slice(i));
    if (!m) { i++; return 0; }
    i += m[0].length;
    return parseFloat(m[0]);
  };
  const mul = (): number => {
    let v = num();
    while (s[i] === "x" || s[i] === "X" || s[i] === "/") { const op = s[i++]; const r = num(); v = op === "/" ? v / r : v * r; }
    return v;
  };
  const add = (): number => {
    let v = mul();
    while (s[i] === "+" || s[i] === "-") { const op = s[i++]; const r = mul(); v = op === "+" ? v + r : v - r; }
    return v;
  };
  return add();
}

/** Expands a macro body (the blocks after AM<name>) for the given parameters, in file units. */
export function expandMacro(body: string[], params: number[]): { on: Prim[]; off: Prim[] } {
  const vars: Record<number, number> = {};
  params.forEach((v, k) => (vars[k + 1] = v));
  const on: Prim[] = [], off: Prim[] = [];
  for (const raw of body) {
    const blk = raw.trim();
    if (!blk || /^0(?![\d.])/.test(blk)) continue; // primitive 0: comment
    const asg = /^\$(\d+)=(.*)$/.exec(blk);
    if (asg) { vars[+asg[1]] = evalExpr(asg[2], vars); continue; }
    const f = blk.split(",").map(x => evalExpr(x, vars));
    const code = f[0];
    const exposure = f[1];
    const push = (p: Prim) => (exposure === 0 ? off : on).push(p);
    switch (code) {
      case 1: { // circle: exp, dia, cx, cy, rot
        const [x, y] = rotPt(f[3], f[4], f[5] ?? 0);
        push(circ(x, y, f[2] / 2));
        break;
      }
      case 2: case 20: { // vector line: exp, width, sx, sy, ex, ey, rot
        const [w, sx, sy, ex, ey, r] = f.slice(2);
        const dx = ex - sx, dy = ey - sy, l = Math.hypot(dx, dy) || 1;
        const nx = (-dy / l) * (w / 2), ny = (dx / l) * (w / 2);
        push({ k: "p", pts: ccw(rotPts([sx - nx, sy - ny, ex - nx, ey - ny, ex + nx, ey + ny, sx + nx, sy + ny], r ?? 0)) });
        break;
      }
      case 21: { // centre line: exp, w, h, cx, cy, rot
        push({ k: "p", pts: ccw(rotPts(rect(f[4], f[5], f[2], f[3]), f[6] ?? 0)) });
        break;
      }
      case 22: { // lower-left line (deprecated): exp, w, h, llx, lly, rot
        push({ k: "p", pts: ccw(rotPts(rect(f[4] + f[2] / 2, f[5] + f[3] / 2, f[2], f[3]), f[6] ?? 0)) });
        break;
      }
      case 4: { // outline: exp, n, x0, y0, ..., xn, yn, rot
        const n = f[2];
        const pts = f.slice(3, 3 + 2 * (n + 1));
        push({ k: "p", pts: ccw(rotPts(pts, f[3 + 2 * (n + 1)] ?? 0)) });
        break;
      }
      case 5: { // polygon: exp, n, cx, cy, dia, rot
        const r = f[6] ?? 0;
        const [cx, cy] = rotPt(f[3], f[4], r);
        push({ k: "p", pts: ccw(regPoly(cx, cy, f[5] / 2, f[2], r)) });
        break;
      }
      case 6: { // moiré: cx, cy, od, ... rot (drawn as its outer circle)
        const [x, y] = rotPt(f[1], f[2], f[9] ?? 0);
        on.push(circ(x, y, f[3] / 2));
        break;
      }
      case 7: { // thermal: cx, cy, od, id, gap, rot (outer disc minus inner disc; gaps not cut)
        const [x, y] = rotPt(f[1], f[2], f[6] ?? 0);
        on.push(circ(x, y, f[3] / 2));
        off.push(circ(x, y, f[4] / 2));
        break;
      }
    }
  }
  return { on, off };
}

function scalePrim(p: Prim, k: number): Prim {
  if (k === 1) return p;
  if (p.k === "c") return { k: "c", ax: p.ax * k, ay: p.ay * k, bx: p.bx * k, by: p.by * k, r: p.r * k };
  return { k: "p", pts: p.pts.map(v => v * k) };
}

/** Builds an aperture's flash shape (millimetres) from its template or macro. `k` converts file units to mm. */
export function makeAperture(code: number, shape: string, params: number[], macros: Map<string, string[]>, k: number, attrs?: Attrs): ApDef {
  const P = params.map(v => v * k);
  let prims: Prim[] = [];
  let clear: Prim[] = [];
  const hole = (i: number) => { if (P[i] > 0) clear.push(circ(0, 0, P[i] / 2)); };
  switch (shape) {
    case "C": prims = [circ(0, 0, (P[0] ?? 0) / 2)]; hole(1); break;
    case "R": prims = [{ k: "p", pts: rect(0, 0, P[0], P[1]) }]; hole(2); break;
    case "O": {
      const w = P[0], h = P[1];
      prims = [w >= h
        ? { k: "c", ax: -(w - h) / 2, ay: 0, bx: (w - h) / 2, by: 0, r: h / 2 }
        : { k: "c", ax: 0, ay: -(h - w) / 2, bx: 0, by: (h - w) / 2, r: w / 2 }];
      hole(2);
      break;
    }
    case "P": prims = [{ k: "p", pts: ccw(regPoly(0, 0, P[0] / 2, Math.max(3, Math.round(params[1])), params[2] ?? 0)) }]; if (P[3] > 0) clear.push(circ(0, 0, P[3] / 2)); break;
    default: {
      const body = macros.get(shape);
      if (body) {
        // Macro parameters are expanded in file units (angles and counts must stay unscaled), then scaled.
        const m = expandMacro(body, params);
        prims = m.on.map(p => scalePrim(p, k));
        clear = m.off.map(p => scalePrim(p, k));
      }
    }
  }
  // Lengths in mm; a polygon's vertex count and rotation stay as given.
  const out = shape === "P" ? params.map((v, i) => (i === 1 || i === 2 ? v : v * k)) : P;
  return { code, shape, params: out, prims, clear, attrs };
}

// ---------- the parser ----------

export interface GerberResult {
  objs: GObj[];
  apertures: Record<number, ApDef>;
  fileAttrs: Attrs;
  warnings: string[];
  units: "mm" | "in";
}

export function parseGerber(text: string): GerberResult {
  const objs: GObj[] = [];
  const apertures: Record<number, ApDef> = {};
  const macros = new Map<string, string[]>();
  const fileAttrs: Attrs = {};
  const warnings = new Set<string>();
  let apAttrs: Attrs = {};
  let objAttrs: Attrs | undefined;

  let units: "mm" | "in" = "in";
  let unitsSet = false;
  let fi = 2, fd = 4, zeros: "L" | "T" = "L", incremental = false;
  let x = 0, y = 0, curAp = 0, interp = 1, multi: boolean | null = null, dark = true;
  let lastD = 0;
  let region = false, contours: CV[][] = [], cur: CV[] | null = null;
  let sr: { start: number; nx: number; ny: number; dx: number; dy: number } | null = null;
  const k = () => (units === "in" ? 25.4 : 1);

  const coord = (s: string) => {
    if (s.includes(".")) return parseFloat(s) * k();
    const neg = s.startsWith("-");
    let d = s.replace(/^[+-]/, "");
    if (zeros === "T") d = d.padEnd(fi + fd, "0");
    return ((neg ? -1 : 1) * parseInt(d || "0", 10)) / 10 ** fd * k();
  };

  const closeSR = () => {
    if (!sr) return;
    const block = objs.slice(sr.start);
    for (let ix = 0; ix < sr.nx; ix++) for (let iy = 0; iy < sr.ny; iy++) {
      if (!ix && !iy) continue;
      const ox = ix * sr.dx, oy = iy * sr.dy;
      for (const o of block) objs.push(shiftObj(o, ox, oy));
    }
    sr = null;
  };

  const setAttr = (blk: string) => {
    const [name, ...vals] = blk.slice(2).split(",");
    const v = vals.join(",");
    const kind = blk.slice(0, 2);
    if (kind === "TF") fileAttrs[name] = v;
    else if (kind === "TA") apAttrs = { ...apAttrs, [name]: v };
    else if (kind === "TO") objAttrs = { ...(objAttrs ?? {}), [name]: v };
    else if (kind === "TD") {
      if (!name) { apAttrs = {}; objAttrs = undefined; }
      else {
        if (name in apAttrs) { apAttrs = { ...apAttrs }; delete apAttrs[name]; }
        if (objAttrs && name in objAttrs) { objAttrs = { ...objAttrs }; delete objAttrs[name]; if (!Object.keys(objAttrs).length) objAttrs = undefined; }
      }
    }
  };

  const extended = (blocks: string[]) => {
    if (blocks[0]?.startsWith("AM")) { macros.set(blocks[0].slice(2), blocks.slice(1)); return; }
    for (const blk of blocks) {
      const c2 = blk.slice(0, 2);
      if (c2 === "FS") {
        const m = /^FS([LTD]?)([AI]?)(?:N\d+)?(?:G\d+)?X(\d)(\d)Y(\d)(\d)/.exec(blk);
        if (m) { zeros = m[1] === "T" ? "T" : "L"; incremental = m[2] === "I"; fi = +m[3]; fd = +m[4]; }
      } else if (c2 === "MO") { units = blk.slice(2, 4) === "MM" ? "mm" : "in"; unitsSet = true; }
      else if (c2 === "AD") {
        const m = /^ADD(\d+)([^,]+)(?:,(.*))?$/.exec(blk);
        if (m) {
          const params = m[3] ? m[3].split(/[xX]/).map(Number) : [];
          const code = +m[1];
          apertures[code] = makeAperture(code, m[2], params, macros, k(), Object.keys(apAttrs).length ? apAttrs : undefined);
        }
      } else if (c2 === "LP") { dark = blk[2] !== "C"; }
      else if (c2 === "SR") {
        closeSR();
        const m = /^SRX(\d+)Y(\d+)I([\d.+-]+)J([\d.+-]+)/.exec(blk);
        if (m && (+m[1] > 1 || +m[2] > 1)) sr = { start: objs.length, nx: +m[1], ny: +m[2], dx: +m[3] * k(), dy: +m[4] * k() };
      } else if (c2 === "TF" || c2 === "TA" || c2 === "TO" || c2 === "TD") setAttr(blk);
      else if (c2 === "LM" && blk.slice(2) !== "N") warnings.add("Layer mirroring (LM) is not applied.");
      else if (c2 === "LR" && parseFloat(blk.slice(2)) !== 0) warnings.add("Layer rotation (LR) is not applied.");
      else if (c2 === "LS" && parseFloat(blk.slice(2)) !== 1) warnings.add("Layer scaling (LS) is not applied.");
      else if (c2 === "AB") warnings.add("Block apertures (AB) are not supported.");
      else if (c2 === "IP" && blk.includes("NEG")) warnings.add("Negative image polarity (IPNEG) is drawn as positive.");
      else if (c2 === "IN" || c2 === "LN" || c2 === "OF" || c2 === "SF" || c2 === "IR" || c2 === "AS" || c2 === "MI" || c2 === "IP") { /* legacy, ignored */ }
    }
  };

  const op = (d: number, nx: number, ny: number, i: number, j: number) => {
    if (d === 1) {
      if (interp === 1) {
        if (region) { cur ??= [{ x, y }]; cur.push({ x: nx, y: ny }); }
        else objs.push({ t: "track", x1: x, y1: y, x2: nx, y2: ny, ap: curAp, dark, a: objAttrs });
      } else {
        const isCcw = interp === 3;
        let cx: number, cy: number;
        const single = multi === false || (multi === null && i >= 0 && j >= 0);
        if (!single) { cx = x + i; cy = y + j; }
        else {
          // Single quadrant: pick the sign combination that fits a ≤ 90° arc in the given direction.
          let best = Infinity; cx = x + i; cy = y + j;
          for (const [si, sj] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
            const tx = x + si * Math.abs(i), ty = y + sj * Math.abs(j);
            const r1 = Math.hypot(x - tx, y - ty), r2 = Math.hypot(nx - tx, ny - ty);
            let sw = Math.atan2(ny - ty, nx - tx) - Math.atan2(y - ty, x - tx);
            if (isCcw) { while (sw < 0) sw += 2 * Math.PI; } else { while (sw > 0) sw -= 2 * Math.PI; }
            if (Math.abs(sw) > Math.PI / 2 + 1e-6) continue;
            const err = Math.abs(r1 - r2);
            if (err < best) { best = err; cx = tx; cy = ty; }
          }
          if (Math.hypot(x - nx, y - ny) < 1e-9) { // zero-length single-quadrant arc
            if (!region) objs.push({ t: "track", x1: x, y1: y, x2: nx, y2: ny, ap: curAp, dark, a: objAttrs });
            x = nx; y = ny; return;
          }
        }
        if (region) { cur ??= [{ x, y }]; cur.push({ x: nx, y: ny, arc: { cx, cy, ccw: isCcw } }); }
        else objs.push({ t: "arc", x1: x, y1: y, x2: nx, y2: ny, cx, cy, ccw: isCcw, ap: curAp, dark, a: objAttrs });
      }
    } else if (d === 2) {
      if (region && cur) { if (cur.length > 2) contours.push(cur); cur = null; }
    } else if (d === 3) {
      objs.push({ t: "flash", x: nx, y: ny, ap: curAp, dark, a: objAttrs });
    }
    x = nx; y = ny;
  };

  const word = (w: string) => {
    if (!w) return;
    if (/^G0?4(?!\d)/.test(w)) {
      const x2 = /#@!\s*(T[FAOD].*)$/.exec(w); // KiCad writes X2 attributes as comments in older files
      if (x2) setAttr(x2[1].trim());
      return;
    }
    if (w.startsWith("M02") || w.startsWith("M00")) { closeSR(); return; }
    let nx: number | null = null, ny: number | null = null, i = 0, j = 0, d = -1;
    const re = /([GDMXYIJ])([+-]?[\d.]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(w))) {
      const v = m[2];
      switch (m[1]) {
        case "G": {
          const g = parseInt(v, 10);
          if (g >= 1 && g <= 3) interp = g;
          else if (g === 36) { region = true; contours = []; cur = null; }
          else if (g === 37) {
            if (cur && cur.length > 2) contours.push(cur);
            if (contours.length) objs.push({ t: "region", contours, dark, a: objAttrs });
            region = false; contours = []; cur = null;
          } else if (g === 74) multi = false;
          else if (g === 75) multi = true;
          else if (g === 70) { units = "in"; unitsSet = true; }
          else if (g === 71) { units = "mm"; unitsSet = true; }
          else if (g === 90) incremental = false;
          else if (g === 91) incremental = true;
          break;
        }
        case "X": nx = coord(v); break;
        case "Y": ny = coord(v); break;
        case "I": i = coord(v); break;
        case "J": j = coord(v); break;
        case "D": d = parseInt(v, 10); break;
      }
    }
    if (d >= 10) { curAp = d; return; }
    const hasCoord = nx !== null || ny !== null;
    if (d < 0 && hasCoord) d = lastD || 1; // deprecated modal D-code
    if (d >= 1 && d <= 3) {
      lastD = d;
      const tx = nx === null ? x : incremental ? x + nx : nx;
      const ty = ny === null ? y : incremental ? y + ny : ny;
      op(d, tx, ty, i, j);
    }
  };

  // Tokenizer: %...% extended blocks, otherwise words ended by '*'.
  const n = text.length;
  let p = 0;
  let nextPct = text.indexOf("%");
  while (p < n) {
    if (nextPct >= 0 && nextPct < p) nextPct = text.indexOf("%", p);
    const c = text[p];
    if (c === "%") {
      const e = text.indexOf("%", p + 1);
      const body = text.slice(p + 1, e < 0 ? n : e);
      extended(body.split("*").map(s => s.replace(/[\r\n]/g, "")).filter(Boolean).map(s => s.trim()));
      p = e < 0 ? n : e + 1;
    } else if (c === "\n" || c === "\r" || c === " " || c === "\t") p++;
    else {
      let e = text.indexOf("*", p);
      if (e < 0) e = n;
      if (nextPct >= 0 && nextPct < e) e = nextPct; // malformed: unterminated word before a block
      word(text.slice(p, e).replace(/[\r\n]/g, "").trim());
      p = text[e] === "*" ? e + 1 : e;
    }
  }
  closeSR();
  if (!unitsSet) warnings.add("No unit command (MO); inches assumed.");
  const used = new Set<number>();
  for (const o of objs) if ("ap" in o) used.add(o.ap);
  for (const a of used) if (!apertures[a]) warnings.add(`Aperture D${a} is used but not defined.`);
  return { objs, apertures, fileAttrs, warnings: [...warnings], units };
}

export function shiftObj(o: GObj, dx: number, dy: number): GObj {
  switch (o.t) {
    case "flash": case "hole": return { ...o, x: o.x + dx, y: o.y + dy };
    case "track": case "slot": return { ...o, x1: o.x1 + dx, y1: o.y1 + dy, x2: o.x2 + dx, y2: o.y2 + dy };
    case "arc": return { ...o, x1: o.x1 + dx, y1: o.y1 + dy, x2: o.x2 + dx, y2: o.y2 + dy, cx: o.cx + dx, cy: o.cy + dy };
    case "region": return { ...o, contours: o.contours.map(c => c.map(v => ({ x: v.x + dx, y: v.y + dy, arc: v.arc && { ...v.arc, cx: v.arc.cx + dx, cy: v.arc.cy + dy } }))) };
  }
}
