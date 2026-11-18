// File ▸ Export… (FR-UI-010): a dialog that asks the format, the mesh quality for STL/3MF/OBJ/glTF and the PNG
// scale, then exports, the way a CAD app's export does. It used to switch the side panel to its Export page,
// which looked like nothing happened when that page was already showing or the panel was out of sight.

import { t } from "./i18n";
import { busy, trapFocus } from "./ui";
import { MESH_KINDS, MESH_PRESETS, meshQuality, setMeshQuality, type MeshQuality, type MeshQualityKind } from "./tools/meshQuality";

export type ExportFormat = "step" | "stl" | "3mf" | "obj" | "glb" | "png" | "pngt" | "pdf";
export const MESH_FORMATS: ExportFormat[] = ["stl", "3mf", "obj", "glb"];

const FORMATS: { f: ExportFormat; label: string; note: string }[] = [
  { f: "stl", label: "STL", note: "Triangle mesh for 3D printing" },
  { f: "3mf", label: "3MF", note: "3D printing: closed meshes in millimetres with colours" },
  { f: "step", label: "STEP", note: "Exact solids (AP214) with names and colours" },
  { f: "obj", label: "OBJ", note: "Triangle mesh with materials" },
  { f: "glb", label: "glTF (GLB)", note: "Triangle mesh for the web and AR" },
  { f: "png", label: "PNG", note: "Picture of the view" },
  { f: "pngt", label: "PNG (transparent)", note: "Picture of the view without the background" },
  { f: "pdf", label: "PDF report", note: "Inspection report with the view, sizes and measurements" },
];
const LAST = "mc:exportFormat";

export interface ExportHost {
  /** Runs the export; resolves when the file has been written (or the export said why not). */
  run(f: ExportFormat, opts: { quality: MeshQuality; scale: number }): Promise<void>;
  /** Why a format cannot be used now (null = it can). */
  why?(f: ExportFormat): string | null;
}

const esc = (x: string) => x.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Opens the Export dialog. */
export function openExportDialog(host: ExportHost) {
  document.querySelector("#export-dlg")?.remove();
  const d = document.createElement("dialog");
  d.id = "export-dlg";
  d.className = "modal";
  d.setAttribute("aria-labelledby", "export-dlg-title");
  let last: string | null = null;
  try { last = localStorage.getItem(LAST); } catch { /* none */ }
  const usable = FORMATS.filter(x => !host.why?.(x.f));
  const pick = usable.find(x => x.f === last)?.f ?? usable[0]?.f ?? "stl";
  const q = meshQuality();
  const kindOpts = MESH_KINDS.map(k => `<option value="${k.kind}"${k.kind === q.kind ? " selected" : ""}>${esc(t(k.label))}</option>`).join("");
  d.innerHTML = `<form method="dialog" novalidate><h3 id="export-dlg-title">${esc(t("Export"))}</h3>`
    + `<fieldset class="xd-formats"><legend>${esc(t("Format"))}</legend>`
    + FORMATS.map(x => {
      const why = host.why?.(x.f) ?? null;
      return `<label class="xd-f${why ? " off" : ""}"${why ? ` title="${esc(why)}"` : ""}><input type="radio" name="xf" value="${x.f}"${x.f === pick ? " checked" : ""}${why ? " disabled" : ""}>`
        + `<b translate="no">${esc(x.label)}</b><span class="muted">${esc(why ?? t(x.note))}</span></label>`;
    }).join("")
    + `</fieldset>`
    + `<fieldset class="xd-mesh"><legend>${esc(t("Mesh quality"))}</legend>`
    + `<label class="xd-row"><span>${esc(t("Quality"))}</span><select data-x="kind">${kindOpts}</select></label>`
    + `<div class="xd-custom"><label class="xd-row"><span>${esc(t("Deviation"))}</span><span><input type="number" data-x="dev" min="0.0005" max="10" step="any" value="${q.kind === "view" ? 0.01 : q.dev}"> mm</span></label>`
    + `<label class="xd-row"><span>${esc(t("Angle"))}</span><span><input type="number" data-x="ang" min="0.5" max="45" step="any" value="${q.kind === "view" ? 5 : q.ang}"> °</span></label></div>`
    + `<p class="muted xd-hint"></p></fieldset>`
    + `<fieldset class="xd-png"><legend>${esc(t("Picture"))}</legend><label class="xd-row"><span>${esc(t("Scale"))}</span><select data-x="scale"><option value="2">2×</option><option value="3">3×</option><option value="4">4×</option></select></label></fieldset>`
    + `<div class="row end"><button class="btn" type="button" data-a="cancel">${esc(t("Cancel"))}</button><button class="btn primary" type="submit" data-a="ok">${esc(t("Export"))}</button></div></form>`;
  document.body.appendChild(d);
  trapFocus(d, () => d.open);
  const opener = document.activeElement as HTMLElement | null;
  const $x = <T extends HTMLElement>(s: string) => d.querySelector<T>(s)!;
  const kindSel = $x<HTMLSelectElement>("[data-x=kind]"), dev = $x<HTMLInputElement>("[data-x=dev]"), ang = $x<HTMLInputElement>("[data-x=ang]");
  const fmt = () => (d.querySelector<HTMLInputElement>("input[name=xf]:checked")?.value ?? pick) as ExportFormat;
  const quality = (): MeshQuality => {
    const kind = kindSel.value as MeshQualityKind;
    if (kind === "custom") return { kind, dev: Number(dev.value.replace(",", ".")) || 0.01, ang: Number(ang.value.replace(",", ".")) || 5 };
    const p = MESH_KINDS.find(k => k.kind === kind) ? kind : "fine";
    return { ...meshQualityOf(p), kind: p };
  };
  const sync = () => {
    const f = fmt(), mesh = MESH_FORMATS.includes(f), k = kindSel.value as MeshQualityKind;
    $x(".xd-mesh").hidden = !mesh;
    $x(".xd-png").hidden = f !== "png" && f !== "pngt";
    $x(".xd-custom").hidden = k !== "custom";
    const cur = quality();
    $x(".xd-hint").textContent = k === "view" ? t("Uses the view's triangles: quick, but round faces may show flats.")
      : t("Facets deviate at most {dev} mm from the true surface and turn at most {ang}° each.", { dev: String(cur.dev), ang: String(cur.ang) });
  };
  d.addEventListener("change", sync);
  d.addEventListener("input", sync);
  sync();
  const close = () => { d.close(); };
  d.addEventListener("close", () => { d.remove(); opener?.focus?.(); }, { once: true });
  d.querySelector("[data-a=cancel]")!.addEventListener("click", close);
  d.querySelector("form")!.addEventListener("submit", e => {
    e.preventDefault();
    const f = fmt(), ok = $x<HTMLButtonElement>("[data-a=ok]");
    if (ok.classList.contains("busy")) return;
    const quality0 = quality();
    try { localStorage.setItem(LAST, f); } catch { /* not kept */ }
    if (MESH_FORMATS.includes(f)) setMeshQuality(quality0);
    const scale = parseInt($x<HTMLSelectElement>("[data-x=scale]").value) || 2;
    void busy(ok, () => host.run(f, { quality: meshQuality(), scale })).finally(close);
  });
  d.showModal();
  d.querySelector<HTMLInputElement>("input[name=xf]:checked")?.focus();
  return d;
}

function meshQualityOf(kind: MeshQualityKind) {
  return kind in MESH_PRESETS ? MESH_PRESETS[kind as keyof typeof MESH_PRESETS] : { dev: 0, ang: 0 };
}
