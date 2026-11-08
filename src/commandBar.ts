// Command manager (FRS 13.2, FR-UI-010..013): one tabbed command bar below the header for every 3D
// document. The tabs depend on what is open (a plain model: Evaluate; a part: Features, Sketch, Surfaces,
// Weldments, Evaluate; an assembly: Assembly, Evaluate). Each pane in #cm-body names the tabs it serves in
// `data-cm-pane`; the owner of a pane (main.ts, the part or assembly controller) fills it and re-renders
// on `onCmTab`. Entering a sketch selects the Sketch tab; leaving it goes back to Features.
import { t } from "./i18n";

export type CmTabId = "features" | "sketch" | "surfaces" | "weldments" | "assembly" | "evaluate";

const LABELS: Record<CmTabId, string> = {
  features: "Features", sketch: "Sketch", surfaces: "Surfaces", weldments: "Weldments", assembly: "Assembly", evaluate: "Evaluate",
};

let tabs: CmTabId[] = [];
let active: CmTabId | null = null;
/** The tab picked last for each set of tabs, so going back to a part shows the tab it had. */
const lastFor = new Map<string, CmTabId>();
const subs = new Set<(tab: CmTabId | null) => void>();

const $ = (s: string) => document.querySelector<HTMLElement>(s);

/** The selected command tab (null when the bar is hidden). */
export const cmTab = () => active;

export function onCmTab(fn: (tab: CmTabId | null) => void) { subs.add(fn); }

/** Sets which tabs the bar offers; keeps the current tab when it is still offered, else the one used last. */
export function setCmTabs(list: CmTabId[], prefer?: CmTabId) {
  const key = list.join(",");
  const same = key === tabs.join(",");
  tabs = list;
  const next = prefer && list.includes(prefer) ? prefer
    : active && list.includes(active) && same ? active
    : lastFor.get(key) ?? list[0] ?? null;
  if (!same) render();
  select(next);
}

/** Selects a tab (ignored when it is not offered). */
export function selectCmTab(id: CmTabId | null) {
  if (id && !tabs.includes(id)) return;
  select(id);
}

function select(id: CmTabId | null) {
  const changed = id !== active;
  active = id;
  if (id) lastFor.set(tabs.join(","), id);
  const bar = $("#cm");
  if (bar) bar.hidden = !tabs.length;
  document.querySelectorAll<HTMLElement>("#cm-tabs [data-cm]").forEach(b => {
    const on = b.dataset.cm === id;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", String(on));
    b.tabIndex = on ? 0 : -1;
  });
  document.querySelectorAll<HTMLElement>("#cm-body [data-cm-pane]").forEach(p => {
    p.hidden = !id || !p.dataset.cmPane!.split(" ").includes(id);
  });
  if (changed) for (const fn of subs) fn(id);
}

function render() {
  const el = $("#cm-tabs");
  if (!el) return;
  el.innerHTML = tabs.map(id => `<button type="button" role="tab" data-cm="${id}" id="cm-t-${id}" aria-selected="false" tabindex="-1">${t(LABELS[id])}</button>`).join("");
}

/** Wires the tab strip: click and arrow keys (roving tab index). */
export function bindCommandBar() {
  const el = $("#cm-tabs");
  if (!el) return;
  el.addEventListener("click", e => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-cm]");
    if (b) select(b.dataset.cm as CmTabId);
  });
  el.addEventListener("keydown", e => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return;
    const i = active ? tabs.indexOf(active) : 0;
    const j = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : (i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    e.preventDefault();
    e.stopPropagation();
    select(tabs[j]);
    el.querySelector<HTMLElement>(`[data-cm="${tabs[j]}"]`)?.focus();
  });
}

/** Re-labels the tabs after a language change. */
export function relabelCmTabs() {
  document.querySelectorAll<HTMLElement>("#cm-tabs [data-cm]").forEach(b => { b.textContent = t(LABELS[b.dataset.cm as CmTabId]); });
}
