// Curve through XYZ points (FR-FT-085): reading points from a CSV or text file.
import type { V3 } from "./types";

/**
 * Points from text, one per line: x, y, z separated by commas, semicolons, tabs or spaces. With
 * semicolons a comma is the decimal mark. Lines without three numbers (headers, comments) are skipped;
 * two numbers give z = 0. Values are scaled by `scale` (to millimetres).
 */
export function parseXyz(text: string, scale = 1): V3[] {
  const out: V3[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const parts = line.includes(";") ? line.split(";").map(x => x.trim().replace(",", ".")) : line.split(/[\s,]+/);
    const nums = parts.filter(Boolean).map(Number);
    if (nums.length < 2 || nums.slice(0, Math.min(3, nums.length)).some(v => !Number.isFinite(v))) continue;
    out.push([nums[0] * scale, nums[1] * scale, (nums.length >= 3 ? nums[2] : 0) * scale]);
  }
  return out;
}
