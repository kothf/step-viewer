// Hover cursor glyphs (FR-SEL-012): which glyph a snap or sketch hit gets, and the cursor values.
import { test } from "node:test";
import assert from "node:assert/strict";
import { HOVER_KINDS, hoverCursor, hoverKindOfSketch, hoverKindOfSnap, hoverSvg } from "../../src/hoverCursor";

test("snap kinds map to face, edge, vertex or point", () => {
  assert.equal(hoverKindOfSnap("onFace"), "face");
  assert.equal(hoverKindOfSnap("onCap"), "face");
  assert.equal(hoverKindOfSnap("onEdge"), "edge");
  assert.equal(hoverKindOfSnap("vertex"), "vertex");
  for (const k of ["midpoint", "quadrant", "intersection", "circleCenter", "faceCenter"]) assert.equal(hoverKindOfSnap(k), "point");
  assert.equal(hoverKindOfSnap(null), null);
  assert.equal(hoverKindOfSnap("other"), null);
});

test("sketch hits: points and the origin are points, curves are sketch entities, dimensions none", () => {
  assert.equal(hoverKindOfSketch("point"), "point");
  assert.equal(hoverKindOfSketch("origin"), "point");
  for (const k of ["line", "arc", "circle", "spline", "ellipse", "curve"]) assert.equal(hoverKindOfSketch(k), "sketch");
  assert.equal(hoverKindOfSketch("dim"), null);
  assert.equal(hoverKindOfSketch("rel"), null);
  assert.equal(hoverKindOfSketch(null), null);
});

test("every kind has its own SVG cursor with the hot spot at the arrow tip", () => {
  const seen = new Set<string>();
  for (const k of HOVER_KINDS) {
    const svg = hoverSvg(k);
    assert.match(svg, /^<svg [^>]*width="28" height="28"/);
    seen.add(svg);
    const c = hoverCursor(k);
    assert.match(c, /^url\("data:image\/svg\+xml,[^"]+"\) 1 1, default$/);
    assert.equal(decodeURIComponent(c.slice(c.indexOf(",") + 1, c.indexOf('")'))), svg);
  }
  assert.equal(seen.size, HOVER_KINDS.length);
});
