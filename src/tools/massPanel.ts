// Mass Properties panel (FR-MAT-002, Evaluate ▸ Mass properties): what a CAD app lists in its
// Mass Properties dialog, shown in a panel over the view, plus a plain-text copy.
import { t } from "../i18n";
import { UNITS, fmtArea, fmtMass, fmtNum, fmtVol, units } from "./units";
import type { MassReport, V3 } from "./inertia";

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Inertia display unit: g·mm² scaled to the mass unit fmtMass uses and the display length unit. */
export function inertiaUnit(massG: number) {
  const kg = massG >= 1000, f = UNITS[units.current].f;
  return { k: (kg ? 1e-3 : 1) * f * f, label: `${kg ? "kg" : "g"}·${units.current}²` };
}

const lenNum = (mm: number) => (mm * UNITS[units.current].f).toFixed(units.decimals ?? UNITS[units.current].d);

/** Every number of the report as display strings; values smaller than 1e-9 of the largest moment show as 0. */
export function massNumbers(r: MassReport) {
  const u = inertiaUnit(r.mass);
  const big = Math.max(...r.principal.moments.map(Math.abs), 1e-300);
  const n = (v: number) => fmtNum(Math.abs(v) < big * 1e-9 ? 0 : v * u.k);
  const ax = (a: V3) => `(${a.map(c => (Math.abs(c) < 5e-7 ? 0 : c).toFixed(4)).join(", ")})`;
  const tensor = (m: MassReport["atCom"], p: "L" | "I") => [
    [[`${p}xx`, n(m.xx)], [`${p}xy`, n(m.xy)], [`${p}xz`, n(m.zx)]],
    [[`${p}yx`, n(m.xy)], [`${p}yy`, n(m.yy)], [`${p}yz`, n(m.yz)]],
    [[`${p}zx`, n(m.zx)], [`${p}zy`, n(m.yz)], [`${p}zz`, n(m.zz)]],
  ];
  return {
    unit: u.label,
    mass: fmtMass(r.mass), volume: fmtVol(r.volume), area: fmtArea(r.area),
    com: r.local.map(lenNum) as [string, string, string],
    principal: r.principal.axes.map((a, i) => ({ axis: ax(a), moment: n(r.principal.moments[i]) })),
    atCom: tensor(r.atCom, "L"), atOrigin: tensor(r.atOrigin, "I"),
  };
}

export interface MassView {
  rep: MassReport;
  /** "Whole model (n parts)" or "n selected parts", translated. */
  scope: string;
  /** Density line, translated. */
  density: string;
  frame: {
    name: string; options: { key: string; name: string }[]; key: string;
    /** Pick axes is waiting for a click; the typed axes form is open; the output frame is one the user added. */
    picking: boolean; typing: boolean; user: boolean;
    /** Display length unit of the typed origin. */
    unit: string;
  };
  hidden: boolean;
  axes: boolean;
  /** Translated warnings and notes (open shells, overridden values, mesh values). */
  notes: string[];
  overridden: { mass: boolean; com: boolean };
  canMaterial: boolean;
}

