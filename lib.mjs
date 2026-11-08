// Drives MöbiusCAD the way a user does: mouse clicks on the screen, keys, typed values.
// window.__sv is used only to READ where things are on screen (what a user sees), never to make geometry.
import { chromium } from "playwright";
import fs from "node:fs";
export const OUT = "/tmp/claude-0/exam/out";
export const FILES = "/mnt/project-files/leuenberger";
export const stats = { clicks: 0, keys: 0, travel: 0, last: null, notes: [] };
export async function start(name) {
  const browser = await chromium.launch({ args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
  // Headless Chromium cannot answer the native save dialog: behave like a browser without the File System Access API.
  await ctx.addInitScript(() => { delete window.showSaveFilePicker; delete window.showOpenFilePicker; });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", e => errs.push("PAGEERROR " + e.message));
  page.on("console", m => { if (m.type() === "error") errs.push("console " + m.text()); });
  page.on("dialog", d => { const a = globalThis.__dlgAnswer; globalThis.__dlgAnswer = undefined; if (a !== undefined) d.accept(a); else { errs.push("DIALOG " + d.message()); d.accept(); } });
  await page.goto("http://localhost:5173/index.html?debug");
  await page.evaluate(() => localStorage.setItem("sv:tips", "off"));
  await page.goto("http://localhost:5173/index.html?debug");
  await page.waitForFunction(() => window.__sv);
  const u = mkUser(page, name);
  return { browser, page, errs, u };
}
function mkUser(page, name) {
  let shot = 0;
  const move = async (x, y) => {
    if (stats.last) stats.travel += Math.hypot(x - stats.last[0], y - stats.last[1]);
    stats.last = [x, y];
    await page.mouse.move(x, y, { steps: 2 });
  };
  const u = {
    page,
    async shot(tag) { const f = `${OUT}/${name}-${String(++shot).padStart(2, "0")}-${tag}.png`; await page.screenshot({ path: f }); return f; },
    async idle() { await page.waitForFunction(() => document.querySelector("#mc-busy")?.hidden !== false, null, { timeout: 120000 }); await page.waitForTimeout(150); },
    /** screen point of a sketch-plane point (what a user sees on screen) */
    async sk2px(p) {
      return page.evaluate(p => {
        const v = window.__sv.viewer, f = window.__sv.model.editor().frame;
        const w = [0, 1, 2].map(i => f.o[i] + f.x[i] * p[0] + f.y[i] * p[1]);
        const q = new (v.camera.position.constructor)(...w).project(v.camera), r = v.renderer.domElement.getBoundingClientRect();
        return [r.left + ((q.x + 1) / 2) * r.width, r.top + ((1 - q.y) / 2) * r.height];
      }, p);
    },
    /** sketch coordinates of a world point on the active sketch plane */
    async w2sk(p) {
      return page.evaluate(p => {
        const f = window.__sv.model.editor().frame, d = [0, 1, 2].map(i => p[i] - f.o[i]);
        const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        return [dot(d, f.x), dot(d, f.y)];
      }, p);
    },
    async w2px(p) {
      return page.evaluate(p => {
        const v = window.__sv.viewer;
        const q = new (v.camera.position.constructor)(...p).project(v.camera), r = v.renderer.domElement.getBoundingClientRect();
        return [r.left + ((q.x + 1) / 2) * r.width, r.top + ((1 - q.y) / 2) * r.height];
      }, p);
    },
    async clickPx(x, y, opt = {}) { await move(x + 3, y); await move(x, y); await page.waitForTimeout(40); await page.mouse.down(opt); await page.mouse.up(opt); stats.clicks++; await page.waitForTimeout(80); },
    async dblPx(x, y) { await move(x, y); await page.mouse.dblclick(x, y); stats.clicks += 2; await page.waitForTimeout(80); },
    async canvasRect() { return page.evaluate(() => { const r = window.__sv.viewer.renderer.domElement.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; }); },
    /** a user zooms out (wheel) until the place to click is on screen */
    async ensureVisible(toPx, p) {
      for (let i = 0; i < 12; i++) {
        const [x, y] = await toPx(p), c = await u.canvasRect();
        if (x > c.l + 30 && x < c.r - 30 && y > c.t + 30 && y < c.b - 30) return [x, y];
        await move((c.l + c.r) / 2, (c.t + c.b) / 2); await page.mouse.wheel(0, 300); stats.keys++; await page.waitForTimeout(250);
      }
      return toPx(p);
    },
    /** zoom (mouse wheel at the place) until a sketch box fills about half of the view */
    async zoomSk(a, b) {
      for (let i = 0; i < 20; i++) {
        const [x0, y0] = await u.sk2px(a), [x1, y1] = await u.sk2px(b), c = await u.canvasRect();
        const f = Math.max(Math.abs(x1 - x0) / (c.r - c.l), Math.abs(y1 - y0) / (c.b - c.t));
        const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
        const inside = cx > c.l && cx < c.r && cy > c.t && cy < c.b;
        if (f > 0.35 && f < 0.75 && inside) return;
        await move(inside ? cx : (c.l + c.r) / 2, inside ? cy : (c.t + c.b) / 2);
        await page.mouse.wheel(0, f <= 0.35 ? -240 : 240); stats.keys++; await page.waitForTimeout(200);
      }
    },    async zoomW(a, b) {
      for (let i = 0; i < 20; i++) {
        const [x0, y0] = await u.w2px(a), [x1, y1] = await u.w2px(b), c = await u.canvasRect();
        const f = Math.max(Math.abs(x1 - x0) / (c.r - c.l), Math.abs(y1 - y0) / (c.b - c.t));
        const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
        const inside = cx > c.l && cx < c.r && cy > c.t && cy < c.b;
        if (f > 0.35 && f < 0.75 && inside) return;
        await move(inside ? cx : (c.l + c.r) / 2, inside ? cy : (c.t + c.b) / 2);
        await page.mouse.wheel(0, f <= 0.35 ? -240 : 240); stats.keys++; await page.waitForTimeout(200);
      }
    },

    async toSelect() {
      for (let i = 0; i < 3; i++) {
        const st = await page.evaluate(() => { const e = window.__sv.model.editor(); return e ? { tool: e.tool, sel: e.selection.size, busy: e.draft.pts.length + e.dimDraft.picks.length } : null; });
        if (!st || (st.tool === "select" && !st.sel && !st.busy)) return;
        await u.key("Escape");
      }
    },
    async sk(p) { const [x, y] = await u.ensureVisible(u.sk2px, p); await u.clickPx(x, y); },
    async hoverSk(p) { const [x, y] = await u.sk2px(p); await move(x + 2, y); await move(x, y); await page.waitForTimeout(60); },
    async w(p) { const [x, y] = await u.ensureVisible(u.w2px, p); await u.clickPx(x, y); },
    async tool(id) {
      if (await page.isVisible(`#mc-tools [data-c="sk:${id}"]`)) { await u.el(`#mc-tools [data-c="sk:${id}"]`); return; }
      const groups = { line: ["line", "spline"], rect: ["rect", "crect", "polygon"], circle: ["circle", "circle3", "ellipse", "earc"], arc: ["arc", "arc3"], trim: ["trim", "extend", "split"], fillet: ["fillet", "chamfer"], offset: ["offset", "convert", "intersect"], dim: ["dim", "hord", "vord"], point: ["point", "text"] };
      const g = Object.entries(groups).find(([, v]) => v.includes(id))[0];
      await u.el(`#mc-tools [data-fly="${g}"]`);
      const i = groups[g].indexOf(id);
      await page.locator("#mc-menu button").nth(i).click(); stats.clicks++; await page.waitForTimeout(100);
    },
    async el(sel) { const b = await page.locator(sel).first().boundingBox(); if (b) await move(b.x + b.width / 2, b.y + b.height / 2); await page.locator(sel).first().click(); stats.clicks++; await page.waitForTimeout(80); },
    async key(k) { await page.keyboard.press(k); stats.keys++; await page.waitForTimeout(60); },
    async type(s) { await page.keyboard.type(s); stats.keys += s.length; await page.waitForTimeout(40); },
    note(s) { stats.notes.push(`[${name}] ${s}`); console.log("NOTE", s); },
    async cmd(label) {
      for (const exact of [true, false]) {
        const pick = async sel => { const t = await page.$$eval(sel, els => els.map(e => (e.querySelector(".mc-l") ?? e).textContent.trim())); return exact ? t.indexOf(label) : t.findIndex(x => x.startsWith(label)); };
        for (const tab of ["features", "sketch", "surfaces", "sheetmetal", "weldments"]) {
          if (!(await page.$(`#cm-t-${tab}`))) continue;
          if (!(await page.isVisible(`#cm-t-${tab}`))) continue;
          await page.click(`#cm-t-${tab}`);
          const i = await pick("#mc-tools [data-c]");
          if (i >= 0) { await page.locator("#mc-tools [data-c]").nth(i).click(); stats.clicks += 2; await page.waitForTimeout(150); return; }
          for (const key of await page.$$eval("#mc-tools [data-fly]", els => els.map(e => e.dataset.fly))) {
            await page.click(`#mc-tools [data-fly="${key}"]`);
            const j = await pick("#mc-menu button");
            if (j >= 0) { await page.locator("#mc-menu button").nth(j).click(); stats.clicks += 3; await page.waitForTimeout(150); return; }
            await page.keyboard.press("Escape");
          }
        }
      }
      throw new Error("No command " + label);
    },
    state() { return page.evaluate(() => { const m = window.__sv.model, l = m.last?.(); return { mode: m.mode().kind, n: m.store?.doc.features.length, vol: l?.props?.volume, bad: l?.statuses?.filter(s => !s.ok).map(s => s.code + ":" + (s.msg ?? "")) }; }); },
    skInfo() { return page.evaluate(() => { const e = window.__sv.model.editor(); return e ? { ...e.info, ents: e.sk.ents.length, dims: e.sk.dims.map(d => d.t + "=" + (+d.val.v).toFixed(3)) } : null; }); },
    async save(file) {
      const dl = page.waitForEvent("download", { timeout: 20000 }).catch(() => null);
      await page.keyboard.press("Control+s"); stats.keys++;
      await page.waitForTimeout(500);
      const d = await dl;
      if (d) { fs.mkdirSync(FILES, { recursive: true }); await d.saveAs(`${FILES}/${file}`); return `${FILES}/${file}`; }
      return null;
    },
  };
  return u;
}
export function report(name, errs) {
  const s = { part: name, clicks: stats.clicks, keys: stats.keys, travelPx: Math.round(stats.travel), notes: stats.notes, errs };
  fs.appendFileSync(`${OUT}/stats.jsonl`, JSON.stringify(s) + "\n");
  console.log(JSON.stringify(s, null, 1));
}
/** Panel field by its label text: click into it, select all, type the value (as a user does). */
export async function field(u, label, value, enter = false) {
  const page = u.page;
  const loc = page.locator("#mc-pm label.pm-field").filter({ has: page.locator(`span:text-is("${label}")`) }).locator("input, select").first();
  const tag = await loc.evaluate(e => e.tagName);
  if (tag === "SELECT") { await loc.selectOption({ label: String(value) }); }
  else { await loc.click({ clickCount: 3 }); await page.keyboard.type(String(value)); await page.keyboard.press(enter ? "Enter" : "Tab"); }
  u.page.__n = (u.page.__n ?? 0) + 1;
  await page.waitForTimeout(200);
}
export async function check(u, label, on = true) {
  const loc = u.page.locator("#mc-pm label.chk").filter({ hasText: label }).locator("input").first();
  if ((await loc.isChecked()) !== on) await loc.click();
  await u.page.waitForTimeout(200);
}
/** Hole positions: the first click on the face makes hole 1, then each position is typed in the panel. */
export async function holeAt(u, faceWorld, pts) {
  await u.w(faceWorld); await u.idle();
  for (let i = 0; i < pts.length; i++) {
    if (i > 0) { await u.el('#mc-pm [data-k="addPt"]'); await u.idle(); }
    for (const j of [0, 1]) {
      const loc = u.page.locator(`#mc-pm input[data-hp="${i}:${j}"]`);
      if (i === 0 && j === 0) await loc.click({ clickCount: 3 }); else await u.page.waitForTimeout(100);
      await u.page.keyboard.type(String(pts[i][j])); await u.page.keyboard.press("Enter"); await u.idle();
      if (process.env.DBG) console.log("hp", i, j, await u.state(), await u.page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80)));
    }
  }
}
export async function newPart(u) {
  if (await u.page.isVisible("#empty-new")) await u.el("#empty-new");
  else { await u.el("#new-part"); }
  await u.page.waitForTimeout(500);
}
export async function sketchOn(u, plane) {
  await u.cmd("Sketch"); await u.page.waitForTimeout(200);
  if (typeof plane === "string") await u.el(`#mc-tree .ft-name:text-is("${plane}")`);
  else await u.w(plane);
  await u.idle();
  await u.page.waitForFunction(() => window.__sv.model.mode().kind === "sketch" && window.__sv.model.editor(), null, { timeout: 30000 });
  await u.page.waitForTimeout(300);
}
/** Smart Dimension between sketch items at a, b (b null = one item), placed at `at`, value typed into the Modify box. */
export async function dim(u, a, b, at, value) {
  if (!(await u.page.evaluate(() => window.__sv.model.editor().tool === "dim"))) { await u.toSelect(); await u.key("d"); }
  await u.sk(a); if (b) await u.sk(b); await u.sk(at);
  await u.page.waitForTimeout(150);
  const box = u.page.locator("#sk-layer input.sk-input, .sk-input").first();
  if (await box.isVisible().catch(() => false)) { await box.fill(""); await u.type(String(value)); await u.key("Enter"); }
  else u.note("no Modify box after placing a dimension");
  await u.page.waitForTimeout(150);
}
export async function hole(u, face, kind, opts, pts) {
  await u.cmd("Hole"); await u.idle();
  await field(u, "Type", kind); await u.idle();
  for (const [k, v] of opts) { await field(u, k, v); await u.idle(); }
  await holeAt(u, face, pts);
  await u.el("#mc-pm [data-k=ok]"); await u.idle();
}
export async function extrude(u, depth, opts = []) {
  await u.cmd("Extrude"); await u.idle();
  for (const [k, v] of opts) { await field(u, k, v); await u.idle(); }
  if (depth != null) await field(u, "Depth", depth, true); else await u.el("#mc-pm [data-k=ok]");
  await u.idle();
}
/** Line chain from a clicked start: each segment typed as length + angle (deg). */
export async function chain(u, startSk, segs) {
  await u.key("l");
  await u.sk(startSk);
  let p = startSk;
  for (const [len, ang] of segs) {
    const a = ang * Math.PI / 180;
    const q = [p[0] + Math.cos(a) * len * 0.6, p[1] + Math.sin(a) * len * 0.6];
    await u.hoverSk(q);
    await u.type(String(len)); await u.key("Enter"); await u.page.keyboard.press("Control+a"); await u.type(String(ang)); await u.key("Enter");
    await u.page.waitForTimeout(120);
    p = [p[0] + Math.cos(a) * len, p[1] + Math.sin(a) * len];
  }
  await u.key("Escape");
}
/** Read what the status bar says under the pointer (snap kind + coordinates), as a user reads it. */
export async function hoverRead(u, x, y) {
  await u.page.mouse.move(x + 2, y); await u.page.mouse.move(x, y); await u.page.waitForTimeout(90);
  return u.page.evaluate(() => {
    const t = document.querySelector("#st-coord")?.textContent ?? "";
    const m = t.match(/X\s*(-?[\d.]+)\s*Y\s*(-?[\d.]+)\s*Z\s*(-?[\d.]+)/);
    return { snap: document.querySelector("#st-snap")?.textContent ?? "", p: m ? [+m[1], +m[2], +m[3]] : null };
  });
}
/**
 * Click an edge: hover candidate points on it until the status bar shows an Edge (or a point on it) under the
 * pointer at that place, turning the view a step when none is visible. `onEdge(p)` says if a 3D point is on it.
 */
