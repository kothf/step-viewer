// Settings (FR-UI-080): one dialog for every lasting choice, as a CAD app's system options. Categories on the
// left, a search over all of them, the page on the right. OK stores, Cancel leaves everything as it was;
// Reset page / Reset all fill the fields with the defaults (OK still stores them). Values live in prefs.ts
// (localStorage) or, for language, theme, tips, units and decimals, behind the host.
import { t } from "./i18n";
import { trapFocus } from "./ui";
import { AUTOSAVE_CHOICES, DEFAULT_PREFS, loadPrefs, setPrefs, settingMatches, type PrefKey, type Prefs } from "./prefs";
import { SNAP_KINDS, parseSnaps } from "./sketch/snaps";
import { RESERVED, assign, comboOf, loadShortcuts, saveShortcuts, type Shortcuts } from "./shortcuts";

export interface PrefsHost {
  units(): string;
  decimals(): string;
  setUnits(u: string): void;
  setDecimals(d: string): void;
  lang(): string;
  setLang(l: string): void;
  theme(): string;
  setTheme(th: string): void;
  tips(): boolean;
  setTips(on: boolean): void;
  /** Opens the mouse gesture settings. */
  gestures(): void;
  /** Part and sketch commands a shortcut can run: [id, label in the UI language, English label]. */
  commands?(): [string, string, string][];
}

export type SettingsPage = "general" | "units" | "view" | "mouse" | "keys" | "modelling" | "sketch";

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const UNITS = ["mm", "cm", "m", "in", "ft"];
const PAGE_KEY = "mc:settingsPage";

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

/** Host values that are not in prefs.ts, with their defaults for Reset. */
type HostKey = "lang" | "theme" | "tips" | "units" | "decimals";
const HOST_DEFAULTS: Record<HostKey, string> = { lang: "en", theme: "light", tips: "1", units: "mm", decimals: "" };

const PAGES: [SettingsPage, string, string][] = [
  ["general", "General", ""],
  ["units", "Units", "M2 11h12M4 11V8M6 11V9M8 11V7M10 11V9M12 11V8"],
  ["view", "View and performance", "M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"],
  ["mouse", "Mouse", "M5 2.5h6v6a3 3 0 0 1-6 0zM8 2.5v3"],
  ["keys", "Keyboard", "M1.5 4.5h13v7h-13zM4 7h.01M6.5 7h.01M9 7h.01M11.5 7h.01M5 9.5h6"],
  ["modelling", "Modelling", "M3 5.5 8 3l5 2.5v5L8 13l-5-2.5zM3 5.5 8 8l5-2.5M8 8v5"],
  ["sketch", "Sketch", "M2.5 13.5 12 4l1.5 1.5L4 15H2.5zM10.5 5.5l1.5 1.5"],
];

