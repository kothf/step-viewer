// Popup editors of the drawing annotations that are built from symbols (FR-DRW-022/023): the
// geometric tolerance frame and the hole callout. Each opens when the annotation is placed and
// on a double-click of an existing one, with the symbols as buttons and a live preview.
import { t } from "../i18n";
import { trapFocus } from "../ui";
import { GMODS, GSYMS, GSYM_NAMES, gtolPrims, rowText, surfPrims, symbolPrims } from "./gdt";
import { drawnSymbols, svgBody } from "./output";
import type { Prim } from "./prims";
import { textWidth } from "./textWidth";
import type { GRow, GSym, GtolAnnot, HoleAnnot, SurfAnnot, WeldAnnot, WeldSide, WeldSym } from "./types";
import { WELD_SYMS, WELD_SYM_NAMES, weldPrims, weldSymPrims } from "./weld";

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function dialog(id: string, cls: string, title: string): HTMLDialogElement {
  let d = document.getElementById(id) as HTMLDialogElement | null;
  if (!d) {
    d = document.createElement("dialog");
    d.id = id;
    d.className = `modal ${cls}`;
    d.setAttribute("aria-labelledby", title);
    document.body.appendChild(d);
    const dl = d;
    trapFocus(dl, () => dl.open);
  }
  return d;
}

/** A characteristic symbol as an icon. */
export const symIcon = (s: GSym) => `<svg class="gt-ico" viewBox="-2.6 -2.6 5.2 5.2" aria-hidden="true">${svgBody(symbolPrims(s, 0, 0, 3.6), 0, "currentColor")}</svg>`;
/** A modifier as its button face: a circled letter, the statistical hexagon or plain text. */
const modFace = (ch: string, face: string) => ch === "⬡" ? `<svg class="gt-ico" viewBox="0 0 24 14" aria-hidden="true"><path d="M1 7 5 1h14l4 6-4 6H5Z" fill="none" stroke="currentColor"/><text x="12" y="10.4" font-size="8" text-anchor="middle" fill="currentColor">ST</text></svg>`
  : /[Ⓐ-Ⓩ]/.test(ch) ? `<span class="gt-circ">${face}</span>` : `<span class="gt-plain">${esc(face)}</span>`;

/** The primitives in a box, as a preview picture on white. */
function previewSvg(prims: Prim[], box: [number, number, number, number], label: string): string {
  const pad = 2.5, w = box[2] - box[0] + 2 * pad, h = box[3] - box[1] + 2 * pad;
  const body = svgBody(drawnSymbols(prims.map(p => shift(p, -box[0] + pad, -box[1] + pad))), h);
  return `<svg class="ad-pv" viewBox="0 0 ${w} ${h}" style="width:${Math.round(w * 7)}px" role="img" aria-label="${esc(label)}">${body}</svg>`;
}
function shift(p: Prim, dx: number, dy: number): Prim {
  if (p.t === "l") return { ...p, p: [p.p[0] + dx, p.p[1] + dy, p.p[2] + dx, p.p[3] + dy] };
  if (p.t === "a") return { ...p, o: [p.o[0] + dx, p.o[1] + dy] };
  if (p.t === "p") return { ...p, p: p.p.map((v, i) => v + (i % 2 ? dy : dx)) };
  return { ...p, x: p.x + dx, y: p.y + dy };
}

