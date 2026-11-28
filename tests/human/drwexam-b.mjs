// B. Hole callouts.
import { clickAt, dblAt } from "./lib.mjs";
export default async function ({ pg, drw, snap, check, tool, click, at, vs }) {
  const top = vs.find(v => v.side && v.side[1] === -1), front = vs.find(v => !v.parent);
  const pt = await drw.pl(top.id), pf = await drw.pl(front.id);
  const c45 = Math.SQRT1_2;
  const holes = async () => (await drw.annots()).filter(a => a.t === "hole");
  const textNear = async (id) => {
    const b = await drw.hit(id);
    return b ? pg.evaluate(b => window.__sv.drw.prims().filter(p => p.t === "t" && p.x >= b[0] - 1 && p.x <= b[2] + 1 && p.y >= b[1] - 1 && p.y <= b[3] + 1).map(p => p.s), b) : [];
  };
  // B1: plain Ø6.6 through hole on the top view.
  await tool("hole");
  await click(pt.x + (25 + 3.3 * c45) * pt.s, pt.y + 3.3 * c45 * pt.s);
  await click(pt.x + 45 * pt.s, pt.y + 22 * pt.s);
  await pg.waitForTimeout(500);
  let hs = await holes();
  const h1 = hs[0], t1 = h1 ? await textNear(h1.id) : [];
  const img1 = await snap(pg, "callout-plain");
  check("B1", hs.length === 1 && t1.some(s => /Ø\s*6[.,]6/.test(s) && /THRU/i.test(s)), "a plain through hole's callout reads Ø6.6 THRU", { t1, h1 }, img1);
  // B2: counterbore on the top view: big circle edge (r 5.5 or so).
  const cbR = await pg.evaluate(() => { const f = window.__sv.drw.doc(); return null; });
  await tool("hole");
  await click(pt.x + (-25 + 3.3 * c45) * pt.s, pt.y - 3.3 * c45 * pt.s);
  await click(pt.x - 45 * pt.s, pt.y - 22 * pt.s);
  await pg.waitForTimeout(500);
  hs = await holes();
  const h2 = hs.find(h => h.id !== h1?.id), t2 = h2 ? await textNear(h2.id) : [];
  const img2 = await snap(pg, "callout-cbore");
  check("B2", t2.some(s => /⌴/.test(s)) && t2.some(s => /Ø\s*6[.,]6/.test(s)), "the counterbore callout has the drill Ø and a ⌴ line", { t2 }, img2);
  // B5: on the front view, the plain hole seen from the side (hidden lines): click its left wall.
  await tool("hole");
  await click(...pf.at(25 - 3.3, 10));
  await click(...pf.at(60, 35));
  await pg.waitForTimeout(500);
  hs = await holes();
  const h3 = hs.find(h => h.id !== h1?.id && h.id !== h2?.id), t3 = h3 ? await textNear(h3.id) : [];
  check("B5", !!h3 && t3.some(s => /Ø\s*6[.,]6/.test(s)), "a hole seen from the side takes a callout too", { t3, h3 }, await snap(pg, "callout-side"));
  await pg.keyboard.press("Escape");
  // B6: double-click the first callout, add a line below, OK.
  const b1 = await drw.hit(h1.id);
  await dblAt(pg, await at((b1[0] + b1[2]) / 2, (b1[1] + b1[3]) / 2));
  const dlg = await pg.waitForSelector("#drw-hole-dlg[open]", { timeout: 5000 }).catch(() => null);
  if (dlg) {
    await pg.fill('#drw-hole-dlg [data-h="below"]', "DEBURR");
    await pg.waitForTimeout(200);
    await pg.click('#drw-hole-dlg button[value="ok"]');
    await pg.waitForTimeout(500);
  }
  const h1b = (await holes()).find(h => h.id === h1.id);
  check("B6", !!dlg && h1b?.below === "DEBURR" && (await textNear(h1.id)).includes("DEBURR"), "double-click opens the callout dialog; a line added below stays after OK", { below: h1b?.below }, await snap(pg, "callout-edited"));
  // B7: drag the callout text: the leader stays on the hole (ref unchanged), the text moves.
  const b1b = await drw.hit(h1.id), from = await at((b1b[0] + b1b[2]) / 2, (b1b[1] + b1b[3]) / 2);
  await pg.waitForTimeout(700);
  await pg.mouse.move(...from); await pg.mouse.down();
  await pg.mouse.move(from[0] + 30, from[1] - 20, { steps: 5 }); await pg.mouse.up();
  await pg.waitForTimeout(600);
  const h1c = (await holes()).find(h => h.id === h1.id);
  check("B7", JSON.stringify(h1c.pos) !== JSON.stringify(h1b.pos) && JSON.stringify(h1c.ref) === JSON.stringify(h1b.ref), "a dragged callout moves its text, the leader stays on the hole", { before: h1b.pos, after: h1c.pos }, await snap(pg, "callout-dragged"));
  globalThis.T.h1 = h1; globalThis.T.h2 = h2; globalThis.T.h3 = h3;
}