export function openPrefs(host: PrefsHost, page?: SettingsPage | "modelling" | "sketch" | "mouse") {
  document.getElementById("prefs-dlg")?.remove();
  const p = loadPrefs();
  let start = page;
  if (!start) { try { start = (localStorage.getItem(PAGE_KEY) as SettingsPage | null) ?? undefined; } catch { /* private mode */ } }
  if (!start || !PAGES.some(([id]) => id === start)) start = "general";
  const dlg = document.createElement("dialog");
  dlg.id = "prefs-dlg";
  dlg.className = "modal settings";
  dlg.setAttribute("aria-labelledby", "prefs-title");
  let uid = 0;
  // Every row carries its English and shown texts in data-find, so a search works in either language.
  const find = (...en: string[]) => esc(en.filter(Boolean).flatMap(s => [s, t(s)]).join(" "));
  const help = (h: string) => h ? `<span class="set-help">${esc(t(h))}</span>` : "";
  const chk = (k: PrefKey | HostKey, label: string, h = "", on = !!p[k as PrefKey]) => {
    const attr = k in DEFAULT_PREFS ? `data-p="${k}"` : `data-h="${k}"`;
    return `<label class="set-row set-chk" data-find="${find(label, h)}"><input type="checkbox" ${attr}${on ? " checked" : ""} /><span class="set-l"><span class="set-t">${esc(t(label))}</span>${help(h)}</span></label>`;
  };
  const row = (label: string, h: string, control: (id: string) => string) => {
    const id = `set-f${++uid}`;
    return `<div class="set-row" data-find="${find(label, h)}"><span class="set-l"><label class="set-t" for="${id}">${esc(t(label))}</label>${help(h)}</span><span class="set-c">${control(id)}</span></div>`;
  };
  const opt = (v: string, label: string, cur: string, raw = false) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(raw ? label : t(label))}</option>`;
  const sel = (attr: string, opts: string) => (id: string) => `<select id="${id}" ${attr}>${opts}</select>`;
  const num = (k: PrefKey, unit: string, min: string, placeholder = "") => (id: string) =>
    `<input id="${id}" type="number" min="${min}" step="any" data-p="${k}" value="${p[k] || ""}"${placeholder ? ` placeholder="${esc(t(placeholder))}"` : ""} /> <span class="muted">${esc(t(unit))}</span>`;
  const group = (title: string, body: string) => `<section class="set-group"><h4 class="set-gh">${esc(t(title))}</h4>${body}</section>`;
  const autosave = AUTOSAVE_CHOICES.map(s => `<option value="${s}"${s === p.autosave ? " selected" : ""}>${esc(s === 0 ? t("Off") : s === 1 ? t("After each change") : s < 60 ? t("{n} s", { n: s }) : t("{n} min", { n: s / 60 }))}</option>`).join("");
  const snapsOn = parseSnaps(p.snaps);
  const keys: Shortcuts = { ...loadShortcuts() };
  const cmds = host.commands?.() ?? [];

  const body: Record<SettingsPage, string> = {
    general: group("Interface",
      row("Language", "", sel(`data-h="lang"`, opt("en", "English", host.lang(), true) + opt("ru", "Русский", host.lang(), true)))
      + row("Theme", "", sel(`data-h="theme"`, opt("light", "Light", host.theme()) + opt("dark", "Dark", host.theme())))
      + chk("tips", "Show tips", "Short tips the first time you open a model or board, measure or add a section.", host.tips()))
      + group("Recovery",
        row("Autosave for recovery", "Unsaved work is kept in the browser for recovery after a crash.", sel(`data-p="autosave"`, autosave))),
    units: group("Units",
      row("Units", "Lengths in measurements, panels and new parts. A part keeps its own unit; the status bar changes it too.", sel(`data-h="units"`, UNITS.map(u => opt(u, u, host.units(), true)).join("")))
      + row("Decimals", "Digits after the point in shown values; Auto picks them by size.", sel(`data-h="decimals"`, opt("", "Auto", host.decimals()) + [0, 1, 2, 3, 4, 5, 6].map(d => opt(String(d), String(d), host.decimals(), true)).join(""))))
      + group("Spin boxes",
        row("Length step", "How much ↑/↓ and the spin arrows change a length (Shift: ×10).", num("lenStep", "shown unit", "0.000001"))
        + row("Angle step", "How much ↑/↓ and the spin arrows change an angle (Shift: ×10).", num("angStep", "°", "0.000001"))),
    view: group("Image quality",
      row("Parts", "How finely parts you model are drawn on screen. Coarse rebuilds faster; it does not change the exact geometry.", sel(`data-p="quality"`, opt("coarse", "Coarse", p.quality) + opt("normal", "Normal", p.quality) + opt("fine", "Fine", p.quality)))
      + row("Opened files", "Mesh of STEP, IGES and BREP files when they are opened. Fine is smoother and slower; measurements use the exact geometry either way.", sel(`data-p="importQuality"`, opt("draft", "Draft mesh", p.importQuality) + opt("normal", "Normal mesh", p.importQuality) + opt("fine", "Fine mesh", p.importQuality)))),
    mouse: group("Buttons and wheel",
      `<ul class="set-note">${["Left drag: rotate the view (in a sketch: draw or select).", "Right drag: pan, or a mouse gesture when gestures are on.", "Wheel: zoom about the pointer."].map(s => `<li>${esc(t(s))}</li>`).join("")}</ul>`
      + row("Middle drag", "In a sketch the middle button always rotates, since the left one draws.", sel(`data-p="middle"`, opt("pan", "Pan", p.middle) + opt("rotate", "Rotate (CAD app style)", p.middle)))
      + row("Wheel zoom", "", sel(`data-p="wheel"`, opt("normal", "Wheel away zooms in", p.wheel) + opt("reverse", "Wheel away zooms out", p.wheel))))
      + group("Mouse gestures",
        `<div class="set-row" data-find="${find("Mouse gestures", "Right-drag in a part or a sketch runs a command")}"><span class="set-l"><span class="set-t">${esc(t("Mouse gestures"))}</span>${help("Right-drag in a part or a sketch runs a command")}</span><span class="set-c"><button type="button" class="btn" data-a="gestures">${esc(t("Set up…"))}</button></span></div>`),
    keys: `<p class="set-help set-gnote">${esc(t("Click a box and press the keys for that command; Backspace clears it. Save, undo, copy, Esc and the other fixed keys stay as they are."))}</p>`
      + group("Part and sketch commands", cmds.map(([id, label, en]) => {
        const fid = `set-k${++uid}`;
        return `<div class="set-row" data-find="${find(en, "Keyboard")}"><span class="set-l"><label class="set-t" for="${fid}">${esc(label)}</label></span><span class="set-c"><input id="${fid}" class="set-key" readonly data-sc="${esc(id)}" value="${esc(keys[id] ?? "")}" placeholder="${esc(t("None"))}" aria-label="${esc(t("Shortcut for {name}", { name: label }))}" /><button type="button" class="icon" data-scx="${esc(id)}" aria-label="${esc(t("Clear"))}" title="${esc(t("Clear"))}">✕</button></span></div>`;
      }).join("") || `<p class="set-help">${esc(t("Open a part to set its commands' shortcuts."))}</p>`),
    modelling: group("Rebuild",
      chk("verify", "Verification on rebuild", "Checks the body after every feature and warns when it is not valid. Slower.")),
    sketch: group("When a sketch opens",
      chk("rotateToSketch", "Rotate the view normal to the sketch plane")
      + chk("projectFace", "Project the face's edges", "A new sketch on a model face starts with the face's outline as construction lines that follow the edges, to snap and dimension to."))
      + group("Display",
        chk("showRels", "Show relation glyphs", "Relation glyphs next to the entities; hover one to see what it ties, click to select it.")
        + chk("shade", "Shade closed regions", "Fill closed regions while sketching, so an outline that does not close shows at once."))
      + group("While drawing",
        chk("autoRels", "Automatic relations", "Lines snap horizontal, vertical, perpendicular, parallel or tangent and keep that relation; hold Ctrl to draw without them.")
        + chk("modelSnap", "Snap to model geometry", "Points snap to model vertices, edge midpoints and circle centres, and stay attached to them; Smart Dimension takes model edges.")
        + chk("addDims", "Dimension new lines, rectangles, circles and arcs", "Their sizes become dimensions and the Modify box opens on each; click on to keep the drawn size.")
        + chk("slotDims", "Dimension new slots", "Slots get width and length (or radius) dimensions, and the Modify box opens on them."))
      + group("Snaps",
        `<p class="set-help set-gnote">${esc(t("What the drawing tools snap to. A quick snap (status bar or right-click) uses one kind for the next click."))}</p><div class="set-cols">`
        + SNAP_KINDS.map(([k, label]) => `<label class="set-row set-chk" data-find="${find(label, "Snaps")}"><input type="checkbox" data-sksnap="${k}"${snapsOn.has(k) ? " checked" : ""} /><span class="set-l"><span class="set-t">${esc(t(label))}</span></span></label>`).join("") + `</div>`)
      + group("Grid",
        chk("grid", "Show grid")
        + chk("gridSnap", "Snap to grid", "Points that snap to nothing else go to the nearest grid point; hold Ctrl to place freely.")
        + row("Grid spacing", "Millimetres between grid lines; empty follows the zoom.", num("gridStep", "mm", "0", "Automatic")))
      + `<details class="set-group set-legend" data-find="${find("Sketch colours", ...SK_COLOURS.flatMap(c => [c[1], c[2]]))}"><summary class="set-gh">${esc(t("Sketch colours"))}</summary><ul class="prefs-legend">${SK_COLOURS.map(([c, l, d]) => `<li><span class="prefs-sw" style="background:${c}" aria-hidden="true"></span><b>${esc(t(l))}</b> <span class="muted">${esc(t(d))}</span></li>`).join("")}</ul></details>`,
  };

  const GEAR = `<svg viewBox="3 3 18 18" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M17.25 10.74L19.14 11.04L19.14 12.96L17.25 13.26L16.60 14.82L17.72 16.37L16.37 17.72L14.82 16.60L13.26 17.25L12.96 19.14L11.04 19.14L10.74 17.25L9.18 16.60L7.63 17.72L6.28 16.37L7.40 14.82L6.75 13.26L4.86 12.96L4.86 11.04L6.75 10.74L7.40 9.18L6.28 7.63L7.63 6.28L9.18 7.40L10.74 6.75L11.04 4.86L12.96 4.86L13.26 6.75L14.82 7.40L16.37 6.28L17.72 7.63L16.60 9.18Z"/><circle cx="12" cy="12" r="2.6"/></svg>`;
  const icon = (d: string) => d ? `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>` : GEAR;
  dlg.innerHTML = `<div class="modal-head set-head"><h3 id="prefs-title">${esc(t("Settings"))}</h3>`
    + `<input type="search" id="set-q" class="set-q" placeholder="${esc(t("Search settings"))}" aria-label="${esc(t("Search settings"))}" autocomplete="off" />`
    + `<button type="button" class="icon" data-a="cancel" aria-label="${esc(t("Close"))}" title="${esc(t("Close (Esc)"))}">✕</button></div>`
    + `<div class="set-body"><nav class="set-nav" role="tablist" aria-orientation="vertical" aria-label="${esc(t("Settings"))}">`
    + PAGES.map(([id, label, d]) => `<button type="button" role="tab" data-tab="${id}" id="pt-${id}" aria-controls="pp-${id}" aria-selected="false" tabindex="-1">${icon(d)}<span>${esc(t(label))}</span><span class="set-n" aria-hidden="true"></span></button>`).join("")
    + `</nav><div class="set-pages">`
    + PAGES.map(([id, label]) => `<section class="prefs-page set-page" role="tabpanel" id="pp-${id}" aria-labelledby="pt-${id}" tabindex="0" hidden><h3 class="set-ph">${esc(t(label))}</h3>${body[id]}</section>`).join("")
    + `<p class="set-none muted" role="status" hidden></p></div></div>`
    + `<div class="row end set-foot"><button type="button" class="btn" data-a="reset" title="${esc(t("Put this page's settings back to their defaults (OK stores them)"))}">${esc(t("Reset page"))}</button>`
    + `<button type="button" class="btn" data-a="resetall" title="${esc(t("Put every setting back to its default (OK stores them)"))}">${esc(t("Reset all"))}</button><span class="spacer"></span>`
    + `<button type="button" class="btn" data-a="cancel">${esc(t("Cancel"))}</button><button type="button" class="btn primary" data-a="ok">${esc(t("OK"))}</button></div>`;
  document.body.appendChild(dlg);

  const tabs = [...dlg.querySelectorAll<HTMLButtonElement>(".set-nav [role=tab]")];
  const pages = [...dlg.querySelectorAll<HTMLElement>(".set-page")];
  const q = dlg.querySelector<HTMLInputElement>("#set-q")!;
  let cur = start as SettingsPage;
  const show = (id: SettingsPage, focus = false) => {
    cur = id;
    tabs.forEach(b => { const on = b.dataset.tab === id; b.classList.toggle("on", on); b.setAttribute("aria-selected", String(on)); b.tabIndex = on ? 0 : -1; if (on) { if (focus) b.focus(); b.scrollIntoView?.({ block: "nearest", inline: "nearest" }); } });
    pages.forEach(s => (s.hidden = s.id !== `pp-${id}`));
    try { localStorage.setItem(PAGE_KEY, id); } catch { /* private mode */ }
  };
  // Search: every page shows its matching rows (groups without one fold away); the nav counts them.
  const search = () => {
    const text = q.value.trim();
    dlg.classList.toggle("searching", !!text);
    if (!text) {
      dlg.querySelectorAll<HTMLElement>("[data-find], .set-group, .set-gnote").forEach(el => (el.hidden = false));
      dlg.querySelectorAll(".set-row.first").forEach(r => r.classList.remove("first"));
      tabs.forEach(b => { b.querySelector(".set-n")!.textContent = ""; b.classList.remove("dim"); });
      dlg.querySelector<HTMLElement>(".set-none")!.hidden = true;
      show(cur);
      return;
    }
    let total = 0;
    for (const s of pages) {
      let n = 0;
      s.querySelectorAll<HTMLElement>("[data-find]").forEach(el => { const ok = settingMatches(text, [el.dataset.find ?? ""]); el.hidden = !ok; if (ok) n++; });
      s.querySelectorAll<HTMLElement>(".set-group:not([data-find])").forEach(g => (g.hidden = !g.querySelector("[data-find]:not([hidden])")));
      s.querySelectorAll<HTMLElement>(".set-gnote").forEach(g => (g.hidden = true));
      s.hidden = !n;
      total += n;
      const b = tabs.find(x => `pp-${x.dataset.tab}` === s.id)!;
      b.querySelector(".set-n")!.textContent = n ? String(n) : "";
      b.classList.toggle("dim", !n);
      b.classList.remove("on");
      b.setAttribute("aria-selected", "false");
    }
    // The first shown row of a group has no line above it.
    dlg.querySelectorAll<HTMLElement>(".set-group").forEach(g => {
      let first = true;
      g.querySelectorAll<HTMLElement>(":scope > .set-row, :scope > .set-cols > .set-row").forEach(r => { r.classList.toggle("first", first && !r.hidden); if (!r.hidden) first = false; });
    });
    const none = dlg.querySelector<HTMLElement>(".set-none")!;
    none.hidden = !!total;
    none.textContent = total ? "" : t("No settings match “{q}”.", { q: text });
  };
  q.addEventListener("input", search);
  q.addEventListener("keydown", e => { if (e.key === "Escape" && q.value) { e.preventDefault(); e.stopPropagation(); q.value = ""; search(); } });
  tabs.forEach((b, i) => {
    b.addEventListener("click", () => { if (q.value) { q.value = ""; search(); } show(b.dataset.tab as SettingsPage); });
    b.addEventListener("keydown", e => {
      const j = e.key === "ArrowDown" || e.key === "ArrowRight" ? i + 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : null;
      if (j === null) return;
      e.preventDefault();
      if (q.value) { q.value = ""; search(); }
      show(tabs[(j + tabs.length) % tabs.length].dataset.tab as SettingsPage, true);
    });
  });
  show(cur);
  trapFocus(dlg, () => dlg.open);
  const opener = document.activeElement as HTMLElement | null;
  const close = () => { dlg.close(); };
  dlg.addEventListener("close", () => { dlg.remove(); opener?.focus?.(); });
  dlg.addEventListener("cancel", e => { if (q.value && document.activeElement === q) e.preventDefault(); });
  dlg.querySelectorAll('[data-a="cancel"]').forEach(b => b.addEventListener("click", close));
  dlg.querySelector('[data-a="gestures"]')!.addEventListener("click", () => host.gestures());

  // Shortcut boxes: the keys pressed in one become its combination; the command that had it loses it.
  const keyBox = (id: string) => dlg.querySelector<HTMLInputElement>(`[data-sc="${CSS.escape(id)}"]`);
  const setKey = (id: string, combo: string) => {
    const lost = assign(keys, id, combo);
    const box = keyBox(id);
    if (box) box.value = combo;
    if (lost) { const b = keyBox(lost); if (b) b.value = ""; flash(t("{key} moved from {name}.", { key: combo, name: cmds.find(c => c[0] === lost)?.[1] ?? lost })); }
  };
  dlg.querySelectorAll<HTMLInputElement>("[data-sc]").forEach(box => box.addEventListener("keydown", e => {
    if (e.key === "Tab" || (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey)) return;
    e.preventDefault(); e.stopPropagation();
    if ((e.key === "Backspace" || e.key === "Delete") && !e.ctrlKey && !e.altKey && !e.shiftKey) { setKey(box.dataset.sc!, ""); return; }
    const combo = comboOf(e);
    if (!combo) return;
    if (RESERVED.has(combo)) { flash(t("{key} is kept for the app.", { key: combo })); return; }
    setKey(box.dataset.sc!, combo);
  }));
  dlg.querySelectorAll<HTMLButtonElement>("[data-scx]").forEach(b => b.addEventListener("click", () => setKey(b.dataset.scx!, "")));

  const resetIn = (root: ParentNode) => {
    root.querySelectorAll<HTMLInputElement>("[data-sc]").forEach(el => { assign(keys, el.dataset.sc!, ""); el.value = ""; });
    root.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-p]").forEach(el => {
      const v = DEFAULT_PREFS[el.dataset.p as PrefKey];
      if (el instanceof HTMLInputElement && el.type === "checkbox") el.checked = !!v;
      else el.value = typeof v === "number" && v === 0 && el instanceof HTMLInputElement ? "" : String(v);
    });
    root.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-h]").forEach(el => {
      const v = HOST_DEFAULTS[el.dataset.h as HostKey];
      if (el instanceof HTMLInputElement && el.type === "checkbox") el.checked = v === "1"; else el.value = v;
    });
    const def = parseSnaps(DEFAULT_PREFS.snaps);
    root.querySelectorAll<HTMLInputElement>("[data-sksnap]").forEach(el => (el.checked = def.has(el.dataset.sksnap as never)));
  };
  const flash = (text: string) => {
    const none = dlg.querySelector<HTMLElement>(".set-none")!;
    if (q.value) return;
    none.hidden = false; none.textContent = text;
    setTimeout(() => { if (!q.value) none.hidden = true; }, 2500);
  };
  dlg.querySelector('[data-a="reset"]')!.addEventListener("click", () => {
    // During a search the shown rows are the "page".
    if (q.value) dlg.querySelectorAll<HTMLElement>(".set-page [data-find]:not([hidden])").forEach(el => resetIn(el));
    else { resetIn(dlg.querySelector(`#pp-${cur}`)!); flash(t("This page shows the defaults; OK stores them.")); }
  });
  dlg.querySelector('[data-a="resetall"]')!.addEventListener("click", () => { resetIn(dlg); flash(t("Every page shows the defaults; OK stores them.")); });

  dlg.querySelector('[data-a="ok"]')!.addEventListener("click", () => {
    const out: Partial<Record<PrefKey, unknown>> = {};
    for (const k of Object.keys(DEFAULT_PREFS) as PrefKey[]) {
      const el = dlg.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-p="${k}"]`);
      if (!el) continue;
      if (el instanceof HTMLInputElement && el.type === "checkbox") out[k] = el.checked;
      else if (typeof DEFAULT_PREFS[k] === "number") {
        const n = Number(el.value.replace(",", "."));
        out[k] = el.value.trim() === "" ? (k === "gridStep" ? 0 : DEFAULT_PREFS[k]) : Number.isFinite(n) && n >= 0 ? n : DEFAULT_PREFS[k];
      } else out[k] = el.value;
    }
    out.snaps = JSON.stringify([...dlg.querySelectorAll<HTMLInputElement>("[data-sksnap]")].filter(i => i.checked).map(i => i.dataset.sksnap));
    const hv = (k: HostKey) => dlg.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-h="${k}"]`)!;
    const tips = (hv("tips") as HTMLInputElement).checked;
    if (tips !== host.tips()) host.setTips(tips);
    if (hv("theme").value !== host.theme()) host.setTheme(hv("theme").value);
    if (hv("units").value !== host.units()) host.setUnits(hv("units").value);
    if (hv("decimals").value !== host.decimals()) host.setDecimals(hv("decimals").value);
    const lang = hv("lang").value;
    setPrefs(out as Partial<Prefs>);
    if (cmds.length) saveShortcuts(keys);
    close();
    if (lang !== host.lang()) host.setLang(lang);
  });
  dlg.showModal();
  if (page) dlg.querySelector<HTMLElement>(`#pt-${cur}`)?.focus(); else q.focus();
  return dlg;
}
