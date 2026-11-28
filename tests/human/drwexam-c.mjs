// C. Geometric tolerances and datums.
import { clickAt, dblAt } from "./lib.mjs";
import { readFileSync } from "node:fs";
export default async function ({ pg, drw, snap, check, tool, cmdA, click, at, vs }) {
  const top = vs.find(v => v.side && v.side[1] === -1), front = vs.find(v => !v.parent);
  const pt = await drw.pl(top.id), pf = await drw.pl(front.id);
  const of = async k => (await drw.annots()).filter(a => a.t === k);
  const mid = async id => { const b = await drw.hit(id); return at((b[0] + b[2]) / 2, (b[1] + b[3]) / 2); };
  const okDlg = async () => { await pg.click('#drw-gtol-dlg button[value="ok"]'); await pg.waitForTimeout(500); };
  // A dimension on the top view's upper edge (100), placed above it.
  await cmdA("dim");
  await click(pt.x + 10 * pt.s, pt.y - 30 * pt.s);
  await click(pt.x + 10 * pt.s, pt.y - 42 * pt.s);
  await pg.waitForTimeout(400);
  await pg.keyboard.press("Escape");
  const dim = (await of("dim"))[0];
  // C1/C2/C4: the Geometric tolerance tool clicked on the dimension's text: the dialog; parallelism 0.05 to A, Ø via the button.
  await tool("gtol");
  await pg.waitForTimeout(200);
  await clickAt(pg, await mid(dim.id));
  const dlg = await pg.waitForSelector("#drw-gtol-dlg[open]", { timeout: 6000 }).catch(() => null);
  if (dlg) {
    if (!(await pg.isVisible('#drw-gtol-dlg .gt-pal'))) await pg.click('#drw-gtol-dlg [data-sym="0"]');
    await pg.click('#drw-gtol-dlg .gt-pal [data-pick="pos"]');
    await pg.keyboard.type("0.05");
    await pg.keyboard.press("Home");
    await pg.click('#drw-gtol-dlg [data-ins="Ø"]');
    await pg.keyboard.press("End");
    await pg.click('#drw-gtol-dlg [data-ins="Ⓜ"]');
    await pg.fill('#drw-gtol-dlg [data-g="0:d0"]', "A");
    await pg.fill('#drw-gtol-dlg [data-g="0:d1"]', "B");
    await okDlg();
  }
  await pg.keyboard.press("Escape");
  let g = await of("gtol");
  const g1 = g[0];
  const img1 = await snap(pg, "gtol-on-dim");
  check("C1", !!dlg && g.length === 1 && g1.rows[0].sym === "pos", "the tool clicked on a dimension opens the dialog, OK adds a position frame", { g1 }, img1);
  check("C2", g1 && /Ø/.test(g1.rows[0].tol) && /0[.,]05/.test(g1.rows[0].tol) && /Ⓜ/.test(g1.rows[0].tol) && g1.rows[0].datums[0] === "A" && g1.rows[0].datums[1] === "B", "Ø and Ⓜ from the buttons, datums A and B in their cells", { row: g1?.rows[0] }, img1);
  check("C4", g1?.dim === dim.id, "the frame is attached under the dimension", { dim: g1?.dim, id: dim.id }, img1);
  // C4 moving: drag the dimension, the frame comes along.
  const gb0 = await drw.hit(g1.id), from = await mid(dim.id);
  await pg.waitForTimeout(700);
  await pg.mouse.move(...from); await pg.mouse.down(); await pg.mouse.move(from[0] + 10, from[1] + 25, { steps: 5 }); await pg.mouse.up();
  await pg.waitForTimeout(600);
  const gb1 = await drw.hit(g1.id);
  check("C4-move", gb0 && gb1 && Math.abs(gb1[1] - gb0[1]) > 2, "dragging the dimension takes the frame along", { gb0, gb1 }, await snap(pg, "gtol-dim-moved"));
  // C3: datum on the front view's bottom edge, then another on its left edge.
  await pg.keyboard.press("Escape");
  const pr = await drw.pl(vs.find(v => v.side && v.side[0] === 1).id);
  for (const [e, p] of [[pr.at(-20, 0), pr.at(-20, -14)], [pr.at(30, 8), pr.at(42, 8)]]) {
    await tool("datum");
    await click(...e);
    await click(...p);
    await pg.waitForTimeout(300);
    await pg.keyboard.press("Escape");
  }
  const ds = await of("datum");
  // Datums and section views share one run of letters (drawings exam #6), so after sections A-A and B-B they are C, D.
  const used = (await drw.views()).map(v => v.letter).filter(Boolean).sort(), a0 = used.length ? String.fromCharCode(used.at(-1).charCodeAt(0) + 1) : "A";
  check("C3", ds.length === 2 && ds[0].letter === a0 && ds[1].letter === String.fromCharCode(a0.charCodeAt(0) + 1), "datum feature symbols on two edges get the next two letters (A, B on a sheet with no sections)", { letters: ds.map(d => d.letter) }, await snap(pg, "datums"));
  // C5: a frame with a leader to the front view's top edge, dragged: the leader stays on the edge.
  await tool("gtol");
  await click(...pf.at(5, 20));
  await click(...pf.at(5, 40));
  const dlg2 = await pg.waitForSelector("#drw-gtol-dlg[open]", { timeout: 6000 }).catch(() => null);
  if (dlg2) {
    if (!(await pg.isVisible('#drw-gtol-dlg .gt-pal'))) await pg.click('#drw-gtol-dlg [data-sym="0"]');
    await pg.click('#drw-gtol-dlg .gt-pal [data-pick="flat"]');
    await pg.fill('#drw-gtol-dlg [data-g="0:tol"]', "0.02");
    await okDlg();
  }
  await pg.keyboard.press("Escape");
  g = await of("gtol");
  const g2 = g.find(x => x.id !== g1.id);
  const f0 = await mid(g2.id);
  await pg.waitForTimeout(700);
  await pg.mouse.move(...f0); await pg.mouse.down(); await pg.mouse.move(f0[0] + 40, f0[1] - 10, { steps: 5 }); await pg.mouse.up();
  await pg.waitForTimeout(600);
  const g2b = (await of("gtol")).find(x => x.id === g2.id);
  check("C5-form", !!g2 && g2.rows[0].sym === "flat" && !g2.rows[0].datums.length, "flatness takes no datum: the datum the new frame had goes when Flatness is picked", { row: g2?.rows[0] }, null);
  check("C5", !!g2?.leader && JSON.stringify(g2b.leader) === JSON.stringify(g2.leader) && JSON.stringify(g2b.pos) !== JSON.stringify(g2.pos), "a frame with a leader to an edge: dragging moves the frame, the leader stays on the edge", { g2, g2b }, await snap(pg, "gtol-leader"));
  // C6: double-click opens it; a changed value and Cancel leaves it as it was.
  await pg.waitForTimeout(700);
  await dblAt(pg, await mid(g2.id));
  const dlg3 = await pg.waitForSelector("#drw-gtol-dlg[open]", { timeout: 6000 }).catch(() => null);
  if (dlg3) { await pg.fill('#drw-gtol-dlg [data-g="0:tol"]', "0.9"); await pg.click("#drw-gtol-dlg [data-cancel]"); await pg.waitForTimeout(400); }
  const g2c = (await of("gtol")).find(x => x.id === g2.id);
  check("C6", !!dlg3 && g2c.rows[0].tol === "0.02", "double-click edits the frame; Cancel keeps it as it was", { tol: g2c.rows[0].tol }, await snap(pg, "gtol-cancel"));
  // C8: Export ▸ SVG holds the frames' text.
  await pg.keyboard.press("Escape");
  const dl = pg.waitForEvent("download", { timeout: 30000 }).catch(() => null);
  await pg.click('#drw [data-a="export"]');
  await pg.click('#drw [data-x="svg"]');
  const d = await dl;
  let svg = "";
  if (d) { const p = `${process.env.HT_OUT}/exam.svg`; await d.saveAs(p); svg = readFileSync(p, "utf8"); }
  check("C8", /0[.,]05/.test(svg) && /0[.,]02/.test(svg) && />A</.test(svg), "the SVG export has the frames and datum letters", { bytes: svg.length }, null);
  // C7: select the dimension, Delete: the frame on it goes too; Ctrl+Z brings both back.
  await clickAt(pg, await mid(dim.id));
  await pg.waitForTimeout(300);
  await pg.keyboard.press("Delete");
  await pg.waitForTimeout(500);
  const after = await drw.annots();
  await pg.keyboard.press("Control+z");
  await pg.waitForTimeout(500);
  const back = await drw.annots();
  check("C7", !after.some(a => a.id === dim.id || a.id === g1.id) && back.some(a => a.id === dim.id) && back.some(a => a.id === g1.id), "deleting a dimension removes its frame; Undo brings both back", { after: after.map(a => a.t), back: back.map(a => a.t) }, await snap(pg, "undo-delete"));
  globalThis.T.dim = dim; globalThis.T.g1 = g1;
}
