// Part temperatures in a board study (FRS-thermal FR-TBRD-021): body maximum, or case + p × Rjc for junction parts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { partTemps } from "../../src/thermal/study";
import { readSources } from "../../src/thermal/package";

const max: Record<string, number> = { a: 60, b: 72, q: 80, q2: 85, u: 50 };
const maxOf = (c: string) => max[c];

test("a plain part reports the hottest point of its bodies", () => {
  const [r] = partTemps([{ name: "R1", p: 2, comps: ["a", "b"], limit: 70 }], maxOf);
  assert.equal(r.t, 72);
  assert.equal(r.kind, "body");
  assert.equal(r.over, true);
});

test("a junction part with Rjc reports case + p × Rjc", () => {
  const [r] = partTemps([{ name: "Q1", p: 4, junction: true, rjc: 2.5, comps: ["q", "q2"], limit: 100 }], maxOf);
  assert.equal(r.body, 85);
  assert.equal(r.t, 95);
  assert.equal(r.kind, "junction");
  assert.equal(r.over, false);
  assert.ok(!r.caseOnly);
});

test("a junction part with no Rjc reports its case, marked", () => {
  const [r] = partTemps([{ name: "Q2", p: 4, junction: true, comps: ["q"] }], maxOf);
  assert.equal(r.t, 80);
  assert.equal(r.kind, "case");
  assert.equal(r.caseOnly, true);
});

test("a typed Rjc makes any part a junction; a part left out adds nothing; unknown bodies are skipped", () => {
  const out = partTemps([
    { name: "U1", p: 1, rjc: 10, comps: ["u"] },
    { name: "U2", p: 1, rjc: 10, off: true, comps: ["u"] },
    { name: "X", p: 1, comps: ["nope"] },
  ], maxOf);
  assert.deepEqual(out.map(x => [x.name, x.t, x.kind]), [["U1", 60, "junction"], ["U2", 50, "junction"]]);
});

test("the heat-source CSV may give Rjc in an rjc_KW column", () => {
  const rows = readSources("part_id,designator,step_bodies,p_total_W,t_kind,rjc_KW\n1,Q1,Q1,3,junction,1.5\n2,R1,R1,1,body,\n");
  assert.equal(rows[0].rjc, 1.5);
  assert.equal(rows[0].tKind, "junction");
  assert.equal(rows[1].rjc, undefined);
});