export async function clickEdge(u, cands, onEdge, kinds = /Edge|Mid|Vertex|Centre|Quadrant/) {
  for (let turn = 0; turn < 6; turn++) {
    for (const w of cands) {
      const [x, y] = await u.w2px(w);
      const c = await u.canvasRect();
      if (x < c.l + 5 || x > c.r - 5 || y < c.t + 5 || y > c.b - 5) continue;
      const r = await hoverRead(u, x, y);
      if (r.p && kinds.test(r.snap) && onEdge(r.p)) { await u.clickPx(x, y); return true; }
    }
    await u.key(turn % 2 ? "ArrowUp" : "ArrowLeft"); await u.page.waitForTimeout(200);
  }
  u.note(`could not find a visible point on an edge near ${JSON.stringify(cands[0])}`);
  return false;
}
/** Points on a circle: centre, axis index (0 = X), radius. */
export const ring = (c, ax, r, n = 24) => Array.from({ length: n }, (_, i) => { const a = (i / n) * 2 * Math.PI, p = [...c]; const [i1, i2] = [0, 1, 2].filter(k => k !== ax); p[i1] += r * Math.cos(a); p[i2] += r * Math.sin(a); return p; });
export const onRing = (c, ax, r, tol = 0.3) => p => { const [i1, i2] = [0, 1, 2].filter(k => k !== ax); return Math.abs(p[ax] - c[ax]) < tol && Math.abs(Math.hypot(p[i1] - c[i1], p[i2] - c[i2]) - r) < tol; };
export async function circ(u, d, c = [0, 0]) { await u.key("c"); await u.sk(c); await u.hoverSk([c[0] + 3, c[1] + 2]); await u.type(String(d)); await u.key("Enter"); }
export async function ok(u) { await u.el("#mc-pm [data-k=ok]"); await u.idle(); }
export async function exitSketch(u) { await u.key("Enter"); await u.idle(); }
export async function revolveSketch(u, opts = []) { await u.cmd("Revolve"); await u.idle(); for (const [k, v] of opts) { await field(u, k, v); await u.idle(); } await ok(u); }
/** construction centreline along sketch X through the origin */
export async function centreline(u, x0 = -10, len = 40) { await u.toSelect(); await chain(u, [x0, 0], [[len, 0]]); await u.toSelect(); await u.sk([x0 + len / 2 + 1, 0]); await u.key("q"); await u.toSelect(); }
/** Turned part on the Front plane: steps [[diameter, length], ...] along +X; revolved about the closing line on the axis. */
export async function turned(u, steps) {
  const total = steps.reduce((a, s) => a + s[1], 0), dmax = Math.max(...steps.map(s => s[0]));
  await sketchOn(u, "Front (XZ)"); await u.zoomSk([-3, -dmax / 2 - 3], [total + 3, dmax / 2 + 3]);
  const segs = []; let r = 0;
  for (const [d, len] of steps) {
    const nr = d / 2;
    if (Math.abs(nr - r) > 1e-9) segs.push([+Math.abs(nr - r).toFixed(4), nr > r ? 90 : 270]);
    segs.push([len, 0]); r = nr;
  }
  segs.push([r, 270]); segs.push([total, 180]);
  await chain(u, [0, 0], segs);
  await exitSketch(u); await revolveSketch(u, [["Axis", `Line ${segs.length}`]]);
}
/** Assembly helpers: the user's clicks; window.__sv is read only to find where things are on screen. */
export async function newAsm(u) {
  await u.el("#new-more"); await u.el("#new-asm");
  await u.page.waitForFunction(() => window.__sv.asm.doc && document.querySelector("#app").classList.contains("asm"));
}
export async function asmIdle(u) {
  await u.page.waitForFunction(() => !window.__sv.asm.building && document.querySelector("#asm-busy").hidden, null, { timeout: 180000 });
  await u.page.waitForTimeout(200);
}
export async function closeMate(u) {
  if (await u.page.evaluate(() => !!window.__sv.asm.mating)) { await u.el('#asm-tools [data-ac="mate"]'); await u.page.waitForTimeout(150); }
}
export async function insertComp(u, file) {
  await closeMate(u);
  const n0 = await u.page.evaluate(() => window.__sv.asm.doc.components.length);
  const fc = u.page.waitForEvent("filechooser");
  await u.el('#asm-tools [data-ac="insert"]');
  if (await u.page.locator(".popup button, #asm-pop button, [role=menu] button").filter({ hasText: "Browse" }).count()) await u.page.locator("button", { hasText: "Browse" }).first().click();
  const ch = await fc; await ch.setFiles(`${FILES}/${file}`);
  await u.page.waitForFunction(n => window.__sv.asm.doc.components.length > n, n0, { timeout: 60000 });
  await asmIdle(u);
  return u.page.evaluate(() => window.__sv.asm.doc.components.length - 1);
}
/** Move a component by typing its pose (X Y Z mm, rotations deg), picked from its tree row. */
export async function pose(u, idx, p) {
  await closeMate(u);
  await u.el(`#asm-tree .ft-comp >> nth=${idx}`);
  await u.el('#asm-tools [data-ac="move"]');
  const keys = ["x", "y", "z", "rx", "ry", "rz"];
  for (let i = 0; i < keys.length; i++) {
    if (p[i] == null) continue;
    const inp = u.page.locator(`#asm-pm input[data-pose="${keys[i]}"]`);
    await inp.click({ clickCount: 3 }); await u.type(String(p[i]));
  }
  await u.key("Enter"); await asmIdle(u);
}
/** World point of a point given in a component's own coordinates. */
export async function cw(u, idx, p) {
  return u.page.evaluate(([i, p]) => { const t = window.__sv.asm.doc.components[i].tf; return [0, 1, 2].map(r => t[r * 4] * p[0] + t[r * 4 + 1] * p[1] + t[r * 4 + 2] * p[2] + t[r * 4 + 3]); }, [idx, p]);
}
export async function mateInfo(u) {
  return u.page.evaluate(() => { const m = window.__sv.asm.mating; return m ? { a: m.a?.face, b: m.b?.face, type: m.type, problem: m.problem, boxes: [...document.querySelectorAll("#asm-pm .pm-box")].map(e => e.textContent) } : null; });
}
/** One mate: click face A then face B (points in each component's own coordinates, each in its own view),
 *  check the type the panel chose (or pick `type`), ✓. The Mate panel stays open for the next one. */
