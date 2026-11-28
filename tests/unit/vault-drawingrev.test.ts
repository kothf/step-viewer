// A released drawing's title block gets its revision; transitions offered only when they can run (vault tests round 1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { memDir, Vault } from "../../src/pdm/vault";
import { zip } from "../../src/model/zip";
import { readProps } from "../../src/pdm/codec";

const drawing = (props: Record<string, string> = {}) => zip([
  { name: "manifest.json", data: JSON.stringify({ format: "mobiuscad", schema: 1, kind: "drawing" }) },
  { name: "drawing.json", data: JSON.stringify({ kind: "drawing", props, sheets: [{ name: "Sheet1", views: [] }], source: { kind: "file", name: "x.step" } }) },
]);

test("vault: releasing a drawing writes revision and approver into its title block", async () => {
  const v = await Vault.create(memDir("D"), "D", "Andrey", "pc1");
  const f = await v.add("Bracket.mcaddrw", await drawing({ number: "BR-1" }));
  // The drawing number shows on the data card.
  assert.equal(f.card?.["Part number"], "BR-1");
  await v.transition([f.id], "Submit for review");
  await v.transition([f.id], "Approve");
  const g = await v.file(f.id);
  assert.equal(g.revision, "A");
  const bytes = await v.versionBytes(f.id, v.latest(g).n);
  const read = await readProps("Bracket.mcaddrw", bytes);
  assert.equal(read?.revision, "A");
  assert.equal(read?.["Approved by"], "Andrey");
  assert.equal(read?.partNumber, "BR-1");
});

test("vault: no state change offered while checked out, nor one the user's roles do not allow", async () => {
  const v = await Vault.create(memDir("E"), "E", "Andrey", "pc1");
  const f = await v.add("Bracket.mcaddrw", await drawing());
  await v.checkOut(f.id);
  assert.deepEqual(v.allowedTransitions(await v.file(f.id)), []);
  await v.undoCheckOut(f.id);
  assert.deepEqual(v.allowedTransitions(await v.file(f.id)).map(x => x.name), ["Submit for review"]);
  await v.transition([f.id], "Submit for review");
  const all = v.allowedTransitions(await v.file(f.id)).map(x => x.name);
  assert.ok(all.includes("Approve"));
});
