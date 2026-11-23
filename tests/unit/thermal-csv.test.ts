// CSV exports of thermal results (FRS-thermal FR-TREP-011): Parts list and heat balance.
import { test } from "node:test";
import assert from "node:assert/strict";
import { balanceCsv, BALANCE_HEAD, csvText, partsCsv, PARTS_HEAD } from "../../src/thermal/csv";
import type { PartStat, ThermalPart } from "../../src/thermal/package";

const parse = (text: string) => text.trimEnd().split("\r\n").map(l => {
  const out: string[] = []; let cur = "", q = false;
  for (let i = 0; i < l.length; i++) {
    const c = l[i];
    if (q) { if (c === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c;
  }
  out.push(cur); return out;
});

test("cells with commas and quotes are quoted, empty for missing or non-finite values", () => {
  assert.equal(csvText([["a,b", 'say "hi"', null, NaN, 3]]), '"a,b","say ""hi""",,,3\r\n');
});

test("the Parts list keeps the given order and marks parts over their limit and missing ones", () => {
  const parts: ThermalPart[] = [
    { id: 2, designator: "R1", bodies: [], part: "470R, 5W", p: 2.5, limit: 100, path: "board" },
    { id: 3, designator: "C1", bodies: [], part: "100u", p: 0, t: 70, limit: 85, life: 12345.6 },
  ];
  const stats = new Map<number, PartStat>([[2, { tris: 4, min: 60, max: 112.4, at: [0, 0, 0], box: [0, 0, 0, 1, 1, 1] }], [3, { tris: 4, min: 50, max: 72, at: [0, 0, 0], box: [0, 0, 0, 1, 1, 1] }]]);
  const rows = parse(partsCsv(parts, stats, { missing: [3] }));
  assert.deepEqual(rows[0], PARTS_HEAD);
  assert.deepEqual(rows[1], ["R1", "470R, 5W", "2.5", "112.4", "60", "100", "-12.4", "", "board", "over limit"]);
  // the package's own temperature wins over the map's highest
  assert.deepEqual(rows[2], ["C1", "100u", "0", "70", "50", "85", "15", "12346", "", "not in the model"]);
});

test("the heat balance lists what goes in, what each item takes away, the balance, contacts and components", () => {
  const rows = parse(balanceCsv({
    applied: 10,
    flows: [{ name: "Convection 1", out: 6, area: 1200, mean: 55.5, h: 8e-6 }, { name: "Temperature 1", out: 3.9, area: 100, mean: 25 }],
    contacts: [{ a: "Board", b: "Heatsink", heat: 4, area: 300, ta: 60, tb: 58 }],
    comps: [{ name: "Board", power: 10, min: 40, max: 70, mean: 55 }],
  }));
  assert.deepEqual(rows[0], BALANCE_HEAD);
  assert.deepEqual(rows[1].slice(0, 3), ["Heat put in", "Total", "10"]);
  assert.deepEqual(rows[2], ["Heat taken away", "Convection 1", "6", "55.5", "", "1200", "8"]);
  assert.deepEqual(rows[4].slice(0, 3), ["Heat taken away", "Total", "9.9"]);
  assert.equal(rows[5][0], "Out of balance (%)");
  assert.ok(Math.abs(Number(rows[5][2]) - 1) < 1e-9);
  assert.deepEqual(rows[6].slice(0, 4), ["Contact", "Board -> Heatsink", "4", "60 -> 58"]);
  assert.deepEqual(rows[7].slice(0, 5), ["Component", "Board", "10", "55", "70"]);
});
