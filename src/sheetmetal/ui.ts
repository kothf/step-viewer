// Sheet metal commands in the part modeller (FR-FT-120): the Sheet metal ▾ flyout, drafts with
// sensible picks, PropertyManager-style panels and their checks. The controller calls these; the
// generic panel handlers take `data-num` (lengths, angles) and `data-k` (plain values), and the
// `data-sm` controls here need their own handling (gauge rows, K-factor, toggles that add fields).
import { t } from "../i18n";
import type { EdgeRef, Feature, Num, PartDoc, SketchFeature } from "../model/types";
import { sketchPath, sketchProfile } from "../sketch/profile";
import { flatSize, type SheetState } from "./sheet";
import { GAUGE_TABLES, gaugeRow, type SheetFeature, type SmBaseFeature, type SmFlangeFeature, type SmHemFeature, type SmJogFeature, type SmSketchBendFeature, type SmTabFeature } from "./types";

export type SmTool = "smbase" | "smflange" | "smhem" | "smbend" | "smjog" | "smflat" | "smdxf";


/** The Sheet metal flyout's commands. */
export const SM_TOOLS = (): [SmTool, string, string][] => [
  ["smbase", t("Base Flange/Tab"), t("Base flange: a flat plate from a closed sketch, or a bent flange from an open chain of lines")],
  ["smflange", t("Edge Flange"), t("Edge flange: a bend and a flange on straight edges of the sheet")],
  ["smhem", t("Hem"), t("Hem: fold an edge back on itself, closed or open")],
  ["smbend", t("Sketched Bend"), t("Sketched bend: fold a flat face along a line sketched on it")],
  ["smjog", t("Jog"), t("Jog: two opposite bends along a sketched line that offset the rest of the face")],
  ["smflat", t("Flatten"), t("Flatten: show the flat pattern, or fold it back")],
  ["smdxf", t("Flat pattern DXF"), t("Export the flat pattern with its bend lines as DXF")],
];

/** Default feature names (translated in the tree like the others). */
export const SM_BASES = ["Base-Flange", "Edge-Flange", "Hem", "Sketched-Bend", "Jog", "Tab", "Flat-Pattern"];
export const SM_TREE_ICONS: Record<string, string> = { smbase: "▬", smflange: "⌐", smhem: "⊃", smbend: "⌙", smjog: "⎍", smtab: "▭", smflat: "▭" };

