import type { EdgeInfo, FaceInfo } from "./topology";
import { t } from "./i18n";
import { fmtAngle, fmtArea, fmtLen } from "./tools/units";

/**
 * The status bar's summary of what is selected (gap list M3): sizes of the picked edges and faces without
 * running a measurement. One edge: its length (and radius / arc angle); one face: its area (and radius);
 * several: how many and their summed length / area.
 */
export function selSummary(edges: readonly EdgeInfo[], faces: readonly FaceInfo[]): string {
  const out: string[] = [];
  if (edges.length === 1) {
    const e = edges[0];
    const bits = [`${t("Length")} ${fmtLen(e.length)}`];
    if (e.radius != null && (e.type === "circle" || e.type === "arc")) bits.push(`R ${fmtLen(e.radius)}`);
    if (e.type === "arc" && e.sweep != null) bits.push(fmtAngle(e.sweep));
    out.push(`${t("Edge")}: ${bits.join(" · ")}`);
  } else if (edges.length > 1) {
    const sum = edges.reduce((s, e) => s + e.length, 0);
    out.push(t("{n} edges: total length {v}", { n: edges.length, v: fmtLen(sum) }));
  }
  if (faces.length === 1) {
    const f = faces[0];
    const bits = [`${t("Area")} ${fmtArea(f.area)}`];
    if (f.radius != null && (f.type === "cylinder" || f.type === "sphere")) bits.push(`R ${fmtLen(f.radius)}`);
    out.push(`${t("Face")}: ${bits.join(" · ")}`);
  } else if (faces.length > 1) {
    const sum = faces.reduce((s, f) => s + f.area, 0);
    out.push(t("{n} faces: total area {v}", { n: faces.length, v: fmtArea(sum) }));
  }
  return out.join(" · ");
}

/** Shows the summary in `#st-sel` (empty hides it). */
export function showSelStatus(edges: readonly EdgeInfo[], faces: readonly FaceInfo[]) {
  const el = document.getElementById("st-sel");
  if (!el) return;
  const s = edges.length || faces.length ? selSummary(edges, faces) : "";
  el.textContent = s;
  el.hidden = !s;
}
