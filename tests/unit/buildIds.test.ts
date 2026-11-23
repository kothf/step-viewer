/** Disk cache build ids (scripts/build-ids.mjs): each kind is keyed by the code that builds it, not by the release. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIds, moduleGraph, KINDS } from "../../scripts/build-ids.mjs";

test("build ids: the kernel's module graph holds the modeller and not the UI or the analysis", () => {
  const g = moduleGraph(KINDS.part);
  for (const f of ["src/kernel/kernel.worker.ts", "src/kernel/model.ts", "src/kernel/occ.ts", "src/sketch/profile.ts", "src/weldments/kernel.ts", "src/sheetmetal/kernel.ts", "src/sw/parasolid.wasm"])
    assert.ok(g.includes(f), f);
  for (const f of ["src/main.ts", "src/model/controller.ts", "src/sim/ui.ts", "src/sim/static.ts", "src/i18n.ru.ts", "src/thermal/ui.ts"])
    assert.ok(!g.includes(f), f);
  const d = moduleGraph(KINDS.drawing);
  assert.ok(d.includes("src/drawing/drawing.worker.ts") && d.includes("src/kernel/drawing.ts") && !d.includes("src/drawing/workspace.ts"));
});

test("build ids: stable between calls and not tied to the app's version", () => {
  const a = buildIds(), b = buildIds();
  assert.deepEqual(a, b);
  for (const k of ["all", "part", "asmpart", "exact", "import", "drawing", "view"]) assert.match(a[k], /^[0-9a-f]{16}$/, k);
  assert.equal(a.part, a.asmpart);
  assert.notEqual(a.part, a.all);
});
