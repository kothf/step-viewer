// Pack and Go names: flatten into one folder, prefix and suffix, references rewritten so the packed folder opens.
import { test } from "node:test";
import assert from "node:assert/strict";
import { memDir, resolveRefs, writeRefs } from "../../src/asm/refs";
import { packedName, relPath, renameRefs } from "../../src/asm/packNames";
import { newPart } from "../../src/model/doc";
import { IDENTITY } from "../../src/asm/math";
import type { AsmDoc } from "../../src/asm/types";

const part = (name: string) => { const p = newPart(name); p.id = `id-${name}`; return p; };
const asmOf = (entries: Record<string, { file: string; id?: string; asm?: AsmDoc }>, id = "asm"): AsmDoc => ({
  schema: 1, kind: "assembly", id, name: id, units: { length: "mm", decimals: 2 },
  parts: Object.fromEntries(Object.entries(entries).map(([n, e]) => [`k_${n}`, { name: n, file: e.file, doc: part(e.id ?? n), ...(e.asm ? { asm: e.asm } : {}) }])),
  components: Object.keys(entries).map(n => ({ id: `c_${n}`, name: `${n}<1>`, part: `k_${n}`, tf: IDENTITY })),
} as AsmDoc);

test("packed names: prefix, suffix, flatten", () => {
  assert.equal(packedName("bought/Plate.mcadprt", { prefix: "X-", suffix: "_v2" }), "bought/X-Plate_v2.mcadprt");
  assert.equal(packedName("bought/Plate.mcadprt", { flatten: true }), "Plate.mcadprt");
  assert.equal(relPath("sub", "Plate.mcadprt"), "../Plate.mcadprt");
  assert.equal(relPath("", "a/b.mcadprt"), "a/b.mcadprt");
  assert.equal(relPath("a", "a/b.mcadprt"), "b.mcadprt");
});

test("a flattened, renamed assembly with a sub-assembly opens from the packed files", async () => {
  // a sub-assembly in a folder with its own part; two different parts named Pin in different folders
  const sub = asmOf({ Pin: { file: "Pin.mcadprt", id: "pin-a" } }, "sub");
  const top = asmOf({ Plate: { file: "Plate.mcadprt" }, Pin: { file: "Pin.mcadprt", id: "pin-b" }, Sub: { file: "Sub.mcadasm", asm: sub } });
  const dir = memDir();
  const w = await writeRefs(top, dir, new Map(), "t", "", "Top.mcadasm");
  // put the sub-assembly into a folder by hand, as a person might have
  w.doc.parts.k_Sub.link!.path = "subs/Sub.mcadasm";
  const r = renameRefs(w.doc, "Top.mcadasm", { flatten: true, prefix: "P-" });
  assert.equal(r.name, "P-Top.mcadasm");
  const out = memDir();
  const w2 = await writeRefs(r.doc, out, new Map(), "t", "", r.name);
  const names = [...out.files.keys()].sort();
  assert.deepEqual(names, ["P-Pin (2).mcadprt", "P-Pin.mcadprt", "P-Plate.mcadprt", "P-Sub.mcadasm"]);
  // every reference resolves from the packed files
  const back = await resolveRefs(w2.doc, out, new Map());
  assert.deepEqual([back.missing, back.foreign, back.damaged], [[], [], []]);
  assert.equal(back.doc.parts.k_Sub.asm!.parts.k_Pin.doc.id, "id-pin-a");
});