/** Puts `text` at the caret of an input or textarea and keeps the caret after it. */
function insertAt(el: HTMLInputElement | HTMLTextAreaElement, text: string) {
  const a = el.selectionStart ?? el.value.length, b = el.selectionEnd ?? a;
  el.value = el.value.slice(0, a) + text + el.value.slice(b);
  el.focus();
  el.setSelectionRange(a + text.length, a + text.length);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function run<T>(dlg: HTMLDialogElement, handlers: [string, (e: Event) => void][], result: () => T): Promise<T | null> {
  // Cancel is no submit button: Enter in a field must press OK, the form's only one.
  const cancel = (e: Event) => { if ((e.target as HTMLElement).closest("[data-cancel]")) dlg.close("cancel"); };
  handlers = [...handlers, ["click", cancel]];
  for (const [k, h] of handlers) dlg.addEventListener(k, h);
  const opener = document.activeElement as HTMLElement | null;
  dlg.returnValue = "";
  dlg.showModal();
  return new Promise(res => dlg.addEventListener("close", () => {
    for (const [k, h] of handlers) dlg.removeEventListener(k, h);
    opener?.focus?.();
    res(dlg.returnValue === "ok" ? result() : null);
  }, { once: true }));
}

const COLS: [string, string][] = [["tol", "Tolerance 1"], ["tol2", "Tolerance 2"], ["d0", "Primary"], ["d1", "Secondary"], ["d2", "Tertiary"]];

/**
 * The geometric tolerance dialog on a copy of `start`: one line per frame (symbol, two
 * tolerances, three datums), the modifying symbols as buttons that go in at the caret, a preview.
 * Resolves to the edited annotation, or null when cancelled.
 */
export function editGtol(start: GtolAnnot, dec: string, isNew: boolean): Promise<GtolAnnot | null> {
  const a: GtolAnnot = { ...structuredClone(start), rows: start.rows.map(rowText) };
  const dlg = dialog("drw-gtol-dlg", "wide ad-dlg", "drw-gtol-title");
  let last = "0:tol", pal: number | null = null;
  const cellVal = (r: GRow, k: string) => k === "tol" ? r.tol : k === "tol2" ? r.tol2 ?? "" : r.datums[+k[1]] ?? "";
  const preview = () => { const g = gtolPrims(clean(a), [0, 0], null, dec); return previewSvg(g.prims, g.box, t("Preview")); };
  const rowHtml = (r: GRow, i: number) => {
    const comp = i > 0 && !!r.composite;
    return `<tr>
      <td><button type="button" class="gt-sym" data-sym="${i}" aria-haspopup="true" aria-expanded="${pal === i}"${comp ? " disabled" : ""} title="${esc(t(GSYM_NAMES[r.sym]))}" aria-label="${esc(t("Symbol"))} ${i + 1}: ${esc(t(GSYM_NAMES[r.sym]))}">${symIcon(r.sym)}<span aria-hidden="true">▾</span></button></td>
      ${COLS.map(([k, l]) => `<td><input data-g="${i}:${k}" value="${esc(cellVal(r, k))}" ${k[0] === "d" ? 'maxlength="10" class="gt-datum"' : 'inputmode="decimal"'} aria-label="${esc(t(l))} ${i + 1}" translate="no" autocomplete="off"></td>`).join("")}
      <td class="gt-rowend">${i > 0 ? `<label class="drw-chk" title="${esc(t("Composite with the row above"))}"><input type="checkbox" data-comp="${i}"${comp ? " checked" : ""}> ${esc(t("Composite"))}</label>` : ""}${a.rows.length > 1 ? `<button type="button" class="btn small" data-rm="${i}" aria-label="${esc(t("Remove row"))} ${i + 1}">✕</button>` : ""}</td></tr>`;
  };
  const render = () => {
    dlg.innerHTML = `<form method="dialog">
      <div class="modal-head"><h3 id="drw-gtol-title">${esc(t("Geometric tolerance"))}</h3></div>
      <div class="ad-syms" role="toolbar" aria-label="${esc(t("Modifying symbols"))}">${GMODS.map(([ch, face, name]) => `<button type="button" class="ad-symb" data-ins="${esc(ch)}" title="${esc(t(name))}" aria-label="${esc(t(name))}">${modFace(ch, face)}</button>`).join("")}</div>
      <p class="drw-note">${esc(t("A symbol goes in where the cursor is, in a tolerance or a datum."))}</p>
      <div class="gt-scroll"><table class="gt-rows"><thead><tr><th>${esc(t("Symbol"))}</th>${COLS.map(([, l]) => `<th>${esc(t(l))}</th>`).join("")}<th></th></tr></thead><tbody>${a.rows.map(rowHtml).join("")}</tbody></table></div>
      ${pal != null ? `<div class="gt-pal" role="menu" aria-label="${esc(t("Symbol"))}">${GSYMS.map(g => `<button type="button" role="menuitemradio" aria-checked="${a.rows[pal!]?.sym === g}" class="ad-symb${a.rows[pal!]?.sym === g ? " on" : ""}" data-pick="${g}" title="${esc(t(GSYM_NAMES[g]))}" aria-label="${esc(t(GSYM_NAMES[g]))}">${symIcon(g)}</button>`).join("")}</div>` : ""}
      <div class="row"><button type="button" class="btn small" data-add>${esc(t("Add frame"))}</button></div>
      <div class="gt-opts">
        <label class="drw-f">${esc(t("Text above the frame"))}<input data-o="above" value="${esc(a.above ?? "")}" translate="no" placeholder="2×"></label>
        <label class="drw-f">${esc(t("Text below the frame"))}<input data-o="below" value="${esc(a.below ?? "")}" translate="no"></label>
        <div class="drw-f"><span id="gt-btw">${esc(t("Between two points"))}</span><span class="gt-btw"><input data-o="b0" value="${esc(a.between?.[0] ?? "")}" maxlength="4" aria-labelledby="gt-btw" translate="no"><span aria-hidden="true">↔</span><input data-o="b1" value="${esc(a.between?.[1] ?? "")}" maxlength="4" aria-labelledby="gt-btw" translate="no"></span></div>
        ${a.leader ? `<label class="drw-chk"><input type="checkbox" data-o="around"${a.around ? " checked" : ""}> ${esc(t("All around"))}</label>` : ""}
      </div>
      <div class="ad-pvbox">${preview()}</div>
      <div class="row end"><button type="button" class="btn" data-cancel>${esc(t("Cancel"))}</button><button class="btn primary" value="ok">${esc(t("OK"))}</button></div>
    </form>`;
    placePal();
  };
  /** The palette drops from its symbol button, over the rows below. */
  const placePal = () => {
    const el = dlg.querySelector<HTMLElement>(".gt-pal"), b = pal != null ? dlg.querySelector<HTMLElement>(`[data-sym="${pal}"]`) : null;
    if (!el || !b) return;
    const r = b.getBoundingClientRect(), w = el.offsetWidth, h = el.offsetHeight;
    el.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
    el.style.top = `${r.bottom + 4 + h > innerHeight - 8 ? Math.max(8, r.top - h - 4) : r.bottom + 4}px`;
  };
  const focusCell = (key: string, sel = false) => { const el = dlg.querySelector<HTMLInputElement>(`[data-g="${key}"]`); el?.focus(); if (sel) el?.select(); };
  const refresh = () => { const b = dlg.querySelector(".ad-pvbox"); if (b) b.innerHTML = preview(); };
  const onInput = (e: Event) => {
    const el = e.target as HTMLInputElement, g = el.dataset.g, o = el.dataset.o, c = el.dataset.comp;
    if (g) {
      const [si, k] = g.split(":"), r = a.rows[+si];
      if (!r) return;
      if (k === "tol") r.tol = el.value.replace(",", ".");
      else if (k === "tol2") { if (el.value.trim()) r.tol2 = el.value.replace(",", "."); else delete r.tol2; }
      else { const d = [0, 1, 2].map(j => r.datums[j] ?? ""); d[+k[1]] = el.value.toUpperCase(); r.datums = d; }
    } else if (o === "above" || o === "below") { if (el.value.trim()) a[o] = el.value.trim(); else delete a[o]; }
    else if (o === "b0" || o === "b1") { const b: [string, string] = [a.between?.[0] ?? "", a.between?.[1] ?? ""]; b[o === "b0" ? 0 : 1] = el.value.trim().toUpperCase(); if (b[0] || b[1]) a.between = b; else delete a.between; }
    else if (o === "around") { if (el.checked) a.around = true; else delete a.around; }
    else if (c) { const r = a.rows[+c]; if (el.checked) { r.composite = true; r.sym = a.rows[+c - 1].sym; } else delete r.composite; render(); return; }
    else return;
    refresh();
  };
  const onFocus = (e: Event) => { const g = (e.target as HTMLElement).dataset?.g; if (g) last = g; };
  const onClick = (e: Event) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("button");
    if (!b) { if (pal != null && !(e.target as HTMLElement).closest(".gt-pal")) { pal = null; render(); } return; }
    if (b.dataset.ins) { const el = dlg.querySelector<HTMLInputElement>(`[data-g="${last}"]`) ?? dlg.querySelector<HTMLInputElement>("[data-g]"); if (el) insertAt(el, b.dataset.ins); return; }
    if (b.dataset.sym) { pal = pal === +b.dataset.sym ? null : +b.dataset.sym; render(); (dlg.querySelector<HTMLElement>(".gt-pal .on") ?? dlg.querySelector<HTMLElement>(".gt-pal button"))?.focus(); return; }
    if (b.dataset.pick && pal != null) {
      const i = pal;
      a.rows[i].sym = b.dataset.pick as GSym;
      // Composite rows under it share its symbol.
      for (let j = i + 1; a.rows[j]?.composite; j++) a.rows[j].sym = a.rows[i].sym;
      pal = null; render(); focusCell(`${i}:tol`, true); return;
    }
    if (b.dataset.add !== undefined) { a.rows.push({ sym: a.rows.at(-1)?.sym ?? "flat", tol: "", datums: [] }); pal = null; render(); focusCell(`${a.rows.length - 1}:tol`); return; }
    if (b.dataset.rm) { a.rows.splice(+b.dataset.rm, 1); if (a.rows[0]) delete a.rows[0].composite; pal = null; last = "0:tol"; render(); }
  };
  const onKey = (e: Event) => { if ((e as KeyboardEvent).key === "Escape" && pal != null) { e.preventDefault(); const i = pal; pal = null; render(); dlg.querySelector<HTMLElement>(`[data-sym="${i}"]`)?.focus(); } };
  render();
  const p = run(dlg, [["input", onInput], ["focusin", onFocus], ["click", onClick], ["keydown", onKey]], () => clean(a));
  // A new frame starts in its symbol palette, as the tool does in other CAD apps; an existing one in its tolerance.
  if (isNew) { pal = 0; render(); placePal(); (dlg.querySelector<HTMLElement>(".gt-pal .on") ?? dlg.querySelector<HTMLElement>(".gt-pal button"))?.focus(); }
  else focusCell("0:tol", true);
  return p;
}

