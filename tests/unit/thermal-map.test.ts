// Board thermal maps (FRS-thermal section 7, 15.2): the package reader, part matching and checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { unzipLimited } from "../../src/model/zip";
import { matchParts, misfit, paletteColor, triWeights, type ModelBody } from "../../src/thermal/match";
import { byMargin, capacitorLife, csvRows, findManifest, partStats, problems, readManifest, readPackage, readSources, summary } from "../../src/thermal/package";
import { readVtu, ThermalError, writeVtu, type ThermalMesh } from "../../src/thermal/vtu";

const enc = new TextEncoder();
function small(): ThermalMesh {
  // a board square (part 0) and a part triangle pair (part 1)
  const pos = new Float32Array([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0, 2, 2, 1, 4, 2, 1, 4, 4, 1.5, 2, 4, 1.25]);
  const temp = new Float32Array([40, 45.5, 60.25, 42, 120, 121, 131.125, 119]);
  return { pos, temp, tri: new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]), part: new Int32Array([0, 0, 1, 1]), face: new Int8Array([1, 1, 0, 0]), power: new Float32Array([0, 0, 3.1, 3.1]), flux: new Float32Array([120, 80, 0, 0]), ambient: 40, gridStep: 1, range: [40, 131.125] };
}
const same = (a: ThermalMesh, b: ThermalMesh) => {
  assert.deepEqual([...a.pos], [...b.pos]);
  assert.deepEqual([...a.temp], [...b.temp]);
  assert.deepEqual([...a.tri], [...b.tri]);
  assert.deepEqual([...a.part], [...b.part]);
  assert.deepEqual([...a.face!], [...b.face!]);
  assert.deepEqual([...a.power!], [...b.power!]);
  assert.deepEqual([...a.flux!], [...b.flux!]);
  assert.equal(a.ambient, b.ambient);
  assert.equal(a.gridStep, b.gridStep);
  assert.deepEqual(a.range, b.range);
};

test("vtu: ascii, binary and compressed forms of one map read the same (AT-TH1-7)", async () => {
  const m = small();
  for (const encoding of ["ascii", "binary", "zlib"] as const) for (const header of [4, 8] as const) {
    const text = await writeVtu(m, { encoding, header, block: 16 });
    same(await readVtu(text), m);
    same(await readVtu(enc.encode(text)), m);
  }
});

test("vtu: quads are split a-b-c / a-c-d and keep their cell data", async () => {
  const text = `<?xml version="1.0"?><VTKFile type="UnstructuredGrid" version="1.0" byte_order="LittleEndian"><UnstructuredGrid><Piece NumberOfPoints="4" NumberOfCells="1">
<Points><DataArray type="Float32" NumberOfComponents="3" format="ascii">0 0 0 1 0 0 1 1 0 0 1 0</DataArray></Points>
<Cells><DataArray type="Int32" Name="connectivity" format="ascii">0 1 2 3</DataArray><DataArray type="Int32" Name="offsets" format="ascii">4</DataArray><DataArray type="UInt8" Name="types" format="ascii">9</DataArray></Cells>
<PointData><DataArray type="Float32" Name="Temperature_C" format="ascii">40 41 42 43</DataArray></PointData>
<CellData><DataArray type="Int32" Name="PartId" format="ascii">7</DataArray></CellData></Piece></UnstructuredGrid></VTKFile>`;
  const m = await readVtu(text);
  assert.deepEqual([...m.tri], [0, 1, 2, 0, 2, 3]);
  assert.deepEqual([...m.part], [7, 7]);
  assert.deepEqual(m.range, [40, 43]);
  assert.equal(m.face, undefined);
});

