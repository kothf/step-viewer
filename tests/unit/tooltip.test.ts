// Command tooltips (FR-UI-112): the shortcut key is read from a title's trailing "(key)".
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitTip, tipParts } from "../../src/tipText";

test("a title's trailing key in brackets becomes the shortcut", () => {
  assert.deepEqual(splitTip("Line (L)"), { text: "Line", key: "L" });
  assert.deepEqual(splitTip("Selection filter: faces, edges, vertices (F5)"), { text: "Selection filter: faces, edges, vertices", key: "F5" });
  assert.deepEqual(splitTip("Undo: Add Extrude1 (Ctrl+Z)"), { text: "Undo: Add Extrude1", key: "Ctrl+Z" });
  assert.deepEqual(splitTip("Select and drag (Esc)"), { text: "Select and drag", key: "Esc" });
  // Brackets that are not a key stay in the text.
  assert.deepEqual(splitTip("Hole wizard (ISO sizes)"), { text: "Hole wizard (ISO sizes)", key: null });
});

test("the description is left out when it only repeats the label", () => {
  assert.deepEqual(tipParts("Line", "Line (L)", null), { label: "Line", key: "L", text: "", why: null });
  assert.deepEqual(tipParts("Undo", "Undo (Ctrl+Z)", "Nothing to undo."), { label: "Undo", key: "Ctrl+Z", text: "", why: "Nothing to undo." });
  assert.equal(tipParts("Fillet", "Round edges", null).text, "Round edges");
});
