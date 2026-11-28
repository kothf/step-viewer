// A. Section views.
export default async function ({ pg, drw, snap, check, menuItem, click, at, vs }) {
  const top = vs.find(v => v.side && v.side[1] === -1);
  const pt = await drw.pl(top.id);
  // A1: Section ▸ Horizontal cutting line, a click near the plain hole's centre (2 mm off): the line snaps there.
  await menuItem("section", '[data-cut="h"]');
  await pg.waitForTimeout(200);
  await click(pt.x + 25 * pt.s, pt.y + 2 * pt.s);
  await pg.waitForTimeout(600);
  // A2: move below the top view; the preview shows; click places it.
  const place = [pt.x, pt.y - 75];
  await pg.mouse.move(...(await at(place[0], place[1] + 5)));
  await pg.waitForTimeout(400);
  await pg.mouse.move(...(await at(...place)));
  await pg.waitForTimeout(2500);
  const prev = await pg.evaluate(() => window.__sv.drw.previews());
  const img1 = await snap(pg, "section-preview");
  check("A2-preview", prev.left > 0 || prev.sections > 0 || (await pg.$("#drw .drw-ghost, #drw .drw-preview")) !== null, "the section previews while the cursor moves", prev, img1);
  await clickAt(pg, await at(...place));
  await drw.ready();
  await pg.waitForTimeout(800);
  let views = await drw.views();
  const sec = views.find(v => v.kind === "section");
  const lineY = sec && sec.line ? [sec.line[1], sec.line[3]] : null;
  check("A1", !!sec && lineY && Math.abs(lineY[0]) < 0.01 && Math.abs(lineY[1]) < 0.01, "a horizontal cutting line clicked 2 mm off the hole centre snaps through it", { line: sec?.line }, null);
  const sp = sec && (await drw.pl(sec.id));
  check("A2-place", !!sp && sp.y < pt.y && Math.abs(sp.x - pt.x) < 1, "the section lands below the top view, lined up with it", { sp, pt }, null);
  const texts = await drw.texts();
  const img2 = await snap(pg, "section-placed");
  check("A3", texts.some(s => /SECTION\s*A\s*-\s*A/i.test(s)) && texts.filter(s => s === "A").length >= 2, "label SECTION A-A under the view, A at both ends of the cutting line", { texts: texts.slice(0, 30) }, img2);
  const prims = await pg.evaluate(id => window.__sv.drw.prims().filter(p => p.layer === "HATCH" || p.pen === "hatch").length, sec?.id);
  check("A4", prims > 0, "cut faces are hatched", { hatch: prims }, img2);
  // A5: drag the section sideways: it stays lined up (only moves up/down).
  const from = await at(sp.x - 30, sp.y);
  await pg.mouse.move(...from); await pg.mouse.down();
  await pg.mouse.move(from[0] + 40, from[1] + 20, { steps: 5 }); await pg.mouse.up();
  await pg.waitForTimeout(600);
  const sp2 = await drw.pl(sec.id);
  check("A5", Math.abs(sp2.x - sp.x) < 0.5 && Math.abs(sp2.y - sp.y) > 1, "a dragged section stays lined up with its parent", { before: [sp.x, sp.y], after: [sp2.x, sp2.y] }, await snap(pg, "section-dragged"));
  // A6: flip direction from the properties.
  const look0 = (await drw.views()).find(v => v.id === sec.id).look;
  const flip = await pg.$('#drw .drw-props [data-a="flip"], #drw .drw-props [data-v="flip"]');
  if (flip) { await flip.click(); await pg.waitForTimeout(600); await drw.ready(); }
  const look1 = (await drw.views()).find(v => v.id === sec.id).look;
  check("A6", !!flip && JSON.stringify(look0) !== JSON.stringify(look1), "Flip direction in the section's properties turns it round", { look0, look1, flip: !!flip }, await snap(pg, "section-flipped"));
  if (flip) { await pg.click('#drw .drw-props [data-a="flip"]'); await pg.waitForTimeout(600); await drw.ready(); }
  // A7: a vertical cutting line through the counterbore on the top view: B-B.
  await menuItem("section", '[data-cut="v"]');
  await click(pt.x - 25 * pt.s + 1, pt.y);
  await pg.waitForTimeout(600);
  const placeB = [pt.x + 120, pt.y];
  await pg.mouse.move(...(await at(placeB[0] - 5, placeB[1])));
  await pg.mouse.move(...(await at(...placeB)));
  await pg.waitForTimeout(1500);
  await clickAt(pg, await at(...placeB));
  await drw.ready();
  await pg.waitForTimeout(600);
  views = await drw.views();
  const secB = views.find(v => v.kind === "section" && v.id !== sec.id);
  check("A7", secB?.letter === "B" && (await drw.texts()).some(s => /SECTION\s*B\s*-\s*B/i.test(s)), "a second section gets the letter B", { letter: secB?.letter }, await snap(pg, "section-b"));
  globalThis.T.sec = sec; globalThis.T.secB = secB; globalThis.T.top = top;
}
import { clickAt } from "./lib.mjs";
