// Sketch text (FR-SK-020): glyph outlines become regions the kernel extrudes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "three/examples/jsm/libs/opentype.module.js";
import { outlineFrom, textBox, textKey, textLoops } from "../../src/sketch/text";
import { loopPolygon, polyArea, sketchProfile } from "../../src/sketch/profile";
import { checkSketch } from "../../src/sketch/check";
import { solve } from "../../src/sketch/solver";
import { Modeller } from "../../src/kernel/model";
import type { Feature, PartDoc, SketchFeature, SkEnt } from "../../src/model/types";
import { occ } from "./occ";

const font = (f: string) => { const b = readFileSync(join(process.cwd(), "node_modules/dejavu-fonts-ttf/ttf", f)); return parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)) as never; };
const doc = (features: Feature[]): PartDoc => ({ schema: 1, kind: "part", id: "d", name: "t", units: { length: "mm", decimals: 2 }, props: {}, features, rollback: null });

test("text outline: capital height 1, letters with holes nest, the box follows height and angle", () => {
  const sans = font("DejaVuSans.ttf");
  const gl = outlineFrom(sans, { text: "HO" });
  assert.equal(gl.key, textKey({ text: "HO" }));
  // H: one contour; O: outer and inner.
  assert.equal(gl.c.length, 3);
  const e: Extract<SkEnt, { t: "text" }> = { id: "t", t: "text", p: "p", text: "HO", h: 10, gl };
  const box = textBox(e, [5, 0]);
  assert.ok(Math.abs(box[2][1] - 10.2) < 0.5, `top ${box[2][1]}`);
  assert.ok(Math.abs(box[0][0] - 5) < 1.5, `left ${box[0][0]}`);
  const turned = textBox({ ...e, ang: Math.PI / 2 }, [0, 0]);
  assert.ok(turned[1][1] > 10 && Math.abs(turned[1][0]) < 1.5, JSON.stringify(turned));
  // A stale outline (the text changed) draws nothing until it is remade.
  assert.equal(textLoops({ ...e, text: "HI" }, [0, 0]).length, 0);
  const sk: SketchFeature = { id: "s", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [{ id: "p", t: "point", x: 0, y: 0 }, e] };
  const prof = sketchProfile(sk);
  assert.equal(prof.error, undefined);
  assert.equal(prof.faces.length, 2);
  assert.equal(prof.faces.filter(f => f.holes.length === 1).length, 1);
  assert.ok(checkSketch(sk, "region").ok);
  // The anchor is an ordinary point: 2 degrees of freedom.
  assert.equal(solve(sk).dof, 2);
});

test("text in the kernel: an extruded text has the volume of its letters", async () => {
  const m = new Modeller(await occ());
  const gl = outlineFrom(font("DejaVuSans-Bold.ttf"), { text: "Ab8", bold: true });
  const txt: Extract<SkEnt, { t: "text" }> = { id: "t", t: "text", p: "p", text: "Ab8", h: 8, bold: true, gl };
  const sk: SketchFeature = { id: "s", type: "sketch", name: "Sketch1", plane: { std: "XY" }, rels: [], dims: [], ents: [{ id: "p", t: "point", x: -10, y: 0 }, txt] };
  const prof = sketchProfile(sk);
  let area = 0;
  for (const f of prof.faces) area += Math.abs(polyArea(loopPolygon(f.outer, 48))) - f.holes.reduce((a, h) => a + Math.abs(polyArea(loopPolygon(h, 48))), 0);
  const r = m.evaluate(doc([sk, { id: "e", type: "extrude", name: "Boss-Extrude1", sketch: "s", op: "boss", end: "blind", depth: { v: 2 } }]));
  assert.deepEqual(r.statuses.filter(s => !s.ok), []);
  const v = m.props(r.body!).volume;
  assert.ok(area > 20 && Math.abs(v - 2 * area) < 0.01 * v, `${v} vs ${2 * area}`);
});
