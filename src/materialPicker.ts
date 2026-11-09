// Material library dialog (FR-MAT-001): categories on the left, a searchable list, the picked
// material's properties on the right. Resolves with the chosen material (null = no material) or
// undefined when cancelled. The user's own materials are kept in this browser (materials.ts).
import { t } from "./i18n";
import { confirmModal, toast, trapFocus } from "./ui";
import { CATEGORIES, MAT_NUMS, SOURCES, allMaterials, customMaterials, removeCustom, resolveRef, saveCustom, searchMaterials, type MatCat, type MatNum, type MatRef, type Material } from "./tools/materials";

export interface PickOptions {
  current?: MatRef | null;
  /** Offer "No material". */
  allowNone?: boolean;
  /** Offer to take the material's colour too. */
  colour?: boolean;
}
export interface Picked { material: Material | null; colour: boolean }

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const COLOUR_KEY = "mc:matColour";

/** Property rows: key, label, unit. */
export const MAT_PROPS: [MatNum, string, string][] = [
  ["E", "Elastic modulus", "GPa"],
  ["nu", "Poisson's ratio", ""],
  ["sy", "Yield strength", "MPa"],
  ["su", "Tensile strength", "MPa"],
  ["k", "Thermal conductivity", "W/(m·K)"],
  ["cp", "Specific heat", "J/(kg·K)"],
  ["alpha", "Thermal expansion", "10⁻⁶/K"],
];

const num = (v: number) => String(+v.toPrecision(5));

/** Name as shown: translated, never scanned again by the DOM translator. */
export function materialLabel(m: { name: string }) { return t(m.name); }

