// Analysis progress (FR-SOL-023): the solver says which stage it is in and how far, the worker passes that to the
// page, which shows it in the status bar. One sink at a time (the worker runs one solve at a time); with no sink
// a report costs one comparison.

/** The stages of a pass, in the order they run. */
export type SimStage = "geometry" | "cells" | "assemble" | "factor" | "solve" | "modes" | "time" | "results";
export interface SimProgress {
  stage: SimStage;
  /** How far the stage is, 0..1 (−1 = not known). */
  frac: number;
  /** 1-based pass and the passes asked for (0 = not in a pass). */
  pass: number;
  of: number;
}

let sink: ((p: SimProgress) => void) | null = null;
let pass = 0, passes = 0, last = 0, lastStage = "";
const clock = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** Where reports go (null = nowhere). */
export function progressTo(f: ((p: SimProgress) => void) | null) { sink = f; pass = 0; passes = 0; last = 0; lastStage = ""; }
/** The pass being solved, for the reports that follow. */
export function progressPass(n: number, of: number) { pass = n; passes = of; }
/** A report: at most one every 80 ms within a stage, always when the stage changes. */
export function progress(stage: SimStage, done = -1, total = 1) {
  if (!sink) return;
  const t = clock();
  if (stage === lastStage && t - last < 80) return;
  last = t; lastStage = stage;
  sink({ stage, frac: done < 0 || !(total > 0) ? -1 : Math.min(1, done / total), pass, of: passes });
}

/** The share of a pass each stage usually takes: for one bar over the whole pass. */
const SHARE: Record<SimStage, [number, number]> = {
  geometry: [0, 0.02], cells: [0.02, 0.3], assemble: [0.3, 0.45], factor: [0.45, 0.9], solve: [0.9, 0.93], modes: [0.45, 0.95], time: [0.3, 0.97], results: [0.95, 1],
};
/** One number 0..1 for a whole run from a report (passes weigh more as the degree grows). */
export function overall(p: SimProgress): number {
  const [a, b] = SHARE[p.stage], inPass = a + (b - a) * (p.frac < 0 ? 0.5 : p.frac);
  if (!p.of) return inPass;
  // pass k of n takes about k² of the time
  const w = (k: number) => k * (k + 1) * (2 * k + 1) / 6, n = Math.max(p.of, p.pass);
  return Math.min(1, (w(p.pass - 1) + (w(p.pass) - w(p.pass - 1)) * inPass) / w(n));
}
