// Numeric input with units and arithmetic (FRS FR-PAR-002/004): "10+2.5",
// "1in", "25.4 mm / 2", "30deg", "sqrt(2)*10", "2*pi". Parsed by hand: no eval.
// Lengths come out in millimetres, angles in radians.

export type Quantity = "length" | "angle" | "number";

const LEN: Record<string, number> = { mm: 1, cm: 10, m: 1000, in: 25.4, "\"": 25.4, ft: 304.8, um: 0.001, мм: 1, см: 10, м: 1000 };
const ANG: Record<string, number> = { deg: Math.PI / 180, "°": Math.PI / 180, rad: 1, град: Math.PI / 180 };
const FN: Record<string, (...a: number[]) => number> = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
  sqrt: Math.sqrt, abs: Math.abs, min: Math.min, max: Math.max, round: Math.round, floor: Math.floor, ceil: Math.ceil,
};

export class ExprError extends Error {}

/**
 * Evaluates an expression. Plain numbers take `defUnit` (the document unit for
 * lengths, degrees for angles). `vars` may name other values (already in internal units).
 */
export function evaluate(src: string, q: Quantity, defUnit = q === "angle" ? "deg" : "mm", vars: Record<string, number> = {}): number {
  // Decimal comma (Russian keyboards): "12,5" is 12.5 unless commas separate function arguments.
  const hasFn = /[a-z]\s*\(/i.test(src);
  const text = hasFn ? src.trim() : src.trim().replace(/(\d),(\d)/g, "$1.$2");
  if (!text) throw new ExprError("Enter a value");
  let i = 0;
  const peek = () => text[i];
  const ws = () => { while (i < text.length && /\s/.test(text[i])) i++; };
  const scaleOf = (u: string) => (q === "angle" ? ANG[u] : q === "length" ? LEN[u] : undefined);
  const dflt = scaleOf(defUnit) ?? 1;

  // Values carry whether a unit was given, so "10 + 2mm" works and bare numbers get the default unit.
  type V = { v: number; unit: boolean };
  const num = (): V => {
    ws();
    const m = /^(\d+\.?\d*(?:e[+-]?\d+)?|\.\d+(?:e[+-]?\d+)?)/i.exec(text.slice(i));
    if (!m) throw new ExprError(`Unexpected "${text.slice(i, i + 8) || "end"}"`);
    i += m[0].length;
    let v = parseFloat(m[0]);
    ws();
    const u = /^(mm|cm|um|m|in|ft|deg|rad|°|"|мм|см|м|град)(?![a-zа-я])/i.exec(text.slice(i));
    if (u) {
      const s = scaleOf(u[1].toLowerCase());
      if (s === undefined) throw new ExprError(`"${u[1]}" is not a unit for this value`);
      i += u[0].length;
      return { v: v * s, unit: true };
    }
    return { v, unit: false };
  };
  const atom = (): V => {
    ws();
    const c = peek();
    if (c === "(") { i++; const v = expr(); ws(); if (peek() !== ")") throw new ExprError("Missing )"); i++; return v; }
    if (c === "-") { i++; const v = atom(); return { v: -v.v, unit: v.unit }; }
    if (c === "+") { i++; return atom(); }
    const id = /^[a-z_а-я][\w@.а-я]*/i.exec(text.slice(i));
    if (id) {
      const name = id[0];
      i += name.length;
      ws();
      if (name.toLowerCase() === "pi" || name === "π") return { v: Math.PI, unit: false };
      const fn = FN[name.toLowerCase()];
      if (fn) {
        if (peek() !== "(") throw new ExprError(`${name} needs (…)`);
        i++;
        const args: number[] = [];
        // Trig functions take degrees unless a unit is given.
        const trig = /^(sin|cos|tan)$/i.test(name);
        for (;;) {
          const a = expr();
          args.push(trig && !a.unit ? a.v * Math.PI / 180 : a.v);
          ws();
          if (peek() === ",") { i++; continue; }
          if (peek() === ")") { i++; break; }
          throw new ExprError("Missing )");
        }
        return { v: fn(...args), unit: !/^(sin|cos|tan)$/i.test(name) && args.length > 0 };
      }
      if (name in vars) return { v: vars[name], unit: true };
      throw new ExprError(`Unknown name "${name}"`);
    }
    return num();
  };
  const pow = (): V => { const a = atom(); ws(); if (peek() === "^") { i++; const b = pow(); return { v: Math.pow(a.v, b.v), unit: a.unit }; } return a; };
  const term = (): V => {
    let a = pow();
    for (;;) {
      ws();
      const c = peek();
      if (c !== "*" && c !== "/") return a;
      i++;
      const b = pow();
      if (c === "/" && b.v === 0) throw new ExprError("Division by zero");
      // A unitless factor scales a value that has a unit.
      a = { v: c === "*" ? a.v * b.v : a.v / b.v, unit: a.unit || b.unit };
    }
  };
  const expr = (): V => {
    let a = term();
    for (;;) {
      ws();
      const c = peek();
      if (c !== "+" && c !== "-") return a;
      i++;
      const b = term();
      // Mixing: bare numbers in a sum take the default unit.
      const av = a.unit ? a.v : a.v * dflt, bv = b.unit ? b.v : b.v * dflt;
      a = { v: c === "+" ? av + bv : av - bv, unit: true };
    }
  };
  const r = expr();
  ws();
  if (i < text.length) throw new ExprError(`Unexpected "${text.slice(i, i + 8)}"`);
  const v = r.unit ? r.v : r.v * dflt;
  if (!Number.isFinite(v)) throw new ExprError("Not a number");
  return v;
}

/** True when the text is just a number (no expression worth keeping). */
export const isPlain = (s: string) => /^\s*[+-]?(\d+\.?\d*|\.\d+)\s*$/.test(s);