/** A tolerance frame alone, as a picture (the properties panel shows it). */
export function gtolPicture(a: GtolAnnot, dec: string): string { const g = gtolPrims(a, [0, 0], null, dec); return previewSvg(g.prims, g.box, t("Preview")); }

/** The annotation as stored: empty cells dropped. */
function clean(a: GtolAnnot): GtolAnnot {
  const rows = a.rows.map(r => {
    const d = r.datums.map(s => s.trim());
    while (d.length && !d[d.length - 1]) d.pop();
    const o: GRow = { sym: r.sym, tol: r.tol.trim(), datums: d };
    if (r.tol2?.trim()) o.tol2 = r.tol2.trim();
    if (r.composite) o.composite = true;
    return o;
  });
  return { ...a, rows };
}

/** Symbols of a hole callout: the text that goes in, its name, and a drawn icon for the ones a screen font may lack. */
const HOLE_SYMS: [string, string, string?][] = [
  ["Ø", "Diameter"],
  ["⌴", "Counterbore or spotface", '<path d="M3 3v8h10V3"/>'],
  ["⌵", "Countersink", '<path d="m2 4 6 7 6-7"/>'],
  ["↧", "Depth", '<path d="M3 2.5h10M8 2.5v10M4.5 9 8 12.5 11.5 9"/>'],
  ["×", "Times"], ["°", "Degrees"], ["±", "Plus or minus"], ["□", "Square"], ["R", "Radius"], ["M", "Metric thread"],
];
export interface HoleEdit { txt?: string; count?: boolean; below?: string }