test("vtu: malformed files are refused with a reason (AT-TH1-9)", async () => {
  const good = await writeVtu(small(), { encoding: "ascii" });
  const refused = async (text: string, what: RegExp) => {
    await assert.rejects(() => readVtu(text), (e: unknown) => e instanceof ThermalError && e.code === "E-TH-VTU" && what.test(e.message), text.slice(0, 40));
  };
  await refused("hello", /not a VTK XML/);
  await refused(good.slice(0, good.length / 2), /cut short|missing/);
  await refused(good.replace('Name="Temperature_C"', 'Name="Temp"'), /Temperature_C is missing/);
  await refused(good.replace(/(Name="offsets" format="ascii">)3 6/, "$19 6"), /past the end|type/);
  await refused(good.replace(/(Name="connectivity" format="ascii">)0 1 2/, "$10 1 99"), /does not exist/);
  await refused(good.replace('type="UnstructuredGrid"', 'type="PolyData"'), /PolyData/);
  await refused(good.replace('byte_order="LittleEndian"', 'byte_order="BigEndian"'), /big-endian/);
  const bin = await writeVtu(small(), { encoding: "binary" });
  await refused(bin.replace(/(Name="Temperature_C" format="binary">)[A-Za-z0-9+/=]{12}/, "$1AAAAAAAAAAAA"), /values|cut short|length/);
});

const MANIFEST = {
  format: "tubecad-thermal", version: 1, app: "Tube Amp CAD 3.24.0", created: "2026-11-21T20:00:00Z", design: "Test",
  files: { mesh: "t-thermal.vtu", sources: "t-heat-sources.csv" },
  settings: { ambient_C: 40, enclosure: "closed", operating_point: "dc", grid_mm: 1 }, accuracy_C: 15, range_C: [40, 182], future: [1, 2],
  parts: [{ part_id: 1, designator: "R14", step_bodies: ["R14"], bbox_mm: [2, 2, 1, 4, 4, 1.5], p_total_W: 3.1, t_body_C: 131, t_limit_C: 155, heat_path: "board", unknown: true }],
};
const CSV = `part_id,designator,step_bodies,part,heat_path,mount,x_mm,y_mm,z_mm,dx_mm,dy_mm,dz_mm,volume_mm3,p_total_W,p_board_W,p_air_W,p_sink_W,t_body_C,t_kind,t_limit_C,margin_C,life_h,source,extra
1,R14,R14,"470R, 5W",board,lying,3,3,1.25,2,2,0.5,2,9.9,1.6,1.5,0,131,body,155,24,,dc,x
4,C12,C12;C12-2,47u 450V,air,standing,60,55,18,16,16,32,6400,0.05,0,0.05,0,71,case,105,34,19000,dc,y
`;

test("manifest: read, unknown keys ignored, other formats and broken JSON refused", () => {
  const m = readManifest(JSON.stringify(MANIFEST));
  assert.equal(m.format, "tubecad-thermal");
  assert.equal(m.settings.ambient, 40);
  assert.equal(m.accuracy, 15);
  assert.deepEqual(m.range, [40, 182]);
  assert.equal(m.parts.length, 1);
  assert.equal(m.parts[0].margin, 24);
  assert.throws(() => readManifest("{"), (e: unknown) => e instanceof ThermalError && e.code === "E-TH-PKG");
  assert.throws(() => readManifest(JSON.stringify({ ...MANIFEST, format: "gerber" })), (e: unknown) => e instanceof ThermalError && e.code === "E-TH-PKG");
  // a newer version opens when it still names its mesh, else asks for a newer app
  assert.equal(readManifest(JSON.stringify({ ...MANIFEST, version: 2 })).newer, true);
  assert.throws(() => readManifest(JSON.stringify({ ...MANIFEST, version: 2, files: {} })), (e: unknown) => e instanceof ThermalError && e.code === "E-TH-VERSION");
  assert.equal(readManifest(JSON.stringify({ ...MANIFEST, format: "mobiuscad-thermal" })).format, "mobiuscad-thermal");
});

test("heat-source CSV: columns by name, quotes, several bodies", () => {
  assert.deepEqual(csvRows('a,"b ""c""",d\r\n1,,3\n'), [["a", 'b "c"', "d"], ["1", "", "3"]]);
  const rows = readSources(CSV);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].part, "470R, 5W");
  assert.deepEqual(rows[0].box, [2, 2, 1, 4, 4, 1.5]);
  assert.deepEqual(rows[1].bodies, ["C12", "C12-2"]);
  assert.equal(rows[1].life, 19000);
  assert.equal(rows[1].lifeBy, "package");
});

