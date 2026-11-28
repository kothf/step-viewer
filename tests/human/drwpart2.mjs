// Second part of the drawings exam, made by hand: a 100 × 60 × 20 block with two M6 tapped holes of one
// Hole feature at (25, ±15) and a Ø16 hole cut through by a sketched circle at (-25, 0) (no Hole feature).
import { open, snap, check, finish, makeBlock, idle, clickAt, screenOf, cmd, saveModel } from "./lib.mjs";
export async function makeFlange(pg) {
  await makeBlock(pg, 100, 60, 20);
  await cmd(pg, "Hole");
  await pg.waitForTimeout(600);
  await pg.selectOption('#mc-pm select[data-k="kind"]', "tapped");
  await pg.waitForTimeout(400);
  await pg.click('#mc-pm [data-htab="pos"]');
  await pg.waitForTimeout(200);
  await clickAt(pg, await screenOf(pg, [25, 15, 20]));
  await pg.waitForFunction(() => window.__sv.modeller.mode.kind === "sketch", null, { timeout: 30000 });
  await pg.waitForTimeout(600);
  await clickAt(pg, await screenOf(pg, [25, -15, 20]));
  await pg.waitForTimeout(400);
  await pg.click("#mc-ok");
  await pg.waitForFunction(() => window.__sv.modeller.mode.kind === "feature", null, { timeout: 30000 });
  await idle(pg);
  await pg.click("#mc-ok");
  await pg.waitForFunction(() => window.__sv.modeller.mode.kind === "none", null, { timeout: 30000 });
  await idle(pg);
  await cmd(pg, "Sketch");
  await pg.waitForTimeout(300);
  await pg.getByRole("button", { name: "Top (XY)" }).last().click();
  await pg.waitForTimeout(1200);
  await pg.click('#mc-tools [data-c="sk:circle"]');
  await clickAt(pg, await screenOf(pg, [-25, 0, 0]));
  await clickAt(pg, await screenOf(pg, [-17, 0, 0]));
  await pg.keyboard.press("Escape");
  await pg.click('#mc-tools [data-c="cut"]');
  await pg.waitForTimeout(800);
  await pg.selectOption('#mc-pm select[data-k="end"]', "through2");
  await idle(pg);
  if (await pg.isVisible("#mc-ok")) await pg.click("#mc-ok");
  await idle(pg);
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const { browser, pg } = await open("drwpart2");
  await makeFlange(pg);
  const f = await pg.evaluate(() => window.__sv.modeller.store.doc.features.map(x => ({ type: x.type, op: x.op, kind: x.kind, pts: x.pts, end: x.end })));
  check("P1", f.some(x => x.type === "hole" && x.kind === "tapped" && x.pts?.length === 2) && f.some(x => x.op === "cut"), "the flange has two tapped holes and a cut hole", f, await snap(pg, "flange"));
  const path = await saveModel(pg, process.env.HT_MODELS || "/mnt/project-files/tests/drw", "Flange");
  console.log("saved", path);
  await finish(browser, pg);
}