/**
 * The hole callout dialog: the text read from the hole, or your own with the symbols as buttons,
 * the number of holes, a line below, and a preview. `auto(count)` gives the lines the hole itself gives.
 */
export function editHole(start: HoleAnnot, auto: (count: boolean) => string[], thru: string): Promise<HoleEdit | null> {
  const a: HoleEdit = { ...(start.txt ? { txt: start.txt } : {}), ...(start.count === false ? { count: false } : {}), ...(start.below ? { below: start.below } : {}) };
  const dlg = dialog("drw-hole-dlg", "ad-dlg", "drw-hole-title");
  let last = "txt";
  const lines = () => [...(a.txt != null ? a.txt.split("\n") : auto(a.count !== false)), ...(a.below ? a.below.split("\n") : [])];
  const preview = () => {
    const ls = lines(), h = 3.5, w = Math.max(6, ...ls.map(s => textWidth(s, h))) + 1;
    const prims: Prim[] = [{ t: "l", p: [0, 0, w, 0], pen: "thin", layer: "ANNOT" }, ...ls.map((s, i): Prim => ({ t: "t", x: 0.5, y: 0.8 + (ls.length - 1 - i) * h * 1.5, s, h, al: "l", layer: "ANNOT" }))];
    return previewSvg(prims, [0, 0, w, 0.8 + ls.length * h * 1.5], t("Preview"));
  };
  const render = () => {
    const own = a.txt != null;
    dlg.innerHTML = `<form method="dialog">
      <div class="modal-head"><h3 id="drw-hole-title">${esc(t("Hole callout"))}</h3></div>
      <div class="ad-syms" role="toolbar" aria-label="${esc(t("Symbols"))}">${HOLE_SYMS.map(([ch, name, icon]) => `<button type="button" class="ad-symb" data-ins="${esc(ch)}" title="${esc(t(name))}" aria-label="${esc(t(name))}">${icon ? `<svg class="hc-ico" viewBox="0 0 16 14" aria-hidden="true">${icon}</svg>` : `<span class="gt-plain">${esc(ch)}</span>`}</button>`).join("")}<button type="button" class="ad-symb wide" data-ins=" ${esc(thru)}" title="${esc(t("Through all"))}" translate="no">${esc(thru)}</button></div>
      <label class="drw-chk"><input type="checkbox" data-h="auto"${own ? "" : " checked"}> ${esc(t("Text from the hole"))}</label>
      <label class="drw-f">${esc(t("Callout text"))}<textarea data-h="txt" rows="4" translate="no"${own ? "" : " readonly"}>${esc(own ? a.txt! : auto(a.count !== false).join("\n"))}</textarea></label>
      <p class="drw-note">${esc(t(own ? "Your own text: it no longer follows the hole." : "The text follows the hole. Untick the box, or press a symbol, to write your own."))}</p>
      <label class="drw-chk"><input type="checkbox" data-h="count"${a.count !== false ? " checked" : ""}${own ? " disabled" : ""}> ${esc(t("Show the number of holes"))}</label>
      <label class="drw-f">${esc(t("Text below"))}<textarea data-h="below" rows="2" translate="no">${esc(a.below ?? "")}</textarea></label>
      <div class="ad-pvbox">${preview()}</div>
      <div class="row end"><button type="button" class="btn" data-cancel>${esc(t("Cancel"))}</button><button class="btn primary" value="ok">${esc(t("OK"))}</button></div>
    </form>`;
  };
  const refresh = () => { const b = dlg.querySelector(".ad-pvbox"); if (b) b.innerHTML = preview(); };
  const own = () => { if (a.txt == null) { a.txt = auto(a.count !== false).join("\n"); render(); } };
  const onInput = (e: Event) => {
    const el = e.target as HTMLInputElement, k = el.dataset.h;
    if (k === "auto") { if (el.checked) delete a.txt; else a.txt = auto(a.count !== false).join("\n"); render(); if (!el.checked) dlg.querySelector<HTMLTextAreaElement>("[data-h=txt]")?.focus(); return; }
    if (k === "txt") { if (a.txt != null) a.txt = el.value; }
    else if (k === "count") { if (el.checked) delete a.count; else a.count = false; if (a.txt == null) { render(); return; } }
    else if (k === "below") { if (el.value.trim()) a.below = el.value; else delete a.below; }
    else return;
    refresh();
  };
  const onFocus = (e: Event) => { const k = (e.target as HTMLElement).dataset?.h; if (k === "txt" || k === "below") last = k; };
  const onClick = (e: Event) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-ins]");
    if (!b) return;
    // A symbol into the text read from the hole makes it your own text first.
    if (last === "txt") own();
    const el = dlg.querySelector<HTMLTextAreaElement>(`[data-h="${last}"]`);
    if (el) insertAt(el, b.dataset.ins!);
  };
  render();
  const p = run(dlg, [["input", onInput], ["focusin", onFocus], ["click", onClick]], (): HoleEdit => ({ ...(a.txt != null && a.txt.trim() ? { txt: a.txt } : {}), ...(a.count === false ? { count: false } : {}), ...(a.below ? { below: a.below } : {}) }));
  dlg.querySelector<HTMLElement>("[data-h=auto]")?.focus();
  return p;
}