/** The panel's inner HTML. */
export function massPanelHtml(v: MassView | null, empty: string): string {
  const head = `<div class="mp-head"><h2>${esc(t("Mass properties"))}</h2>
    <button class="icon" data-mp="close" title="${esc(t("Close"))}" aria-label="${esc(t("Close mass properties"))}">✕</button></div>`;
  if (!v) return `${head}<p class="mp-note">${esc(empty)}</p>`;
  const N = massNumbers(v.rep), ovr = ` <span class="mp-ovr">(${esc(t("overridden"))})</span>`;
  const row = (k: string, val: string) => `<span class="k">${esc(t(k))}</span><span class="v" translate="no">${val}</span>`;
  const grid = (m: string[][][]) => `<div class="mp-grid" translate="no">${m.map(r => r.map(([k, x]) => `<span class="mp-c"><i>${k}</i> = ${esc(x)}</span>`).join("")).join("")}</div>`;
  const xyz = ["X", "Y", "Z"];
  return `${head}
    <div class="mp-opts">
      <p class="mp-scope">${esc(v.scope)}</p>
      <label class="ana-row">${esc(t("Output coordinate system"))} <select data-mp="frame">${v.frame.options.map(o => `<option value="${esc(o.key)}"${o.key === v.frame.key ? " selected" : ""}>${esc(o.name)}</option>`).join("")}</select></label>
      <div class="row wrap mp-axes"><button class="btn small" data-mp="pick" aria-pressed="${v.frame.picking}" title="${esc(t("Click a flat face, straight edge, circle or point to put your own axes there"))}">${esc(t(v.frame.picking ? "Click the model…" : "Pick axes"))}</button><button class="btn small" data-mp="type" aria-expanded="${v.frame.typing}" title="${esc(t("Type an origin and the X and Z directions"))}">${esc(t("Type axes…"))}</button>${v.frame.user ? `<button class="btn small" data-mp="delframe">${esc(t("Delete axes"))}</button>` : ""}</div>
      ${v.frame.typing ? typedAxes(v.frame.unit) : ""}
      <label class="chk"><input type="checkbox" data-mp="hidden"${v.hidden ? " checked" : ""} /> ${esc(t("Include hidden bodies"))}</label>
      <label class="chk"><input type="checkbox" data-mp="axes"${v.axes ? " checked" : ""} /> ${esc(t("Show principal axes"))}</label>
      <div class="row wrap"><button class="btn small" data-mp="recalc">${esc(t("Recalculate"))}</button><button class="btn small" data-mp="copy" title="${esc(t("Copy the results as text"))}">${esc(t("Copy to clipboard"))}</button>${v.canMaterial ? `<button class="btn small" data-mp="material" title="${esc(t("Material and density of the parts"))}">${esc(t("Material…"))}</button>` : ""}</div>
    </div>
    <div class="kv mp-kv">
      ${row("Density", esc(v.density))}
      ${row("Mass", esc(N.mass) + (v.overridden.mass ? ovr : ""))}
      ${row("Volume", esc(N.volume))}
      ${row("Surface area", esc(N.area))}
    </div>
    <h3>${esc(t("Centre of mass"))} (${esc(units.current)})${v.overridden.com ? ovr : ""}</h3>
    <div class="mp-grid" translate="no">${N.com.map((c, i) => `<span class="mp-c"><i>${xyz[i]}</i> = ${esc(c)}</span>`).join("")}</div>
    <h3>${esc(t("Principal axes of inertia and principal moments of inertia ({unit}), taken at the centre of mass", { unit: N.unit }))}</h3>
    <div class="mp-princ" translate="no">${N.principal.map((p, i) => `<span><i>I${"xyz"[i]}</i> = ${esc(p.axis)}</span><span><i>P${"xyz"[i]}</i> = ${esc(p.moment)}</span>`).join("")}</div>
    <h3>${esc(t("Moments of inertia ({unit}), taken at the centre of mass and aligned with the output coordinate system", { unit: N.unit }))}</h3>
    ${grid(N.atCom)}
    <h3>${esc(t("Moments of inertia ({unit}), taken at the output coordinate system", { unit: N.unit }))}</h3>
    ${grid(N.atOrigin)}
    <p class="mp-note">${esc(t("Products of inertia use positive notation: Lxy = ∫xy dm."))}</p>
    ${v.notes.map(n => `<p class="mp-note mp-warn">${esc(n)}</p>`).join("")}`;
}

/** The form for typed axes: name, origin (display units) and the X and Z directions (world). */
function typedAxes(unit: string): string {
  const inp = (k: string, v: string, label: string) => `<input type="text" inputmode="decimal" data-ax="${k}" value="${v}" aria-label="${esc(label)}" spellcheck="false" />`;
  const row = (k: "o" | "x" | "z", label: string, def: [string, string, string], u: string) =>
    `<span class="mp-axl">${esc(label)}</span>${def.map((d, i) => inp(`${k}${i}`, d, `${label} ${"XYZ"[i]}`)).join("")}<span class="muted">${esc(u)}</span>`;
  return `<div class="mp-type">
    <label class="mp-axn"><span>${esc(t("Name"))}</span><input type="text" data-ax="name" placeholder="${esc(t("Axes"))}" /></label>
    <div class="mp-axg">${row("o", t("Origin"), ["0", "0", "0"], unit)}${row("x", t("X direction"), ["1", "0", "0"], "")}${row("z", t("Z direction"), ["0", "0", "1"], "")}</div>
    <div class="row"><button class="btn small primary" data-mp="addaxes">${esc(t("Add axes"))}</button><button class="btn small" data-mp="type">${esc(t("Cancel"))}</button></div>
  </div>`;
}

/** The report as plain text (Copy to clipboard), in the interface language. */
export function massText(v: MassView): string {
  const N = massNumbers(v.rep), xyz = ["X", "Y", "Z"];
  const o = (on: boolean) => (on ? ` (${t("overridden")})` : "");
  const L: string[] = [
    `${t("Mass properties")}: ${v.scope}`,
    `${t("Output coordinate system")}: ${v.frame.name}`,
    "",
    `${t("Density")} = ${v.density}`,
    `${t("Mass")} = ${N.mass}${o(v.overridden.mass)}`,
    `${t("Volume")} = ${N.volume}`,
    `${t("Surface area")} = ${N.area}`,
    "",
    `${t("Centre of mass")} (${units.current})${o(v.overridden.com)}:`,
    ...N.com.map((c, i) => `\t${xyz[i]} = ${c}`),
    "",
    `${t("Principal axes of inertia and principal moments of inertia ({unit}), taken at the centre of mass", { unit: N.unit })}:`,
    ...N.principal.map((p, i) => `\tI${"xyz"[i]} = ${p.axis}\tP${"xyz"[i]} = ${p.moment}`),
    "",
    `${t("Moments of inertia ({unit}), taken at the centre of mass and aligned with the output coordinate system", { unit: N.unit })}:`,
    ...N.atCom.map(r => "\t" + r.map(([k, x]) => `${k} = ${x}`).join("\t")),
    "",
    `${t("Moments of inertia ({unit}), taken at the output coordinate system", { unit: N.unit })}:`,
    ...N.atOrigin.map(r => "\t" + r.map(([k, x]) => `${k} = ${x}`).join("\t")),
  ];
  if (v.notes.length) L.push("", ...v.notes);
  return L.join("\n");
}