const S = (body: string) => `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
export const SM_ICONS: Record<string, string> = {
  smbase: S('<path d="M2 10l4-3h8l-4 3z" fill="currentColor" fill-opacity=".25"/><path d="M2 10v1.6l4-3M10 10v1.6l4-3"/>'),
  smflange: S('<path d="M2 12h8a2 2 0 0 0 2-2V3"/><path d="M2 14h8a4 4 0 0 0 4-4V3"/>'),
  smhem: S('<path d="M2 6h10a2 2 0 0 1 0 4H6"/><path d="M2 4h10a4 4 0 0 1 0 8H6"/>'),
  smbend: S('<path d="M2 12h6l5-7"/><path d="M8 3v11" stroke-dasharray="1.6 1.4"/>'),
  smjog: S('<path d="M1.5 11h5l3-5h5"/><path d="M1.5 13h5.6l3-5h4.4"/>'),
  smflat: S('<path d="M1.5 11h13M4 5h8"/><path d="M8 5v6" stroke-dasharray="1.6 1.4"/><path d="M4 5 1.5 11M12 5l2.5 6"/>'),
  smdxf: S('<path d="M3 2h7l3 3v9H3z"/><path d="M5 9h6M8 6v6" stroke-dasharray="1.6 1.4"/>'),
};

export interface DraftCtx {
  id: string;
  doc: PartDoc;
  /** Sketches before the insertion point. */
  sketches: SketchFeature[];
  /** Sketches some feature uses already. */
  used: Set<string>;
  selected: string | null;
  name: (type: SheetFeature["type"]) => string;
  /** The edge picked with Smart measure before the command, if any. */
  edge: EdgeRef | null;
  hasBody: boolean;
}

const usable = (s: SketchFeature) => !sketchProfile(s).error || (() => { const p = sketchPath(s); return !p.error && !p.closed; })();

/** A sketch holding just one line (for sketched bends and jogs). */
const oneLine = (s: SketchFeature) => { const p = sketchPath(s); return !p.error && p.segs.length === 1 && p.segs[0].kind === "line"; };

/** A new sheet metal feature, or the message to show when it can't start yet. */
export function smDraft(type: "smbase" | "smflange" | "smhem" | "smbend" | "smjog", c: DraftCtx): Feature | string {
  const base = c.doc.features.find((f): f is SmBaseFeature => f.type === "smbase");
  if (type === "smbase") {
    if (base) {
      // With a base flange, a closed sketch on a face of the sheet makes a tab (SolidWorks' Base Flange/Tab).
      const closed = (s: SketchFeature) => !sketchProfile(s).error;
      const sel = c.selected ? c.sketches.find(s => s.id === c.selected && closed(s)) : undefined;
      const sk = sel ?? c.sketches.filter(s => !c.used.has(s.id) && closed(s)).at(-1);
      if (!sk) return t("Draw a closed sketch on a flat face of the sheet for a tab.");
      return { id: c.id, type: "smtab", name: c.name("smtab"), sketch: sk.id } satisfies SmTabFeature;
    }
    const sel = c.selected ? c.sketches.find(s => s.id === c.selected && usable(s)) : undefined;
    const sk = sel ?? c.sketches.filter(s => !c.used.has(s.id) && usable(s)).at(-1);
    if (!sk) return t("Draw a sketch first: a closed profile for a plate, or an open chain of lines for a bent flange.");
    return { id: c.id, type: "smbase", name: c.name("smbase"), sketch: sk.id, thickness: { v: 2 }, radius: { v: 2 }, depth: { v: 20 }, k: 0.5 } satisfies SmBaseFeature;
  }
  if (!base) return t("Make a base flange first.");
  if (type === "smbend" || type === "smjog") {
    const sel = c.selected ? c.sketches.find(s => s.id === c.selected && oneLine(s)) : undefined;
    const sk = sel ?? c.sketches.filter(s => !c.used.has(s.id) && oneLine(s)).at(-1);
    if (!sk) return t("Sketch one line on a flat face of the sheet first.");
    if (type === "smbend") return { id: c.id, type: "smbend", name: c.name("smbend"), sketch: sk.id, angle: { v: Math.PI / 2 } } satisfies SmSketchBendFeature;
    return { id: c.id, type: "smjog", name: c.name("smjog"), sketch: sk.id, offset: { v: 10 }, angle: { v: Math.PI / 2 } } satisfies SmJogFeature;
  }
  const edges = c.edge ? [c.edge] : [];
  if (type === "smflange") return { id: c.id, type: "smflange", name: c.name("smflange"), edges, length: { v: 20 }, angle: { v: Math.PI / 2 } } satisfies SmFlangeFeature;
  return { id: c.id, type: "smhem", name: c.name("smhem"), edges, kind: "closed", length: { v: 6 } } satisfies SmHemFeature;
}

/** Why ✓ can't keep the draft yet (null: it can). */
export function smCheck(f: Feature): string | null {
  if (f.type === "smbase" && !f.sketch) return t("Pick a sketch for the base flange.");
  if (f.type === "smtab" && !f.sketch) return t("Pick a closed sketch for the tab.");
  if ((f.type === "smbend" || f.type === "smjog") && !f.sketch) return t("Pick a sketch with the bend line.");
  if ((f.type === "smflange" || f.type === "smhem") && !f.edges.length) return t("Pick the edges for the flange.");
  return null;
}

export interface PanelKit {
  esc: (s: string) => string;
  group: (legend: string, inner: string) => string;
  numField: (key: string, label: string, n: Num, q: "length" | "angle") => string;
  chk: (k: string, on: boolean | undefined, label: string) => string;
  sketches: SketchFeature[];
  label: (name: string) => string;
  sheet: SheetState | null | undefined;
  unit: string;
  /** mm → the shown unit. */
  f: number;
}

const opt = (esc: PanelKit["esc"], v: string, cur: string | undefined, label: string) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(label)}</option>`;

