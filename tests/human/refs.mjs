// Assemblies that reference part files (FR-ASM-003), by hand: Save beside the parts, Open part, a part changed in
// its own file, renamed / moved / deleted / replaced part files, Pack and Go and opening the packed folder.
// The folder picker is the browser's private file system (`?asmfolder=`); what a person does to files outside the
// app (renaming one in the file manager) is done to that folder directly.
import { mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { open, snap, idle, check, finish, makeBlock, openFiles, cmd, clickAt, screenOf, OUT } from "./lib.mjs";
const FOLDER = "refs-ht";
const TMP = process.env.HT_TMP || "/tmp/refs-ht";
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const only = process.env.REFS_ONLY ? new Set(process.env.REFS_ONLY.split(",")) : null;
const want = id => !only || only.has(id);

let { browser, pg } = await open("refs", `&asmfolder=${FOLDER}`);
pg.on("dialog", d => d.accept());
await pg.evaluate(async f => { await (await navigator.storage.getDirectory()).removeEntry(f, { recursive: true }).catch(() => {}); }, FOLDER);

const disk = (p = pg, folder = FOLDER) => p.evaluate(async f => {
  const out = {};
  const walk = async (d, at) => { for await (const [n, h] of d.entries()) { const k = at ? `${at}/${n}` : n; if (h.kind === "file") out[k] = (await h.getFile()).size; else await walk(h, k); } };
  await walk(await (await navigator.storage.getDirectory()).getDirectoryHandle(f, { create: true }), "");
  return out;
}, folder);
/** A file of the folder copied out to the computer's disk, so File ▸ Open can pick it. */
const fetchOut = async (name, to = `${TMP}/${name.split("/").at(-1)}`) => {
  const data = await pg.evaluate(async ({ f, n }) => {
    let d = await (await navigator.storage.getDirectory()).getDirectoryHandle(f);
    const parts = n.split("/"); const last = parts.pop();
    for (const s of parts) d = await d.getDirectoryHandle(s);
    return [...new Uint8Array(await (await (await d.getFileHandle(last)).getFile()).arrayBuffer())];
  }, { f: FOLDER, n: name });
  writeFileSync(to, Buffer.from(data));
  return to;
};
/** What a person does in the file manager: rename/move, delete, copy over. */
const fs = (op, a, b) => pg.evaluate(async ({ f, op, a, b }) => {
  const root = await (await navigator.storage.getDirectory()).getDirectoryHandle(f);
  const at = async (p, create) => { let d = root; const parts = p.split("/"); const last = parts.pop(); for (const s of parts) d = await d.getDirectoryHandle(s, { create }); return [d, last]; };
  const get = async p => { const [d, n] = await at(p, false); return new Uint8Array(await (await (await d.getFileHandle(n)).getFile()).arrayBuffer()); };
  const put = async (p, data) => { const [d, n] = await at(p, true); const w = await (await d.getFileHandle(n, { create: true })).createWritable(); await w.write(data); await w.close(); };
  const del = async p => { const [d, n] = await at(p, false); await d.removeEntry(n); };
  if (op === "move") { await put(b, await get(a)); await del(a); }
  else if (op === "copy") await put(b, await get(a));
  else if (op === "del") await del(a);
  else if (op === "junk") await put(a, new TextEncoder().encode("not a zip"));
}, { f: FOLDER, op, a, b });
const asmState = (p = pg) => p.evaluate(() => {
  const a = window.__sv.asm, d = a.doc;
  return d ? {
    title: a.title, dirty: a.dirty,
    parts: Object.fromEntries(Object.values(d.parts).map(e => [e.name, { link: e.link?.path ?? null, file: e.file ?? null, feats: e.doc?.features?.length ?? 0, desc: e.doc?.props?.description ?? "", depth: e.doc?.features?.find(f => f.type === "extrude")?.depth?.v ?? null }])),
    comps: d.components.map(c => c.name),
    bar: document.getElementById("asm-refs")?.textContent ?? null,
    marks: [...document.querySelectorAll("#asm-tree .ft-link")].map(x => x.getAttribute("title")),
  } : null;
});
const toasts = (p = pg) => p.evaluate(() => [...document.querySelectorAll(".toast")].map(x => x.textContent).join(" | "));
const clearToasts = (p = pg) => p.evaluate(() => document.querySelectorAll(".toast").forEach(x => x.remove()));
const toAsm = async (p = pg) => { await p.waitForFunction(() => document.querySelector("#app").classList.contains("asm"), null, { timeout: 30000 }); await p.waitForTimeout(1500); await idle(p); };
const treeMenu = async (name, item) => {
  await pg.locator("#asm-tree .ft-row").filter({ hasText: name }).first().click({ button: "right" });
  await pg.waitForTimeout(250);
  await pg.locator("#mc-menu button, .mc-menu button").filter({ hasText: new RegExp(`^${item}$`) }).first().click();
};
/** Changes the live part's Extrude1 depth by hand: double-click it in the Features tree, type, ✓. */
const setDepth = async v => {
  if (await pg.$("#t-features")) await pg.click("#t-features").catch(() => {});
  await pg.locator('#mc-tree .ft-row:not([data-id^="body:"])').filter({ hasText: "Extrude1" }).first().dblclick();
  const dp = await pg.waitForSelector('#mc-pm input[data-num="depth"]', { timeout: 10000 }).catch(async e => { await snap(pg, "no-depth-field"); throw e; });
  await dp.fill(String(v)); await dp.press("Enter");
  await idle(pg);
  if (await pg.isVisible("#mc-ok")) await pg.click("#mc-ok");
  await idle(pg);
};

/** The save dialog: the person picks `name` in the assembly's folder (counts how often it was asked). */
const pickerGives = name => pg.evaluate(({ f, n }) => {
  window.__asked = 0;
  window.showSaveFilePicker = async () => { window.__asked++; const d = await (await navigator.storage.getDirectory()).getDirectoryHandle(f); return d.getFileHandle(n, { create: true }); };
}, { f: FOLDER, n: name });

// ---- R1: an assembly of two parts made by hand, saved: the folder gets the assembly and each part file.
await makeBlock(pg, 100, 60, 20);   // Part1
await makeBlock(pg, 40, 40, 10);    // Part2
await pg.click("#file-btn");
await pg.click('#file-menu [data-f="asm-part"]');
await toAsm();
await pg.click('#asm-tools [data-ac="insert"]');
await pg.waitForTimeout(300);
await pg.getByText(/^Open document:.*Part1/).first().click();
await pg.waitForTimeout(800);
const vp = await pg.$eval("#viewport", e => { const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
await pg.mouse.click(vp[0] + 200, vp[1] - 120);
await pg.waitForTimeout(1500);
await idle(pg);
await pg.keyboard.press("Control+s");
await pg.waitForTimeout(600);
if (await pg.isVisible("#name-dlg[open]")) { await pg.fill("#name-dlg-in", "Gearbox.mcadasm"); await pg.keyboard.press("Enter"); }
await pg.waitForTimeout(2500);
const d1 = await disk(), s1 = await asmState();
const img1 = await snap(pg, "saved");
check("R1", d1["Part1.mcadprt"] && d1["Part2.mcadprt"] && Object.keys(d1).some(n => n.endsWith(".mcadasm")) && !s1.dirty && s1.parts.Part1?.link === "Part1.mcadprt",
  "Ctrl+S on a new assembly writes the assembly and both part files into its folder, references them and is clean", { d1, s1 }, img1);
const tabsNow = async tag => console.log("TABS", tag, JSON.stringify(await pg.evaluate(() => window.__sv.docs()?.tabs.map(x => `${x.kind}:${x.label}:${x.state?.fileName ?? "live"}:${x.state?.store?.doc?.id ?? ""}:${!!x.state?.handle}`).concat(Object.values(window.__sv.asm.doc?.parts ?? {}).map(e => e.doc?.id + ":" + e.link?.path)))));
await tabsNow("R1");
const asmFile = Object.keys(d1).find(n => n.endsWith(".mcadasm"));

// ---- R2: the same part still open in its own tab is edited and saved there: does the assembly see it?
if (want("R2")) {
  await pg.locator("#doc-tabs [data-dt]").filter({ hasText: /^Part1/ }).first().click();
  await pg.waitForFunction(() => document.querySelector("#app").classList.contains("model"), null, { timeout: 30000 });
  await idle(pg);
  await setDepth(35);
  await pickerGives("Part1.mcadprt");
  await pg.keyboard.press("Control+s");
  await pg.waitForTimeout(1200);
  const asked = await pg.evaluate(() => window.__asked);
  const got = null;
  await pg.locator("#doc-tabs [data-dt]").filter({ hasText: /^Gearbox|mcadasm|Assembly/ }).first().click();
  await toAsm();
  const s2 = await asmState(), d2 = await disk();
  const img2 = await snap(pg, "part-tab-saved");
  check("R2", asked === 0 && s2.parts.Part1.depth === 35 && d2["Part1.mcadprt"] !== d1["Part1.mcadprt"],
    "Part1 open in its own tab, changed and saved: the save goes to the file the assembly references, and the assembly shows it", { asked, download: got?.suggestedFilename() ?? null, depth: s2.parts.Part1.depth, size: [d1["Part1.mcadprt"], d2["Part1.mcadprt"]] }, img2);
}

// ---- R3: Open part from the tree, change it, save, Return to assembly.
await treeMenu("Part2", "Open part");
await pg.waitForFunction(() => window.__sv.modeller.active && window.__sv.modeller.returnTo, null, { timeout: 30000 });
await idle(pg);
await setDepth(15);
await pg.keyboard.press("Control+s");
await pg.waitForTimeout(1500);
const d3a = await disk();
await pg.click('#mc-ret [data-a="ret"]');
await toAsm();
const s3 = await asmState();
const img3 = await snap(pg, "open-part-saved");
check("R3", d3a["Part2.mcadprt"] !== d1["Part2.mcadprt"] && s3.parts.Part2.depth === 15,
  "Open part ▸ change ▸ Ctrl+S writes Part2.mcadprt; Return to assembly shows the change", { before: d1["Part2.mcadprt"], after: d3a["Part2.mcadprt"], depth: s3.parts.Part2.depth, dirty: s3.dirty }, img3);
await pg.keyboard.press("Control+s");
await pg.waitForTimeout(1500);

await fetchOut("Part2.mcadprt", `${TMP}/v15.mcadprt`);

await tabsNow("R3");
// ---- R4: Part2 changed in its own file (opened with File ▸ Open, saved); back in the assembly it updates.
await clearToasts();
await openFiles(pg, [await fetchOut("Part2.mcadprt")]);
await pg.waitForFunction(() => window.__sv.modeller.active, null, { timeout: 30000 });
await setDepth(25);
await pickerGives("Part2.mcadprt");
await pg.keyboard.press("Control+s");
await pg.waitForTimeout(1200);
const handleSave = await pg.evaluate(() => window.__asked);
const d4 = await disk();
await pg.locator("#doc-tabs [data-dt]").filter({ hasText: /Gearbox|mcadasm|Assembly/ }).first().click();
await toAsm();
const s4 = await asmState();
const img4 = await snap(pg, "changed-in-own-file");
check("R4", s4.parts.Part2.depth === 25,
  "Part2.mcadprt opened with File ▸ Open, changed and saved: the assembly shows the change when switched back to", { handleSave, size: [d3a["Part2.mcadprt"], d4["Part2.mcadprt"]], depth: s4.parts.Part2.depth, toast: await toasts() }, img4);

await tabsNow("R4");
// ---- R5: the file renamed and moved into a subfolder: the assembly opened again finds it.
const asmPath = await fetchOut(asmFile);
await fs("move", "Part1.mcadprt", "bought/Base plate.mcadprt");
await clearToasts();
await openFiles(pg, [asmPath]);
await toAsm();
await pg.waitForTimeout(1500);
const s5 = await asmState();
const img5 = await snap(pg, "moved-found");
check("R5", s5.parts.Part1.link === "bought/Base plate.mcadprt" && !s5.bar,
  "Part1.mcadprt renamed and moved into a subfolder: opening the assembly finds it by its document and says so", { s5, toast: await toasts() }, img5);
await pg.keyboard.press("Control+s");
await pg.waitForTimeout(1500);

await tabsNow("R5");
// ---- R6: a part file deleted: the bar names it, the tree marks the component, the last copy shows.
const asmPath6 = await fetchOut(asmFile);
await fs("copy", "Part2.mcadprt", "_keep.bin");
await fs("del", "Part2.mcadprt");
await clearToasts();
await openFiles(pg, [asmPath6]);
await toAsm();
await pg.waitForTimeout(1200);
const s6 = await asmState();
const img6 = await snap(pg, "missing");
check("R6", /not found/.test(s6.bar ?? "") && s6.marks.some(m => /not found/.test(m ?? "")) && s6.parts.Part2.feats > 0,
  "a deleted part file: the bar names it, the tree marks it, the last copy is still shown", { bar: s6.bar, marks: s6.marks }, img6);


// ---- R7: the file comes back with the same name but another part in it (somebody saved over it).
await fs("copy", "bought/Base plate.mcadprt", "Part2.mcadprt");
await clearToasts();
await openFiles(pg, [asmPath6]);
await toAsm();
await pg.waitForTimeout(1500);
const s7 = await asmState(), t7 = await toasts();
const img7 = await snap(pg, "other-part-same-name");
check("R7", s7.parts.Part2.depth !== 35 || /another part|different part|not the same/i.test(t7 + (s7.bar ?? "")),
  "Part2.mcadprt replaced by another part's file: the assembly does not silently swap in the other part (other CAD apps warn)", { depth: s7.parts.Part2.depth, toast: t7, bar: s7.bar }, img7);

// ---- R8: a damaged part file.
await fs("junk", "Part2.mcadprt");
await clearToasts();
await openFiles(pg, [asmPath6]);
await toAsm();
await pg.waitForTimeout(1200);
const s8 = await asmState(), t8 = await toasts();
const img8 = await snap(pg, "damaged");
check("R8", /could not|cannot|damaged|not read/i.test((s8.bar ?? "") + t8),
  "a damaged part file is reported as unreadable, not as missing", { bar: s8.bar, toast: t8 }, img8);

// A save leaves a file it could not read alone (other CAD apps do not overwrite it either).
await pg.keyboard.press("Control+s");
await pg.waitForTimeout(2000);
const d8 = await disk();
check("R8b", d8["Part2.mcadprt"] < 100, "saving the assembly does not overwrite a part file it could not read", { d8 });
// restore Part2 for the rest and open the assembly again
await fs("move", "_keep.bin", "Part2.mcadprt");
await openFiles(pg, [asmPath6]);
await toAsm();
await pg.waitForTimeout(1200);
await pg.keyboard.press("Control+s");
await pg.waitForTimeout(2000);
const d9 = await disk();

// ---- R9: Pack and Go: the zip has the assembly and its part files at their reference paths.
await pg.click("#file-btn");
await pg.click("#file-menu [data-f=pack]");
await pg.waitForSelector("#pack-dlg[open]");
const imgP = await snap(pg, "pack-dialog");
const packOpts = await pg.$$eval("#pack-dlg label", ls => ls.map(l => l.textContent.trim()));
await pg.waitForSelector("#pack-dlg tr[data-pf]", { timeout: 20000 });
const rows9 = await pg.$$eval("#pack-dlg tr[data-pf]", rs => rs.map(r => { const [f, d] = [...r.cells].map(c => c.textContent.trim()); return d === "(top)" ? f : `${d}/${f}`; }));
const [dl] = await Promise.all([pg.waitForEvent("download"), pg.click("#pack-dlg [data-a=ok]")]);
const zipPath = `${TMP}/${dl.suggestedFilename()}`;
await dl.saveAs(zipPath);
const unz = `${TMP}/unzipped`;
mkdirSync(unz, { recursive: true });
execFileSync("unzip", ["-o", "-q", zipPath, "-d", unz]);
const listing = []; const walk = (d, at = "") => { for (const n of readdirSync(d)) { const p = `${d}/${n}`; if (statSync(p).isDirectory()) walk(p, `${at}${n}/`); else listing.push(`${at}${n}`); } }; walk(unz);
check("R9", listing.includes("bought/Base plate.mcadprt") && listing.includes("Part2.mcadprt") && listing.some(n => n.endsWith(".mcadasm")),
  "Pack and Go zips the assembly with its part files at their reference paths", { listing, d9, packOpts }, imgP);
check("F4", rows9.length === listing.length && listing.every(n => rows9.includes(n)), "the Pack and Go dialog lists every file that goes into the zip, with its folder, before saving (other CAD apps: the file list)", { rows9, listing });

// ---- R12: the same assembly file opened again and again: one tab, not one per Open.
const tabs12 = await pg.$$eval("#doc-tabs [data-dt]", ts => ts.map(t => t.textContent.trim()));
const kinds12 = await pg.evaluate(() => window.__sv.docs()?.tabs.map(x => `${x.kind}:${x.label}:${x.state?.fileName ?? "live"}:${x.state?.store?.doc?.id ?? x.state?.doc?.id ?? ""}`));
check("R12", tabs12.filter(x => /Assembly1/.test(x)).length === 1, "opening an assembly that is already open goes to its tab, as in other CAD apps (no second copy)", { tabs12, kinds12 });

// ---- R10: the packed folder opened elsewhere (a new browser, the folder not known): the parts come from it.
await finish(browser, pg);
({ browser, pg } = await open("refs", "&asmfolder=refs-ht2"));
pg.on("dialog", d => d.accept());
await pg.evaluate(async files => {
  const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("refs-ht2", { create: true });
  for (const [p, data] of files) {
    let d = root; const parts = p.split("/"); const last = parts.pop();
    for (const s of parts) d = await d.getDirectoryHandle(s, { create: true });
    const w = await (await d.getFileHandle(last, { create: true })).createWritable(); await w.write(new Uint8Array(data)); await w.close();
  }
}, listing.map(n => [n, [...readFileSync(`${unz}/${n}`)]]));
await openFiles(pg, [`${unz}/${listing.find(n => n.endsWith(".mcadasm"))}`]);
await toAsm();
const s10a = await asmState();
const img10a = await snap(pg, "packed-opened");
if (await pg.isVisible('#asm-refs [data-refs="go"]')) await pg.click('#asm-refs [data-refs="go"]');
await pg.waitForTimeout(2000);
const s10 = await asmState(), t10 = await toasts();
const img10 = await snap(pg, "packed-folder-read");
check("R10", /Choose folder/.test(s10a.bar ?? "") && !s10.bar && /up to date/.test(t10),
  "the unpacked assembly opened in a fresh browser asks for its folder once, then reads every part from it", { before: s10a.bar, after: s10.bar, toast: t10 }, img10);

// ---- R11: Pack and Go with the parts unticked.
await pg.click("#file-btn");
await pg.click("#file-menu [data-f=pack]");
await pg.waitForSelector("#pack-dlg[open]");
const partsBox = await pg.$('#pack-dlg [data-pk="parts"]');
if (partsBox) await partsBox.uncheck();
const [dl2] = await Promise.all([pg.waitForEvent("download"), pg.click("#pack-dlg [data-a=ok]")]);
const zip2 = `${TMP}/noparts.zip`;
await dl2.saveAs(zip2);
const l2 = execFileSync("unzip", ["-Z1", zip2]).toString().trim().split("\n");
check("R11", l2.length === 1, "Pack and Go with the parts unticked packs the assembly alone (its copies still open it)", { l2 });

// ---- R13: changed both here (Open part, Return, not saved) and in its file: this assembly's version is kept, with a word.
await clearToasts();
await treeMenu("Part2", "Open part");
await pg.waitForFunction(() => window.__sv.modeller.active && window.__sv.modeller.returnTo, null, { timeout: 30000 });
await idle(pg);
await setDepth(40);
await pg.click('#mc-ret [data-a="ret"]');
await toAsm();
// meanwhile somebody saved Part2 with another depth: its file now holds an earlier version
await pg.evaluate(async b64 => {
  const d = await (await navigator.storage.getDirectory()).getDirectoryHandle("refs-ht2");
  const w = await (await d.getFileHandle("Part2.mcadprt")).createWritable(); await w.write(Uint8Array.from(atob(b64), c => c.charCodeAt(0))); await w.close();
}, readFileSync(`${TMP}/v15.mcadprt`).toString("base64"));
await pg.evaluate(() => window.dispatchEvent(new Event("focus")));
await pg.waitForTimeout(2000);
const s13 = await asmState(), t13 = await toasts();
const img13 = await snap(pg, "conflict");
check("R13", s13.parts.Part2.depth === 40 && /Changed both/.test(t13), "a part changed both here and in its file: this assembly's version stays and a warning says so", { depth: s13.parts.Part2.depth, toast: t13 }, img13);

// ---- R14: New part in place named like a file of another part already in the folder.
await pg.evaluate(async b64 => {
  const d = await (await navigator.storage.getDirectory()).getDirectoryHandle("refs-ht2");
  const w = await (await d.getFileHandle("Cover.mcadprt", { create: true })).createWritable(); await w.write(Uint8Array.from(atob(b64), c => c.charCodeAt(0))); await w.close();
}, readFileSync(`${TMP}/v15.mcadprt`).toString("base64"));
await pg.click('#asm-tools [data-ac="newpart"]');
await pg.waitForTimeout(400);
await pg.fill('#asm-pm [data-pn]', "Cover");
await pg.click('#asm-pm [data-a="origin"]');
await pg.waitForFunction(() => document.querySelector("#app").classList.contains("model"), null, { timeout: 30000 });
await idle(pg);
await cmd(pg, "Sketch");
await pg.waitForTimeout(300);
await pg.getByRole("button", { name: "Top (XY)" }).last().click();
await pg.waitForTimeout(1200);
await pg.click('#mc-tools [data-c="sk:rect"]');
await clickAt(pg, await screenOf(pg, [-10, -10, 0]));
await clickAt(pg, await screenOf(pg, [10, 10, 0]));
await pg.keyboard.press("Escape");
await pg.click('#mc-tools [data-c="extrude"]');
await pg.waitForTimeout(800);
const dp14 = await pg.$('#mc-pm input[data-num="depth"]');
await dp14.fill("5"); await dp14.press("Enter");
await idle(pg);
if (await pg.isVisible("#mc-ok")) await pg.click("#mc-ok");
await idle(pg);
const img14a = await snap(pg, "inplace-origin");
await pg.click('#mc-ret [data-a="ret"]').catch(() => {});
await toAsm();
await clearToasts();
await pg.keyboard.press("Control+s");
await pg.waitForTimeout(2500);
const d14 = await disk(pg, "refs-ht2"), t14 = await toasts(), s14 = await asmState();
check("R14", !d14["Cover (2).mcadprt"] || /Cover \(2\)/.test(t14), "a new part whose file name is taken by another part's file is saved under another name, and the person is told", { d14, t14, parts: s14.parts }, img14a);

// ---- R6b/R6c: a missing file: Find file… points at it elsewhere in the folder; Suppress puts the component aside.
const opfs2 = (op, a, b) => pg.evaluate(async ({ op, a, b }) => {
  const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("refs-ht2");
  const at = async (p, create) => { let d = root; const parts = p.split("/"); const last = parts.pop(); for (const s of parts) d = await d.getDirectoryHandle(s, { create }); return [d, last]; };
  if (op === "copy") { const [d, n] = await at(a, false); const data = await (await d.getFileHandle(n)).getFile(); const [d2, n2] = await at(b, true); const w = await (await d2.getFileHandle(n2, { create: true })).createWritable(); await w.write(await data.arrayBuffer()); await w.close(); }
  else if (op === "del") { const [d, n] = await at(a, false); await d.removeEntry(n); }
  else if (op === "pick") window.showOpenFilePicker = async () => { const [d, n] = await at(a, false); return [await d.getFileHandle(n)]; };
}, { op, a, b });
// the file is moved out of the assembly's folder (it is not found by its document there)
await pg.evaluate(async () => {
  const root = await navigator.storage.getDirectory(), d = await root.getDirectoryHandle("refs-ht2"), o = await root.getDirectoryHandle("elsewhere", { create: true });
  const data = await (await (await d.getFileHandle("Cover (2).mcadprt")).getFile()).arrayBuffer();
  const w = await (await o.getFileHandle("Lid.mcadprt", { create: true })).createWritable(); await w.write(data); await w.close();
  await d.removeEntry("Cover (2).mcadprt");
  window.showOpenFilePicker = async () => [await o.getFileHandle("Lid.mcadprt")];
});
await pg.evaluate(() => window.dispatchEvent(new Event("focus")));
await pg.waitForTimeout(1500);
const btns6 = await pg.$$eval("#asm-refs button", bs => bs.map(b => b.textContent.trim()));
const img6b = await snap(pg, "missing-find");
await pg.click('#asm-refs [data-refs="find"]').catch(() => {});
await pg.waitForTimeout(1500);
const s6b = await asmState();
const d6b = await disk(pg, "refs-ht2"), t6b = await toasts();
check("R6b", btns6.includes("Find file…") && s6b.parts.Cover.link === "Lid.mcadprt" && !!d6b["Lid.mcadprt"] && !s6b.bar,
  "the missing-file bar's Find file… points the component at a file outside the folder: a copy goes in beside the assembly (other CAD apps: Browse for the file)", { btns6, link: s6b.parts.Cover.link, bar: s6b.bar, toast: t6b }, img6b);
await opfs2("del", "Lid.mcadprt");
await pg.evaluate(() => window.dispatchEvent(new Event("focus")));
await pg.waitForTimeout(1500);
await pg.click('#asm-refs [data-refs="sup"]').catch(() => {});
await pg.waitForTimeout(1500);
const s6c = await asmState(), sup6 = await pg.evaluate(() => window.__sv.asm.doc.components.filter(c => c.suppressed).map(c => c.name));
const img6c = await snap(pg, "missing-suppressed");
check("R6c", sup6.some(n => /Cover/.test(n)) && !s6c.bar, "Suppress on the missing-file bar suppresses the component and the bar goes", { sup6, bar: s6c.bar }, img6c);

// ---- F6 / F5: a drawing of the assembly goes along; one folder with a prefix, and the unpacked folder still opens.
await pg.evaluate(() => document.getElementById("new-drawing").click());
await pg.waitForFunction(() => document.querySelector("#app").classList.contains("drawing"), null, { timeout: 30000 });
await pg.waitForTimeout(1500);
await pg.click('#doc-tabs [data-dt]:has-text("mcadasm"), #doc-tabs [data-dt]:has-text("Assembly")');
await toAsm();
await pg.click("#file-btn");
await pg.click("#file-menu [data-f=pack]");
await pg.waitForSelector("#pack-dlg[open]");
await pg.$$eval("#pack-dlg .pack-list label", ls => ls.forEach(l => { const b = l.querySelector("input"); const want = /mcadasm|Assembly/.test(l.textContent) && !/mcaddrw|Drawing/.test(l.textContent); if (b.checked !== want) b.click(); }));
await pg.check('#pack-dlg [data-pk="flat"]');
await pg.check('#pack-dlg [data-pk="drw"]');
await pg.fill('#pack-dlg [data-pk="prefix"]', "X-");
await pg.waitForTimeout(600);
await pg.waitForSelector("#pack-dlg tr[data-pf]", { timeout: 20000 });
const rows5 = await pg.$$eval("#pack-dlg tr[data-pf]", rs => rs.map(r => [...r.cells].map(c => c.textContent.trim())));
const img5f = await snap(pg, "pack-flat-prefix");
const [dl5] = await Promise.all([pg.waitForEvent("download"), pg.click("#pack-dlg [data-a=ok]")]);
const zip5 = `${TMP}/flat.zip`;
await dl5.saveAs(zip5);
const l5 = execFileSync("unzip", ["-Z1", zip5]).toString().trim().split("\n");
check("F6", l5.some(n => n.endsWith(".mcaddrw")), "Include drawings puts the assembly's drawing in the zip (other CAD apps: Include drawings)", { l5 }, img5f);
const unz5 = `${TMP}/flat`;
mkdirSync(unz5, { recursive: true });
execFileSync("unzip", ["-o", "-q", zip5, "-d", unz5]);
await finish(browser, pg);
({ browser, pg } = await open("refs", "&asmfolder=refs-ht3"));
pg.on("dialog", d => d.accept());
await pg.evaluate(async files => {
  const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("refs-ht3", { create: true });
  for (const [p, data] of files) { const w = await (await root.getFileHandle(p, { create: true })).createWritable(); await w.write(new Uint8Array(data)); await w.close(); }
}, l5.map(n => [n, [...readFileSync(`${unz5}/${n}`)]]));
await openFiles(pg, [`${unz5}/${l5.find(n => n.endsWith(".mcadasm"))}`]);
await toAsm();
if (await pg.isVisible('#asm-refs [data-refs="go"]')) await pg.click('#asm-refs [data-refs="go"]');
await pg.waitForTimeout(2500);
const s5f = await asmState();
const links5 = Object.values(s5f.parts).map(x => x.link).filter(Boolean);
const img5o = await snap(pg, "flat-opened");
check("F5", l5.every(n => !n.includes("/") && n.startsWith("X-")) && links5.length > 0 && links5.every(n => n.startsWith("X-") && !n.includes("/")) && !s5f.bar,
  "Pack and Go into one folder with a prefix renames every file and rewrites the assembly's references, so the unpacked folder opens with nothing missing", { l5, rows5, links5, bar: s5f.bar }, img5o);

await finish(browser, pg);
console.log(`files in ${TMP}`);
