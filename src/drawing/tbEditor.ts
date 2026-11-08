// Title block editor (FR-DRW-004): a dialog that lays out a user sheet format's cells
// (position, size, the field each shows, its label), its logo and size, with a live preview.
import { t } from "../i18n";
import { toast, trapFocus } from "../ui";
import { LOGO_MAX, TB_KEYS, deleteFormat, formatFile, loadFormats, saveFormat, validFormat, FORMAT_EXT } from "./formats";
import { svgBody } from "./output";
import { FIELD_LABEL, userBlock, type Fields } from "./sheet";
import type { Sheet, TbKey, TitleFormat } from "./types";

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const KEY_LABEL: Record<TbKey, string> = { ...FIELD_LABEL, scale: "Scale", sheet: "Sheet", size: "Size", units: "Units", projection: "Projection symbol" };

/**
 * Opens the editor on a copy of `start`. Resolves to the format to put on the sheet (it is also
 * saved in the library), or null when cancelled.
 */
export function editTitleBlock(start: TitleFormat, sheet: Sheet, fields: Fields, download: (b: Blob, name: string) => void): Promise<TitleFormat | null> {
  let tb: TitleFormat = structuredClone(start);
  if (!tb.id) tb.id = `fmt_${Math.random().toString(36).slice(2, 10)}`;
  let d = document.getElementById("drw-tb-dlg") as HTMLDialogElement | null;
  if (!d) {
    d = document.createElement("dialog");
    d.id = "drw-tb-dlg";
    d.className = "modal wide drw-tb-dlg";
    d.setAttribute("aria-labelledby", "drw-tb-title");
    document.body.appendChild(d);
    trapFocus(d, () => d!.open);
  }
  const dlg = d;
  const num = (v: number) => String(Math.round(v * 100) / 100);
  const preview = () => {
    const s = { ...sheet, tb };
    const prims = userBlock(s, tb, 0, 0, fields, l => t(l));
    const pad = 2;
    return `<svg class="drw-tb-pv" viewBox="${-pad} ${-pad} ${tb.w + 2 * pad} ${tb.h + 2 * pad}" role="img" aria-label="${esc(t("Preview"))}"><rect x="0" y="0" width="${tb.w}" height="${tb.h}" fill="#fff"/>${svgBody(prims, tb.h)}</svg>`;
  };
  const cellRow = (c: TitleFormat["cells"][number], i: number) => `<tr>
      ${(["x", "y", "w", "h"] as const).map(k => `<td><input type="number" step="0.5" min="0" data-c="${i}.${k}" value="${num(c[k])}" aria-label="${esc(t(k.toUpperCase()))} ${i + 1}"></td>`).join("")}
      <td><select data-c="${i}.key" aria-label="${esc(t("Field"))} ${i + 1}"><option value="">${esc(t("None"))}</option>${TB_KEYS.map(k => `<option value="${k}"${c.key === k ? " selected" : ""}>${esc(t(KEY_LABEL[k]))}</option>`).join("")}</select></td>
      <td><input data-c="${i}.label" value="${esc(c.label ?? "")}" aria-label="${esc(t("Label"))} ${i + 1}" translate="no"></td>
      <td><input type="checkbox" data-c="${i}.big"${c.big ? " checked" : ""} aria-label="${esc(t("Large text"))} ${i + 1}"></td>
      <td><button type="button" class="btn small" data-tb="rm" data-i="${i}" aria-label="${esc(t("Remove cell"))} ${i + 1}">✕</button></td></tr>`;
  const inLib = () => loadFormats().some(f => f.id === tb.id);
  const render = () => {
    const L = tb.logo;
    dlg.innerHTML = `<form method="dialog">
      <h3 id="drw-tb-title">${esc(t("Title block"))}</h3>
      <div class="row drw-tb-top">
        <label class="drw-f">${esc(t("Name"))}<input data-tb-f="name" value="${esc(tb.name)}" translate="no"></label>
        <label class="drw-f">${esc(t("Width"))}<input type="number" min="20" max="420" data-tb-f="w" value="${num(tb.w)}"></label>
        <label class="drw-f">${esc(t("Height"))}<input type="number" min="5" max="297" data-tb-f="h" value="${num(tb.h)}"></label>
      </div>
      <div class="drw-tb-pvbox">${preview()}</div>
      <div class="v-scroll"><table class="v-table drw-tb-cells"><thead><tr><th>X</th><th>Y</th><th>${esc(t("W"))}</th><th>${esc(t("H"))}</th><th>${esc(t("Field"))}</th><th>${esc(t("Label"))}</th><th>${esc(t("Large"))}</th><th></th></tr></thead><tbody>${tb.cells.map(cellRow).join("")}</tbody></table></div>
      <div class="row"><button type="button" class="btn small" data-tb="add">${esc(t("Add cell"))}</button></div>
      <fieldset class="pm-group"><legend>${esc(t("Logo"))}</legend>
        ${L ? `<div class="row">${(["x", "y", "w", "h"] as const).map(k => `<label class="drw-f">${esc(k === "x" || k === "y" ? k.toUpperCase() : t(k === "w" ? "Width" : "Height"))}<input type="number" step="0.5" min="0" data-tb-l="${k}" value="${num(L[k])}"></label>`).join("")}</div>` : `<p class="drw-note">${esc(t("A PNG or JPEG image, up to 512 KB."))}</p>`}
        <div class="row"><label class="btn small">${esc(L ? t("Replace logo…") : t("Add logo…"))}<input type="file" accept="image/png,image/jpeg" data-tb="logo" hidden></label>${L ? `<button type="button" class="btn small" data-tb="nologo">${esc(t("Remove logo"))}</button>` : ""}</div>
      </fieldset>
      <div class="row"><button type="button" class="btn small" data-tb="export">${esc(t("Export format"))}</button><label class="btn small">${esc(t("Import format…"))}<input type="file" accept=".json,application/json" data-tb="import" hidden></label>${inLib() ? `<button type="button" class="btn small danger" data-tb="del">${esc(t("Delete from library"))}</button>` : ""}</div>
      <div class="row end"><button class="btn" value="cancel" formnovalidate>${esc(t("Cancel"))}</button><button class="btn primary" value="ok">${esc(t("Save and use"))}</button></div>
    </form>`;
  };
  const refreshPreview = () => { const box = dlg.querySelector(".drw-tb-pvbox"); if (box) box.innerHTML = preview(); };
  render();
  const onInput = (e: Event) => {
    const el = e.target as HTMLInputElement | HTMLSelectElement;
    const c = el.dataset.c, f = el.dataset.tbF, l = el.dataset.tbL;
    if (c) {
      const [i, k] = c.split(".");
      const cell = tb.cells[+i];
      if (!cell) return;
      if (k === "key") { if (el.value) cell.key = el.value as TbKey; else delete cell.key; }
      else if (k === "label") { if (el.value.trim()) cell.label = el.value; else delete cell.label; }
      else if (k === "big") { if ((el as HTMLInputElement).checked) cell.big = true; else delete cell.big; }
      else { const v = parseFloat(el.value); if (Number.isFinite(v) && v >= 0) cell[k as "x" | "y" | "w" | "h"] = v; }
    } else if (f) {
      if (f === "name") tb.name = el.value;
      else { const v = parseFloat(el.value); if (Number.isFinite(v) && v > 0) tb[f as "w" | "h"] = v; }
    } else if (l && tb.logo) { const v = parseFloat(el.value); if (Number.isFinite(v) && v >= 0) tb.logo[l as "x" | "y" | "w" | "h"] = v; }
    else return;
    refreshPreview();
  };
  const onChange = async (e: Event) => {
    const el = e.target as HTMLInputElement;
    const file = el.files?.[0];
    if (!file) return;
    if (el.dataset.tb === "logo") {
      if (file.size > LOGO_MAX) { toast(t("The logo is larger than 512 KB."), true); return; }
      const src = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(file); });
      if (!/^data:image\/(png|jpeg);base64,/.test(src)) { toast(t("Use a PNG or JPEG image."), true); return; }
      // Fit the image's aspect into a box at the block's left, 4/5 of its height.
      const img = new Image();
      await new Promise(r => { img.onload = img.onerror = r; img.src = src; });
      const h = Math.min(tb.h * 0.8, 20), w = img.naturalWidth && img.naturalHeight ? Math.min(tb.w / 3, h * img.naturalWidth / img.naturalHeight) : h;
      tb.logo = { src, x: 1, y: tb.h - h - 1, w, h };
      render();
    } else if (el.dataset.tb === "import") {
      try {
        const f = validFormat(JSON.parse(await file.text()));
        if (!f) throw new Error("bad");
        tb = f;
        render();
      } catch { toast(t("That file is not a sheet format."), true); }
    }
  };
  const onClick = (e: Event) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-tb]");
    if (!b || b.tagName === "INPUT") return;
    const a = b.dataset.tb;
    if (a === "add") tb.cells.push({ x: 0, y: 0, w: Math.min(40, tb.w), h: Math.min(8, tb.h), label: "" });
    else if (a === "rm") tb.cells.splice(+b.dataset.i!, 1);
    else if (a === "nologo") delete tb.logo;
    else if (a === "export") { download(new Blob([formatFile(tb)], { type: "application/json" }), `${(tb.name || "title-block").replace(/[\\/:*?"<>|]+/g, "_")}${FORMAT_EXT}`); return; }
    else if (a === "del") { deleteFormat(tb.id); toast(t("Deleted from the library.")); }
    else return;
    render();
  };
  dlg.addEventListener("input", onInput);
  dlg.addEventListener("change", onChange);
  dlg.addEventListener("click", onClick);
  const opener = document.activeElement as HTMLElement | null;
  dlg.returnValue = "";
  dlg.showModal();
  dlg.querySelector<HTMLInputElement>("[data-tb-f=name]")?.focus();
  return new Promise(res => dlg.addEventListener("close", () => {
    dlg.removeEventListener("input", onInput);
    dlg.removeEventListener("change", onChange);
    dlg.removeEventListener("click", onClick);
    opener?.focus?.();
    if (dlg.returnValue !== "ok") { res(null); return; }
    const f = validFormat(tb);
    if (!f) { toast(t("The title block needs a size of at least 20 × 5 mm."), true); res(null); return; }
    if (!saveFormat(f)) toast(t("The library is full: the format is used on this sheet but not saved for others."), true);
    res(f);
  }, { once: true }));
}
