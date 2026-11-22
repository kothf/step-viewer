// Thermal overlay in the 2D PCB view (FRS-thermal FR-TMAP-040): the package's board-face temperatures drawn under
// the Gerber layers at 50 % opacity, for the face the view shows, with a colour scale and the temperature under
// the pointer. The PCB view's Thermal button turns it on and off.

import { t } from "../i18n";
import type { GerberView } from "../gerber/GerberView";
import { paletteColor, paletteCss, type PaletteName } from "./match";
import type { ThermalPackage } from "./package";
import { faceGrids, gridAt, type FaceGrids, type SideGrid } from "./pcbOverlay";
import { pcbFit, pictureSize, type GBox } from "./pcbTexture";
import { deg } from "./ui";

/** Opacity of the temperatures, and the factor on the layers' own opacity drawn over them (the layers at 50 %). */
export const OVERLAY_ALPHA = 0.9;
export const LAYER_ALPHA = 0.5;

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export class PcbThermal {
  private pkg: ThermalPackage | null = null;
  private shift: [number, number] = [0, 0];
  private grids: FaceGrids | null = null;
  private box: GBox | null = null;
  private pics: { top: HTMLCanvasElement; bottom: HTMLCanvasElement } | null = null;
  private legend: HTMLElement;
  private btn: HTMLButtonElement;
  private hoverT: number | null = null;
  on = false;

  constructor(private g: GerberView, private palette: () => PaletteName) {
    this.btn = document.querySelector<HTMLButtonElement>("[data-gview=thermal]")!;
    this.btn.addEventListener("click", () => this.setOn(!this.on));
    this.legend = document.createElement("div");
    this.legend.id = "g-th-legend";
    this.legend.className = "g-th-legend";
    this.legend.hidden = true;
    this.legend.setAttribute("role", "region");
    this.legend.setAttribute("aria-label", t("Thermal overlay"));
    document.querySelector("#gerber")!.appendChild(this.legend);
    this.legend.addEventListener("click", e => { if ((e.target as HTMLElement).closest("[data-a=thoff]")) this.setOn(false); });
    g.onChange(() => this.renderLegend());
    g.onHover = p => {
      const v = this.on && this.grids && this.box && !g.is3d ? gridAt(g.view.mirror ? this.grids.bottom : this.grids.top, this.box, p[0], p[1]) : null;
      if (v === this.hoverT) return;
      this.hoverT = v;
      this.renderLegend();
    };
    this.sync();
  }

  /** The package whose temperatures the PCB view can show (null = none), moved by (du, dv) mm like the 3D map's layers. */
  set(pkg: ThermalPackage | null, du = 0, dv = 0, on = !!pkg): boolean {
    this.pkg = pkg && !pkg.sourcesOnly ? pkg : null;
    this.shift = [du, dv];
    this.grids = null; this.pics = null; this.box = null;
    this.on = false;
    if (this.pkg && on) return this.setOn(true);
    this.g.setThermal(null); this.sync();
    return !!this.pkg;
  }

  has() { return !!this.pkg; }

  /** Shows or hides the overlay. False when there is nothing to show (no package, or no board in it). */
  setOn(on: boolean): boolean {
    if (on && !this.build()) on = false;
    this.on = on;
    this.hoverT = null;
    this.g.setThermal(on && this.pics && this.box ? { top: this.pics.top, bottom: this.pics.bottom, box: this.box, alpha: OVERLAY_ALPHA, layers: LAYER_ALPHA } : null);
    this.sync();
    return on;
  }

  /** Makes the grids and pictures for the Gerber set on screen (again when the layers changed their box). */
  private build(): boolean {
    if (!this.pkg) return false;
    const box = this.g.boardBox(false);
    if (!box) return false;
    if (this.pics && this.box && this.box.every((v, i) => v === box[i])) return true;
    const m = this.pkg.mesh;
    const f = pcbFit(m.pos, m.tri, m.part, box, this.shift[0], this.shift[1], m.face);
    if (!f) return false;
    const { w, h } = pictureSize(box, 6, 1200);
    const grids = faceGrids(m, f, box, w, h);
    this.grids = grids; this.box = box;
    this.pics = { top: this.picture(grids.top), bottom: this.picture(grids.bottom) };
    return true;
  }

  private picture(s: SideGrid) {
    const cv = document.createElement("canvas");
    cv.width = s.w; cv.height = s.h;
    const c = cv.getContext("2d")!, img = c.createImageData(s.w, s.h), px = img.data;
    const lo = this.grids!.min, span = this.grids!.max - lo || 1, pal = this.palette(), col = [0, 0, 0];
    for (let i = 0; i < s.t.length; i++) {
      const v = s.t[i];
      if (Number.isNaN(v)) continue;
      paletteColor(pal, (v - lo) / span, col);
      px[i * 4] = col[0] * 255; px[i * 4 + 1] = col[1] * 255; px[i * 4 + 2] = col[2] * 255; px[i * 4 + 3] = 255;
    }
    c.putImageData(img, 0, 0);
    return cv;
  }

  private sync() {
    this.btn.hidden = !this.pkg;
    this.btn.classList.toggle("on", this.on);
    this.btn.setAttribute("aria-pressed", String(this.on));
    this.renderLegend();
  }

  private renderLegend() {
    const show = this.on && !!this.grids && !this.g.is3d;
    this.legend.hidden = !show;
    if (!show) return;
    const gr = this.grids!, bottom = this.g.view.mirror;
    this.legend.innerHTML = `<div class="g-th-head"><strong>${esc(bottom ? t("Board bottom") : t("Board top"))}</strong>`
      + `<span class="muted" translate="no">${esc(this.pkg!.name)}</span>`
      + `<button class="icon" data-a="thoff" title="${esc(t("Hide the thermal overlay"))}" aria-label="${esc(t("Hide the thermal overlay"))}">✕</button></div>`
      + `<div class="g-th-bar" style="background:${paletteCss(this.palette())}"></div>`
      + `<div class="g-th-ends"><span data-v="min">${esc(deg(gr.min))} °C</span><span data-v="max">${esc(deg(gr.max))} °C</span></div>`
      + (this.hoverT !== null ? `<div class="g-th-at" data-v="at">${esc(t("Under the pointer: {t} °C", { t: deg(this.hoverT) }))}</div>` : "");
  }

  /** For tests (`__sv.pcbThermal.state()`). */
  state() {
    return {
      has: !!this.pkg, on: this.on, name: this.pkg?.name ?? null, box: this.box,
      min: this.grids?.min ?? null, max: this.grids?.max ?? null,
      cells: this.grids ? { top: this.grids.top.t.reduce((n, v) => n + (Number.isNaN(v) ? 0 : 1), 0), bottom: this.grids.bottom.t.reduce((n, v) => n + (Number.isNaN(v) ? 0 : 1), 0), w: this.grids.top.w, h: this.grids.top.h } : null,
      hover: this.hoverT, legend: !this.legend.hidden,
    };
  }

  /** The temperature drawn at a board point (board mm) on the face the view shows, or null. */
  valueAt(x: number, y: number): number | null {
    if (!this.grids || !this.box) return null;
    return gridAt(this.g.view.mirror ? this.grids.bottom : this.grids.top, this.box, x, y);
  }
}