export async function settle(u) {
  const cam = () => u.page.evaluate(() => { const p = window.__sv.viewer.camera.position; return [p.x, p.y, p.z]; });
  let a = await cam();
  for (let i = 0; i < 40; i++) { await u.page.waitForTimeout(300); const b = await cam(); if (b.every((v, k) => Math.abs(v - a[k]) < 1e-3)) return; a = b; }
}
export async function mate(u, A, B, type, value, more = [], expect = null) {
  if (!(await u.page.evaluate(() => !!window.__sv.asm.mating))) { await u.el('#asm-tools [data-ac="mate"]'); await u.page.waitForTimeout(150); }
  const picks = async list => { for (const [view, idx, p, zoom] of list) {
    if (view) { for (const k of [view].flat()) { await u.key(k); await u.page.waitForTimeout(k.startsWith("Arrow") ? 700 : 350); } await settle(u); }
    let w = typeof p === "function" ? await p() : await cw(u, idx, p);
    if (zoom) { await u.zoomW(w.map(v => v - zoom), w.map(v => v + zoom)); w = typeof p === "function" ? await p() : w; }
    const count = () => u.page.evaluate(() => { const m = window.__sv.asm.mating; return (m?.a ? 1 : 0) + (m?.b ? 1 : 0) + (m?.c ? 1 : 0) + (m?.d ? 1 : 0); });
    const n0 = await count();
    for (let k = 0; k < 3; k++) {
      await u.page.waitForTimeout(250 + k * 400);
      const [x, y] = await u.ensureVisible(u.w2px, w);
      await u.clickPx(x, y); await u.page.waitForTimeout(250);
      if (process.env.DBG) { console.log("pick", JSON.stringify({ w: w.map(v => +v.toFixed(2)), x, y, cam: await u.page.evaluate(() => { const p = window.__sv.viewer.camera.position; return [p.x, p.y, p.z].map(v => +v.toFixed(1)); }), mi: (await mateInfo(u))?.boxes })); await u.shot("pick"); }
      if ((await count()) > n0) break;
    }
  } };
  await picks([A, B]);
  let mi = await mateInfo(u); if (process.env.DBG) { console.log("picked", JSON.stringify(mi)); await u.shot("picked"); }
  let align; if (type && type.includes(":")) [type, align] = type.split(":");
  if (type && mi?.type !== type) { await u.el(`#asm-pm [data-mt="${type}"]`); await u.page.waitForTimeout(150); }
  if (align) { await u.el(`#asm-pm [data-al="${align}"]`); await u.page.waitForTimeout(150); }
  if (more.length) { await picks(more); mi = await mateInfo(u); }
  if (value != null) { const vi = u.page.locator("#asm-pm input[data-mv], #asm-pm input[data-a=value], #asm-pm .pm-in input").first(); await vi.click({ clickCount: 3 }); await u.type(String(value)); await u.key("Tab"); }
  mi = await mateInfo(u);
  if (expect && !expect.every((e, i) => (mi?.boxes?.[i] ?? "").includes(e))) { console.log("wrong picks", JSON.stringify(mi)); await u.shot("wrong-picks"); throw new Error("wrong picks: " + JSON.stringify(mi?.boxes)); }
  if (process.env.DBG) { console.log("before ok", JSON.stringify(mi)); await u.shot("mate"); }
  if (await u.page.locator("#asm-pm [data-a=ok]").isDisabled()) { console.log("ok disabled", JSON.stringify(mi)); await u.shot("mate-disabled"); throw new Error("mate not ready"); }
  await u.el("#asm-pm [data-a=ok]"); await asmIdle(u);
  const after = await u.page.evaluate(() => ({ n: window.__sv.asm.doc.mates.length, problem: window.__sv.asm.mating?.problem ?? "", status: document.querySelector("#asm-status").textContent }));
  console.log("mate", JSON.stringify(mi), JSON.stringify(after));
  return after;
}

