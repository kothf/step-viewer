// MöbiusCAD's own thermal package (FRS-thermal FR-TREP-010): written in the section 15.2 layout and read back
// by the board thermal map reader.
import { test } from "node:test";
import assert from "node:assert/strict";
import { unzipLimited, zip } from "../../src/model/zip";
import { CSV_HEAD, manifestText, packageFiles, partBoxes, sourcesCsv, type ExportPart } from "../../src/thermal/export";
import { partStats, readPackage, readSources } from "../../src/thermal/package";
import type { ThermalMesh } from "../../src/thermal/vtu";

function mesh(): ThermalMesh {
  // a board square (part 0, top face) and two parts with a triangle each
  const pos = new Float32Array([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0, 2, 2, 1, 4, 2, 1, 4, 4, 3, 6, 6, 1, 8, 6, 1, 8, 8, 2]);
  const temp = new Float32Array([40, 45.5, 60.25, 42, 120, 121, 131.125, 70, 71, 72.5]);
  const part = new Int32Array([0, 0, 3, 4]);
  return { pos, temp, tri: new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 7, 8, 9]), part, face: new Int8Array([1, 1, 0, 0]), power: new Float32Array([0, 0, 3.1, 0.5]), ambient: 40, range: [40, 131.125] };
}

const PARTS: ExportPart[] = [
  { id: 3, designator: "R14", bodies: ["R14"], p: 3.1, t: 131.125, limit: 155, path: "board" },
  { id: 4, designator: "C12, can", bodies: ["C12", "C12-2"], p: 0.5, t: 72.5 },
];

test("thermal export: heat-source table and boxes", () => {
  const m = mesh(), boxes = partBoxes(m);
  assert.deepEqual(boxes.get(3), [2, 2, 1, 4, 4, 3]);
  assert.deepEqual(boxes.get(0), [0, 0, 0, 10, 10, 0]);
  const parts = PARTS.map(p => ({ ...p, box: boxes.get(p.id) }));
  const csv = sourcesCsv(parts), lines = csv.trim().split("\n");
  assert.equal(lines[0], CSV_HEAD);
  // largest power first; a name with a comma is quoted; the box is written as centre and size
  assert.ok(lines[1].startsWith("3,R14,R14,,board,,3,3,2,2,2,2,"), lines[1]);
  assert.ok(lines[2].startsWith('4,"C12, can",C12;C12-2,'), lines[2]);
  const back = readSources(csv);
  assert.equal(back.length, 2);
  const r = back.find(x => x.id === 3)!;
  assert.equal(r.p, 3.1); assert.equal(r.t, 131.125); assert.equal(r.limit, 155); assert.equal(r.margin, 155 - 131.125);
  assert.deepEqual(r.box, [2, 2, 1, 4, 4, 3]);
  const j = JSON.parse(manifestText({ name: "x", design: "Amp", app: "MöbiusCAD test", created: "2026-11-22T00:00:00Z", mesh: m, parts, settings: { ambient: 40 } }, { mesh: "x-thermal.vtu" }));
  assert.equal(j.format, "mobiuscad-thermal"); assert.equal(j.version, 1);
  assert.deepEqual(j.range_C, [40, 131.125]);
  assert.equal(j.settings.ambient_C, 40);
  assert.deepEqual(j.parts[1].step_bodies, ["C12", "C12-2"]);
});

test("thermal export: the zip opens again as a thermal map with the same values", async () => {
  const m = mesh(), boxes = partBoxes(m);
  const parts = PARTS.map(p => ({ ...p, box: boxes.get(p.id) }));
  for (const encoding of ["ascii", "zlib"] as const) {
    const files = await packageFiles({ name: "Amp: study/1", design: "Amp", app: "MöbiusCAD test", created: "2026-11-22T00:00:00Z", mesh: m, parts, settings: { ambient: 40, enclosure: "closed" }, study: { name: "Thermal 1", kind: "steady" }, picture: new Uint8Array([137, 80, 78, 71]), vtu: { encoding } });
    // file names are safe and follow the package layout
    assert.deepEqual(files.map(f => f.name), ["Amp_ study_1-thermal.vtu", "Amp_ study_1-heat-sources.csv", "Amp_ study_1-thermal.png", "Amp_ study_1-thermal.json", "README-thermal.txt"]);
    const bytes = await zip(files);
    const pk = await readPackage(await unzipLimited(bytes.buffer as ArrayBuffer), "fallback");
    assert.equal(pk.name, "Amp_ study_1");
    assert.equal(pk.manifest.format, "mobiuscad-thermal");
    assert.equal(pk.manifest.settings.ambient, 40);
    assert.equal(pk.manifest.settings.enclosure, "closed");
    assert.deepEqual(pk.manifest.parts.map(p => p.id), [3, 4]);
    assert.deepEqual(pk.manifest.parts[1].bodies, ["C12", "C12-2"]);
    assert.ok(pk.picture && pk.picture.length === 4);
    assert.deepEqual([...pk.mesh.part], [0, 0, 3, 4]);
    assert.deepEqual([...pk.mesh.face!], [1, 1, 0, 0]);
    for (let i = 0; i < m.temp.length; i++) assert.ok(Math.abs(pk.mesh.temp[i] - m.temp[i]) < 1e-3);
    const stats = partStats(pk.mesh);
    assert.ok(Math.abs(stats.get(3)!.max - 131.125) < 1e-3);
    assert.equal(pk.mesh.power![2], Math.fround(3.1));
    assert.equal(pk.notes.length, 0);
  }
});