test("package: the manifest wins over the CSV, which fills what it lacks; a lone .vtu opens too", async () => {
  const vtu = enc.encode(await writeVtu(small(), { encoding: "zlib" }));
  const files = new Map<string, Uint8Array>([["sub/t-thermal.json", enc.encode(JSON.stringify(MANIFEST))], ["sub/t-thermal.vtu", vtu], ["sub/t-heat-sources.csv", enc.encode(CSV)], ["sub/t-thermal.png", new Uint8Array([1, 2, 3])]]);
  assert.ok(findManifest(files));
  const pk = await readPackage(files);
  assert.equal(pk.name, "t");
  assert.equal(pk.manifest.parts.length, 2);
  const r14 = pk.manifest.parts.find(p => p.id === 1)!;
  assert.equal(r14.p, 3.1, "the manifest's power, not the CSV's");
  assert.equal(r14.pBoard, 1.6, "from the CSV");
  assert.equal(r14.tKind, "body");
  assert.equal(pk.picture?.length, 3);
  assert.equal(pk.mesh.temp.length, 8);
  const lone = await readPackage(new Map([["x.vtu", vtu]]));
  assert.equal(lone.name, "x");
  assert.equal(lone.manifest.parts.length, 1, "the mesh's part 1, unnamed");
  assert.equal(lone.manifest.settings.ambient, 40, "from the field data");
  await assert.rejects(() => readPackage(new Map([["a.txt", enc.encode("x")]])), (e: unknown) => e instanceof ThermalError && e.code === "E-TH-PKG");
  await assert.rejects(() => readPackage(new Map([["t-thermal.json", enc.encode(JSON.stringify(MANIFEST))]])), /mesh file/);
});

test("checks: part statistics, problems, order by margin, summary, capacitor life", async () => {
  const pk = await readPackage(new Map<string, Uint8Array>([["t-thermal.json", enc.encode(JSON.stringify({ ...MANIFEST, parts: [
    { part_id: 1, designator: "R14", t_body_C: 162, t_limit_C: 155, p_total_W: 3, p_board_W: 2, p_air_W: 1 },
    { part_id: 2, designator: "C1", t_body_C: 88, t_limit_C: 105, life_h: 6500, p_total_W: 0.1, p_air_W: 0.1 },
    { part_id: 3, designator: "C2", t_body_C: 85, t_limit_C: 105, life_rated_h: 2000 },
    { part_id: 4, designator: "X", t_body_C: 50 },
  ] }))], ["t-thermal.vtu", enc.encode(await writeVtu(small()))]]));
  const st = partStats(pk.mesh);
  assert.equal(st.get(0)!.max, 60.25);
  assert.deepEqual(st.get(1)!.at, [4, 4, 1.5]);
  assert.deepEqual(st.get(1)!.box, [2, 2, 1, 4, 4, 1.5]);
  const c2 = pk.manifest.parts.find(p => p.id === 3)!;
  assert.equal(c2.life, 8000, "2000 h at 105 °C is 8000 h at 85 °C");
  assert.equal(c2.lifeBy, "computed");
  assert.equal(capacitorLife(2000, 105, 95), 4000);
  const pr = problems(pk, st);
  assert.deepEqual(pr.map(p => [p.kind, p.id]), [["over", 1], ["life", 2], ["life", 3]]);
  assert.deepEqual(problems(pk, st, { life: 7000, board: 50 }).map(p => [p.kind, p.id]), [["over", 1], ["life", 2], ["board", 0]]);
  assert.deepEqual(byMargin(pk.manifest.parts, st).map(p => p.designator), ["R14", "C1", "C2", "X"]);
  const s = summary(pk, st);
  assert.deepEqual(s.hottest, { id: 1, t: 162 });
  assert.equal(s.over, 1);
  assert.deepEqual(s.life, { id: 2, h: 6500 });
  assert.equal(s.board, 60.25);
  assert.ok(Math.abs(s.power - 3.1) < 1e-9);
  assert.equal(s.split.board, 2);
});

