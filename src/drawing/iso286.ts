// ISO 286-1/-2 limits for fit codes such as H7 or g6, sizes up to 500 mm (FR-DRW-021).
// Values in micrometres from the standard's tables; results in millimetres.

/** Upper bounds of the 13 main size ranges (mm). */
const R = [3, 6, 10, 18, 30, 50, 80, 120, 180, 250, 315, 400, 500];
/** Upper bounds of the intermediate ranges used by r and s. */
const RI = [3, 6, 10, 18, 30, 50, 65, 80, 100, 120, 140, 160, 180, 200, 225, 250, 280, 315, 355, 400, 450, 500];

/** Standard tolerance grades IT3..IT14 (µm) per main range. */
const IT: Record<number, number[]> = {
  3: [2, 2.5, 2.5, 3, 4, 4, 5, 6, 8, 10, 12, 13, 15],
  4: [3, 4, 4, 5, 6, 7, 8, 10, 12, 14, 16, 18, 20],
  5: [4, 5, 6, 8, 9, 11, 13, 15, 18, 20, 23, 25, 27],
  6: [6, 8, 9, 11, 13, 16, 19, 22, 25, 29, 32, 36, 40],
  7: [10, 12, 15, 18, 21, 25, 30, 35, 40, 46, 52, 57, 63],
  8: [14, 18, 22, 27, 33, 39, 46, 54, 63, 72, 81, 89, 97],
  9: [25, 30, 36, 43, 52, 62, 74, 87, 100, 115, 130, 140, 155],
  10: [40, 48, 58, 70, 84, 100, 120, 140, 160, 185, 210, 230, 250],
  11: [60, 75, 90, 110, 130, 160, 190, 220, 250, 290, 320, 360, 400],
  12: [100, 120, 150, 180, 210, 250, 300, 350, 400, 460, 520, 570, 630],
  13: [140, 180, 220, 270, 330, 390, 460, 540, 630, 720, 810, 890, 970],
  14: [250, 300, 360, 430, 520, 620, 740, 870, 1000, 1150, 1300, 1400, 1550],
};

/** Shaft upper deviations es (µm) for d..h. */
const ES: Record<string, number[]> = {
  d: [-20, -30, -40, -50, -65, -80, -100, -120, -145, -170, -190, -210, -230],
  e: [-14, -20, -25, -32, -40, -50, -60, -72, -85, -100, -110, -125, -135],
  f: [-6, -10, -13, -16, -20, -25, -30, -36, -43, -50, -56, -62, -68],
  g: [-2, -4, -5, -6, -7, -9, -10, -12, -14, -15, -17, -18, -20],
  h: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
};

/** Shaft lower deviations ei (µm) for k (grades 4 to 7), m, n, p per main range. */
const EI: Record<string, number[]> = {
  k: [0, 1, 1, 1, 2, 2, 2, 3, 3, 4, 4, 4, 5],
  m: [2, 4, 6, 7, 8, 9, 11, 13, 15, 17, 20, 21, 23],
  n: [4, 8, 10, 12, 15, 17, 20, 23, 27, 31, 34, 37, 40],
  p: [6, 12, 15, 18, 22, 26, 32, 37, 43, 50, 56, 62, 68],
};
/** r and s per intermediate range. */
const EI2: Record<string, number[]> = {
  r: [10, 15, 19, 23, 28, 34, 41, 43, 51, 54, 63, 65, 68, 77, 80, 84, 94, 98, 108, 114, 126, 132],
  s: [14, 19, 23, 28, 35, 43, 53, 59, 71, 79, 92, 100, 108, 122, 130, 140, 158, 170, 190, 208, 232, 252],
};

const rangeOf = (bounds: number[], size: number) => bounds.findIndex(b => size <= b + 1e-9);

/** Every letter this table knows, for hints. */
export const FIT_LETTERS = { holes: ["D", "E", "F", "G", "H", "JS", "K", "M", "N", "P", "R", "S"], shafts: ["d", "e", "f", "g", "h", "js", "k", "m", "n", "p", "r", "s"] };

/** Splits "H7", "js6", "Js7" into letter + grade; null when it isn't one code. */
export function parseFit(code: string): { letter: string; hole: boolean; grade: number } | null {
  const m = /^\s*([A-Za-z]{1,2})\s*(\d{1,2})\s*$/.exec(code);
  if (!m) return null;
  let letter = m[1];
  const hole = letter[0] === letter[0].toUpperCase();
  letter = /^js$/i.test(letter) ? (hole ? "JS" : "js") : letter;
  if (letter.length === 2 && !/^js$/i.test(letter)) return null;
  return { letter, hole, grade: +m[2] };
}

/** Upper and lower deviation (mm) of a fit code at a nominal size, or null when the code or size is outside the table. */
export function fitLimits(code: string, size: number): { up: number; lo: number } | null {
  const p = parseFit(code);
  if (!p || !(size > 0) || size > 500) return null;
  const i = rangeOf(R, size), it = IT[p.grade]?.[i];
  if (it == null) return null;
  const l = p.letter.toLowerCase();
  const us = (v: number) => (Math.round(v) || 0) / 1000;
  if (l === "js") { const h = it % 2 && it > 1 ? (it - 1) / 2 : it / 2; return { up: us(h), lo: us(-h) }; }
  // Shaft deviations first, then holes mirror them (with Δ for K..S).
  if (!p.hole) {
    if (ES[l]) { const es = ES[l][i]; return { up: us(es), lo: us(es - it) }; }
    let ei: number | undefined;
    if (l === "k") ei = p.grade >= 4 && p.grade <= 7 ? EI.k[i] : 0;
    else if (EI[l]) ei = EI[l][i];
    else if (EI2[l]) ei = EI2[l][rangeOf(RI, size)];
    if (ei == null) return null;
    return { up: us(ei + it), lo: us(ei) };
  }
  if (ES[l]) { const ei = -ES[l][i]; return { up: us(ei + it), lo: us(ei) }; }
  // Δ = IT(n) − IT(n−1), 0 in the first range.
  const prev = IT[p.grade - 1]?.[i];
  const delta = i === 0 || prev == null ? 0 : it - prev;
  let es: number | undefined;
  if (l === "k") es = p.grade <= 8 ? -EI.k[i] + delta : 0;
  else if (l === "m") es = p.grade <= 8 ? -EI.m[i] + delta : -EI.m[i];
  else if (l === "n") es = p.grade <= 8 ? -EI.n[i] + delta : 0;
  else if (l === "p") es = p.grade <= 7 ? -EI.p[i] + delta : -EI.p[i];
  else if (EI2[l]) { const e = EI2[l][rangeOf(RI, size)]; es = p.grade <= 7 ? -e + delta : -e; }
  if (es == null) return null;
  return { up: us(es), lo: us(es - it) };
}

/** "H7/g6" → the hole and shaft codes; a single code gives itself as `hole` or `shaft`. */
export function splitFit(fit: string): { hole?: string; shaft?: string } {
  const [a, b] = fit.split("/").map(s => s.trim());
  if (b != null) return { hole: a, shaft: b };
  const p = parseFit(a ?? "");
  return p?.hole ? { hole: a } : p ? { shaft: a } : {};
}