export function pickMaterial(o: PickOptions = {}): Promise<Picked | undefined> {
  document.getElementById("mat-dlg")?.remove();
  const dlg = document.createElement("dialog");
  dlg.id = "mat-dlg";
  dlg.className = "modal wide";
  dlg.setAttribute("aria-labelledby", "mat-title");
  let colour = true;
  try { colour = localStorage.getItem(COLOUR_KEY) !== "0"; } catch { /* private mode */ }
  dlg.innerHTML = `<div class="modal-head"><h3 id="mat-title">${esc(t("Material"))}</h3><button class="btn small" data-a="cancel" aria-label="${esc(t("Close"))}">✕</button></div>`
    + `<input type="search" id="mat-q" autocomplete="off" spellcheck="false" placeholder="${esc(t("Search by name, grade or standard"))}" aria-label="${esc(t("Search materials"))}" />`
    + `<div class="mat-grid"><div class="mat-cats" role="tablist" aria-orientation="vertical" aria-label="${esc(t("Categories"))}"></div>`
    + `<ul class="mat-list" role="listbox" tabindex="0" aria-label="${esc(t("Materials"))}"></ul>`
    + `<section class="mat-props" aria-live="polite"></section></div>`
    + `<div class="row end mat-foot">${o.colour ? `<label class="chk"><input type="checkbox" data-a="colour"${colour ? " checked" : ""} /> ${esc(t("Use the material's colour"))}</label>` : ""}<span class="mat-gap"></span>`
    + `<button class="btn" data-a="new">${esc(t("New material…"))}</button>`
    + (o.allowNone ? `<button class="btn" data-a="none">${esc(t("No material"))}</button>` : "")
    + `<button class="btn" data-a="cancel">${esc(t("Cancel"))}</button><button class="btn primary" data-a="ok">${esc(t("Apply"))}</button></div>`;
  document.body.appendChild(dlg);
  trapFocus(dlg, () => dlg.open);
  const q = dlg.querySelector<HTMLInputElement>("#mat-q")!, cats = dlg.querySelector<HTMLElement>(".mat-cats")!;
  const list = dlg.querySelector<HTMLElement>(".mat-list")!, props = dlg.querySelector<HTMLElement>(".mat-props")!;
  const okBtn = dlg.querySelector<HTMLButtonElement>("[data-a=ok]")!;

  let all = allMaterials();
  // A document's material that is in no library (another computer's custom one) is still listed.
  const cur = o.current ? resolveRef(o.current) : null;
  const known = () => !!cur && all.some(m => m.name === cur.name && m.density === cur.density);
  let cat: MatCat | "all" = "all";
  let shown: Material[] = [];
  let sel: Material | null = cur;
  /** The custom material being typed in, or null. */
  let form: Partial<Material> & { old?: string } | null = null;

  const pool = () => (cur && !known() ? [...all, { ...cur, cat: "custom" as MatCat }] : all);
  const renderCats = () => {
    const found = searchMaterials(pool(), q.value, t);
    const n = (c: MatCat | "all") => (c === "all" ? found : found.filter(m => m.cat === c)).length;
    cats.innerHTML = [{ id: "all" as const, name: "All materials" }, ...CATEGORIES].map(c =>
      `<button type="button" role="tab" class="mat-cat${cat === c.id ? " on" : ""}" data-cat="${c.id}" aria-selected="${cat === c.id}"${n(c.id) ? "" : " disabled"}>${esc(t(c.name))} <span class="muted">${n(c.id)}</span></button>`).join("");
  };
  const renderList = () => {
    shown = searchMaterials(pool(), q.value, t).filter(m => cat === "all" || m.cat === cat);
    if (sel && !shown.some(m => m.name === sel!.name)) sel = shown[0] ?? null;
    if (!sel) sel = shown[0] ?? null;
    list.innerHTML = shown.length ? shown.map((m, i) =>
      `<li role="option" id="mat-o${i}" data-i="${i}" aria-selected="${m.name === sel?.name}"${m.name === sel?.name ? ' class="on"' : ""}><span class="mat-sw" style="background:${esc(m.color ?? "#9aa0a6")}" aria-hidden="true"></span>`
      + `<span class="mat-n"><b translate="no">${esc(t(m.name))}</b>${m.eq ? `<small class="muted" translate="no">${esc(m.eq)}</small>` : ""}</span><span class="mat-d" translate="no">${num(m.density)}</span></li>`).join("")
      : `<li class="mat-none muted" role="presentation">${esc(t("No material matches the search."))}</li>`;
    const i = sel ? shown.findIndex(m => m.name === sel!.name) : -1;
    if (i >= 0) { list.setAttribute("aria-activedescendant", `mat-o${i}`); list.querySelector(`#mat-o${i}`)?.scrollIntoView({ block: "nearest" }); }
    else list.removeAttribute("aria-activedescendant");
    okBtn.disabled = !sel || !!form;
  };
  const renderProps = () => {
    if (form) { renderForm(); return; }
    const m = sel;
    if (!m) { props.innerHTML = ""; return; }
    const s = m.src ? SOURCES[m.src] : undefined;
    const row = (label: string, v: number | null | undefined, unit: string) => `<tr><th scope="row">${esc(t(label))}</th><td translate="no">${typeof v === "number" ? `${num(v)}${unit ? ` <span class="muted">${unit}</span>` : ""}` : "—"}</td></tr>`;
    props.innerHTML = `<h4 translate="no"><span class="mat-sw" style="background:${esc(m.color ?? "#9aa0a6")}" aria-hidden="true"></span>${esc(t(m.name))}</h4>`
      + (m.eq ? `<p class="muted mat-eq" translate="no">${esc(m.eq)}</p>` : "")
      + `<table class="v-table mat-table"><tbody>${row("Density", m.density, "g/cm³")}${MAT_PROPS.map(([k, l, u]) => row(l, m[k], u)).join("")}</tbody></table>`
      + (s ? `<p class="muted mat-src">${esc(t(s.basis === "min" ? "Strengths are the standard's minimum values." : "Typical values."))} ${esc(t("Source:"))} <span translate="no">${esc(t(s.text))}</span></p>` : "")
      + `<p class="muted mat-src">${esc(t("For mass and first estimates; use the supplier's certificate for design."))}</p>`
      + `<div class="row wrap">${m.cat === "custom"
        ? `<button class="btn small" data-a="edit">${esc(t("Edit"))}</button>${customMaterials().some(c => c.name === m.name) ? `<button class="btn small" data-a="del">${esc(t("Delete"))}</button>` : `<button class="btn small" data-a="keep">${esc(t("Add to my materials"))}</button>`}`
        : `<button class="btn small" data-a="copy">${esc(t("Copy to my materials…"))}</button>`}</div>`;
  };
  const renderForm = () => {
    const f = form!;
    const inp = (k: string, label: string, v: string | number | null | undefined, unit: string, type = "text") =>
      `<label class="mat-f"><span>${esc(t(label))}</span><input type="${type}" data-f="${k}" value="${esc(v == null ? "" : String(v))}"${type === "text" && k !== "name" && k !== "eq" ? ' inputmode="decimal"' : ""} translate="no" />${unit ? `<span class="muted" translate="no">${unit}</span>` : ""}</label>`;
    props.innerHTML = `<h4>${esc(t(f.old ? "Edit material" : "New material"))}</h4>`
      + inp("name", "Name", f.name, "") + inp("eq", "Other designations", f.eq, "") + inp("density", "Density", f.density, "g/cm³")
      + MAT_PROPS.map(([k, l, u]) => inp(k, l, f[k], u)).join("")
      + inp("color", "Colour", f.color ?? "#9aa0a6", "", "color")
      + `<p class="muted mat-src">${esc(t("Only the name and density are needed. My materials are kept in this browser; a part keeps its material's values in its file."))}</p>`
      + `<div class="row wrap"><button class="btn small primary" data-a="save">${esc(t("Save"))}</button><button class="btn small" data-a="back">${esc(t("Back"))}</button></div>`;
    props.querySelector<HTMLInputElement>("[data-f=name]")?.focus();
  };
  const render = () => { renderCats(); renderList(); renderProps(); };
  const select = (m: Material | null) => { sel = m; form = null; renderList(); renderProps(); };
  const move = (d: number) => {
    if (!shown.length) return;
    const i = sel ? shown.findIndex(m => m.name === sel!.name) : -1;
    select(shown[Math.max(0, Math.min(shown.length - 1, i + d))]);
  };
  const saveForm = () => {
    const get = (k: string) => props.querySelector<HTMLInputElement>(`[data-f="${k}"]`)!.value.trim();
    const n = (k: string) => { const s = get(k).replace(",", "."); return s === "" ? undefined : Number(s); };
    const m: Material = { name: get("name"), density: n("density") ?? NaN, cat: "custom", eq: get("eq") || undefined, color: get("color") };
    if (!m.name) { toast(t("Give the material a name."), true); return; }
    if (!(m.density > 0) || !isFinite(m.density)) { toast(t("Density must be a number greater than 0 g/cm³."), true); return; }
    for (const k of MAT_NUMS) {
      const v = n(k);
      if (v === undefined) continue;
      if (!isFinite(v) || (k !== "alpha" && v < 0) || (k === "nu" && v > 0.5)) { toast(t("Check the value of {p}.", { p: t(MAT_PROPS.find(p => p[0] === k)![1]) }), true); return; }
      m[k] = v;
    }
    if (!saveCustom(m)) { toast(t("A library material already has this name. Choose another name."), true); return; }
    if (form?.old && form.old !== m.name) removeCustom(form.old);
    all = allMaterials();
    form = null;
    cat = "custom";
    sel = all.find(x => x.name === m.name && x.cat === "custom") ?? null;
    render();
  };

  return new Promise(resolve => {
    const opener = document.activeElement as HTMLElement | null;
    let result: Picked | undefined;
    const done = (r: Picked | undefined) => { result = r; dlg.close(); };
    const apply = () => { if (sel && !form) done({ material: sel, colour: !!o.colour && colour }); };
    dlg.addEventListener("close", () => { dlg.remove(); opener?.focus?.(); resolve(result); });
    q.addEventListener("input", () => { form = null; if (cat !== "all" && !searchMaterials(pool(), q.value, t).some(m => m.cat === cat)) cat = "all"; render(); });
    q.addEventListener("keydown", e => {
      if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
      else if (e.key === "Enter") { e.preventDefault(); apply(); }
    });
    list.addEventListener("keydown", e => {
      const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : e.key === "PageDown" ? 8 : e.key === "PageUp" ? -8 : e.key === "Home" ? -1e6 : e.key === "End" ? 1e6 : 0;
      if (step) { e.preventDefault(); move(step); }
      else if (e.key === "Enter") { e.preventDefault(); apply(); }
    });
    list.addEventListener("click", e => {
      const li = (e.target as HTMLElement).closest<HTMLElement>("li[data-i]");
      if (li) select(shown[+li.dataset.i!]);
    });
    list.addEventListener("dblclick", e => { if ((e.target as HTMLElement).closest("li[data-i]")) apply(); });
    cats.addEventListener("click", e => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-cat]");
      if (!b) return;
      cat = b.dataset.cat as MatCat | "all";
      form = null;
      render();
      dlg.querySelector<HTMLElement>(`.mat-cat[data-cat="${cat}"]`)?.focus();
    });
    cats.addEventListener("keydown", e => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const bs = [...cats.querySelectorAll<HTMLButtonElement>(".mat-cat:not([disabled])")], i = bs.indexOf(document.activeElement as HTMLButtonElement);
      if (i < 0) return;
      e.preventDefault();
      bs[(i + (e.key === "ArrowDown" ? 1 : -1) + bs.length) % bs.length].focus();
    });
    dlg.addEventListener("change", e => {
      const el = e.target as HTMLInputElement;
      if (el.dataset.a === "colour") { colour = el.checked; try { localStorage.setItem(COLOUR_KEY, colour ? "1" : "0"); } catch { /* private mode */ } }
    });
    dlg.addEventListener("click", e => {
      const a = (e.target as HTMLElement).closest<HTMLElement>("button[data-a]")?.dataset.a;
      if (!a) return;
      if (a === "cancel") done(undefined);
      else if (a === "ok") apply();
      else if (a === "none") done({ material: null, colour: false });
      else if (a === "new") { form = { color: "#9aa0a6" }; renderList(); renderProps(); }
      else if (a === "copy" && sel) { form = { ...sel, name: t("{name} (copy)", { name: t(sel.name) }) }; renderList(); renderProps(); }
      else if (a === "edit" && sel) { form = { ...sel, old: customMaterials().some(c => c.name === sel!.name) ? sel.name : undefined }; renderList(); renderProps(); }
      else if (a === "keep" && sel) { if (saveCustom(sel)) { all = allMaterials(); sel = all.find(x => x.name === sel!.name) ?? sel; render(); } else toast(t("A library material already has this name. Choose another name."), true); }
      else if (a === "del" && sel) {
        const name = sel.name;
        void confirmModal(t("Delete the material “{name}” from My materials? Parts that use it keep their values.", { name }), t("Delete")).then(yes => {
          if (!yes) return;
          removeCustom(name);
          all = allMaterials();
          sel = null;
          if (!all.some(m => m.cat === "custom")) cat = "all";
          render();
        });
      }
      else if (a === "save") saveForm();
      else if (a === "back") { form = null; renderList(); renderProps(); }
    });
    render();
    dlg.showModal();
    q.focus();
  });
}
