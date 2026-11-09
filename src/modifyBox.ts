// The Modify box (FR-UI-114): the small window SolidWorks opens next to a dimension when it is placed or
// double-clicked. A value field (expressions allowed) with spin arrows, ✓ to accept, ✕ to cancel and ⟲ to
// rebuild with the value typed so far. Enter accepts, Esc cancels, ↑/↓ and the wheel step the value by the
// increment in its own field (remembered per kind of value), and a click outside keeps the value as typed. A
// renamable dimension shows its name as a field in the title; a value with a direction gets ⇄ Reverse direction.
// One box is open at a time.
import { t } from "./i18n";

export interface ModifyOpts {
  /** Where to open, in client pixels: the box's left middle sits a little to the right of it. */
  at: { x: number; y: number };
  /** The dimension's name (D1@Sketch1), shown in the title. */
  title: string;
  /** The value as it is now, as typed in the field. */
  value: string;
  /** The spin step, in the shown units (default 1): the increment field's first value. */
  step?: number;
  /** Remembers the increment typed for this kind of value (default: by `step`). */
  incKey?: string;
  /** An editable name in the title (FR-SK-065): `value` before "@", `suffix` after; `check` returns an error key or "". */
  name?: { value: string; suffix: string; check?(name: string): string };
  /** Reverse direction (⇄): flips the value's direction; the box previews again. */
  reverse?(): void;
  /** Shows the model with the value typed so far. `live`: also while typing, not only on ⟲ and spins. */
  preview?(text: string): void;
  live?: boolean;
  /** Takes the value (and the name, when the title is editable). False keeps the box open (the value was refused). */
  accept(text: string, name?: string): boolean;
  /** The box closed without taking the value: undo any preview. */
  cancel(): void;
}

let open: ModifyBox | null = null;
/** Increments typed in the box, by kind of value, for the session. */
const increments = new Map<string, number>();

/** The box that is open now, if any. */
export const modifyOpen = () => open;

export class ModifyBox {
  readonly el: HTMLDivElement;
  readonly input: HTMLInputElement;
  private closed = false;
  private timer = 0;
  private previewed = "";
  private nameIn: HTMLInputElement | null = null;
  private incIn!: HTMLInputElement;
  private incKey = "";

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
      + `<button type="button" data-m="rebuild" title="${t("Rebuild with this value")}" aria-label="${t("Rebuild")}">⟲</button>`
      + (o.reverse ? `<button type="button" data-m="rev" title="${t("Reverse direction")}" aria-label="${t("Reverse direction")}">⇄</button>` : "")
      + `<input class="mod-inc" spellcheck="false" autocomplete="off" title="${t("Increment")}" aria-label="${t("Increment")}"></div>`;
    const tt = el.querySelector<HTMLElement>(".mod-t")!;
    if (o.name) {
      const ni = document.createElement("input");
      ni.className = "mod-name";
      ni.value = o.name.value;
      ni.spellcheck = false;
      ni.setAttribute("aria-label", t("Name"));
      ni.addEventListener("keydown", e => {
        e.stopPropagation();
        if (e.key === "Enter") { e.preventDefault(); this.close(true); }
        else if (e.key === "Escape") { e.preventDefault(); this.close(false); }
      });
      ni.addEventListener("input", () => { ni.removeAttribute("aria-invalid"); ni.title = ""; });
      this.nameIn = ni;
      tt.append(ni, `@${o.name.suffix}`);
    } else tt.textContent = o.title;
    this.incKey = o.incKey ?? String(o.step ?? 1);
    const inc = el.querySelector<HTMLInputElement>(".mod-inc")!;
    inc.value = String(increments.get(this.incKey) ?? o.step ?? 1);
    inc.addEventListener("keydown", e => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); this.input.focus(); }
      else if (e.key === "Escape") { e.preventDefault(); this.close(false); }
    });
    inc.addEventListener("change", () => { const v = Number(inc.value.replace(",", ".")); if (v > 0 && Number.isFinite(v)) increments.set(this.incKey, v); else inc.value = String(increments.get(this.incKey) ?? o.step ?? 1); });
    this.incIn = inc;
    const inp = el.querySelector<HTMLInputElement>(".mod-in")!;
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
      else if (m === "rev") { this.o.reverse?.(); this.preview(true); }
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
    // Leaving the box (not for its own name or increment field) keeps the value as typed.
    const away = () => setTimeout(() => { if (!this.closed && !el.contains(document.activeElement)) this.close(true); }, 0);
    inp.addEventListener("blur", away);
    this.nameIn?.addEventListener("blur", away);
    this.incIn.addEventListener("blur", away);
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
    const inc = Number(this.incIn.value.replace(",", "."));
    const step = (inc > 0 && Number.isFinite(inc) ? inc : this.o.step ?? 1) * (e?.shiftKey ? 10 : e?.altKey ? 0.1 : 1);
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
      const nm = this.nameIn?.value.trim();
      const bad = nm != null && nm !== this.o.name!.value ? this.o.name!.check?.(nm) ?? "" : "";
      if (bad && this.nameIn) { this.nameIn.setAttribute("aria-invalid", "true"); this.nameIn.title = t(bad); this.nameIn.focus(); return; }
      this.closed = true;
      if (!this.o.accept(this.input.value, nm != null && nm !== this.o.name!.value ? nm : undefined)) { this.closed = false; this.input.focus(); this.input.select(); return; }
    } else {
      this.closed = true;
      this.o.cancel();
    }
    this.el.remove();
    if (open === this) open = null;
  }
}
