// Mate type labels and new mate names (pure, for the unit tests).
import type { MateType } from "./types";

export const MATE_LABEL: Record<MateType, string> = { coincident: "Coincident", parallel: "Parallel", perpendicular: "Perpendicular", tangent: "Tangent", concentric: "Concentric", lock: "Lock", distance: "Distance", angle: "Angle", symmetric: "Symmetric", width: "Width", limitdist: "Limit distance", limitangle: "Limit angle", hinge: "Hinge", slot: "Slot", gear: "Gear", screw: "Screw" };

/**
 * A new mate's name: its type's label and one past the highest number in use for it (exam #79). Counting the mates
 * of the type gave a name still in use once one had been deleted (two "Lock23"s).
 */
export function mateName(mates: readonly { name: string }[], type: MateType, taken: ReadonlySet<string> = new Set()): string {
  const label = MATE_LABEL[type].replace(/ (\w)/g, (_, c: string) => c.toUpperCase());
  const re = new RegExp(`^${label}(\\d+)$`);
  let n = 0;
  for (const x of [...mates.map(m => m.name), ...taken]) { const k = re.exec(x); if (k) n = Math.max(n, Number(k[1])); }
  return `${label}${n + 1}`;
}
