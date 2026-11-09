/**
 * Measured values into numeric inputs (FR-MEA-002): a shown value ("40 mm", "Ø12.5 mm", "30°") can be dragged
 * from the measurement card onto any text or number input. The input gets the value with its unit, so an
 * expression field reads it in any document unit; a number input gets the bare number in millimetres or degrees.
 * The input then receives `input` and `change` events, as if the value had been typed.
 */

const LEN: Record<string, number> = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 };

export interface ShownValue {
  /** The number as shown. */
  num: number;
  /** The unit as shown ("mm", "in", "°"). */
  unit: string;
  /** Text for an expression input: number and unit ("40 mm", "30°"). */
  expr: string;
  /** The value in millimetres (lengths) or degrees (angles). */
  base: number;
  angle: boolean;
}

/** Parses one displayed value; anything else (areas, pairs, words) gives null. */
export function parseShown(text: string): ShownValue | null {
  const m = /^[RØ⌀]?S?[Ø⌀]?\s*(-?\d+(?:\.\d+)?(?:e[-+]?\d+)?)\s*(mm|cm|m|in|ft|°)$/.exec(text.trim().replace(/−/g, "-"));
  if (!m) return null;
  const num = Number(m[1]);
  if (!Number.isFinite(num)) return null;
  const unit = m[2];
  const angle = unit === "°";
  return { num, unit, angle, expr: angle ? `${m[1]}°` : `${m[1]} ${unit}`, base: angle ? num : Math.round(num * LEN[unit] * 1e9) / 1e9 };
}

const TYPE = "application/x-mcad-value";

/** Makes an element showing a value draggable (when its text is a single value). */
export function dragValue(el: HTMLElement) {
  const v = parseShown(el.textContent ?? "");
  if (!v) return;
  el.draggable = true;
  el.classList.add("drag-val");
  el.addEventListener("dragstart", e => {
    const now = parseShown(el.textContent ?? "") ?? v;
    e.dataTransfer?.setData(TYPE, JSON.stringify(now));
    e.dataTransfer?.setData("text/plain", now.expr);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
    document.body.classList.add("dragging-val");
  });
  el.addEventListener("dragend", () => {
    document.body.classList.remove("dragging-val");
    document.querySelectorAll(".drop-val").forEach(x => x.classList.remove("drop-val"));
  });
}

const target = (e: Event): HTMLInputElement | null => {
  const el = (e.target as HTMLElement | null)?.closest?.("input");
  if (!(el instanceof HTMLInputElement) || el.disabled || el.readOnly) return null;
  return el.type === "text" || el.type === "number" || el.type === "search" || el.type === "" ? el : null;
};

/** The text for a text input: the bare number when the input's unit label (the element after it) already says
 * the value's unit, so the box keeps a plain value rather than an expression; else number and unit. */
export function plainText(inp: HTMLElement, v: ShownValue) {
  const label = inp.nextElementSibling?.textContent?.trim();
  return label === v.unit ? String(v.num) : v.expr;
}

/** Puts a dropped value into an input as if typed: `input` then `change`. */
export function putValue(inp: HTMLInputElement, v: ShownValue) {
  inp.value = inp.type === "number" ? String(Math.round(v.base * 1e9) / 1e9) : plainText(inp, v);
  inp.focus();
  inp.dispatchEvent(new Event("input", { bubbles: true }));
  inp.dispatchEvent(new Event("change", { bubbles: true }));
}

let bound = false;
/** Listens once on the document for values dropped onto inputs. */
export function bindValueDrops() {
  if (bound) return;
  bound = true;
  const ours = (e: DragEvent) => !!e.dataTransfer?.types.includes(TYPE);
  document.addEventListener("dragover", e => {
    if (!ours(e)) return;
    const inp = target(e);
    document.querySelectorAll(".drop-val").forEach(x => { if (x !== inp) x.classList.remove("drop-val"); });
    if (!inp) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    inp.classList.add("drop-val");
  }, true);
  document.addEventListener("drop", e => {
    if (!ours(e)) return;
    const inp = target(e);
    if (!inp) return;
    e.preventDefault();
    e.stopPropagation();
    inp.classList.remove("drop-val");
    let v: ShownValue | null = null;
    try { v = JSON.parse(e.dataTransfer!.getData(TYPE)); } catch { v = null; }
    if (v) putValue(inp, v);
  }, true);
}
