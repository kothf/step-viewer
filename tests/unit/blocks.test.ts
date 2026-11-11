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
