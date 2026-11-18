import { test } from "node:test";
import assert from "node:assert/strict";
import { TUTORIAL_STEPS, tutorialNext, tutorialProgress } from "../../src/tutorial";
import { newPart } from "../../src/model/doc";
import { RU } from "../../src/i18n.ru";
import type { Feature, PartDoc } from "../../src/model/types";

const rect = (id: string, plane: unknown, dims = 0) => ({
  id, type: "sketch", name: id, plane,
  ents: [
    ...["a", "b", "c", "d"].map((p, i) => ({ id: p, t: "point", x: i, y: i })),
    ...[["a", "b"], ["b", "c"], ["c", "d"], ["d", "a"]].map(([a, b], i) => ({ id: `l${i}`, t: "line", a, b })),
  ],
  rels: [], dims: Array.from({ length: dims }, (_, i) => ({ id: `d${i}` })),
}) as unknown as Feature;
const feat = (o: Record<string, unknown>) => ({ id: String(o.type) + Math.random(), name: "", ...o }) as unknown as Feature;

test("tutorial: ten steps, each with a Russian title and directions (FR-HLP-003)", () => {
  assert.equal(TUTORIAL_STEPS.length, 10);
  for (const s of TUTORIAL_STEPS) { assert.ok(RU[s.title], s.title); assert.ok(RU[s.how], s.how); }
});

test("tutorial: the document ticks the steps, and undoing unticks them (FR-HLP-003)", () => {
  const d: PartDoc = newPart("Bracket");
  assert.deepEqual(tutorialProgress(d), Array(10).fill(false));
  assert.equal(tutorialNext(tutorialProgress(d)), 0);
  d.features.push({ id: "s1", type: "sketch", name: "s1", plane: { std: "XY" }, ents: [], rels: [], dims: [] } as Feature);
  assert.equal(tutorialNext(tutorialProgress(d)), 1);
  d.features[d.features.length - 1] = rect("s1", { std: "XY" });
  assert.equal(tutorialNext(tutorialProgress(d)), 2);
  d.features[d.features.length - 1] = rect("s1", { std: "XY" }, 2);
  assert.equal(tutorialNext(tutorialProgress(d)), 3);
  d.features.push(feat({ type: "extrude", sketch: "s1", op: "boss" }));
  assert.equal(tutorialNext(tutorialProgress(d)), 4);
  // A second sketch on a standard plane is not the wall sketch: it has to sit on a face.
  d.features.push(rect("s2", { std: "XZ" }));
  assert.equal(tutorialNext(tutorialProgress(d)), 4);
  d.features[d.features.length - 1] = rect("s2", { face: { name: "x" } });
  assert.equal(tutorialNext(tutorialProgress(d)), 5);
  d.features.push(feat({ type: "extrude", sketch: "s2", op: "boss" }));
  d.features.push(feat({ type: "fillet" }));
  assert.equal(tutorialNext(tutorialProgress(d)), 7);
  d.features.push(feat({ type: "extrude", sketch: "s3", op: "cut" }));
  assert.equal(tutorialNext(tutorialProgress(d)), 8);
  d.features.push(feat({ type: "chamfer" }));
  assert.equal(tutorialNext(tutorialProgress(d)), 9);
  d.material = { name: "Steel", density: 7.85 } as PartDoc["material"];
  assert.equal(tutorialNext(tutorialProgress(d)), -1);
  d.features.pop();
  assert.deepEqual(tutorialProgress(d).map((x, i) => (x ? "" : i)).filter(x => x !== ""), [8]);
});
