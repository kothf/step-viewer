// Check sketch for feature (FR-SK-073).
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSketch } from "../../src/sketch/check";
import type { SketchFeature, SkEnt } from "../../src/model/types";

const sk = (ents: SkEnt[]): SketchFeature => ({ id: "s", type: "sketch", name: "S", plane: { std: "XY" }, ents, rels: [], dims: [] });
const pt = (id: string, x: number, y: number): SkEnt => ({ id, t: "point", x, y });
const ln = (id: string, a: string, b: string, cons = false): SkEnt => ({ id, t: "line", a, b, ...(cons ? { cons } : {}) });
const rect = (x0 = 0, y0 = 0, x1 = 10, y1 = 5): SkEnt[] => [pt("a", x0, y0), pt("b", x1, y0), pt("c", x1, y1), pt("d", x0, y1), ln("l1", "a", "b"), ln("l2", "b", "c"), ln("l3", "c", "d"), ln("l4", "d", "a")];

test("check: a rectangle is ready for extrude, loft and not for a rib", () => {
  const r = checkSketch(sk(rect()), "region");
  assert.ok(r.ok);
  assert.equal(r.summary.params?.n, 1);
  assert.ok(checkSketch(sk(rect()), "single").ok);
  const rib = checkSketch(sk(rect()), "open");
  assert.ok(!rib.ok && rib.issues[0].code === "E-RIB-CLOSED");
});

test("check: every open end is listed with its point", () => {
  const ents = rect().filter(e => e.id !== "l2" && e.id !== "l4");
  const r = checkSketch(sk(ents), "region");
  assert.equal(r.issues.filter(i => i.code === "E-SK-OPEN").length, 4);
  assert.deepEqual(r.issues.map(i => i.ents[0]).sort(), ["a", "b", "c", "d"]);
  // The same two lines are no single path either (two chains).
  assert.ok(!checkSketch(sk(ents), "path").ok);
  // One line is a good path and rib.
  const one = sk([pt("a", 0, 0), pt("b", 5, 0), ln("l", "a", "b")]);
  assert.ok(checkSketch(one, "path").ok && checkSketch(one, "open").ok);
});

test("check: branch points, crossings and duplicates", () => {
  const br = checkSketch(sk([...rect(), pt("e", 20, 0), ln("l5", "b", "e")]), "region");
  assert.ok(br.issues.some(i => i.code === "E-SK-BRANCH" && i.ents[0] === "b"));
  assert.ok(br.issues.some(i => i.code === "E-SK-OPEN" && i.ents[0] === "e"));
  const x = checkSketch(sk([...rect(), pt("p", 5, -2), pt("q", 5, 7), pt("r", 4, 7), ln("m1", "p", "q"), ln("m2", "q", "r"), ln("m3", "r", "p")]), "region");
  assert.ok(x.issues.some(i => i.code === "E-SK-SELFX"));
  const dup = checkSketch(sk([...rect(), ln("l6", "b", "a")]), "region");
  assert.ok(dup.issues.some(i => i.code === "E-SK-DUP"));
  assert.ok(checkSketch(sk([pt("a", 0, 0), pt("b", 0, 0), pt("c", 3, 0), ln("z", "a", "b"), ln("y", "b", "c")]), "region").issues.some(i => i.code === "E-SK-ZERO"));
});

test("check: revolve wants a centerline the profile does not cross", () => {
  assert.ok(checkSketch(sk([...rect(), pt("u", -1, -5), pt("v", -1, 10), ln("ax", "u", "v", true)]), "revolve").ok);
  const cross = checkSketch(sk([...rect(), pt("u", 5, -5), pt("v", 5, 10), ln("ax", "u", "v", true)]), "revolve");
  assert.ok(!cross.ok && cross.issues[0].code === "E-REV-CROSS" && cross.issues[0].ents[0] === "ax");
  // An edge of the profile on the axis is fine.
  assert.ok(checkSketch(sk([...rect(), pt("u", 0, -5), pt("v", 0, 10), ln("ax", "u", "v", true)]), "revolve").ok);
  assert.equal(checkSketch(sk([pt("o", 0, 0)]), "region").issues[0].code, "E-SK-NONE");
});
