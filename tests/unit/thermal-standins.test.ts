// A bare board STEP (as MöbiusCAD writes it from Gerbers) with a thermal package: the board found by its outline,
// and stand-in bodies made from the package boxes of the parts the STEP lacks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { unzipLimited } from "../../src/model/zip";
import { boardOnly, matchParts, misfit, partBox, type ModelBody } from "../../src/thermal/match";
import { partStats, readPackage } from "../../src/thermal/package";
import { boardPlan, GUESS } from "../../src/thermal/study";
import { looksRound, standInPart, standIns } from "../../src/thermal/standins";
import { gerberName } from "../../src/thermal/copper";
import { Modeller } from "../../src/kernel/model";
import { occ } from "./occ";

const amp = async () => readPackage(await unzipLimited(new Uint8Array(readFileSync("tests/fixtures/thermal/amp-thermal.zip")).buffer as ArrayBuffer));
// the board MöbiusCAD exports: centred on z = 0, named after the Gerber set
const bare: ModelBody[] = [{ name: "amp board", box: [0, 0, -0.8, 120, 80, 0.8] }];

test("the board of a bare board STEP is found by its outline and the package moves onto it", async () => {
  const pk = await amp(), st = partStats(pk.mesh);
  const m = matchParts(pk.manifest.parts, st, bare);
  assert.deepEqual(m.bodies.get(0), [0]);
  assert.equal(m.by.get(0), "plate");
  assert.deepEqual(m.missing, [1, 2, 3, 4, 5, 6]);
  assert.ok(Math.abs(m.shift[2] + 0.8) < 1e-3 && Math.abs(m.shift[0]) < 1e-3 && Math.abs(m.shift[1]) < 1e-3, `shift ${m.shift}`);
  assert.ok(boardOnly(m) && misfit(m), "fitted without asking although 0.8 mm off");
  // a plate of another outline is not the board; nor is a block
  assert.equal(matchParts(pk.manifest.parts, st, [{ name: "x", box: [0, 0, -0.8, 100, 80, 0.8] }]).bodies.size, 0);
  assert.equal(matchParts(pk.manifest.parts, st, [{ name: "x", box: [0, 0, 0, 120, 80, 20] }]).bodies.size, 0);
  // with parts found by name the plate pass stays out of it
  const named = matchParts(pk.manifest.parts, st, [...bare, { name: "R14", box: pk.manifest.parts[1].box! }]);
  assert.ok(!named.bodies.has(0) && !boardOnly(named));
});

test("stand-ins: one per missing part with a box, moved onto the model; tubes and capacitors round", async () => {
  const pk = await amp(), st = partStats(pk.mesh), byId = new Map(pk.manifest.parts.map(p => [p.id, p]));
  const m = matchParts(pk.manifest.parts, st, bare);
  const s = standIns(pk.manifest.parts, m.missing, id => partBox(byId.get(id) ?? null, id, st), m.shift);
  assert.deepEqual(s.map(x => x.name), ["V3", "R14", "Q2", "C12", "R20", "C13"]);
  assert.deepEqual(s.map(x => x.round), [true, false, false, true, false, true]);
  const v3 = s[0];
  assert.ok(Math.abs(v3.box[2] - 0.8) < 1e-3, "V3 stands on the board's top face");
  assert.ok(!looksRound({ designator: "R1", part: "1k", mount: "standing" }, [0, 0, 0, 10, 3, 3]), "not round from above");
  // a part with no box gets none; the board is never a stand-in
  assert.equal(standIns(pk.manifest.parts, [0, 2], () => null, [0, 0, 0]).length, 0);
  // the plan heats them through bodies after the file's own
  const plan = boardPlan(pk.manifest, m, bare, s);
  assert.equal(plan.board, 0);
  assert.deepEqual(plan.heat.map(h => h.bodies), [[1], [2], [3], [4], [5], [6]]);
  assert.ok(Math.abs(plan.power - 29.17) < 1e-6);
  assert.equal(plan.standMats?.[0], GUESS.glass);
  assert.equal(plan.standMats?.[1], GUESS.resistor);
  assert.equal(plan.stand?.length, 6);
});

test("a stand-in part builds to its box (block or cylinder) and its transform puts it there", async () => {
  const oc = await occ();
  const block = standInPart({ id: 2, name: "R14", box: [33, 26.75, 1.2, 57, 33.25, 7.7], round: false });
  const tube = standInPart({ id: 1, name: "V3", box: [34, 51, 0.8, 56, 73, 60.8], round: true });
  assert.deepEqual(block.tf, [1, 0, 0, 45, 0, 1, 0, 30, 0, 0, 1, 1.2]);
  for (const [x, vol] of [[block, 24 * 6.5 * 6.5], [tube, Math.PI * 11 ** 2 * 60]] as const) {
    const m = new Modeller(oc);
    const r = m.evaluate(x.doc);
    assert.ok(r.body && r.statuses.every(s => s.ok !== false), JSON.stringify(r.statuses));
    const v = m.props(r.body!).volume;
    assert.ok(Math.abs(v - vol) < 1e-6 * vol, `${v} vs ${vol}`);
  }
});

test("a loose Gerber set is named after what its files share", () => {
  assert.equal(gerberName(["amp-B_Cu.gbr", "amp-Edge_Cuts.gbr", "amp-F_Cu.gbr", "amp-PTH.drl"]), "amp");
});