test("matching: by name, by box when the names are gone, and the fit of a moved map (AT-TH1-3)", async () => {
  const files = await unzipLimited(new Uint8Array(readFileSync("tests/fixtures/thermal/amp-thermal.zip")).buffer as ArrayBuffer);
  const pk = await readPackage(files);
  assert.equal(pk.name, "amp");
  assert.equal(pk.manifest.parts.length, 6);
  assert.equal(pk.manifest.design, "EL84 test board");
  const st = partStats(pk.mesh);
  const bodies: ModelBody[] = [{ name: "Board", box: [0, 0, 0, 120, 80, 1.6] }, ...pk.manifest.parts.map(p => ({ name: p.designator, box: p.box! })), { name: "Chassis", box: [-5, -5, -30, 125, 85, -28] }];
  const m = matchParts(pk.manifest.parts, st, bodies);
  assert.equal(m.missing.length, 0);
  assert.equal(m.bodies.size, 7);
  assert.ok([...m.by.values()].every(b => b === "name"));
  assert.ok(m.off < 1e-6 && !misfit(m));
  assert.deepEqual(m.bodies.get(0), [0]);
  // names removed: boxes find them
  const anon = matchParts(pk.manifest.parts, st, bodies.map(b => ({ ...b, name: "" })));
  assert.equal(anon.missing.length, 0);
  assert.ok([...anon.by.values()].every(b => b === "box"));
  assert.deepEqual(anon.bodies.get(2), [2]);
  // a model 3 mm off: named parts still match, the map does not fit, and the shift brings it back
  const moved = bodies.map(b => ({ name: b.name, box: [b.box[0] + 3, b.box[1], b.box[2], b.box[3] + 3, b.box[4], b.box[5]] as ModelBody["box"] }));
  const off = matchParts(pk.manifest.parts, st, moved);
  assert.ok(misfit(off));
  assert.ok(Math.abs(off.off - 3) < 1e-6);
  assert.ok(Math.abs(off.shift[0] - 3) < 0.1 && Math.abs(off.shift[1]) < 0.1 && Math.abs(off.shift[2]) < 0.1, "under 0.1 mm after the fit");
  assert.equal(off.changed.length, 0);
  // a part gone from the model, another made larger
  const edited = bodies.filter(b => b.name !== "Q2").map(b => (b.name === "R14" ? { ...b, box: [33, 26.75, 2, 63, 33.25, 8.5] as ModelBody["box"] } : b));
  const ed = matchParts(pk.manifest.parts, st, edited);
  assert.deepEqual(ed.missing, [3]);
  assert.deepEqual(ed.changed, [2]);
});

test("fixtures: the compressed package with its STEP inside reads like the plain one", async () => {
  const a = await readPackage(await unzipLimited(new Uint8Array(readFileSync("tests/fixtures/thermal/amp-thermal.zip")).buffer as ArrayBuffer));
  const b = await readPackage(await unzipLimited(new Uint8Array(readFileSync("tests/fixtures/thermal/amp-with-step-thermal.zip")).buffer as ArrayBuffer));
  assert.equal(b.step?.name, "amp.step");
  assert.ok(b.step!.data.length > 10000);
  assert.equal(a.step, undefined);
  assert.deepEqual([...a.mesh.tri], [...b.mesh.tri]);
  assert.equal(a.mesh.temp.length, b.mesh.temp.length);
  // ascii keeps 3 decimals of a temperature, the binary form all of them
  for (let i = 0; i < a.mesh.temp.length; i++) assert.ok(Math.abs(a.mesh.temp[i] - b.mesh.temp[i]) < 1e-3);
  assert.equal(problems(a, partStats(a.mesh)).length, 2, "R20 over its limit, C13 short-lived");
});

test("probe weights and colours", () => {
  const w = triWeights([1, 1, 0], [0, 0, 0], [4, 0, 0], [0, 4, 0]);
  assert.ok(Math.abs(w[0] - 0.5) < 1e-12 && Math.abs(w[1] - 0.25) < 1e-12 && Math.abs(w[2] - 0.25) < 1e-12);
  assert.deepEqual(triWeights([0, 0, 0], [0, 0, 0], [4, 0, 0], [0, 4, 0]), [1, 0, 0]);
  const c = [0, 0, 0], d = [0, 0, 0];
  paletteColor("heat", 0, c); paletteColor("heat", 1, d);
  assert.ok(c[0] + c[1] + c[2] < 0.5 && d[0] + d[1] + d[2] > 2.4, "dark = coolest, light = hottest");
  paletteColor("heat", NaN, c); paletteColor("heat", 5, d);
  assert.ok(c.every(Number.isFinite) && d[0] > 0.9);
});
