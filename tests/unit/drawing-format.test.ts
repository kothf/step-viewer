// User sheet formats (FR-DRW-004): a title block laid out by the user, with a logo, kept on the sheet and in a library.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deleteFormat, formatFile, loadFormats, saveFormat, validFormat } from "../../src/drawing/formats";
import { fieldAt, formatPrims, isoFormat, tbSize, titleBlockAt, type Fields } from "../../src/drawing/sheet";
import { drawnSymbols, sheetDxf, svgBody } from "../../src/drawing/output";
import type { Sheet, TitleFormat } from "../../src/drawing/types";
import type { Prim } from "../../src/drawing/prims";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const fields = { title: "Bracket", number: "BR-001", revision: "A", material: "", mass: "", company: "ACME", author: "AD", checked: "", approved: "", date: "", tcontrol: "", ncontrol: "", litera: "", scale: "1:1", sheet: "1/1", size: "A3", units: "mm" } as Fields;
const tb: TitleFormat = { id: "f1", name: "Mine", w: 120, h: 30, logo: { src: PNG, x: 1, y: 1, w: 28, h: 28 },
  cells: [{ x: 30, y: 15, w: 90, h: 15, key: "title", label: "Title", big: true }, { x: 30, y: 0, w: 50, h: 15, key: "number", label: "Drawing number" }, { x: 80, y: 0, w: 40, h: 15, key: "projection" }] };
const sheet = { id: "s", name: "Sheet1", size: "A3", scale: [1, 1], projection: "first", format: "iso", views: [], tb } as unknown as Sheet;

test("a user title block replaces the ISO one: its size, fields, logo and projection symbol", () => {
  assert.deepEqual(tbSize(sheet), [120, 30]);
  const [bx, by] = titleBlockAt(sheet);
  assert.equal(fieldAt(sheet, bx + 60, by + 20), "title");
  assert.equal(fieldAt(sheet, bx + 40, by + 5), "number");
  assert.equal(fieldAt(sheet, bx + 100, by + 5), null, "the projection cell is not a field");
  const prims = formatPrims(sheet, fields, s => s);
  const texts = prims.filter(p => p.t === "t").map(p => (p as { s: string }).s);
  for (const s of ["Bracket", "BR-001", "Title", "Drawing number", "First angle projection"]) assert.ok(texts.includes(s), s);
  assert.ok(!texts.includes("ACME"), "fields without a cell are not shown");
  const img = prims.find(p => p.t === "i");
  assert.ok(img && img.t === "i" && img.x === bx + 1 && img.w === 28);
  assert.match(svgBody(prims, 297), /<image [^>]*href="data:image\/png;base64,/);
  assert.ok(!/IMAGE|data:image/.test(sheetDxf(prims, 420, 297)), "DXF leaves the logo out");
  // Without it the ISO block is back, with the same projection caption.
  const iso = formatPrims({ ...sheet, tb: undefined }, fields, s => s).filter(p => p.t === "t").map(p => (p as { s: string }).s);
  assert.ok(iso.includes("ACME") && iso.includes("First angle projection"));
});

test("formats from files are checked: bad cells and logos are dropped, junk is refused", () => {
  assert.equal(validFormat(null), null);
  assert.equal(validFormat({ w: 5, h: 30, cells: [] }), null, "too narrow");
  const f = validFormat({ name: "X", w: 100, h: 20, cells: [{ x: 0, y: 0, w: 50, h: 10, key: "title" }, { x: 90, y: 0, w: 50, h: 10 }, { x: 0, y: 10, w: 10, h: 10, key: "evil" }], logo: { src: "javascript:alert(1)", x: 0, y: 0, w: 10, h: 10 } })!;
  assert.equal(f.cells.length, 2, "the cell past the right edge is dropped");
  assert.equal(f.cells[1].key, undefined, "unknown keys are dropped");
  assert.equal(f.logo, undefined);
  assert.ok(f.id.startsWith("fmt_"));
  // The ISO block as a format round-trips through a file.
  const iso = validFormat(JSON.parse(formatFile({ ...isoFormat(), id: "iso1" })))!;
  assert.equal(iso.cells.length, isoFormat().cells.length);
  assert.ok(iso.cells.some(c => c.key === "projection"));
});

test("the library keeps formats in the browser", () => {
  const mem = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); } };
  try {
    assert.deepEqual(loadFormats(), []);
    assert.ok(saveFormat(tb));
    assert.ok(saveFormat({ ...tb, name: "Mine 2" }), "same id replaces");
    assert.deepEqual(loadFormats().map(f => f.name), ["Mine 2"]);
    assert.equal(loadFormats()[0].logo?.src, PNG);
    deleteFormat("f1");
    assert.deepEqual(loadFormats(), []);
  } finally { delete (globalThis as { localStorage?: unknown }).localStorage; }
});

test("counterbore and countersink symbols are drawn in lines for PDF, PNG and DXF (drawings exam #7)", () => {
  const out = drawnSymbols([{ t: "t", x: 10, y: 20, s: "⌴Ø11 ↧6.4", h: 3.5, al: "l", layer: "ANNOT" }]);
  const lines = out.filter(p => p.t === "l"), texts = out.filter(p => p.t === "t") as Extract<Prim, { t: "t" }>[];
  assert.equal(lines.length, 3, "a cup: two sides and a floor");
  assert.equal(texts.length, 1);
  assert.equal(texts[0].s, "Ø11 ↧6.4");
  assert.ok(Math.abs(texts[0].x - (10 + 0.95 * 3.5)) < 1e-9 && texts[0].y === 20, "the text starts after the symbol");
  const cs = drawnSymbols([{ t: "t", x: 0, y: 0, s: "⌵Ø13.44 × 90°", h: 3.5, al: "c", layer: "ANNOT", rot: 90 }]);
  assert.equal(cs.filter(p => p.t === "l").length, 2, "a V");
  const t = cs.find(p => p.t === "t") as Extract<Prim, { t: "t" }>;
  assert.ok(Math.abs(t.x) < 1e-9 && t.y < 0 && t.rot === 90 && t.al === "l", "centred and turned with the text");
  const plain: Prim[] = [{ t: "t", x: 0, y: 0, s: "Ø20", h: 3.5, al: "l", layer: "ANNOT" }];
  assert.equal(drawnSymbols(plain), plain);
  assert.ok(!/⌴/.test(sheetDxf([{ t: "t", x: 10, y: 20, s: "⌴Ø11", h: 3.5, al: "l", layer: "ANNOT" }], 420, 297)));
});

test("DXF R12 writes text outside ASCII as \\U+XXXX, like DXF 2000 (drawings exam #8)", () => {
  const dxf = sheetDxf([{ t: "t", x: 10, y: 20, s: "Ø20 ±0.1 Вид А", h: 3.5, al: "l", layer: "ANNOT" }], 420, 297);
  assert.ok(dxf.includes("\\U+00D820 \\U+00B10.1 \\U+0412\\U+0438\\U+0434 \\U+0410"), dxf.split("\n").find(l => l.includes("20 ")));
  assert.ok(!/[^\x00-\x7e]/.test(dxf), "pure ASCII file");
});
