// Command tooltips (FR-UI-112): a command button's tooltip shows its label, its shortcut key and a one-line
// description; a disabled button says why (its `data-why`). The text comes from the button itself: the label
// from `.mc-l` (or aria-label), the description from `title`, whose trailing "(key)" becomes the shortcut.
import { t } from "./i18n";
import { tipParts } from "./tipText";

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/**
 * Rich tooltips for the command buttons under `root` (the command bar). The native title is taken off while the
 * tooltip shows (and put back), so the browser's own tooltip doesn't show twice. Disabled buttons get no pointer
 * events, so the button is found from the pointer position.
 */
export function bindCommandTips(root: HTMLElement, selector = ".mc-b, .mc-caret") {
  let tip: HTMLElement | null = null, cur: HTMLElement | null = null, timer = 0;
  const hide = () => {
    clearTimeout(timer);
    if (cur && cur.dataset.tipTitle != null) { cur.title = cur.dataset.tipTitle; delete cur.dataset.tipTitle; cur.removeAttribute("aria-describedby"); }
    cur = null;
    tip?.remove();
    tip = null;
  };
  const show = (b: HTMLElement) => {
    const title = b.dataset.tipTitle ?? b.title;
    if (!title && !b.dataset.why) return;
    const label = (b.querySelector(".mc-l")?.textContent ?? b.getAttribute("aria-label") ?? "").replace(/\s*▾\s*$/, "").trim();
    const p = tipParts(label, title, (b as HTMLButtonElement).disabled ? b.dataset.why ?? null : null);
    if (b.dataset.tipTitle == null) { b.dataset.tipTitle = title; b.removeAttribute("title"); }
    tip = document.createElement("div");
    tip.id = "cm-tip";
    tip.className = "cm-tip";
    tip.setAttribute("role", "tooltip");
    tip.innerHTML = `<div class="cm-tip-h"><b>${esc(p.label || p.text)}</b>${p.key ? `<kbd>${esc(p.key)}</kbd>` : ""}</div>`
      + (p.label && p.text ? `<div class="cm-tip-d">${esc(p.text)}</div>` : "")
      + (p.why ? `<div class="cm-tip-w">${esc(t("Unavailable: {why}", { why: p.why }))}</div>` : "");
    document.body.appendChild(tip);
    b.setAttribute("aria-describedby", "cm-tip");
    const r = b.getBoundingClientRect(), w = tip.offsetWidth;
    tip.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
    tip.style.top = `${r.bottom + 6}px`;
  };
  root.addEventListener("pointermove", e => {
    const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    const b = el?.closest<HTMLElement>(selector) ?? null;
    if (b === cur || (b && !root.contains(b))) return;
    hide();
    if (!b) return;
    cur = b;
    timer = window.setTimeout(() => { if (cur === b && b.isConnected) show(b); }, 450);
  });
  root.addEventListener("pointerleave", hide);
  root.addEventListener("pointerdown", hide, true);
  // Keyboard users get it too: focus shows it at once, blur and Esc hide it.
  root.addEventListener("focusin", e => { const b = (e.target as HTMLElement).closest<HTMLElement>(selector); if (b && b.matches(":focus-visible")) { hide(); cur = b; show(b); } });
  root.addEventListener("focusout", hide);
  window.addEventListener("keydown", e => { if (e.key === "Escape" && tip) hide(); }, true);
}
