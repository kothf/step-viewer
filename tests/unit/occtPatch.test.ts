/** The start-up patch of opencascade.js's glue (scripts/occt-patch.mjs): the kernel works the same with it. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
// @ts-expect-error plain JavaScript build script
import { patchOcctGlue } from "../../scripts/occt-patch.mjs";
// @ts-expect-error no types for the node entry
import init from "opencascade.js/dist/node.js";

const require = createRequire(import.meta.url);
const dist = dirname(require.resolve("opencascade.js/dist/opencascade.full.js"));

test("opencascade.js glue: the invoker patch applies once and the patched kernel models and measures", async () => {
  const glue = readFileSync(join(dist, "opencascade.full.js"), "utf8");
  const patched = patchOcctGlue(glue) as string | null;
  assert.ok(patched, "the glue has craftInvokerFunction as expected");
  assert.equal(patchOcctGlue(patched), null, "a patched glue is not patched again");
  const dir = join(process.cwd(), "node_modules/.cache/occt-patch");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "opencascade.full.mjs"), patched);
  const mainJS = (await import(pathToFileURL(join(dir, "opencascade.full.mjs")).href)).default;
  const t = performance.now();
  const oc = await init({ mainJS, mainWasm: join(dist, "opencascade.full.wasm") });
  console.log(`patched set-up ${(performance.now() - t).toFixed(0)} ms`);
  // A box with a through hole: overloads, constructors, methods returning objects and doubles.
  const box = new oc.BRepPrimAPI_MakeBox_2(10, 20, 30).Shape();
  const ax = new oc.gp_Ax2_3(new oc.gp_Pnt_3(5, 10, -1), new oc.gp_Dir_4(0, 0, 1));
  const cyl = new oc.BRepPrimAPI_MakeCylinder_3(ax, 2, 32).Shape();
  const cut = new oc.BRepAlgoAPI_Cut_3(box, cyl, new oc.Message_ProgressRange_1());
  const props = new oc.GProp_GProps_1();
  oc.BRepGProp.VolumeProperties_1(cut.Shape(), props, false, false, false);
  assert.ok(Math.abs(props.Mass() - (6000 - Math.PI * 4 * 30)) < 1e-6, String(props.Mass()));
  // The generated argument count check still runs.
  assert.throws(() => new oc.gp_Pnt_3(1, 2));
  assert.throws(() => props.Mass(1));
});
