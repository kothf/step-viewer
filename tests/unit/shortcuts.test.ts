import { test } from "node:test";
import assert from "node:assert/strict";
import { assign, comboOf, commandFor, parseShortcuts, RESERVED } from "../../src/shortcuts";

test("key events become combinations; Cmd counts as Ctrl; a modifier alone is nothing", () => {
  assert.equal(comboOf({ key: "e", ctrlKey: true, shiftKey: true }), "Ctrl+Shift+E");
  assert.equal(comboOf({ key: "e", metaKey: true }), "Ctrl+E");
  assert.equal(comboOf({ key: "F3", altKey: true }), "Alt+F3");
  assert.equal(comboOf({ key: "Shift", shiftKey: true }), "");
  assert.equal(comboOf({ key: "ArrowUp" }), "Up");
});

test("a combination moves to the last command given it; reserved and bad entries are dropped when read", () => {
  const m = parseShortcuts(JSON.stringify({ extrude: "E", fillet: "Ctrl+S", bad: 3 }));
  assert.deepEqual(m, { extrude: "E" });
  assert.equal(assign(m, "cut", "E"), "extrude");
  assert.equal(commandFor(m, "E"), "cut");
  assert.equal(commandFor(m, ""), null);
  assign(m, "cut", "");
  assert.deepEqual(m, {});
  assert.ok(RESERVED.has("Ctrl+Z"));
  assert.deepEqual(parseShortcuts("not json"), {});
});
