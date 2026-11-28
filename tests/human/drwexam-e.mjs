// E. The second part (Flange.mcadprt, drwpart2.mjs): tapped holes of one feature, a hole cut by a sketch,
// a dimension on a section's cut face, a half section, deleting a section's parent.
import { clickAt } from "./lib.mjs";
export default async function ({ pg, drw, snap, check, tool, cmdA, menuItem, click, at, vs }) {
  const top = vs.find(v => v.side && v.side[1] === -1);
  const pt = await drw.pl(top.id);
  const of = async k => (await drw.annots()).filter(a => a.t === k);
  const textIn = async id => { const b = await drw.hit(id); return b ? pg.evaluate(b => window.__sv.drw.prims().filter(p => p.t === "t" && p.x >= b[0] - 1 && p.x <= b[2] + 1 && p.y >= b[1] - 1 && p.y <= b[3] + 1).map(p => p.s), b) : []; };
  const c45 = Math.SQRT1_2;
  // B3/B4: callout on one of the two M6 tapped holes.
  await tool("hole");
  await click(...pt.at(25 + 2.5 * c45, 15 + 2.5 * c45));
  await click(...pt.at(45, 30));
  await pg.keyboard.press("Escape");
  const h1 = (await of("hole")).at(-1), t1 = h1 ? await textIn(h1.id) : [];
  const img1 = await snap(pg, "callout-tapped");
  check("B3", t1.some(s => /M6/.test(s)), "a tapped hole's callout gives the thread size", { t1 }, img1);
  check("B4", t1.some(s => /2\s*[×x]/.test(s)), "two equal holes of one feature read 2×", { t1 }, img1);
  // B8: callout on the Ø16 hole made by a sketched cut.
  await tool("hole");
  await click(...pt.at(-25 + 8 * c45, 8 * c45));
  await click(...pt.at(-45, 30));
  await pg.keyboard.press("Escape");
  const h2 = (await of("hole")).find(h => h.id !== h1?.id), t2 = h2 ? await textIn(h2.id) : [];
  check("B8", t2.some(s => /Ø\s*16/.test(s) && /THRU/i.test(s)), "a hole cut by a sketch gets a callout from the geometry", { t2 }, await snap(pg, "callout-cut"));
  // A8: section A-A through the cut hole, then a dimension between the two walls on the cut face.
  await menuItem("section", '[data-cut="h"]');
  await click(...pt.at(-25, 1));
  await pg.waitForTimeout(600);
  const place = [pt.x, pt.y - 75];
  await pg.mouse.move(...(await at(place[0], place[1] + 5)));
  await pg.mouse.move(...(await at(...place)));
  await pg.waitForTimeout(1500);
  await clickAt(pg, await at(...place));
  await drw.ready();
  await pg.waitForTimeout(800);
  const sec = (await drw.views()).find(v => v.kind === "section");
  const ps = sec && (await drw.pl(sec.id)), vm = ps ? (ps.box[1] + ps.box[3]) / 2 : 0;
  let d = null;
  for (const sgn of [1, -1]) {
    if (!ps) break;
    const n0 = (await of("dim")).length;
    await cmdA("dim");
    await click(...ps.at(sgn * (-25 - 8), vm));
    await click(...ps.at(sgn * (-25 + 8), vm));
    await click(...ps.at(sgn * -25, vm - 25));
    await pg.keyboard.press("Escape");
    await pg.keyboard.press("Escape");
    const ds = await of("dim");
    if (ds.length > n0) { d = ds.at(-1); if ((await textIn(d.id)).some(s => /16/.test(s))) break; }
  }
  check("A8", !!d && (await textIn(d.id)).some(s => /16/.test(s)), "a dimension between the hole's walls on the section reads 16", { dim: d, text: d ? await textIn(d.id) : [] }, await snap(pg, "section-dim"));
  // A10: half section through the cut hole (vertical cut to its centre, then the step), placed right of the top view.
  await menuItem("section", '[data-cut="half"]');
  await click(...pt.at(-25, 25));
  await click(...pt.at(-25, 0));
  await click(...pt.at(-45, 0));
  await pg.waitForTimeout(600);
  const placeH = [pt.x + 120, pt.y];
  await pg.mouse.move(...(await at(placeH[0] - 5, placeH[1])));
  await pg.mouse.move(...(await at(...placeH)));
  await pg.waitForTimeout(1500);
  await clickAt(pg, await at(...placeH));
  await drw.ready();
  await pg.waitForTimeout(800);
  const halves = (await drw.views()).filter(v => v.kind === "section" && v.id !== sec?.id);
  const hatch = await pg.evaluate(() => window.__sv.drw.prims().filter(p => p.layer === "HATCH" || p.pen === "hatch").length);
  check("A10", halves.length === 1 && !!halves[0].path, "a half section is made from three clicks and placed", { half: halves[0], hatch }, await snap(pg, "half-section"));
  // A11: the cuts miss the tapped holes (they are 50 mm behind B-B and 15 mm off A-A): no thread lines in either section.
  const threadsIn = async id => { const p = await drw.pl(id), hw = (p.box[2] - p.box[0]) / 2 * p.s + 1, hh = (p.box[3] - p.box[1]) / 2 * p.s + 1; return pg.evaluate(([x, y, hw, hh]) => window.__sv.drw.prims().filter(q => q.layer === "THREAD" && (q.p || q.o) && Math.abs((q.o ?? q.p)[0] - x) <= hw && Math.abs((q.o ?? q.p)[1] - y) <= hh).length, [p.x, p.y, hw, hh]); };
  const thr = { aa: sec ? await threadsIn(sec.id) : -1, bb: halves[0] ? await threadsIn(halves[0].id) : -1, top: await threadsIn(top.id) };
  check("A11", thr.aa === 0 && thr.bb === 0 && thr.top > 0, "threads of holes a section misses are not drawn as cut (the top view still shows them)", thr, null);
  // A9: delete the top view (the sections' parent): asked first; both go; Undo brings them back.
  const n0 = (await drw.views()).length;
  await pg.keyboard.press("Escape");

  await pg.locator(`#drw .drw-tree [data-sel="${top.id}"]`).click({ timeout: 8000 });
  await pg.waitForTimeout(300);
  await pg.keyboard.press("Delete");
  await pg.waitForTimeout(500);
  const asked = await pg.isVisible("dialog[open]");
  if (asked) await pg.click("#confirm [data-a=ok]");
  await pg.waitForTimeout(800);
  const n1 = (await drw.views()).length;
  await pg.keyboard.press("Control+z");
  await pg.waitForTimeout(1200);
  const n2 = (await drw.views()).length;
  if (process.env.DBG) await dbg({ pg, drw });
  check("A9", asked && n1 < n0 - 1 && n2 === n0, "deleting a section's parent asks, removes both, Undo brings them back", { asked, n0, n1, n2 }, await snap(pg, "parent-deleted-undone"));
}
export async function dbg({ pg, drw }) {
  const v = (await drw.views()).find(v => v.kind === "section" && v.path);
  const p = await drw.pl(v.id);
  const b = [p.x + (p.box[0] - (p.box[0] + p.box[2]) / 2) * p.s - 1, p.y + (p.box[1] - (p.box[1] + p.box[3]) / 2) * p.s - 1, p.x + (p.box[2] - (p.box[0] + p.box[2]) / 2) * p.s + 1, p.y + (p.box[3] - (p.box[1] + p.box[3]) / 2) * p.s + 1];
  const r = await pg.evaluate(b => window.__sv.drw.prims().filter(q => q.p && q.p.length >= 4 && q.p[0] >= b[0] && q.p[0] <= b[2] && q.p[1] >= b[1] && q.p[1] <= b[3] && q.layer !== "HATCH").map(q => `${q.t} ${q.pen ?? ""} ${q.layer ?? ""} ${q.p.slice(0, 8).map(x => (+x).toFixed(1)).join(",")}`), b);
  console.log(JSON.stringify({ v, p, b }), "\n" + r.join("\n"));
}
