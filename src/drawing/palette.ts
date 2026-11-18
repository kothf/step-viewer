// View palette (FR-UI-072): the model's standard views as small pictures beside the sheet, to drag onto it.
import type { Projection, Seg2 } from "../kernel/drawing";
import type { Orient } from "./types";

/** The views the palette offers, in the order a CAD app lists them. */
export const PALETTE: Exclude<Orient, "current">[] = ["front", "top", "right", "iso", "back", "bottom", "left"];

/** The drag data type of a palette tile. */
export const PALETTE_MIME = "application/x-mcad-view";

/** A projection's visible lines as an SVG path fitted into a `size` square (y up in the model, down in SVG). */
export function thumbPath(p: Projection, size = 64, pad = 4): string {
  const [x0, y0, x1, y1] = p.box;
  const w = Math.max(x1 - x0, 1e-9), h = Math.max(y1 - y0, 1e-9);
  const k = (size - 2 * pad) / Math.max(w, h);
  const ox = pad + (size - 2 * pad - w * k) / 2, oy = pad + (size - 2 * pad - h * k) / 2;
  const sx = (x: number) => (ox + (x - x0) * k).toFixed(1), sy = (y: number) => (size - oy - (y - y0) * k).toFixed(1);
  const out: string[] = [];
  const seg = (s: Seg2) => {
    if (s.k === "l") out.push(`M${sx(s.p[0])} ${sy(s.p[1])}L${sx(s.p[2])} ${sy(s.p[3])}`);
    else if (s.k === "p") {
      if (s.p.length < 4) return;
      let d = `M${sx(s.p[0])} ${sy(s.p[1])}`;
      for (let i = 2; i < s.p.length; i += 2) d += `L${sx(s.p[i])} ${sy(s.p[i + 1])}`;
      out.push(d);
    } else {
      const n = Math.max(4, Math.ceil((s.a1 - s.a0) / (Math.PI / 12)));
      let d = "";
      for (let i = 0; i <= n; i++) {
        const a = s.a0 + (s.a1 - s.a0) * i / n;
        d += `${i ? "L" : "M"}${sx(s.o[0] + s.r * Math.cos(a))} ${sy(s.o[1] + s.r * Math.sin(a))}`;
      }
      out.push(d);
    }
  };
  for (const s of p.vis) seg(s);
  return out.join("");
}
