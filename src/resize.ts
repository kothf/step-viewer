// Resizable panels and dialogs (FR-UI-002): a grip on a panel's edge drags its width (or height), arrow keys
// step it, a double-click puts the default back, and the size is remembered (localStorage `mc:size:<key>`).
// Dialogs get the browser's corner grip; a dialog the user resized opens at that size next time.
import { t } from "./i18n";

export interface GripOpts {
  /** localStorage key part: `mc:size:<key>`. */
  key: string;
  /** "x": the grip drags a width; "y": a height. */
  axis: "x" | "y";
  /** 1: dragging right/down grows the panel (grip on its right/bottom edge); -1: the other way. */
  sign: 1 | -1;
  def: number;
  min: number;
  max: () => number;
  /** Sets the size in px (null: back to the default). */
  apply(px: number | null): void;
  /** The panel's size now, when the default comes from CSS. */
  measure?: () => number;
  label: string;
}

const read = (key: string): number | null => {
  try { const v = Number(localStorage.getItem(`mc:size:${key}`)); return v > 0 ? v : null; } catch { return null; }
};
const write = (key: string, v: number | null) => {
  try { if (v == null) localStorage.removeItem(`mc:size:${key}`); else localStorage.setItem(`mc:size:${key}`, String(Math.round(v))); } catch { /* storage off */ }
};

/** Makes a grip element for a panel edge and applies the remembered size. */
export function makeGrip(o: GripOpts): HTMLDivElement {
  const g = document.createElement("div");
  g.className = `grip grip-${o.axis}`;
  g.setAttribute("role", "separator");
  g.setAttribute("aria-orientation", o.axis === "x" ? "vertical" : "horizontal");
  g.setAttribute("aria-label", t(o.label));
  g.title = t("Drag to resize; double-click for the default size");
  g.tabIndex = 0;
  let size = o.def;
  const clamp = (v: number) => Math.round(Math.max(o.min, Math.min(Math.max(o.min, o.max()), v)));
  const set = (v: number | null, save: boolean) => {
    size = v == null ? o.def : clamp(v);
    o.apply(v == null ? null : size);
    g.setAttribute("aria-valuemin", String(o.min));
    g.setAttribute("aria-valuemax", String(Math.round(Math.max(o.min, o.max()))));
    g.setAttribute("aria-valuenow", String(size));
    if (save) write(o.key, v == null ? null : size);
  };
  const saved = read(o.key);
  set(saved, false);
  g.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    g.setPointerCapture(e.pointerId);
    if (o.measure) size = Math.round(o.measure());
    const start = o.axis === "x" ? e.clientX : e.clientY, s0 = size;
    document.documentElement.classList.add("resizing");
    const move = (ev: PointerEvent) => set(s0 + o.sign * ((o.axis === "x" ? ev.clientX : ev.clientY) - start), false);
    const up = () => {
      g.removeEventListener("pointermove", move);
      g.removeEventListener("pointerup", up);
      g.removeEventListener("pointercancel", up);
      document.documentElement.classList.remove("resizing");
      write(o.key, size);
    };
    g.addEventListener("pointermove", move);
    g.addEventListener("pointerup", up);
    g.addEventListener("pointercancel", up);
  });
  g.addEventListener("dblclick", e => { e.stopPropagation(); set(null, true); });
  g.addEventListener("keydown", e => {
    const grow = o.axis === "x" ? (o.sign > 0 ? "ArrowRight" : "ArrowLeft") : (o.sign > 0 ? "ArrowDown" : "ArrowUp");
    const shrink = o.axis === "x" ? (o.sign > 0 ? "ArrowLeft" : "ArrowRight") : (o.sign > 0 ? "ArrowUp" : "ArrowDown");
    const step = e.shiftKey ? 64 : 16;
    if (o.measure && (e.key === grow || e.key === shrink)) size = Math.round(o.measure());
    if (e.key === grow) set(size + step, true);
    else if (e.key === shrink) set(size - step, true);
    else if (e.key === "Home") set(o.min, true);
    else if (e.key === "End") set(o.max(), true);
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  // A smaller window may no longer fit a remembered size: keep it inside.
  window.addEventListener("resize", () => { if (read(o.key) != null) set(size, false); });
  return g;
}

/**
 * Dialogs: the corner grip resizes them (CSS `resize: both`); a dialog with an id that was resized opens at that
 * size next time. Lifting the default width cap starts on a press in the corner.
 */
export function rememberDialogSizes() {
  const corner = (d: HTMLDialogElement, e: PointerEvent) => { const r = d.getBoundingClientRect(); return e.clientX > r.right - 18 && e.clientY > r.bottom - 18; };
  document.addEventListener("pointerdown", e => {
    const d = (e.target as HTMLElement).closest?.("dialog");
    if (d && d.id && corner(d, e)) d.classList.add("sized");
  }, true);
  const seen = new WeakMap<HTMLDialogElement, boolean>();
  const sync = (d: HTMLDialogElement) => {
    const was = seen.get(d) ?? false;
    if (d.open === was) return;
    seen.set(d, d.open);
    const key = `dlg:${d.id}`;
    if (d.open) {
      try {
        const v = JSON.parse(localStorage.getItem(`mc:size:${key}`) ?? "null") as [number, number] | null;
        if (v) { d.classList.add("sized"); d.style.width = `${v[0]}px`; d.style.height = `${v[1]}px`; }
      } catch { /* none */ }
    } else if (d.classList.contains("sized") && d.style.width) {
      try { localStorage.setItem(`mc:size:${key}`, JSON.stringify([parseFloat(d.style.width), parseFloat(d.style.height) || d.offsetHeight])); } catch { /* storage off */ }
    }
  };
  new MutationObserver(ms => { for (const m of ms) if (m.target instanceof HTMLDialogElement && m.target.id) sync(m.target); })
    .observe(document.body, { subtree: true, attributes: true, attributeFilter: ["open"] });
}
