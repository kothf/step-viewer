// A plain .vtu from another tool (FRS-thermal FR-TPKG-014): no manifest, the temperature under another name
// (or in kelvin), no PartId, polygon cells.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readPackage } from "../../src/thermal/package";
import { isKelvin, piecesOf, readVtu, ThermalError } from "../../src/thermal/vtu";

/** Two separate squares (quads), the second a polygon cell, with the given point arrays. */
function plain(arrays: Record<string, number[]>, partId = false) {
  const pts = [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0, 20, 0, 5, 30, 0, 5, 30, 10, 5, 20, 10, 5];
  const da = (name: string, v: number[], type = "Float32", comps = 1) =>
    `<DataArray type="${type}" Name="${name}" NumberOfComponents="${comps}" format="ascii">${v.join(" ")}</DataArray>`;
  return `<?xml version="1.0"?>
<VTKFile type="UnstructuredGrid" version="1.0" byte_order="LittleEndian">
<UnstructuredGrid><Piece NumberOfPoints="8" NumberOfCells="2">
<PointData>${Object.entries(arrays).map(([n, v]) => da(n, v)).join("")}${da("Normals", new Array(24).fill(0), "Float32", 3)}</PointData>
<CellData>${partId ? da("PartId", [3, 4], "Int32") : ""}</CellData>
<Points>${da("Points", pts, "Float32", 3)}</Points>
<Cells>${da("connectivity", [0, 1, 2, 3, 4, 5, 6, 7], "Int32")}${da("offsets", [4, 8], "Int32")}${da("types", [9, 7], "UInt8")}</Cells>
</Piece></UnstructuredGrid></VTKFile>`;
}
const T = [20, 21, 22, 23, 50, 55, 60, 65];

test("the only one-component point array is the temperature; no PartId = connected pieces", async () => {
  const m = await readVtu(plain({ T_surface: T }));
  assert.equal(m.field, "T_surface");
  assert.equal(m.pieces, true);
  assert.equal(m.tri.length / 3, 4, "a quad and a 4-point polygon give two triangles each");
  assert.deepEqual([...m.part], [1, 1, 2, 2]);
  assert.deepEqual(m.range, [20, 65]);
});

test("a name ending in K is kelvin", async () => {
  assert.ok(isKelvin("T_K") && isKelvin("Temperature [K]") && isKelvin("temp(K)") && isKelvin("Kelvin"));
  assert.ok(!isKelvin("Temperature") && !isKelvin("Peak") && !isKelvin("TK1"));
  const m = await readVtu(plain({ T_K: T.map(x => x + 273.15) }));
  assert.equal(m.kelvin, true);
  assert.ok(Math.abs(m.range[0] - 20) < 1e-3 && Math.abs(m.range[1] - 65) < 1e-3);
});

test("several arrays: the one that says temperature wins, else the reader asks", async () => {
  const m = await readVtu(plain({ Pressure: T, NodalTemperature: T }));
  assert.equal(m.field, "NodalTemperature");
  await assert.rejects(readVtu(plain({ A: T, B: T })), (e: unknown) => e instanceof ThermalError && e.code === "E-TH-FIELD" && e.params.list === "A\nB");
  const b = await readVtu(plain({ A: T, B: T.map(x => x * 2) }), { field: "B" });
  assert.equal(b.field, "B");
  assert.equal(b.range[1], 130);
  await assert.rejects(readVtu(plain({})), (e: unknown) => e instanceof ThermalError && e.code === "E-TH-VTU");
});

test("a PartId array still names the parts; Temperature_C needs no note", async () => {
  const m = await readVtu(plain({ Temperature_C: T, Other: T }, true));
  assert.equal(m.field, undefined);
  assert.equal(m.pieces, undefined);
  assert.deepEqual([...m.part], [3, 3, 4, 4]);
});

test("a lone plain .vtu opens as a package with unnamed parts and says where the temperatures came from", async () => {
  const pkg = await readPackage(new Map([["other-tool.vtu", new TextEncoder().encode(plain({ temp: T }))]]), "x");
  assert.equal(pkg.name, "other-tool");
  assert.deepEqual(pkg.manifest.parts.map(p => p.designator), ["#1", "#2"]);
  assert.deepEqual(pkg.notes.map(n => n.text), ["Temperatures read from the array {name}.", "The file names no parts: each connected piece of its surfaces is a part ({n})."]);
  const asked = await readPackage(new Map([["y.vtu", new TextEncoder().encode(plain({ A: T, B: T }))]]), "y", { field: "A" });
  assert.equal(asked.mesh.field, "A");
});

test("pieces are numbered largest first", () => {
  // piece of one triangle (points 0-2), piece of two (points 3-6)
  const p = piecesOf(new Uint32Array([0, 1, 2, 3, 4, 5, 4, 5, 6]), 7);
  assert.deepEqual([...p], [2, 1, 1]);
});
