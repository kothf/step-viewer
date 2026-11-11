import { threadThrough, type HoleFeature } from "./types";

/**
 * Blind tap drill depth vs thread depth (SolidWorks' Automatically Calculate Depth): a tap cannot cut full
 * thread to the bottom of its drill, so the drill runs on past the thread. The automatic drill depth is the
 * thread depth plus half the thread's major diameter (M5: thread 10, drill 12.5); a drill shallower than
 * the thread plus two pitches (the tap's lead) is flagged.
 */

const r1 = (v: number) => Math.round(v * 10) / 10;

/** Holes whose blind drill must clear a thread: tapped (thread not through) and tapered taps. */
export function tapBlind(f: HoleFeature): boolean {
  return f.end === "blind" && (f.kind === "tapped" || f.kind === "ptap") && !threadThrough(f);
}

/** The thread depth as the panel shows it (absent = the panel's default). */
export function threadDepthOf(f: HoleFeature): number {
  return f.threadDepth?.v ?? (f.kind === "ptap" ? f.diameter.v : f.diameter.v * 2);
}

/** Size of the thread the overrun is measured from: the major diameter, else the tap drill. */
function threadDia(f: HoleFeature): number { return f.kind === "ptap" ? f.diameter.v : f.major ?? f.diameter.v; }

/** The automatic drill depth for a thread depth. */
export function autoTapDepth(f: HoleFeature, td = threadDepthOf(f)): number { return r1(td + threadDia(f) * 0.5); }

/** The shallowest drill that still leaves room for the tap's lead (two pitches; custom sizes: 0.3 × Ø). */
export function minTapDepth(f: HoleFeature, td = threadDepthOf(f)): number {
  return td + (f.pitch ? f.pitch * 2 : threadDia(f) * 0.3);
}

/** The drill is too shallow for the thread (null when the hole has no blind thread). */
export function tapTooShallow(f: HoleFeature): number | null {
  if (!tapBlind(f)) return null;
  const min = minTapDepth(f);
  return f.depth.v < min - 1e-9 ? min : null;
}

/** The drill depth is still the automatic one for the current thread depth (so it follows the thread). */
export function tapDepthLinked(f: HoleFeature): boolean {
  return tapBlind(f) && !f.depth.expr && Math.abs(f.depth.v - autoTapDepth(f)) < 1e-6;
}

/**
 * After a change: a linked drill depth follows the thread depth, and a drill too shallow for the thread
 * goes to the automatic depth. A deeper typed drill depth is kept.
 */
export function keepTapDepth(f: HoleFeature, linked: boolean): void {
  if (!tapBlind(f) || f.depth.expr) return;
  if (linked || f.depth.v < minTapDepth(f) - 1e-9) f.depth = { v: autoTapDepth(f) };
}
