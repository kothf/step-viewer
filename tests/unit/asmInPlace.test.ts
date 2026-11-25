// Insert part in place (FR-ASM-031): names, empty parts left out, the new part saved as its own file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BAD_FILE_CHARS, hasContent, nextPartName } from "../../src/asm/inPlace";
import { memDir, writeRefs, type RefBase } from "../../src/asm/refs";
import { newPart } from "../../src/model/doc";
import { IDENTITY } from "../../src/asm/math";
import type { AsmDoc } from "../../src/asm/types";
import type { SketchFeature } from "../../src/model/types";

test("the next free part name skips names in use", () => {
  assert.equal(nextPartName(new Set()), "Part1");
  assert.equal(nextPartName(new Set(["part1", "part2", "plate"])), "Part3");
  assert.ok(BAD_FILE_CHARS.test("a/b") && BAD_FILE_CHARS.test("a:b") && !BAD_FILE_CHARS.test("Bracket 2"));
});

test("a part with only an empty sketch has nothing in it", () => {
  const pd = newPart("Part1");
  assert.equal(hasContent(pd), false);
  const sk: SketchFeature = { id: "s", type: "sketch", name: "Sketch1", plane: { ctx: { comp: "c1", face: "f1:end", host: "c2", p: [0, 0, 10], n: [0, 0, 1] } }, ents: [], rels: [], dims: [] };
  pd.features.push(sk);
  assert.equal(hasContent(pd), false);
  sk.ents.push({ id: "p", t: "point", x: 1, y: 2 } as SketchFeature["ents"][number]);
  assert.equal(hasContent(pd), true);
});

test("a part made in place is written beside the assembly as its own file", async () => {
  const plate = newPart("Plate"), made = newPart("Part1");
  made.features.push({ id: "s", type: "sketch", name: "Sketch1", plane: { ctx: { comp: "c_plate", face: "f1:end", host: "c_new", p: [0, 0, 10], n: [0, 0, 1] } }, ents: [], rels: [], dims: [] });
  const doc = {
    schema: 1, kind: "assembly", id: "asm", name: "A", units: { length: "mm", decimals: 2 },
    parts: { k1: { name: "Plate", file: "Plate.mcadprt", doc: plate }, k2: { name: "Part1", file: "Part1.mcadprt", doc: made } },
    components: [{ id: "c_plate", name: "Plate<1>", part: "k1", tf: IDENTITY, fixed: true }, { id: "c_new", name: "Part1<1>", part: "k2", tf: IDENTITY, fixed: true }],
  } as AsmDoc;
  const dir = memDir(), base: RefBase = new Map();
  const r = await writeRefs(doc, dir, base, "test", "", "A.mcadasm");
  assert.ok(dir.files.has("Part1.mcadprt"));
  assert.equal(r.doc.parts.k2.link?.path, "Part1.mcadprt");
});
