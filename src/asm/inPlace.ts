// Insert part in place (FR-ASM-031): the pure pieces (names, whether a new part has anything in it).
import type { PartDoc } from "../model/types";

/** Whether a new part has anything in it: a feature other than an empty sketch. */
export function hasContent(pd: PartDoc) {
  return pd.features.some(f => f.type !== "sketch" || f.ents.length > 0 || (f.pictures?.length ?? 0) > 0);
}

/** Part1, Part2…: the first name not in `used` (lower case). */
export function nextPartName(used: Set<string>) {
  let n = 1;
  while (used.has(`part${n}`)) n++;
  return `Part${n}`;
}

/** Characters a file name cannot hold on the systems people save to. */
export const BAD_FILE_CHARS = /[\\/:*?"<>|]/;
