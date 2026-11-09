// Magnifying glass (FR-SEL-010, SolidWorks' G): a round inset over the view shows the area around the point where it
// was opened, magnified. Pointer events inside it are passed on to what lies under the magnified point, so hovering,
// snapping and picks work at that zoom. The wheel inside changes the factor; G or Esc closes it.
import * as THREE from "three";
import type { Viewer } from "./Viewer";

export const LENS_PX = 240;
const MIN_F = 2, MAX_F = 16;

/** The view point under a client point inside the lens centred at `c` with factor `f`. */
export const lensSource = (c: { x: number; y: number }, p: { x: number; y: number }, f: number) =>
  ({ x: c.x + (p.x - c.x) / f, y: c.y + (p.y - c.y) / f });

const PASS = ["pointerdown", "pointermove", "pointerup", "click", "dblclick", "contextmenu", "mousedown", "mouseup", "mousemove"] as const;

export class Magnifier {
  factor = 4;
  /** Lens centre in client px, null when closed. */
  at: { x: number; y: number } | null = null;
  private el: HTMLCanvasElement | null = null;
  private ring: HTMLElement | null = null;
  private cam: THREE.PerspectiveCamera | THREE.OrthographicCamera | null = null;
  private drawing = false;

  constructor(private viewer: Viewer) {
    viewer.onRender(() => this.draw());
    for (const type of PASS) window.addEventListener(type, e => this.pass(e as PointerEvent), true);
    window.addEventListener("wheel", e => this.wheel(e), { capture: true, passive: false });
    window.addEventListener("resize", () => this.close());
    // Esc closes the lens before anything else sees it (a running command stays open).
    window.addEventListener("keydown", e => { if (e.key === "Escape" && this.at) { e.preventDefault(); e.stopImmediatePropagation(); this.close(); } }, true);
  }

  get open() { return !!this.at; }

  /** Opens the lens centred on the client point (kept inside the view). */
  show(x: number, y: number) {
    const r = this.viewer.renderer.domElement.getBoundingClientRect(), h = LENS_PX / 2;
    this.at = { x: Math.min(Math.max(x, r.left + h), r.right - h), y: Math.min(Math.max(y, r.top + h), r.bottom - h) };
    if (!this.el) {
      this.el = document.createElement("canvas");
      this.el.className = "mag-lens";
      this.el.setAttribute("aria-hidden", "true");
      this.ring = document.createElement("div");
      this.ring.className = "mag-ring";
      this.ring.setAttribute("role", "status");
      document.body.append(this.el, this.ring);
    }
    // The view canvas is transparent over its page background: the lens takes that colour.
    for (let a = this.viewer.renderer.domElement.parentElement; a; a = a.parentElement) {
      const bg = getComputedStyle(a).backgroundColor;
      if (bg && bg !== "transparent" && !/rgba\(.*,\s*0\)$/.test(bg)) { this.el.style.backgroundColor = bg; break; }
    }
    const dpr = this.viewer.renderer.getPixelRatio();
    this.el.width = this.el.height = Math.round(LENS_PX * dpr);
    for (const e of [this.el, this.ring!]) { e.style.left = `${this.at.x - h}px`; e.style.top = `${this.at.y - h}px`; }
    this.label();
    this.viewer.invalidate();
  }

  close() {
    if (!this.at) return;
    this.at = null;
    this.el?.remove(); this.ring?.remove();
    this.el = this.ring = null;
    this.viewer.invalidate();
  }

  private label() { if (this.ring) this.ring.dataset.f = `×${this.factor}`; }

  private inside(e: { clientX: number; clientY: number }) {
    const c = this.at;
    return !!c && Math.hypot(e.clientX - c.x, e.clientY - c.y) <= LENS_PX / 2;
  }

  private wheel(e: WheelEvent) {
    if (!this.inside(e)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    const f = Math.min(MAX_F, Math.max(MIN_F, Math.round(this.factor * (e.deltaY < 0 ? 1.25 : 0.8))));
    if (f === this.factor) return;
    this.factor = f;
    this.label();
    this.viewer.invalidate();
  }

  /** Pointer events inside the lens go on as if made at the magnified point. */
  private pass(e: PointerEvent) {
    if (!e.isTrusted || !this.inside(e) || !this.at) return;
    const p = lensSource(this.at, { x: e.clientX, y: e.clientY }, this.factor);
    const target = document.elementFromPoint(p.x, p.y);
    if (!target) return;
    e.stopImmediatePropagation();
    if (e.type === "contextmenu" || e.type === "pointerdown" || e.type === "mousedown") e.preventDefault();
    const init: PointerEventInit = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: p.x, clientY: p.y, screenX: e.screenX + p.x - e.clientX, screenY: e.screenY + p.y - e.clientY,
      button: e.button, buttons: e.buttons, detail: e.detail,
      ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey,
    };
    const ev = "pointerId" in e && e.type.startsWith("pointer")
      ? new PointerEvent(e.type, { ...init, pointerId: e.pointerId, pointerType: e.pointerType, isPrimary: e.isPrimary, width: e.width, height: e.height, pressure: e.pressure })
      : new MouseEvent(e.type, init);
    target.dispatchEvent(ev);
  }

  /** After each view render: the area round the lens centre drawn again at the factor and copied into the lens. */
  private draw() {
    const c = this.at, el = this.el;
    if (!c || !el || this.drawing) return;
    const v = this.viewer, r = v.renderer, cv = r.domElement, box = cv.getBoundingClientRect();
    const W = box.width, H = box.height, s = LENS_PX / this.factor;
    const cam = this.cam?.type === v.camera.type ? this.cam : (this.cam = v.camera.clone());
    cam.copy(v.camera as never);
    cam.setViewOffset(W, H, c.x - box.left - s / 2, c.y - box.top - s / 2, s, s);
    // Lens rectangle in drawing-buffer pixels, y up for the scissor.
    const dpr = r.getPixelRatio(), x0 = c.x - box.left - LENS_PX / 2, y0 = H - (c.y - box.top) - LENS_PX / 2;
    this.drawing = true;
    try {
      r.setScissorTest(true);
      r.setScissor(x0, y0, LENS_PX, LENS_PX);
      r.setViewport(x0, y0, LENS_PX, LENS_PX);
      r.render(v.scene, cam);
      const ctx = el.getContext("2d")!;
      ctx.clearRect(0, 0, el.width, el.height);
      ctx.drawImage(cv, x0 * dpr, (H - y0 - LENS_PX) * dpr, LENS_PX * dpr, LENS_PX * dpr, 0, 0, el.width, el.height);
      // The square under the lens back as it was (its corners show outside the round lens).
      r.setViewport(0, 0, W, H);
      r.render(v.scene, v.camera);
    } finally {
      r.setScissorTest(false);
      r.setViewport(0, 0, W, H);
      this.drawing = false;
    }
  }
}
