// The test part of the drawings exam, made by hand: a 100 × 60 × 20 block with a plain through hole
// (Hole, default Ø6.6 THRU) at (25, 0) and a counterbore hole at (-25, 0). Saved for drwexam.mjs.
import { open, snap, check, finish, makeBlock, idle, clickAt, screenOf, cmd, saveModel } from "./lib.mjs";
export async function holeAt(pg, x, y, kind) {
  await cmd(pg, "Hole");
  await pg.waitForTimeout(600);
  if (kind) { await pg.selectOption('#mc-pm select[data-k="kind"]', kind); await pg.waitForTimeout(400); }
  await pg.click('#mc-pm [data-htab="pos"]');
  await pg.waitForTimeout(200);
  await clickAt(pg, await screenOf(pg, [x, y, 20]));
  await pg.waitForFunction(() => window.__sv.modeller.mode.kind === "sketch", null, { timeout: 30000 });
  await pg.waitForTimeout(600);
  await pg.click("#mc-ok");
  await pg.waitForFunction(() => window.__sv.modeller.mode.kind === "feature", null, { timeout: 30000 });
  await idle(pg);
  await pg.click("#mc-ok");
  await pg.waitForFunction(() => window.__sv.modeller.mode.kind === "none", null, { timeout: 30000 });
  await idle(pg);
}
export async function makePlate(pg) {
  await makeBlock(pg, 100, 60, 20);
  await holeAt(pg, 25, 0);
  await holeAt(pg, -25, 0, "cbore");
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const { browser, pg } = await open("drwpart");
  await makePlate(pg);
  const f = await pg.evaluate(() => window.__sv.modeller.store.doc.features.map(x => ({ type: x.type, kind: x.kind, pts: x.pts, d: x.diameter?.v })));
  check("P0", f.filter(x => x.type === "hole").length === 2, "the plate has two holes", f, await snap(pg, "plate"));
  const path = await saveModel(pg, process.env.HT_MODELS || "/mnt/project-files/tests/drw", "Plate");
  console.log("saved", path);
  await finish(browser, pg);
}
