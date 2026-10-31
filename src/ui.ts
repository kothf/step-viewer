// Shared UI building blocks: toasts, modal dialogs (focus trap, Esc, backdrop),
// collapsible side panels, bottom-sheet navigation on phones, tabs, busy buttons
// and empty states. Used by both the 3D view (main.ts) and the PCB view (gerber/panel.ts).

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export const storage = {
  get(k: string) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

// ---------- toasts ----------

export type ToastKind = "info" | "success" | "warn" | "error";
/** Info and success toasts dismiss themselves after this many ms; warnings and errors stay until closed. */
export const TOAST_MS = 4000;
const MAX_TOASTS = 4;

/** Shows a non-blocking notification in the bottom-right stack. */
export function toast(msg: string, kind: ToastKind | boolean = "info") {
  const k: ToastKind = kind === true ? "error" : kind === false ? "info" : kind;
  const host = $("#toasts");
  if (!host) return;
  // The same message again just restarts its timer instead of stacking duplicates.
  for (const t of host.querySelectorAll<HTMLElement>(".toast")) if (t.dataset.msg === msg && t.dataset.kind === k) t.remove();
  const el = document.createElement("div");
  el.className = `toast ${k}`;
  el.dataset.kind = k;
  el.dataset.msg = msg;
  el.setAttribute("role", k === "error" || k === "warn" ? "alert" : "status");
  el.innerHTML = `<span class="msg">${esc(msg)}</span><button class="x" aria-label="Dismiss notification" title="Dismiss">✕</button>`;
  el.querySelector(".x")!.addEventListener("click", () => el.remove());
  host.appendChild(el);
  if (k === "info" || k === "success") window.setTimeout(() => el.remove(), TOAST_MS);
  const all = host.querySelectorAll(".toast");
  for (let i = 0; i < all.length - MAX_TOASTS; i++) all[i].remove();
}

// ---------- modal dialogs ----------

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

export function focusables(root: HTMLElement) {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(e => !e.hidden && e.offsetParent !== null && !e.closest("[hidden]"));
}

/** Keeps Tab / Shift+Tab inside `root` while `active()` is true. */
export function trapFocus(root: HTMLElement, active: () => boolean = () => true) {
  root.addEventListener("keydown", e => {
    if (e.key !== "Tab" || !active()) return;
    const f = focusables(root);
    if (!f.length) { e.preventDefault(); return; }
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
}

/**
 * Wires a <dialog class="modal">: focus trap, Esc (native), close buttons ([data-close]),
 * and closing on a backdrop click when the dialog has data-backdrop-close.
 * Focus returns to the element that opened it.
 */
export function bindModal(d: HTMLDialogElement) {
  let opener: HTMLElement | null = null;
  trapFocus(d, () => d.open);
  d.addEventListener("click", e => {
    if ((e.target as HTMLElement).closest("[data-close]")) { d.close(); return; }
    if (e.target !== d || !("backdropClose" in d.dataset)) return;
    const r = d.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close();
  });
  d.addEventListener("close", () => { opener?.focus?.(); opener = null; });
  return {
    open() {
      opener = document.activeElement as HTMLElement;
      d.showModal();
      (d.querySelector<HTMLElement>("[autofocus]") ?? focusables(d).at(-1))?.focus();
    },
  };
}

/** Confirmation for destructive actions: a backdrop click does not dismiss it, Esc and Cancel do. */
export function confirmModal(text: string, ok = "Delete", title = "Are you sure?"): Promise<boolean> {
  const d = $<HTMLDialogElement>("#confirm");
  $("#confirm-title").textContent = title;
  $("#confirm-text").textContent = text;
  const okBtn = d.querySelector<HTMLButtonElement>("[data-a=ok]")!;
  okBtn.textContent = ok;
  if (d.open) d.close();
  const opener = document.activeElement as HTMLElement | null;
  d.returnValue = "";
  d.showModal();
  d.querySelector<HTMLButtonElement>("[data-a=cancel]")!.focus();
  return new Promise(resolve => {
    const onClick = (e: Event) => {
      const a = (e.target as HTMLElement).closest<HTMLElement>("[data-a]")?.dataset.a;
      if (a) d.close(a);
    };
    // A close event still queued from a previous dialog arrives while this one is open: ignore it.
    const onClose = () => {
      if (d.open) return;
      d.removeEventListener("click", onClick);
      d.removeEventListener("close", onClose);
      opener?.focus?.();
      resolve(d.returnValue === "ok");
    };
    d.addEventListener("click", onClick);
    d.addEventListener("close", onClose);
  });
}

export function initModals() {
  const confirm = $<HTMLDialogElement>("#confirm");
  trapFocus(confirm, () => confirm.open);
}

// ---------- tabs ----------

/** role="tablist" behaviour: click or ←/→/Home/End switches, aria-selected and roving tabindex. */
export function bindTabs(list: HTMLElement, onSelect: (tab: string) => void) {
  const tabs = [...list.querySelectorAll<HTMLButtonElement>("[role=tab]")];
  const select = (b: HTMLButtonElement, focus = false) => {
    tabs.forEach(t => { const on = t === b; t.classList.toggle("on", on); t.setAttribute("aria-selected", String(on)); t.tabIndex = on ? 0 : -1; });
    if (focus) b.focus();
    onSelect(b.dataset.tab!);
  };
  tabs.forEach((b, i) => {
    b.addEventListener("click", () => select(b));
    b.addEventListener("keydown", e => {
      const j = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : null;
      if (j === null) return;
      e.preventDefault();
      select(tabs[(j + tabs.length) % tabs.length], true);
    });
  });
  return (tab: string) => { const b = tabs.find(t => t.dataset.tab === tab); if (b) select(b); };
}

// ---------- busy buttons ----------

/** Shows a spinner on `btn` while `work` runs (after one frame, so the spinner paints first). */
export async function busy<T>(btn: HTMLElement | null, work: () => T | Promise<T>): Promise<T> {
  if (!btn) return work();
  btn.classList.add("busy");
  btn.setAttribute("aria-busy", "true");
  await new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
  try { return await work(); }
  finally { btn.classList.remove("busy"); btn.removeAttribute("aria-busy"); }
}

// ---------- empty states ----------

const ICONS = {
  ruler: `<svg viewBox="0 0 48 48" width="48" height="48" aria-hidden="true"><path d="M6 34 34 6l8 8-28 28z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M13 27l3 3M18 22l4 4M23 17l3 3M28 12l4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  layers: `<svg viewBox="0 0 48 48" width="48" height="48" aria-hidden="true"><path d="M24 8 42 17 24 26 6 17z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M6 25l18 9 18-9M6 33l18 9 18-9" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" opacity=".6"/></svg>`,
  model: `<svg viewBox="0 0 48 48" width="48" height="48" aria-hidden="true"><path d="M24 5 41 15v18L24 43 7 33V15z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M24 5v38M7 15l17 10 17-10" fill="none" stroke="currentColor" stroke-width="1.6" opacity=".6"/></svg>`,
};

/** Illustration, short description and one call-to-action button. */
export function emptyState(host: HTMLElement, o: { icon: keyof typeof ICONS; title: string; text: string; cta: string; action: () => void }) {
  host.innerHTML = `<div class="empty-state">${ICONS[o.icon]}<h3>${esc(o.title)}</h3><p>${esc(o.text)}</p><button class="btn primary">${esc(o.cta)}</button></div>`;
  host.querySelector("button")!.addEventListener("click", o.action);
}

// ---------- side panels and sheets ----------

export type Breakpoint = "desktop" | "tablet" | "mobile";
export const breakpoint = (): Breakpoint => (innerWidth >= 1280 ? "desktop" : innerWidth >= 768 ? "tablet" : "mobile");

/**
 * Collapsible left/right panels (hamburger, panel button, Ctrl/Cmd+[ and Ctrl/Cmd+]).
 * The state is kept per breakpoint in localStorage; on tablets the PCB layer panel floats
 * over the board and starts closed. On phones the PCB panels open as full-screen sheets
 * from the bottom navigation bar.
 */
export function initPanels(app: HTMLElement) {
  const key = (side: "left" | "right") => `sv:panel:${side}:${breakpoint()}`;
  const isOpen = (side: "left" | "right") => {
    const v = storage.get(key(side));
    if (v) return v === "open";
    return !(side === "left" && breakpoint() === "tablet" && app.classList.contains("gerber"));
  };
  const apply = () => {
    for (const side of ["left", "right"] as const) {
      const open = isOpen(side);
      app.classList.toggle(`no-${side}`, !open);
      $(side === "left" ? "#nav-toggle" : "#panel-toggle").setAttribute("aria-expanded", String(open));
    }
  };
  const toggle = (side: "left" | "right") => {
    if (breakpoint() === "mobile" && app.classList.contains("gerber")) { setSheet(side === "left" ? "layers" : "tools"); return; }
    storage.set(key(side), isOpen(side) ? "closed" : "open");
    apply();
  };
  $("#nav-toggle").addEventListener("click", () => toggle("left"));
  $("#panel-toggle").addEventListener("click", () => toggle("right"));

  // Phone sheets
  const nav = $("#g-bottomnav");
  let sheetOpener: HTMLElement | null = null;
  const setSheet = (name: string) => {
    if (name && !app.dataset.sheet) sheetOpener = document.activeElement as HTMLElement;
    if (name) app.dataset.sheet = name; else delete app.dataset.sheet;
    nav.querySelectorAll<HTMLButtonElement>("[data-sheet]").forEach(b => {
      const on = b.dataset.sheet === name;
      b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on));
    });
    for (const id of ["#g-left", "#g-right"]) {
      const el = $(id), open = !!name && breakpoint() === "mobile" && (id === "#g-right" ? name === "tools" : name !== "tools");
      if (open) { el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true"); }
      else { el.removeAttribute("role"); el.removeAttribute("aria-modal"); }
    }
    if (name === "layers" || name === "measures") {
      selectGerberTab?.(name);
      $("#g-left-title").textContent = name === "layers" ? "Layers" : "Measurements";
    }
    if (name) requestAnimationFrame(() => $(name === "tools" ? "#g-right" : "#g-left").querySelector<HTMLElement>(".sheet-close")?.focus());
    else { sheetOpener?.focus?.(); sheetOpener = null; }
  };
  nav.querySelectorAll<HTMLButtonElement>("[data-sheet]").forEach(b => b.addEventListener("click", () => setSheet(b.dataset.sheet!)));
  document.querySelectorAll<HTMLElement>(".sheet-close").forEach(b => b.addEventListener("click", () => setSheet("")));
  for (const id of ["#g-left", "#g-right"]) {
    const el = $(id);
    trapFocus(el, () => !!app.dataset.sheet && breakpoint() === "mobile");
    el.addEventListener("keydown", e => { if (e.key === "Escape" && app.dataset.sheet) { e.stopPropagation(); setSheet(""); } });
  }

  window.addEventListener("keydown", e => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || (e.key !== "[" && e.key !== "]")) return;
    e.preventDefault();
    toggle(e.key === "[" ? "left" : "right");
  });
  let bp = breakpoint();
  window.addEventListener("resize", () => {
    if (breakpoint() === bp) return;
    bp = breakpoint();
    if (bp !== "mobile" && app.dataset.sheet) setSheet("");
    apply();
  });
  // The PCB mode switch changes the tablet default.
  let wasPcb = app.classList.contains("gerber");
  new MutationObserver(() => {
    const pcb = app.classList.contains("gerber");
    if (pcb !== wasPcb) { wasPcb = pcb; if (!pcb && app.dataset.sheet) setSheet(""); apply(); }
  }).observe(app, { attributes: true, attributeFilter: ["class"] });
  apply();
  let selectGerberTab: ((t: string) => void) | null = null;
  return {
    setSheet,
    closeSheet: () => { if (app.dataset.sheet) setSheet(""); },
    /** Closes the floating tablet panel / phone sheet after an action that needs the board visible. */
    revealBoard: () => {
      if (breakpoint() === "mobile") setSheet("");
      else if (breakpoint() === "tablet" && isOpen("left")) toggle("left");
    },
    setGerberTabSelector: (f: (t: string) => void) => { selectGerberTab = f; },
    apply,
  };
}
export type Panels = ReturnType<typeof initPanels>;
