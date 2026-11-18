import { test } from "node:test";
import assert from "node:assert/strict";
import { blockFile, explodeInsert, insertBlock, insertEnts, insertOf, makeBlock, moveInsert, readBlockFile, removeInserts } from "../../src/sketch/blocks";
import { solve } from "../../src/sketch/solver";
import { sketchProfile } from "../../src/sketch/profile";
import type { SketchFeature, SkEnt } from "../../src/model/types";

/** A 20 × 10 rectangle with its lower left corner at (10, 5) and a horizontal relation on its bottom. */
function rectSketch(): SketchFeature {
  const P = (id: string, x: number, y: number): SkEnt => ({ id, t: "point", x, y });
  return {
    id: "s1", type: "sketch", name: "Sketch1", plane: { std: "XY" },
    ents: [P("a", 10, 5), P("b", 30, 5), P("c", 30, 15), P("d", 10, 15),
      { id: "l1", t: "line", a: "a", b: "b" }, { id: "l2", t: "line", a: "b", b: "c" }, { id: "l3", t: "line", a: "c", b: "d" }, { id: "l4", t: "line", a: "d", b: "a" }],
    rels: [{ id: "r1", t: "horizontal", e: ["l1"] }],
    dims: [{ id: "d1", name: "D1", t: "distance", e: ["a", "b"], val: { v: 20 } }],
  };
}
const pt = (sk: SketchFeature, id: string) => { const e = sk.ents.find(x => x.id === id) as Extract<SkEnt, { t: "point" }>; return [e.x, e.y]; };

test("blocks: Make Block turns the picked curves into one fixed instance at the middle of their box", () => {
  const r = makeBlock(rectSketch(), ["l1", "l2", "l3", "l4"]);
  assert.ok(typeof r !== "string");
  const { sk, block, insert } = r;
  assert.equal(block.name, "Block1");
  assert.deepEqual([insert.x, insert.y], [20, 10]);
  assert.deepEqual(pt({ ...sk, ents: block.ents } as SketchFeature, "a"), [-10, -5]);
  assert.equal(block.rels.length, 1, "the horizontal relation goes into the block");
  assert.equal(sk.dims.length, 0, "dimensions to the old entities go");
  assert.deepEqual(pt(sk, "bi1~a"), [10, 5]);
  assert.equal(insertEnts(sk, "bi1").length, 8);
  assert.equal(insertOf(sk, "bi1~l3")?.id, "bi1");
  const res = solve(sk);
  assert.equal(res.status, "ok");
  assert.equal(res.dof, 0, "an instance is fully defined");
  // The instance still makes a profile.
  const prof = sketchProfile(sk);
  assert.ok(!("error" in prof) || !prof.error, JSON.stringify(prof).slice(0, 200));
});

test("blocks: move, turn, scale and copy an instance; relations to it stay", () => {
  const r = makeBlock(rectSketch(), ["l1", "l2", "l3", "l4"]);
  assert.ok(typeof r !== "string");
  let sk = r.sk;
  sk.ents.push({ id: "q", t: "point", x: 0, y: 0 });
  sk.rels.push({ id: "rq", t: "coincident", e: ["q", "bi1~a"] });
  sk = moveInsert(sk, "bi1", { x: 0, y: 0, ang: Math.PI / 2, scale: 2 });
  const a = pt(sk, "bi1~a");
  assert.ok(Math.abs(a[0] - 10) < 1e-9 && Math.abs(a[1] + 20) < 1e-9, String(a));
  assert.ok(sk.rels.some(x => x.id === "rq"), "the user's relation to the instance stays");
  const two = insertBlock(sk, r.block, [100, 0]);
  assert.equal(two.insert.id, "bi2");
  assert.equal(two.sk.blocks!.length, 1, "the same definition is reused");
  assert.deepEqual(pt(two.sk, "bi2~c"), [110, 5]);
  const one = removeInserts(two.sk, ["bi1"]);
  assert.ok(!one.rels.some(x => x.id === "rq"), "relations to a deleted instance go");
  assert.equal(one.inserts!.length, 1);
  assert.equal(removeInserts(one, ["bi2"]).blocks, undefined, "an unused definition goes with its last instance");
});

test("blocks: Explode gives plain entities with the block's relations back; files round-trip", () => {
  const r = makeBlock(rectSketch(), ["l1", "l2", "l3", "l4"]);
  assert.ok(typeof r !== "string");
  let n = 0;
  const sk = explodeInsert(r.sk, "bi1", k => `${k}x${++n}`);
  assert.equal(sk.inserts, undefined);
  assert.ok(!sk.ents.some(e => e.id.includes("~")));
  assert.ok(!sk.rels.some(x => x.t === "fix"));
  assert.ok(sk.rels.some(x => x.t === "horizontal"));
  assert.equal(solve(sk).status, "ok");
  const back = readBlockFile(blockFile(r.block));
  assert.deepEqual(back, r.block);
  assert.throws(() => readBlockFile("{}"), /NOT_BLOCK/);
  assert.equal(makeBlock(rectSketch(), ["a"]), "NOTHING");
});

test("blocks: Edit Block changes the definition, every instance follows, drawn entities join", async () => {
  const { beginEditBlock, finishEditBlock } = await import("../../src/sketch/blocks");
  const r = makeBlock(rectSketch(), ["l1", "l2", "l3", "l4"]);
  assert.ok(typeof r !== "string");
  let sk = insertBlock(r.sk, r.block, [100, 0], Math.PI / 2, 2).sk;
  sk = beginEditBlock(sk, "bi1");
  assert.ok(!sk.rels.some(x => x.id === "bi1~fix"), "the edited instance is free");
  assert.ok(sk.rels.some(x => x.id === "bi1~r1" && x.e[0] === "bi1~l1"), "the block's relations come back on it");
  assert.equal(solve(sk).status, "ok");
  // Make the rectangle 30 wide: move b and c right by 10, and draw a diagonal.
  for (const e of sk.ents) if (e.t === "point" && (e.id === "bi1~b" || e.id === "bi1~c")) e.x += 10;
  sk.ents.push({ id: "n1", t: "line", a: "bi1~a", b: "bi1~c" });
  sk.dims.push({ id: "dn", name: "D9", t: "distance", e: ["bi1~a", "bi1~b"], val: { v: 30 } });
  sk = finishEditBlock(sk);
  assert.equal(sk.editBlock, undefined);
  const def = sk.blocks![0];
  assert.equal(def.ents.length, 9, "the diagonal joined the block");
  assert.equal(def.dims?.length, 1);
  assert.ok(Math.abs(def.dims![0].val.v - 30) < 1e-9);
  assert.ok(sk.rels.some(x => x.id === "bi1~fix") && sk.rels.some(x => x.id === "bi2~fix"));
  assert.ok(!sk.ents.some(e => e.id === "n1"), "the drawn line is now the instance's");
  assert.ok(sk.ents.some(e => e.id === "bi2~n1"), "and the other instance has it too");
  // The other instance (turned 90°, scaled 2) has b at (100, 0) + 2·rot90(20, −5).
  const c = pt(sk, "bi2~b");
  assert.ok(Math.abs(c[0] - 110) < 1e-9 && Math.abs(c[1] - 40) < 1e-9, String(c));
  assert.equal(solve(sk).dof, 0);
});