/** The panel of a sheet metal feature. */
export function smPanel(f: SheetFeature, k: PanelKit): { title: string; body: string } {
  const { esc, group, numField, chk } = k;
  const help = (s: string) => `<p class="pm-help muted">${esc(s)}</p>`;
  const sel = (key: string, label: string, opts: [string, string][], cur: string | undefined) => `<label class="pm-field"><span>${esc(label)}</span><select data-sm="${key}">${opts.map(([v, l]) => opt(esc, v, cur, l)).join("")}</select></label>`;
  const edgeList = (edges: EdgeRef[]) => `<p class="pm-count" data-sm-edges>${esc(edges.length ? t("{n} edge|{n} edges", { n: edges.length }) : t("click straight edges of the sheet in the view"))}</p>`
    + (edges.length ? `<button class="btn small" data-sm="clear">${esc(t("Clear edges"))}</button>` : "");
  if (f.type === "smbase") {
    const sk = k.sketches.find(s => s.id === f.sketch);
    const open = !!sk && !!sketchProfile(sk).error;
    const calc = f.calc ?? "k";
    const gauges: [string, string][] = [["", t("None")], ...GAUGE_TABLES.flatMap(tb => tb.rows.map(r => [`${tb.id}:${r.gauge}`, `${t(tb.name)} · ${r.gauge} (${r.t} mm)`] as [string, string]))];
    return {
      title: t("Base Flange"),
      body: group(t("Profile"), `<label class="pm-field"><span>${esc(t("Sketch"))}</span><select data-k="sketch">${k.sketches.map(s => `<option value="${s.id}"${s.id === f.sketch ? " selected" : ""}>${esc(k.label(s.name))}</option>`).join("")}</select></label>`
        + help(open ? t("Open profile: the lines become flat panels with bends at the corners.") : t("Closed profile: a flat plate.")))
        + (open ? group(t("Direction 1"), numField("depth", t("Depth"), f.depth, "length") + chk("mid", f.mid, t("Mid plane")) + chk("flip", f.flip, t("Reverse direction"))) : "")
        + group(t("Sheet metal parameters"), sel("gauge", t("Gauge table"), gauges, f.gauge ?? "")
          + numField("thickness", t("Thickness"), f.thickness, "length") + chk("reverse", f.reverse, t("Reverse direction"))
          + numField("radius", t("Bend radius"), f.radius, "length"))
        + group(t("Bend allowance"), sel("calc", t("Type"), [["k", t("K-factor")], ["ba", t("Bend allowance")], ["bd", t("Bend deduction")]], calc)
          + (calc === "k" ? `<label class="pm-field"><span>${esc(t("K-factor"))}</span><span class="pm-in"><input type="text" inputmode="decimal" data-sm="k" value="${esc(String(f.k ?? 0.5))}" spellcheck="false" /></span></label>`
            : calc === "ba" ? numField("ba", t("Bend allowance"), f.ba ?? { v: 3 }, "length") : numField("bd", t("Bend deduction"), f.bd ?? { v: 3 }, "length")))
        + group(t("Auto relief"), sel("relief", t("Type"), [["rect", t("Rectangular")], ["none", t("None")]], f.relief === "none" ? "none" : "rect")
          + (f.relief === "none" ? "" : `<label class="pm-field"><span>${esc(t("Relief ratio"))}</span><span class="pm-in"><input type="text" inputmode="decimal" data-sm="ratio" value="${esc(String(f.reliefRatio ?? 0.5))}" spellcheck="false" /></span></label>`)),
    };
  }
  if (f.type === "smflange") {
    const custom = !!f.radius, offs = !!(f.off0 || f.off1);
    return {
      title: t("Edge Flange"),
      body: group(t("Flange parameters"), edgeList(f.edges) + chk("flip", f.flip, t("Reverse direction")))
        + group(t("Angle"), numField("angle", t("Flange angle"), f.angle, "angle"))
        + group(t("Flange length"), sel("lengthRef", t("Measured to"), [["outer", t("Outer virtual sharp")], ["inner", t("Inner virtual sharp")]], f.lengthRef ?? "outer") + numField("length", t("Length"), f.length, "length"))
        + group(t("Flange position"), sel("position", t("Position"), [["inside", t("Material inside")], ["outside", t("Material outside")], ["bendout", t("Bend outside")]], f.position ?? "inside"))
        + group(t("Custom bend radius"), `<label class="chk pm-chk"><input type="checkbox" data-sm="customR"${custom ? " checked" : ""} />${esc(t("Use custom bend radius"))}</label>` + (f.radius ? numField("radius", t("Bend radius"), f.radius, "length") : ""))
        + group(t("Custom width"), `<label class="chk pm-chk"><input type="checkbox" data-sm="offs"${offs ? " checked" : ""} />${esc(t("Offset from the edge ends"))}</label>`
          + (f.off0 ? numField("off0", t("Start offset"), f.off0, "length") : "") + (f.off1 ? numField("off1", t("End offset"), f.off1, "length") : "")
          + (offs ? help(t("A flange shorter than its edge gets bend reliefs.")) : ""))
        + (f.edges.length > 1 && !offs ? group(t("Corners"), numField("gap", t("Corner gap"), f.gap ?? { v: 0.1 }, "length")
          + help(t("Flanges on edges that meet at a corner run on and are mitred, with this gap between them."))) : ""),
    };
  }
  if (f.type === "smhem") {
    return {
      title: t("Hem"),
      body: group(t("Edges"), edgeList(f.edges) + chk("flip", f.flip, t("Reverse direction")))
        + group(t("Type and size"), sel("kind", t("Type"), [["closed", t("Closed")], ["open", t("Open")]], f.kind) + numField("length", t("Length"), f.length, "length")
          + (f.kind === "open" ? numField("gap", t("Gap distance"), f.gap ?? { v: 1 }, "length") : ""))
        + group(t("Position"), sel("position", t("Position"), [["inside", t("Material inside")], ["outside", t("Material outside")]], f.position ?? "inside")),
    };
  }
  if (f.type === "smtab") {
    const closed = k.sketches.filter(s => !sketchProfile(s).error || s.id === f.sketch);
    return {
      title: t("Tab"),
      body: group(t("Profile"), `<label class="pm-field"><span>${esc(t("Sketch"))}</span><select data-k="sketch">${closed.map(s => `<option value="${s.id}"${s.id === f.sketch ? " selected" : ""}>${esc(k.label(s.name))}</option>`).join("")}</select></label>`
        + help(t("A closed sketch on a flat face, beside it and touching its edge: the tab takes the sheet's thickness and joins the flat pattern."))),
    };
  }
  if (f.type === "smbend" || f.type === "smjog") {
    const lines = k.sketches.filter(s => oneLine(s) || s.id === f.sketch);
    const sketchSel = `<label class="pm-field"><span>${esc(t("Sketch"))}</span><select data-k="sketch">${lines.map(s => `<option value="${s.id}"${s.id === f.sketch ? " selected" : ""}>${esc(k.label(s.name))}</option>`).join("")}</select></label>`;
    const pos = sel("position", t("Position"), [["center", t("Bend centerline")], ["start", t("Bend starts at line")], ["end", t("Bend ends at line")]], f.position ?? "center");
    const radius = group(t("Custom bend radius"), `<label class="chk pm-chk"><input type="checkbox" data-sm="customR"${f.radius ? " checked" : ""} />${esc(t("Use custom bend radius"))}</label>` + (f.radius ? numField("radius", t("Bend radius"), f.radius, "length") : ""));
    const sides = chk("flip", f.flip, t("Fold the other side")) + chk("reverse", f.reverse, t("Reverse direction"));
    if (f.type === "smbend") {
      return {
        title: t("Sketched Bend"),
        body: group(t("Bend line"), sketchSel + help(t("One line sketched on a flat face; the side without bends folds, and the flat pattern keeps its size.")) + sides)
          + group(t("Bend parameters"), numField("angle", t("Bend angle"), f.angle, "angle") + pos) + radius,
      };
    }
    return {
      title: t("Jog"),
      body: group(t("Bend line"), sketchSel + sides)
        + group(t("Jog offset"), sel("dim", t("Measured"), [["outside", t("Outside offset")], ["inside", t("Inside offset")], ["face", t("Face to face")]], f.dim ?? "outside") + numField("offset", t("Offset"), f.offset, "length"))
        + group(t("Jog position"), pos) + group(t("Jog angle"), numField("angle", t("Bend angle"), f.angle, "angle")) + radius,
    };
  }
  const st = k.sheet;
  const sz = st ? flatSize(st) : null;
  return {
    title: t("Flat pattern"),
    body: group(t("Flat pattern"), sz ? `<p class="pm-count" data-sm-size>${esc(t("Size {w} × {h} {unit}, {n} bends", { w: (sz.w * k.f).toFixed(2), h: (sz.h * k.f).toFixed(2), unit: k.unit, n: st!.bends.length }))}</p>` : "")
      + `<button class="btn small" data-sm="dxf">${esc(t("Export DXF"))}</button>`
      + help(t("Suppress the flat pattern (or click Flatten again) to fold the part back.")),
  };
}

