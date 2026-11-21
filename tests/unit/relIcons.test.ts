// Sketch relation icons: every relation type has a drawing (the Record type makes it a compile error to miss one),
// each different, and the SVG is decorative and themable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { REL_ICON_KINDS, relIcon } from "../../src/sketch/relIcons";

test("every relation has its own icon", () => {
  const seen = new Set<string>();
  assert.ok(REL_ICON_KINDS.length >= 23);
  for (const k of REL_ICON_KINDS) {
    const svg = relIcon(k as never);
    assert.match(svg, /^<svg [^>]*aria-hidden="true"/);
    assert.match(svg, /stroke="currentColor"/);
    assert.ok(!seen.has(svg), `${k} differs from the others`);
    seen.add(svg);
  }
});

test("size and class are applied", () => {
  const svg = relIcon("tangent", 12, "x");
  assert.match(svg, /class="x" width="12" height="12"/);
  for (const k of ["edge", "merge", "alongX", "alongY", "alongZ", "parallelPlane"] as const) assert.ok(relIcon(k).includes("<path") || relIcon(k).includes("<circle"));
});