/** A point on the wall of a vertical (Z) hole that the camera can see: the far side, just under the rim. */
export async function holeWall(u, idx, c, r, z) {
  const W = await cw(u, idx, [c[0], c[1], z]);
  const cam = await u.page.evaluate(() => { const p = window.__sv.viewer.camera.position; return [p.x, p.y, p.z]; });
  const h = [cam[0] - W[0], cam[1] - W[1]], l = Math.hypot(h[0], h[1]);
  return [W[0] - (r * h[0]) / l, W[1] - (r * h[1]) / l, W[2]];
}
/** A point on the outside of a vertical cylinder that faces the camera. */
export async function cylSide(u, idx, c, r, z) {
  const W = await cw(u, idx, [c[0], c[1], z]);
  const cam = await u.page.evaluate(() => { const p = window.__sv.viewer.camera.position; return [p.x, p.y, p.z]; });
  const h = [cam[0] - W[0], cam[1] - W[1]], l = Math.hypot(h[0], h[1]);
  return [W[0] + (r * h[0]) / l, W[1] + (r * h[1]) / l, W[2]];
}
/** A point on a cylinder wall about any world axis: the side facing the camera (outside) or the far side (inside a hole). */
export async function wall(u, C, axis, r, far) {
  const cam = await u.page.evaluate(() => { const p = window.__sv.viewer.camera.position; return [p.x, p.y, p.z]; });
  const d = [0, 1, 2].map(i => cam[i] - C[i]), al = Math.hypot(...axis), a = axis.map(v => v / al);
  const k = d[0] * a[0] + d[1] * a[1] + d[2] * a[2];
  const h = d.map((v, i) => v - k * a[i]), l = Math.hypot(...h), s = far ? -1 : 1;
  return C.map((v, i) => v + (s * r * h[i]) / l);
}