/** Wires the `data-sm` controls; `upd` changes the draft and rebuilds (structural: the panel is drawn again). */
export function bindSmPanel(pm: HTMLElement, f: SheetFeature, upd: (fn: () => void, structural?: boolean) => void, dxf: () => void, toastBad: (msg: string) => void) {
  pm.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("[data-sm]").forEach(el => {
    const key = el.dataset.sm!;
    if (el instanceof HTMLButtonElement) {
      el.addEventListener("click", () => {
        if (key === "dxf") dxf();
        if (key === "clear" && (f.type === "smflange" || f.type === "smhem")) upd(() => { f.edges = []; }, true);
      });
      return;
    }
    el.addEventListener("change", () => {
      const val = el instanceof HTMLInputElement && el.type === "checkbox" ? el.checked : el.value;
      if (f.type === "smbase") {
        if (key === "gauge") {
          upd(() => {
            const row = gaugeRow(String(val));
            if (!row) { delete f.gauge; return; }
            f.gauge = String(val); f.thickness = { v: row.t }; f.radius = { v: row.r }; f.calc = "k"; f.k = row.k;
          }, true);
          return;
        }
        if (key === "calc") { upd(() => { f.calc = val as SmBaseFeature["calc"]; if (f.calc === "ba") f.ba ??= { v: 3 }; if (f.calc === "bd") f.bd ??= { v: 3 }; if (f.calc === "k") f.k ??= 0.5; }, true); return; }
        if (key === "relief") { upd(() => { if (val === "none") f.relief = "none"; else delete f.relief; }, true); return; }
        if (key === "k" || key === "ratio") {
          const v = Number(String(val).replace(",", "."));
          const ok = key === "k" ? v >= 0 && v <= 1 : v > 0 && v <= 10;
          if (!Number.isFinite(v) || !ok) { el.setAttribute("aria-invalid", "true"); toastBad(key === "k" ? t("The K-factor must be between 0 and 1.") : t("The value must be more than 0.")); return; }
          el.removeAttribute("aria-invalid");
          upd(() => { if (key === "k") { f.k = v; delete f.gauge; } else f.reliefRatio = v; });
        }
        return;
      }
      if (f.type === "smflange") {
        if (key === "lengthRef") upd(() => { if (val === "inner") f.lengthRef = "inner"; else delete f.lengthRef; });
        if (key === "position") upd(() => { if (val === "inside") delete f.position; else f.position = val as SmFlangeFeature["position"]; });
        if (key === "customR") upd(() => { if (val) f.radius = { v: 2 }; else delete f.radius; }, true);
        if (key === "offs") upd(() => { if (val) { f.off0 = { v: 5 }; f.off1 = { v: 5 }; } else { delete f.off0; delete f.off1; } }, true);
        return;
      }
      if (f.type === "smbend" || f.type === "smjog") {
        if (key === "position") upd(() => { if (val === "center") delete f.position; else f.position = val as SmSketchBendFeature["position"]; });
        if (key === "customR") upd(() => { if (val) f.radius = { v: 2 }; else delete f.radius; }, true);
        if (key === "dim" && f.type === "smjog") upd(() => { if (val === "outside") delete f.dim; else f.dim = val as SmJogFeature["dim"]; });
        return;
      }
      if (f.type === "smhem") {
        if (key === "kind") upd(() => { f.kind = val as SmHemFeature["kind"]; if (f.kind === "open") f.gap ??= { v: 1 }; else delete f.gap; }, true);
        if (key === "position") upd(() => { if (val === "outside") f.position = "outside"; else delete f.position; });
      }
    });
  });
}
