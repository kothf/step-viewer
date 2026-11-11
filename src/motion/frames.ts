// Image sequence export of a motion study (CAD app Save Animation → series of images).

/** File name of frame i (0-based) of n: zero-padded to at least 4 digits so the names sort in order. */
export function frameName(base: string, i: number, n: number) {
  const w = Math.max(4, String(Math.max(1, n)).length);
  return `${base}_${String(i + 1).padStart(w, "0")}.png`;
}

/** Frames rendered for a study of `duration` s at `fps`: one per frame step, both ends included. */
export function frameTimes(duration: number, fps: number) {
  const n = Math.max(1, Math.round(duration * fps)) + 1;
  return Array.from({ length: n }, (_, i) => Math.min(duration, i / fps));
}
