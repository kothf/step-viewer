// DXF to sketch (FR-SK-040, AT-P2-5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readDxf } from "../../src/sketch/dxf";

test("gasket outline: polyline with bulge corners, two circles, text skipped", () => {
  const r = readDxf(readFileSync("tests/fixtures/dxf/gasket.dxf", "utf8"));
  assert.equal(r.skipped, 1);
  const lines = r.shapes.filter(s => s.t === "line"), arcs = r.shapes.filter(s => s.t === "arc"), circles = r.shapes.filter(s => s.t === "circle");
  assert.equal(lines.length, 4);
  assert.equal(arcs.length, 4);
  assert.equal(circles.length, 2);
  for (const a of arcs) {
    if (a.t !== "arc") continue;
    assert.ok(Math.abs(a.r - 5) < 1e-6, `r ${a.r}`);
    assert.ok(Math.abs(Math.abs(a.c[0]) - 35) < 1e-6 && Math.abs(Math.abs(a.c[1]) - 20) < 1e-6, `c ${a.c}`);
    let sw = a.a1 - a.a0; while (sw <= 0) sw += 2 * Math.PI;
    assert.ok(Math.abs(sw - Math.PI / 2) < 1e-6, `sweep ${sw}`);
  }
});

test("units: inches scale to millimetres; ARC angles in degrees", () => {
  const dxf = ["0", "SECTION", "2", "HEADER", "9", "$INSUNITS", "70", "1", "0", "ENDSEC", "0", "SECTION", "2", "ENTITIES",
    "0", "ARC", "10", "1", "20", "0", "40", "2", "50", "0", "51", "90", "0", "LINE", "10", "0", "20", "0", "11", "1", "21", "1", "0", "ENDSEC", "0", "EOF"].join("\n");
  const r = readDxf(dxf);
  assert.equal(r.scale, 25.4);
  const arc = r.shapes[0], line = r.shapes[1];
  assert.ok(arc.t === "arc" && Math.abs(arc.r - 50.8) < 1e-9 && Math.abs(arc.c[0] - 25.4) < 1e-9 && Math.abs(arc.a1 - Math.PI / 2) < 1e-12);
  assert.ok(line.t === "line" && Math.abs(line.b[1] - 25.4) < 1e-9);
});
