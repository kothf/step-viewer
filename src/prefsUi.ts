// Preferences dialog (FR-UI-080): Modelling, Sketch and Mouse pages over prefs.ts. OK stores, Cancel leaves
// everything as it was, Defaults fills the page in with the default values (OK still stores them).
import { t } from "./i18n";
import { bindTabs, trapFocus } from "./ui";
import { AUTOSAVE_CHOICES, DEFAULT_PREFS, loadPrefs, setPrefs, type PrefKey, type Prefs } from "./prefs";

export interface PrefsHost {
  units(): string;
  decimals(): string;
  setUnits(u: string): void;
  setDecimals(d: string): void;
  /** Opens the mouse gesture settings. */
  gestures(): void;
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const UNITS = ["mm", "cm", "m", "in", "ft"];

/** Sketch colours as the sketcher draws them (light theme), for the legend. */
const SK_COLOURS: [string, string, string][] = [
  ["#1d4ed8", "Under defined", "Can still move: add relations or dimensions."],
  ["#111827", "Fully defined", "Fixed by relations and dimensions."],
  ["#d32f2f", "Over defined or conflicting", "A relation or dimension fights the others; the sketch assistant suggests fixes."],
  ["#7c8594", "Construction", "Helps place other geometry; not part of profiles."],
  ["#f08c00", "Selected", "In the selection."],
  ["#2f9e44", "Preview", "What the click will add."],
  ["#8f6a00", "Dangling", "Its model edge is gone; drag the glyph onto another edge."],
];

export function openPrefs(host: PrefsHost, page: "modelling" | "sketch" | "mouse" = "modelling") {
  document.getElementById("prefs-dlg")?.remove();
  const p = loadPrefs();
  const dlg = document.createElement("dialog");
  dlg.id = "prefs-dlg";
  dlg.className = "modal";
  dlg.setAttribute("aria-labelledby", "prefs-title");
  const chk = (k: PrefKey, label: string, title = "") => `<label class="chk"${title ? ` title="${esc(t(title))}"` : ""}><input type="checkbox" data-p="${k}"${p[k] ? " checked" : ""} /> ${esc(t(label))}</label>`;
  const opt = (v: string, label: string, cur: string) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(t(label))}</option>`;
  const num = (k: PrefKey, label: string, unit: string, title: string, min = "0") => `<label class="row" title="${esc(t(title))}">${esc(t(label))} <input type="number" min="${min}" step="any" data-p="${k}" value="${p[k] || ""}" placeholder="${esc(t("Automatic"))}" /> <span class="muted">${esc(t(unit))}</span></label>`;
  const autosave = AUTOSAVE_CHOICES.map(s => `<option value="${s}"${s === p.autosave ? " selected" : ""}>${esc(s === 0 ? t("Off") : s === 1 ? t("After each change") : s < 60 ? t("{n} s", { n: s }) : t("{n} min", { n: s / 60 }))}</option>`).join("");
  const modelling = `<section class="prefs-page" role="tabpanel" id="pp-modelling" aria-labelledby="pt-modelling" tabindex="0">`
    + `<h4 class="menu-h">${esc(t("Units"))}</h4>`
    + `<label class="row">${esc(t("Units"))} <select data-x="units">${UNITS.map(u => opt(u, u, host.units())).join("")}</select></label>`
    + `<label class="row">${esc(t("Decimals"))} <select data-x="decimals">${opt("", "Auto", host.decimals())}${[0, 1, 2, 3, 4, 5, 6].map(d => opt(String(d), String(d), host.decimals())).join("")}</select></label>`
    + `<h4 class="menu-h">${esc(t("Rebuild"))}</h4>`
    + `<label class="row" title="${esc(t("How finely the part is drawn on screen. Coarse rebuilds faster; it does not change the exact geometry."))}">${esc(t("Image quality"))} <select data-p="quality">${opt("coarse", "Coarse", p.quality)}${opt("normal", "Normal", p.quality)}${opt("fine", "Fine", p.quality)}</select></label>`
    + chk("verify", "Verification on rebuild", "Checks the body after every feature and warns when it is not valid. Slower.")
    + `<label class="row" title="${esc(t("Unsaved work is kept in the browser for recovery after a crash."))}">${esc(t("Autosave for recovery"))} <select data-p="autosave">${autosave}</select></label>`
    + `<h4 class="menu-h">${esc(t("Spin boxes"))}</h4>`
    + num("lenStep", "Length step", "shown unit", "How much ↑/↓ and the spin arrows change a length (Shift: ×10).", "0.000001")
    + num("angStep", "Angle step", "°", "How much ↑/↓ and the spin arrows change an angle (Shift: ×10).", "0.000001")
    + `</section>`;
  const legend = SK_COLOURS.map(([c, l, d]) => `<li><span class="prefs-sw" style="background:${c}" aria-hidden="true"></span><b>${esc(t(l))}</b> <span class="muted">${esc(t(d))}</span></li>`).join("");
  const sketch = `<section class="prefs-page" role="tabpanel" id="pp-sketch" aria-labelledby="pt-sketch" tabindex="0" hidden>`
    + chk("rotateToSketch", "Rotate the view normal to the sketch plane when a sketch opens")
    + chk("autoRels", "Automatic relations while drawing", "Lines snap horizontal, vertical, perpendicular, parallel or tangent and keep that relation; hold Ctrl to draw without them.")
    + chk("showRels", "Show relation glyphs")
    + chk("modelSnap", "Snap to model edges")
    + chk("slotDims", "Dimension new slots")
    + chk("grid", "Show grid")
    + chk("gridSnap", "Snap to grid")
    + num("gridStep", "Grid spacing", "mm", "Millimetres between grid lines; empty follows the zoom.")
    + `<h4 class="menu-h">${esc(t("Sketch colours"))}</h4><ul class="prefs-legend">${legend}</ul>`
    + `</section>`;
  const mouse = `<section class="prefs-page" role="tabpanel" id="pp-mouse" aria-labelledby="pt-mouse" tabindex="0" hidden>`
    + `<ul class="prefs-mouse"><li>${esc(t("Left drag: rotate the view (in a sketch: draw or select)."))}</li><li>${esc(t("Right drag: pan, or a mouse gesture when gestures are on."))}</li><li>${esc(t("Wheel: zoom about the pointer."))}</li></ul>`
    + `<label class="row">${esc(t("Middle drag"))} <select data-p="middle">${opt("pan", "Pan", p.middle)}${opt("rotate", "Rotate (SolidWorks)", p.middle)}</select></label>`
    + `<p class="muted">${esc(t("In a sketch the middle button always rotates, since the left one draws."))}</p>`
    + `<label class="row">${esc(t("Wheel zoom"))} <select data-p="wheel">${opt("normal", "Wheel away zooms in", p.wheel)}${opt("reverse", "Wheel away zooms out", p.wheel)}</select></label>`
    + `<button type="button" class="btn" data-a="gestures">${esc(t("Mouse gestures…"))}</button>`
    + `</section>`;
  const tab = (id: string, label: string) => `<button role="tab" data-tab="${id}" id="pt-${id}" aria-controls="pp-${id}" aria-selected="false" tabindex="-1">${esc(t(label))}</button>`;
  dlg.innerHTML = `<h3 id="prefs-title">${esc(t("Preferences"))}</h3>`
    + `<div class="tabs prefs-tabs" role="tablist" aria-label="${esc(t("Preferences"))}">${tab("modelling", "Modelling")}${tab("sketch", "Sketch")}${tab("mouse", "Mouse")}</div>`
    + modelling + sketch + mouse
    + `<div class="row end"><button class="btn" data-a="reset">${esc(t("Defaults"))}</button><button class="btn" data-a="cancel">${esc(t("Cancel"))}</button><button class="btn primary" data-a="ok">${esc(t("OK"))}</button></div>`;
  document.body.appendChild(dlg);
  let cur = page;
  const select = bindTabs(dlg.querySelector<HTMLElement>(".prefs-tabs")!, id => {
    cur = id as typeof page;
    dlg.querySelectorAll<HTMLElement>(".prefs-page").forEach(s => (s.hidden = s.id !== `pp-${id}`));
  });
  select(page);
  trapFocus(dlg, () => dlg.open);
  const opener = document.activeElement as HTMLElement | null;
  const close = () => { dlg.close(); };
  dlg.addEventListener("close", () => { dlg.remove(); opener?.focus?.(); });
  const field = (k: PrefKey) => dlg.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-p="${k}"]`);
  dlg.querySelector('[data-a="cancel"]')!.addEventListener("click", close);
  dlg.querySelector('[data-a="gestures"]')!.addEventListener("click", () => host.gestures());
  dlg.querySelector('[data-a="reset"]')!.addEventListener("click", () => {
    // Only the open page goes back to its defaults.
    dlg.querySelectorAll<HTMLInputElement | HTMLSelectElement>(`#pp-${cur} [data-p]`).forEach(el => {
      const v = DEFAULT_PREFS[el.dataset.p as PrefKey];
      if (el instanceof HTMLInputElement && el.type === "checkbox") el.checked = !!v;
      else el.value = typeof v === "number" && v === 0 && el instanceof HTMLInputElement ? "" : String(v);
    });
    if (cur === "modelling") { dlg.querySelector<HTMLSelectElement>('[data-x="units"]')!.value = "mm"; dlg.querySelector<HTMLSelectElement>('[data-x="decimals"]')!.value = ""; }
  });
  dlg.querySelector('[data-a="ok"]')!.addEventListener("click", () => {
    const out: Partial<Record<PrefKey, unknown>> = {};
    for (const k of Object.keys(DEFAULT_PREFS) as PrefKey[]) {
      const el = field(k);
      if (!el) continue;
      if (el instanceof HTMLInputElement && el.type === "checkbox") out[k] = el.checked;
      else if (typeof DEFAULT_PREFS[k] === "number") {
        const n = Number(el.value.replace(",", "."));
        out[k] = el.value.trim() === "" ? (k === "gridStep" ? 0 : DEFAULT_PREFS[k]) : Number.isFinite(n) && n >= 0 ? n : DEFAULT_PREFS[k];
      } else out[k] = el.value;
    }
    const u = dlg.querySelector<HTMLSelectElement>('[data-x="units"]')!.value, d = dlg.querySelector<HTMLSelectElement>('[data-x="decimals"]')!.value;
    if (u !== host.units()) host.setUnits(u);
    if (d !== host.decimals()) host.setDecimals(d);
    setPrefs(out as Partial<Prefs>);
    close();
  });
  dlg.showModal();
  dlg.querySelector<HTMLElement>(`#pt-${page}`)?.focus();
  return dlg;
}
