// The drag that draws a selection box or lasso over the view (FR-SEL-008), shared by parts and assemblies.
import { isClockwise, isCrossing, lassoRegion, rectOf, rectRegion, type Region } from "./boxSelect";

const SVG = "http://www.w3.org/2000/svg";

export class SelDrag {
  private el: HTMLElement | SVGSVGElement | null = null;
  private poly: SVGPolygonElement | null = null;
  private pts: number[];
  constructor(readonly x: number, readonly y: number, readonly add: boolean, readonly lasso: boolean) { this.pts = [x, y]; }

  /** True once the pointer moved far enough to draw. */
  get drawn() { return !!this.el; }

  move(x: number, y: number) {
    if (!this.el && Math.hypot(x - this.x, y - this.y) <= 4) return;
    if (this.lasso) {
      const n = this.pts.length;
      if (Math.hypot(x - this.pts[n - 2], y - this.pts[n - 1]) >= 3) this.pts.push(x, y);
      if (!this.el) {
        const s = document.createElementNS(SVG, "svg");
        s.setAttribute("class", "mc-lasso");
        s.setAttribute("aria-hidden", "true");
        this.poly = document.createElementNS(SVG, "polygon");
        s.appendChild(this.poly);
        document.body.appendChild(s);
        this.el = s;
      }
      this.poly!.setAttribute("points", this.pts.join(" "));
      this.el.classList.toggle("cross", this.pts.length >= 6 && !isClockwise(this.pts));
      return;
    }
    if (!this.el) { const d = document.createElement("div"); d.className = "mc-selbox"; document.body.appendChild(d); this.el = d; }
    const r = rectOf(this.x, this.y, x, y);
    Object.assign((this.el as HTMLElement).style, { left: `${r.x0}px`, top: `${r.y0}px`, width: `${r.x1 - r.x0}px`, height: `${r.y1 - r.y0}px` });
    this.el.classList.toggle("cross", isCrossing(this.x, x));
  }

  /** Removes the drawing; the area and how it selects, or null when nothing was drawn (a click, or a lasso too small). */
  end(x: number, y: number): { area: Region; crossing: boolean } | null {
    const drawn = !!this.el;
    this.el?.remove();
    this.el = null;
    if (!drawn) return null;
    if (!this.lasso) return { area: rectRegion(rectOf(this.x, this.y, x, y)), crossing: isCrossing(this.x, x) };
    const n = this.pts.length;
    if (Math.hypot(x - this.pts[n - 2], y - this.pts[n - 1]) >= 1) this.pts.push(x, y);
    if (this.pts.length < 6) return null;
    return { area: lassoRegion(this.pts), crossing: !isClockwise(this.pts) };
  }

  cancel() { this.el?.remove(); this.el = null; }
}