/** A weld symbol as an icon, standing on its reference line. */
export const weldIcon = (y: WeldSym | "") => `<svg class="gt-ico wd-ico" viewBox="-3 -4.2 6 6" aria-hidden="true"><line x1="-2.8" y1="0" x2="2.8" y2="0" stroke="currentColor"/>${y ? svgBody(weldSymPrims(y, 0, 0, 1), 0, "currentColor") : ""}</svg>`;
/** A surface finish symbol (any process, material removed, none removed) as an icon. */
export function surfIcon(proc: SurfAnnot["proc"]): string {
  const g = surfPrims({ id: "", t: "surf", pos: [0, 0], proc, text: "" }, [0, 0], ".");
  return `<svg class="gt-ico sf-ico" viewBox="-3.5 -9.6 15 10.4" aria-hidden="true">${svgBody(g.prims, 0, "currentColor")}</svg>`;
}

/**
 * The weld symbol dialog: the other side above the reference line and the arrow side below it, as on the
 * symbol itself, each with its weld picked from icons, its size and length; all around, field weld, the tail note.
 */
export function editWeld(start: WeldAnnot, isNew: boolean): Promise<WeldAnnot | null> {
  const a: WeldAnnot = structuredClone(start);
  const dlg = dialog("drw-weld-dlg", "ad-dlg wd-dlg", "drw-weld-title");
  const preview = () => { const g = weldPrims({ ...a, leader: undefined }, [0, 0], [-8, -8]); return previewSvg(g.prims, [Math.min(g.box[0], -9), Math.min(g.box[1], -9), g.box[2], g.box[3]], t("Preview")); };
  const side = (k: "arrow" | "other", label: string) => {
    const w = a[k];
    return `<fieldset class="pm-group wd-side" data-side="${k}"><legend>${esc(t(label))}</legend>
      <div class="ad-syms" role="radiogroup" aria-label="${esc(t(label))}: ${esc(t("Symbol"))}">${(["", ...WELD_SYMS] as const).map(y => `<button type="button" role="radio" aria-checked="${(w?.sym ?? "") === y}" class="ad-symb${(w?.sym ?? "") === y ? " on" : ""}" data-w="${k}:${y}" title="${esc(t(y ? WELD_SYM_NAMES[y] : "None"))}" aria-label="${esc(t(y ? WELD_SYM_NAMES[y] : "None"))}">${weldIcon(y)}</button>`).join("")}</div>
      <div class="wd-vals"><label class="drw-f">${esc(t("Size"))}<input data-wv="${k}:size" value="${esc(w?.size ?? "")}" translate="no" placeholder="a4"${w ? "" : " disabled"}></label>
      <label class="drw-f">${esc(t("Length"))}<input data-wv="${k}:len" value="${esc(w?.len ?? "")}" translate="no" placeholder="100"${w ? "" : " disabled"}></label></div>
    </fieldset>`;
  };
  const render = () => {
    dlg.innerHTML = `<form method="dialog">
      <div class="modal-head"><h3 id="drw-weld-title">${esc(t("Weld symbol"))}</h3></div>
      ${side("other", "Other side")}
      <div class="wd-line"><label class="drw-chk"><input type="checkbox" data-wo="around"${a.around ? " checked" : ""}> ${esc(t("All around"))}</label>
        <label class="drw-chk"><input type="checkbox" data-wo="field"${a.field ? " checked" : ""}> ${esc(t("Field weld"))}</label>
        <label class="drw-f">${esc(t("Tail note"))}<input data-wo="tail" value="${esc(a.tail ?? "")}" placeholder="111 ISO 5817-B"></label></div>
      ${side("arrow", "Arrow side")}
      <div class="ad-pvbox">${preview()}</div>
      <div class="row end"><button type="button" class="btn" data-cancel>${esc(t("Cancel"))}</button><button class="btn primary" value="ok">${esc(t("OK"))}</button></div>
    </form>`;
  };
  const refresh = () => { const b = dlg.querySelector(".ad-pvbox"); if (b) b.innerHTML = preview(); };
  const onInput = (e: Event) => {
    const el = e.target as HTMLInputElement, v = el.dataset.wv, o = el.dataset.wo;
    if (v) { const [k, f] = v.split(":") as ["arrow" | "other", "size" | "len"], w = a[k]; if (!w) return; if (el.value.trim()) w[f] = el.value.trim(); else delete w[f]; }
    else if (o === "around" || o === "field") { if (el.checked) a[o] = true; else delete a[o]; }
    else if (o === "tail") { if (el.value.trim()) a.tail = el.value.trim(); else delete a.tail; }
    else return;
    refresh();
  };
  const onClick = (e: Event) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-w]");
    if (!b) return;
    const [k, y] = b.dataset.w!.split(":") as ["arrow" | "other", WeldSym | ""];
    if (y) a[k] = { ...(a[k] ?? {}), sym: y } as WeldSide; else delete a[k];
    render();
    dlg.querySelector<HTMLElement>(`[data-w="${k}:${y}"]`)?.focus();
  };
  render();
  const p = run(dlg, [["input", onInput], ["click", onClick]], () => a);
  (isNew ? dlg.querySelector<HTMLElement>('[data-side="arrow"] .ad-symb.on') : dlg.querySelector<HTMLInputElement>('[data-wv="arrow:size"]:not([disabled])') ?? dlg.querySelector<HTMLElement>(".ad-symb.on"))?.focus();
  return p;
}
