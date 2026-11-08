// The Modify box (FR-UI-114): the small window SolidWorks opens next to a dimension when it is placed or
// double-clicked. A value field (expressions allowed) with spin arrows, ✓ to accept, ✕ to cancel and ⟲ to
// rebuild with the value typed so far. Enter accepts, Esc cancels, ↑/↓ and the wheel step the value, and a
// click outside keeps the value as typed. One box is open at a time.
import { t } from "./i18n";

export interface ModifyOpts {
  /** Where to open, in client pixels: the box's left middle sits a little to the right of it. */
  at: { x: number; y: number };
  /** The dimension's name (D1@Sketch1), shown in the title. */
  title: string;
  /** The value as it is now, as typed in the field. */
  value: string;
  /** The spin step, in the shown units (default 1). */
  step?: number;
  /** Shows the model with the value typed so far. `live`: also while typing, not only on ⟲ and spins. */
  preview?(text: string): void;
  live?: boolean;
  /** Takes the value. False keeps the box open (the value was refused). */
  accept(text: string): boolean;
  /** The box closed without taking the value: undo any preview. */
  cancel(): void;
}

let open: ModifyBox | null = null;

/** The box that is open now, if any. */
export const modifyOpen = () => open;

export class ModifyBox {
  readonly el: HTMLDivElement;
  readonly input: HTMLInputElement;
  private closed = false;
  private timer = 0;
  private previewed = "";

  constructor(private o: ModifyOpts) {
    open?.close(true);
    open = this;
    const el = document.createElement("div");
    el.className = "mod-box";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", t("Modify"));
    el.innerHTML = `<div class="mod-h"><span class="mod-t" translate="no"></span></div>`
      + `<div class="mod-r"><input class="sk-input mod-in" spellcheck="false" autocomplete="off">`
      + `<span class="mod-spin"><button type="button" data-m="up" tabindex="-1" aria-label="${t("Increase")}">▴</button><button type="button" data-m="down" tabindex="-1" aria-label="${t("Decrease")}">▾</button></span></div>`
      + `<div class="mod-b"><button type="button" class="mod-ok" data-m="ok" title="${t("OK (Enter)")}" aria-label="${t("OK")}">✓</button>`
      + `<button type="button" class="mod-x" data-m="x" title="${t("Cancel (Esc)")}" aria-label="${t("Cancel")}">✕</button>`
      + `<button type="button" data-m="rebuild" title="${t("Rebuild with this value")}" aria-label="${t("Rebuild")}">⟲</button></div>`;
    el.querySelector(".mod-t")!.textContent = o.title;
    const inp = el.querySelector<HTMLInputElement>("input")!;
    inp.setAttribute("aria-label", t("Dimension value"));
    inp.value = o.value;
    this.el = el;
    this.input = inp;
    document.body.appendChild(el);
    this.place();
    // The buttons never take the focus, so a click on them is not a click outside.
    el.addEventListener("pointerdown", e => { if ((e.target as HTMLElement).closest("button")) e.preventDefault(); e.stopPropagation(); });
    el.addEventListener("click", e => {
      const m = (e.target as HTMLElement).closest<HTMLElement>("[data-m]")?.dataset.m;
      if (m === "ok") this.close(true);
      else if (m === "x") this.close(false);
      else if (m === "rebuild") this.preview(true);
      else if (m === "up" || m === "down") this.spin(m === "up" ? 1 : -1, e as MouseEvent);
    });
    inp.addEventListener("keydown", e => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); this.close(true); }
      else if (e.key === "Escape") { e.preventDefault(); this.close(false); }
      else if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); this.spin(e.key === "ArrowUp" ? 1 : -1, e); }
    });
    inp.addEventListener("input", () => { if (o.live) this.later(120); });
    el.addEventListener("wheel", e => { e.preventDefault(); e.stopPropagation(); this.spin(e.deltaY < 0 ? 1 : -1, e); }, { passive: false });
    inp.addEventListener("blur", () => setTimeout(() => { if (!this.closed && document.activeElement !== inp) this.close(true); }, 0));
    inp.focus();
    inp.select();
  }

  /** Keeps the box on screen next to its point. */
  private place() {
    const r = this.el.getBoundingClientRect();
    const x = Math.max(4, Math.min(window.innerWidth - r.width - 4, this.o.at.x + 14));
    const y = Math.max(4, Math.min(window.innerHeight - r.height - 4, this.o.at.y - r.height / 2));
    this.el.style.left = `${x}px`;
    this.el.style.top = `${y}px`;
  }

  /** Steps a plain number by the increment: ×10 with Shift, ×0.1 with Alt, as in SolidWorks. */
  private spin(dir: 1 | -1, e?: { shiftKey: boolean; altKey: boolean }) {
    const v = Number(this.input.value.trim().replace(",", "."));
    if (!Number.isFinite(v)) return;
    const step = (this.o.step ?? 1) * (e?.shiftKey ? 10 : e?.altKey ? 0.1 : 1);
    const n = Math.round((v + dir * step) / step) * step;
    this.input.value = String(Number(n.toFixed(6)));
    this.later(250);
  }

  private later(ms: number) {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.preview(false), ms);
  }

  private preview(force: boolean) {
    clearTimeout(this.timer);
    if (this.closed || !this.o.preview) return;
    const v = this.input.value;
    if (!force && v === this.previewed) return;
    this.previewed = v;
    this.o.preview(v);
  }

  /** Accepts (true) or cancels the box. A refused value keeps it open. */
  close(apply: boolean) {
    if (this.closed) return;
    clearTimeout(this.timer);
    if (apply) {
      this.closed = true;
      if (!this.o.accept(this.input.value)) { this.closed = false; this.input.focus(); this.input.select(); return; }
    } else {
      this.closed = true;
      this.o.cancel();
    }
    this.el.remove();
    if (open === this) open = null;
  }
}
