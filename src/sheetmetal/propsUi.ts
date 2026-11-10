// Sheet metal cut-list properties dialog (FR-FT-120): `#sm-props`, the rows from `cutprops.ts` in display units.
import { t } from "../i18n";
import { toast } from "../ui";
import { fmtArea, fmtLen, fmtMass, fmtNum } from "../tools/units";
import { cutPropRows, cutPropsCsv, sheetCutProps } from "./cutprops";
import type { SheetState } from "./sheet";

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Opens the dialog; `mass` in grams (absent: no material density known). */
export function showSheetProps(st: SheetState | null | undefined, name: string, mass?: number) {
  const dlg = document.querySelector<HTMLDialogElement>("#sm-props");
  if (!dlg) return;
  if (!st) { toast(t("Make a base flange first."), true); return; }
  const p = sheetCutProps(st);
  const show = (v: number | null, q: string) => v == null ? "—" : q === "len" ? fmtLen(v) : q === "area" ? fmtArea(v) : q === "mass" ? fmtMass(v) : q === "count" ? String(v) : fmtNum(v);
  dlg.querySelector<HTMLElement>("#sm-props-body")!.innerHTML = `<table class="v-table sm-props"><tbody>`
    + cutPropRows(p, mass).map(([k, v, q]) => `<tr data-prop="${esc(k)}"><th scope="row">${esc(t(k))}</th><td>${esc(show(v, q))}</td></tr>`).join("")
    + `</tbody></table>` + (st.flatEdges || !st.bends.length ? "" : `<p class="muted">${esc(t("Measured on the flat pattern of the sheet; flatten the part to include cuts made by other features."))}</p>`);
  dlg.querySelector<HTMLButtonElement>("[data-a=close]")!.onclick = () => dlg.close();
  dlg.querySelector<HTMLButtonElement>("[data-a=csv]")!.onclick = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([cutPropsCsv(p, mass)], { type: "text/csv" }));
    a.download = `${name}-sheet-metal.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  dlg.showModal();
  dlg.querySelector<HTMLButtonElement>("[data-a=close]")!.focus();
}
