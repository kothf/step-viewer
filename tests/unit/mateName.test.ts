// New mate names (exam #79): one past the highest number of their type, never one still in use.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mateName } from "../../src/asm/mateName";

test("a new mate never takes a name still in use after a delete (exam #79)", () => {
  // Lock1..Lock24 with Lock3 deleted: counting gave "Lock24" again.
  const mates = Array.from({ length: 24 }, (_, i) => ({ name: `Lock${i + 1}` })).filter(m => m.name !== "Lock3");
  assert.equal(mateName(mates, "lock"), "Lock25");
  assert.equal(mateName([], "limitdist"), "LimitDistance1");
  assert.equal(mateName([{ name: "Coincident2" }, { name: "Concentric9" }], "coincident", new Set(["Coincident3"])), "Coincident4");
});
