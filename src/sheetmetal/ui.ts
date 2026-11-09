// Sheet metal commands in the part modeller (FR-FT-120): the Sheet metal ▾ flyout, drafts with
// sensible picks, PropertyManager-style panels and their checks. The controller calls these; the
// generic panel handlers take `data-num` (lengths, angles) and `data-k` (plain values), and the
// `data-sm` controls here need their own handling (gauge rows, K-factor, toggles that add fields).
import { t } from "../i18n";
import type { EdgeRef, FaceRef, Feature, Num, PartDoc, SketchFeature } from "../model/types";
import { sketchPath, sketchProfile } from "../sketch/profile";
import { bendOfFace, flatSize, panelOfFace, reliefCorners, ventLayout, type SheetState } from "./sheet";
import { loopPolygon } from "../sketch/profile";
import { GAUGE_TABLES, gaugeRow, type SheetFeature, type SmLoftFeature, type SmBaseFeature, type SmClosedFeature, type SmCornerFeature, type SmReliefFeature, type SmGussetFeature, type SmCrossFeature, type SmVentFeature, type SmFormFeature, type SmUnfoldFeature, type FormTool, type SmFlangeFeature, type SmHemFeature, type SmJogFeature, type SmMiterFeature, type SmSketchBendFeature, type SmTabFeature } from "./types";

export type SmTool = "smbase" | "smloft" | "smflange" | "smhem" | "smbend" | "smjog" | "smcorner" | "smclosed" | "smrelief" | "smgusset" | "smcross" | "smvent" | "smform" | "smunfold" | "smfold" | "smmiter" | "smswept" | "smflat" | "smdxf";


/** The Sheet metal flyout's commands. */
export const SM_TOOLS = (): [SmTool, string, string][] => [
  ["smbase", t("Base Flange/Tab"), t("Base flange: a flat plate from a closed sketch, or a bent flange from an open chain of lines")],
  ["smloft", t("Lofted Bend"), t("Lofted bend: join two open profiles of lines and arcs, sketched on two planes, with a sheet of flat facets that unfolds exactly")],
  ["smflange", t("Edge Flange"), t("Edge flange: a bend and a flange on straight edges of the sheet")],
  ["smmiter", t("Miter Flange"), t("Miter flange: run a sketched profile of lines along edges of the sheet, mitred at corners")],
  ["smswept", t("Swept Flange"), t("Swept flange: run a sketched profile of lines and tangent arcs along edges of the sheet; each arc is a bend of its own radius")],
  ["smhem", t("Hem"), t("Hem: fold an edge back on itself, closed or open")],
  ["smbend", t("Sketched Bend"), t("Sketched bend: fold a flat face along a line sketched on it")],
  ["smjog", t("Jog"), t("Jog: two opposite bends along a sketched line that offset the rest of the face")],
  ["smcorner", t("Break Corner"), t("Break corner: chamfer or round outside corners of the sheet through its thickness")],
  ["smclosed", t("Closed Corner"), t("Closed corner: run flange ends on to meet the neighbouring flange, overlapping or underlapping it")],
  ["smrelief", t("Corner Relief"), t("Corner relief: cut a rectangular, circular or tear relief where two bends meet at a corner, in the model and the flat pattern")],
  ["smgusset", t("Sheet Metal Gusset"), t("Sheet metal gusset: press a stiffening rib across a bend; click the bend where the rib goes")],
  ["smcross", t("Cross Break"), t("Cross break: mark a flat face with crossed lines, the shallow stiffening break from corner to corner")],
  ["smvent", t("Vent"), t("Vent: cut openings in a flat face from one sketch, a closed boundary with ribs (lines) and spars (circles) left as material")],
  ["smform", t("Forming Tool"), t("Forming tool: press a dimple, rib, louver or extruded hole into a flat face; click the face to place each one")],
  ["smunfold", t("Unfold"), t("Unfold: flatten the picked bends (or all of them) with one flat face kept in place, so features can cut across them")],
  ["smfold", t("Fold"), t("Fold: bend unfolded bends back; cuts made across them wrap onto the bends")],
  ["smflat", t("Flatten"), t("Flatten: show the flat pattern, or fold it back")],
  ["smdxf", t("Flat pattern DXF"), t("Export the flat pattern with its bend lines as DXF")],
];

/** Default feature names (translated in the tree like the others). */
export const SM_BASES = ["Lofted-Bend", "Base-Flange", "Edge-Flange", "Hem", "Sketched-Bend", "Jog", "Tab", "Break-Corner", "Closed-Corner", "Corner-Relief", "Sheet-Metal-Gusset", "Cross-Break", "Vent", "Form-Tool", "Unfold", "Fold", "Miter-Flange", "Swept-Flange", "Flat-Pattern"];
export const SM_TREE_ICONS: Record<string, string> = { smbase: "▬", smloft: "⏢", smflange: "⌐", smhem: "⊃", smbend: "⌙", smjog: "⎍", smtab: "▭", smcorner: "◿", smclosed: "⌟", smrelief: "◳", smgusset: "◺", smcross: "⨯", smvent: "▦", smform: "◉", smunfold: "⤢", smfold: "⤡", smmiter: "⌐", smswept: "⌒", smflat: "▭" };

const S = (body: string) => `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
export const SM_ICONS: Record<string, string> = {
  smbase: S('<path d="M2 10l4-3h8l-4 3z" fill="currentColor" fill-opacity=".25"/><path d="M2 10v1.6l4-3M10 10v1.6l4-3"/>'),
  smloft: S('<path d="M2 13h12M4.5 4h7"/><path d="M2 13l2.5-9M14 13l-2.5-9M6 13l1-9M10 13l-1-9" stroke-dasharray="1.6 1.4"/>'),
  smflange: S('<path d="M2 12h8a2 2 0 0 0 2-2V3"/><path d="M2 14h8a4 4 0 0 0 4-4V3"/>'),
  smmiter: S('<path d="M2 13h6V8h5"/><path d="M8 13l3-3M13 8l-2 2" stroke-dasharray="1.6 1.4"/>'),
  smswept: S('<path d="M2 13h4a3 3 0 0 0 3-3V8a3 3 0 0 1 3-3h2"/>'),
  smhem: S('<path d="M2 6h10a2 2 0 0 1 0 4H6"/><path d="M2 4h10a4 4 0 0 1 0 8H6"/>'),
  smbend: S('<path d="M2 12h6l5-7"/><path d="M8 3v11" stroke-dasharray="1.6 1.4"/>'),
  smjog: S('<path d="M1.5 11h5l3-5h5"/><path d="M1.5 13h5.6l3-5h4.4"/>'),
  smcorner: S('<path d="M2 13h7l5-5V3"/><path d="M9 13l5-5" stroke-dasharray="1.6 1.4"/><path d="M9 13V8h5"/>'),
  smclosed: S('<path d="M3 3v10h10"/><path d="M5.5 3v7.5H13" stroke-dasharray="1.6 1.4"/><path d="M3 13l2.5-2.5"/>'),
  smrelief: S('<path d="M2 13h7V9h4V3"/><path d="M9 13v-4h4" stroke-dasharray="1.6 1.4"/><circle cx="11" cy="11" r="2.4"/>'),
  smgusset: S('<path d="M3 2v11h11"/><path d="M3 7l6 6" stroke-dasharray="1.6 1.4"/><path d="M3 9.5 6.5 13"/>'),
  smcross: S('<path d="M2 4h12v8H2z"/><path d="M2 4l12 8M14 4 2 12" stroke-dasharray="1.6 1.4"/>'),
  smvent: S('<rect x="2" y="3" width="12" height="10" rx="1"/><path d="M5 6h6M5 8h6M5 10h6"/>'),
  smform: S('<path d="M1.5 11h4a2.5 2.5 0 0 0 5 0h4"/><path d="M5.5 11 7 7h2l1.5 4" stroke-dasharray="1.6 1.4"/>'),
  smunfold: S('<path d="M2 12h6l5-6"/><path d="M8 12h6" stroke-dasharray="1.6 1.4"/><path d="M12.5 8.5l1.5 2.5"/>'),
  smfold: S('<path d="M2 12h12" stroke-dasharray="1.6 1.4"/><path d="M2 12h6l5-6"/><path d="M12 10.5l1-2.5"/>'),
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
  /** The face picked before the command, if any. */
  face?: FaceRef | null;
  hasBody: boolean;
  /** The sheet as the last rebuild left it. */
  sheet?: SheetState | null;
}

const usable = (s: SketchFeature) => !sketchProfile(s).error || (() => { const p = sketchPath(s); return !p.error && !p.closed; })();

/** A sketch holding just one line (for sketched bends and jogs). */
/** An open chain of lines (miter flange profiles). */
const lineChain = (s: SketchFeature) => { const p = sketchPath(s); return !p.error && !p.closed && p.segs.length > 0 && p.segs.every(x => x.kind === "line"); };
/** An open chain of lines joined by sharp corners or tangent arcs, starting and ending with a line (swept flange profiles). */
const sweptChain = (s: SketchFeature) => {
  const p = sketchPath(s);
  if (p.error || p.closed || !p.segs.length || p.segs[0].kind !== "line" || p.segs.at(-1)!.kind !== "line") return false;
  return p.segs.every((x, i) => x.kind === "line" || (x.kind === "arc" && p.segs[i - 1]?.kind === "line" && p.segs[i + 1]?.kind === "line"));
};
/** An open chain of lines and arcs (lofted bend profiles). */
const loftChain = (s: SketchFeature) => { const p = sketchPath(s); return !p.error && !p.closed && p.segs.length > 0 && p.segs.every(x => x.kind === "line" || x.kind === "arc"); };
const oneLine = (s: SketchFeature) => { const p = sketchPath(s); return !p.error && p.segs.length === 1 && p.segs[0].kind === "line"; };

/** A new sheet metal feature, or the message to show when it can't start yet. */
export function smDraft(type: "smbase" | "smloft" | "smflange" | "smhem" | "smbend" | "smjog" | "smcorner" | "smclosed" | "smrelief" | "smgusset" | "smcross" | "smvent" | "smform" | "smunfold" | "smfold" | "smmiter" | "smswept", c: DraftCtx): Feature | string {
  const base = c.doc.features.find(f => f.type === "smbase" || f.type === "smloft");
  if (type === "smloft") {
    if (base) return t("This part already has a base flange.");
    // The selected open profile first, then the last unused ones (sketch the two profiles, then Lofted-Bend).
    const open = c.sketches.filter(s => loftChain(s));
    const sel = c.selected ? open.find(s => s.id === c.selected) : undefined;
    const rest = open.filter(s => s !== sel && !c.used.has(s.id));
    const pick = sel ? [sel, rest.at(-1)] : rest.slice(-2);
    if (!pick[0] || !pick[1]) return t("Sketch two open profiles of lines and arcs on two planes first.");
    const [a, b] = c.sketches.indexOf(pick[0]) < c.sketches.indexOf(pick[1]) ? [pick[0], pick[1]] : [pick[1], pick[0]];
    return { id: c.id, type: "smloft", name: c.name("smloft"), sketch1: a.id, sketch2: b.id, thickness: { v: 2 }, radius: { v: 2 }, k: 0.5 } satisfies SmLoftFeature;
  }
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
  if (type === "smmiter") {
    const sel = c.selected ? c.sketches.find(s => s.id === c.selected && lineChain(s)) : undefined;
    const sk = sel ?? c.sketches.filter(s => !c.used.has(s.id) && lineChain(s)).at(-1);
    if (!sk) return t("Sketch the miter flange profile first: an open chain of lines on a plane square to an edge, starting at it.");
    return { id: c.id, type: "smmiter", name: c.name("smmiter"), sketch: sk.id, edges } satisfies SmMiterFeature;
  }
  if (type === "smswept") {
    const sel = c.selected ? c.sketches.find(s => s.id === c.selected && sweptChain(s)) : undefined;
    const sk = sel ?? c.sketches.filter(s => !c.used.has(s.id) && sweptChain(s)).at(-1);
    if (!sk) return t("Sketch the swept flange profile first: lines joined by tangent arcs on a plane square to an edge, starting at it.");
    return { id: c.id, type: "smswept", name: c.name("smswept"), sketch: sk.id, edges } satisfies SmMiterFeature;
  }
  if (type === "smvent") {
    const closed = (s: SketchFeature) => { try { ventLayout(s); return true; } catch { return false; } };
    const sel = c.selected ? c.sketches.find(s => s.id === c.selected && closed(s)) : undefined;
    const sk = sel ?? c.sketches.filter(s => !c.used.has(s.id) && closed(s)).at(-1);
    if (!sk) return t("Sketch the vent on a flat face first: a closed boundary, with lines for ribs and circles for spars.");
    return { id: c.id, type: "smvent", name: c.name("smvent"), sketch: sk.id, rib: { v: 2 }, spar: { v: 2 } } satisfies SmVentFeature;
  }
  if (type === "smunfold") {
    // A flat face picked first stays fixed; every bend unfolds until bends are picked (SolidWorks: Collect All Bends).
    const face = c.face && c.sheet && /:(top|bot)$/.test(c.face.name) && panelOfFace(c.sheet, c.face.name) ? c.face : undefined;
    return { id: c.id, type: "smunfold", name: c.name("smunfold"), ...(face ? { face } : {}), bends: [] } satisfies SmUnfoldFeature;
  }
  if (type === "smfold") {
    if (c.sheet && !c.sheet.unfold?.bends.length) return t("Unfold some bends first.");
    return { id: c.id, type: "smfold", name: c.name("smfold"), bends: [] } satisfies SmUnfoldFeature;
  }
  if (type === "smform") {
    // A face picked first gets one tool at the middle of its panel (SolidWorks: drop the tool on a face).
    const face = c.face && /:p\d+:(top|bot)$/.test(c.face.name) ? c.face : null;
    const pid = face ? face.name.replace(/:(top|bot)$/, "") : "";
    const panel = c.sheet?.panels.find(p => p.id === pid);
    let pts: [number, number][] = [];
    if (panel) {
      const poly = loopPolygon(panel.outer, 16);
      const xs = poly.map(p => p[0]), ys = poly.map(p => p[1]);
      pts = [[(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2]];
    }
    return { id: c.id, type: "smform", name: c.name("smform"), face: face ?? { name: "" }, ...formSizes("dimple", c.sheet?.T ?? 1), pts } satisfies SmFormFeature;
  }
  if (type === "smgusset") {
    // A bend face picked first holds the gusset (SolidWorks: pick the bend, the rib goes across it).
    const b = c.face && c.sheet ? bendOfFace(c.sheet, c.face.name) : undefined;
    const T = c.sheet?.T ?? 1;
    const set = b ? b.r * Math.tan(Math.min(b.angle, 3) / 2) : 0;
    return { id: c.id, type: "smgusset", name: c.name("smgusset"), bend: b?.id ?? "", depth: { v: Math.round(set + 2.5 * ((b?.r ?? T) + T)) }, width: { v: Math.round(30 * T) / 10 } } satisfies SmGussetFeature;
  }
  if (type === "smrelief") {
    // Every two-bend corner until corners are picked (SolidWorks: Collect all corners).
    if (c.sheet && !c.sheet.faceted && !reliefCorners(c.sheet).length) return t("The sheet has no corners where two bends meet.");
    return { id: c.id, type: "smrelief", name: c.name("smrelief"), corners: [], kind: "rect" } satisfies SmReliefFeature;
  }
  if (type === "smcross") return { id: c.id, type: "smcross", name: c.name("smcross"), faces: c.face && /:p\d+:(top|bot)$/.test(c.face.name) ? [c.face] : [], radius: { v: 0.5 }, angle: { v: Math.PI / 180 } } satisfies SmCrossFeature;
  if (type === "smclosed") return { id: c.id, type: "smclosed", name: c.name("smclosed"), faces: c.face && /:p\d+:(?!top$|bot$)[^:]+$/.test(c.face.name) ? [c.face] : [], kind: "overlap" } satisfies SmClosedFeature;
  if (type === "smcorner") return { id: c.id, type: "smcorner", name: c.name("smcorner"), edges: edges.filter(e => !e.faces.some(n => /:(top|bot)$/.test(n))), kind: "fillet", size: { v: 5 } } satisfies SmCornerFeature;
  if (type === "smflange") return { id: c.id, type: "smflange", name: c.name("smflange"), edges, length: { v: 20 }, angle: { v: Math.PI / 2 } } satisfies SmFlangeFeature;
  return { id: c.id, type: "smhem", name: c.name("smhem"), edges, kind: "closed", length: { v: 6 } } satisfies SmHemFeature;
}

const r1 = (x: number) => Math.round(x * 10) / 10;
/** Default sizes of a forming tool for a sheet of thickness T. */
export function formSizes(tool: FormTool, T: number): Pick<SmFormFeature, "tool" | "size" | "width" | "height" | "draft" | "angle"> {
  const d15 = { v: Math.PI / 12 }, a0 = { v: 0 };
  if (tool === "rib") return { tool, size: { v: r1(25 * T) }, width: { v: r1(5 * T) }, height: { v: r1(1.5 * T) }, draft: d15, angle: a0 };
  if (tool === "louver") return { tool, size: { v: r1(20 * T) }, width: { v: r1(6 * T) }, height: { v: r1(2.5 * T) }, angle: a0 };
  if (tool === "xhole") return { tool, size: { v: r1(5 * T) }, width: { v: r1(5 * T) }, height: { v: r1(2 * T) } };
  return { tool, size: { v: r1(8 * T) }, width: { v: r1(8 * T) }, height: { v: r1(2 * T) }, draft: d15 };
}

/** Why ✓ can't keep the draft yet (null: it can). */
export function smCheck(f: Feature): string | null {
  if (f.type === "smbase" && !f.sketch) return t("Pick a sketch for the base flange.");
  if (f.type === "smloft" && (!f.sketch1 || !f.sketch2 || f.sketch1 === f.sketch2)) return t("Pick two different sketches for the lofted bend.");
  if (f.type === "smtab" && !f.sketch) return t("Pick a closed sketch for the tab.");
  if ((f.type === "smbend" || f.type === "smjog") && !f.sketch) return t("Pick a sketch with the bend line.");
  if ((f.type === "smflange" || f.type === "smhem") && !f.edges.length) return t("Pick the edges for the flange.");
  if (f.type === "smmiter" && !f.sketch) return t("Pick a sketch with the miter flange profile.");
  if (f.type === "smswept" && !f.sketch) return t("Pick a sketch with the swept flange profile.");
  if ((f.type === "smmiter" || f.type === "smswept") && !f.edges.length) return t("Pick the edges for the flange.");
  if (f.type === "smcorner" && !f.edges.length) return t("Pick the corner edges to break.");
  if (f.type === "smclosed" && !f.faces.length) return t("Pick the end faces of the flanges to close.");
  if (f.type === "smvent" && !f.sketch) return t("Pick a sketch with the vent boundary.");
  if (f.type === "smcross" && !f.faces.length) return t("Pick the flat faces for the cross break.");
  if (f.type === "smgusset" && !f.bend) return t("Pick a bend for the gusset.");
  if (f.type === "smform" && !f.face.name) return t("Click a flat face of the sheet to place the forming tool.");
  if (f.type === "smform" && !f.pts.length) return t("Click the face to place the forming tool.");
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
  if (f.type === "smloft") {
    const open = k.sketches.filter(s => loftChain(s) || s.id === f.sketch1 || s.id === f.sketch2);
    const pick = (key: "sketch1" | "sketch2", label: string) => `<label class="pm-field"><span>${esc(label)}</span><select data-k="${key}">${open.map(s => `<option value="${s.id}"${s.id === f[key] ? " selected" : ""}>${esc(k.label(s.name))}</option>`).join("")}</select></label>`;
    const st = k.sheet, folds = st?.folds?.length;
    return {
      title: t("Lofted Bend"),
      body: group(t("Profiles"), pick("sketch1", t("Profile 1")) + pick("sketch2", t("Profile 2"))
        + help(t("Two open chains of lines and arcs, each on its own plane. Their ends are matched start to start; the sheet runs between them.")))
        + group(t("Manufacturing method"), `<label class="pm-field"><span>${esc(t("Facets per arc"))}</span><span class="pm-in"><input type="text" inputmode="numeric" data-sm="facets" value="${esc(String(f.facets ?? 8))}" spellcheck="false" /></span></label>`
          + help(t("Bent: the sheet is made of flat facets with sharp folds between them, drawn as bend lines in the flat pattern."))
          + (folds != null ? `<p class="pm-count" data-sm-folds>${esc(t("{n} fold|{n} folds", { n: folds }))}</p>` : ""))
        + group(t("Sheet metal parameters"), numField("thickness", t("Thickness"), f.thickness, "length") + chk("reverse", f.reverse, t("Reverse direction"))
          + numField("radius", t("Bend radius"), f.radius, "length")
          + `<label class="pm-field"><span>${esc(t("K-factor"))}</span><span class="pm-in"><input type="text" inputmode="decimal" data-sm="k" value="${esc(String(f.k ?? 0.5))}" spellcheck="false" /></span></label>`
          + help(t("The profiles are the sheet's inside face; the bend radius is used by flanges added later."))),
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
  if (f.type === "smmiter" || f.type === "smswept") {
    const swept = f.type === "smswept";
    const chains = k.sketches.filter(s => (swept ? sweptChain(s) : lineChain(s)) || s.id === f.sketch);
    return {
      title: swept ? t("Swept Flange") : t("Miter Flange"),
      body: group(t("Profile"), `<label class="pm-field"><span>${esc(t("Sketch"))}</span><select data-k="sketch">${chains.map(s => `<option value="${s.id}"${s.id === f.sketch ? " selected" : ""}>${esc(k.label(s.name))}</option>`).join("")}</select></label>`
        + help(swept ? t("Lines joined by tangent arcs on a plane square to an edge, starting at it. Each arc is a bend of its radius on the profile's side; sharp corners use the bend radius.")
          : t("An open chain of lines on a plane square to an edge, starting at it. Lengths run to the virtual sharps on the profile's side.")))
        + group(swept ? t("Flange parameters") : t("Miter parameters"), edgeList(f.edges) + numField("gap", t("Corner gap"), f.gap ?? { v: 0.1 }, "length")
          + help(t("The profile runs along every picked edge; flanges on edges that meet at a corner are mitred.")))
        + group(t("Custom bend radius"), `<label class="chk pm-chk"><input type="checkbox" data-sm="customR"${f.radius ? " checked" : ""} />${esc(t("Use custom bend radius"))}</label>` + (f.radius ? numField("radius", t("Bend radius"), f.radius, "length") : "")),
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
  if (f.type === "smcorner") {
    return {
      title: t("Break Corner"),
      body: group(t("Corner edges"), `<p class="pm-count" data-sm-edges>${esc(f.edges.length ? t("{n} edge|{n} edges", { n: f.edges.length }) : t("click the short edges across the thickness at outside corners"))}</p>`
        + (f.edges.length ? `<button class="btn small" data-sm="clear">${esc(t("Clear edges"))}</button>` : ""))
        + group(t("Break type"), sel("kind", t("Type"), [["chamfer", t("Chamfer")], ["fillet", t("Fillet")]], f.kind)
          + numField("size", f.kind === "fillet" ? t("Radius") : t("Distance"), f.size, "length")
          + help(t("The corner is cut in the outline of the flat face, so the flat pattern shows it too."))),
    };
  }
  if (f.type === "smgusset") {
    const mid = !f.at;
    return {
      title: t("Sheet Metal Gusset"),
      body: group(t("Position"), `<p class="pm-count" data-sm-bend>${esc(f.bend ? t("Picked bend") : t("click a bend of the sheet where the rib goes"))}</p>`
        + `<label class="chk pm-chk"><input type="checkbox" data-sm="gmid"${mid ? " checked" : ""} />${esc(t("Centre on the bend"))}</label>`
        + (mid ? "" : numField("at", t("Distance from the bend end"), f.at!, "length")))
        + group(t("Profile"), numField("depth", t("Profile length"), f.depth, "length") + numField("width", t("Gusset width"), f.width, "length")
          + help(t("The rib reaches the profile length along each face from the inside virtual sharp. It keeps the sheet's thickness, with the groove outside; the flat pattern leaves it out."))),
    };
  }
  if (f.type === "smrelief") {
    const all = k.sheet && !k.sheet.faceted ? reliefCorners(k.sheet) : [];
    const rows = all.map((c, i) => `<label class="chk pm-chk"><input type="checkbox" data-sm="rc:${esc(c.key)}"${!f.corners.length || f.corners.includes(c.key) ? " checked" : ""} />${esc(t("Corner {n}", { n: i + 1 }))}</label>`).join("");
    const ratio = !f.size;
    return {
      title: t("Corner Relief"),
      body: group(t("Corners"), `<p class="pm-count" data-sm-corners>${esc(f.corners.length ? t("{n} corner|{n} corners", { n: f.corners.length }) : t("All corners ({n})", { n: all.length }))}</p>` + rows
        + (f.corners.length ? `<button class="btn small" data-sm="clear">${esc(t("Collect all corners"))}</button>` : "")
        + help(t("Corners where two bends meet on one face. Click near a corner in the view to pick it.")))
        + group(t("Relief type"), sel("kind", t("Type"), [["rect", t("Rectangular")], ["circle", t("Circular")], ["tear", t("Tear")]], f.kind)
          + `<label class="chk pm-chk"><input type="checkbox" data-sm="useRatio"${ratio ? " checked" : ""} />${esc(t("Use relief ratio"))}</label>`
          + (ratio ? `<label class="pm-field"><span>${esc(t("Relief ratio"))}</span><span class="pm-in"><input type="text" inputmode="decimal" data-sm="rratio" value="${esc(String(f.ratio ?? 0.5))}" spellcheck="false" /></span></label>`
            : numField("size", f.kind === "tear" ? t("Radius") : t("Clearance"), f.size!, "length"))
          + help(f.kind === "tear" ? t("A round tear at the inside corner; with the ratio its radius is the ratio × thickness.")
            : t("Rectangular: over both bend zones, the clearance past them. Circular: centred where the bend centre lines cross. With the ratio the clearance is the ratio × thickness."))),
    };
  }
  if (f.type === "smclosed") {
    return {
      title: t("Closed Corner"),
      body: group(t("Faces to extend"), `<p class="pm-count" data-sm-faces>${esc(f.faces.length ? t("{n} face|{n} faces", { n: f.faces.length }) : t("click the end faces of flanges at the corners"))}</p>`
        + (f.faces.length ? `<button class="btn small" data-sm="clear">${esc(t("Clear faces"))}</button>` : ""))
        + group(t("Corner type"), sel("kind", t("Type"), [["overlap", t("Overlap")], ["underlap", t("Underlap")]], f.kind)
          + numField("gap", t("Gap distance"), f.gap ?? { v: 0.1 }, "length")
          + help(t("Overlap: the picked flange runs over the other flange's end. Underlap: it stops at the other flange, the gap short of it. The other flange's end moves to meet it."))),
    };
  }
  if (f.type === "smvent") {
    const ok = (s: SketchFeature) => { try { ventLayout(s); return true; } catch { return false; } };
    const list = k.sketches.filter(s => ok(s) || s.id === f.sketch);
    const sk = k.sketches.find(s => s.id === f.sketch);
    let info = "";
    try { if (sk) { const l = ventLayout(sk); info = `${t("Ribs: {n}", { n: l.ribs.length })}, ${t("Spars: {n}", { n: l.spars.length })}`; } } catch { /* the rebuild says what is wrong */ }
    return {
      title: t("Vent"),
      body: group(t("Boundary"), `<label class="pm-field"><span>${esc(t("Sketch"))}</span><select data-k="sketch">${list.map(s => `<option value="${s.id}"${s.id === f.sketch ? " selected" : ""}>${esc(k.label(s.name))}</option>`).join("")}</select></label>`
        + (info ? `<p class="pm-count" data-sm-vent>${esc(info)}</p>` : "")
        + help(t("One sketch on a flat face: the largest closed loop is the boundary, lines ending on it are ribs and circles inside are spars.")))
        + group(t("Ribs"), numField("rib", t("Rib width"), f.rib, "length"))
        + group(t("Spars"), numField("spar", t("Spar width"), f.spar, "length")),
    };
  }
  if (f.type === "smform") {
    const n = (x: number) => esc(String(+(x * k.f).toFixed(4)));
    const rows = f.pts.map((p, i) => `<div class="pm-row sm-pt" data-sm-pt="${i}"><span class="muted">${i + 1}</span>`
      + `<label class="pm-field"><span>X</span><span class="pm-in"><input type="text" inputmode="decimal" data-sm="px:${i}" value="${n(p[0])}" aria-label="X ${i + 1}" spellcheck="false" /></span></label>`
      + `<label class="pm-field"><span>Y</span><span class="pm-in"><input type="text" inputmode="decimal" data-sm="py:${i}" value="${n(p[1])}" aria-label="Y ${i + 1}" spellcheck="false" /></span></label>`
      + `<button class="btn small" data-sm="rm:${i}" title="${esc(t("Remove"))}" aria-label="${esc(t("Remove"))}">✕</button></div>`).join("");
    const tool = f.tool;
    const long = tool === "rib" || tool === "louver";
    return {
      title: t("Forming Tool"),
      body: group(t("Forming tool"), sel("tool", t("Type"), [["dimple", t("Dimple")], ["rib", t("Embossed rib")], ["louver", t("Louver")], ["xhole", t("Extruded hole")]], tool)
        + chk("flip", f.flip, t("Reverse direction")))
        + group(t("Position"), `<p class="pm-count" data-sm-faces>${esc(f.face.name ? t("{n} tool|{n} tools", { n: f.pts.length }) : t("click a flat face of the sheet (top or bottom)"))}</p>`
          + rows + (f.pts.length ? `<button class="btn small" data-sm="clear">${esc(t("Clear positions"))}</button>` : "")
          + help(t("Click the face to add a tool there. X and Y are the face's flat pattern coordinates.")))
        + group(t("Size"), numField("size", tool === "dimple" ? t("Diameter") : tool === "xhole" ? t("Hole diameter") : t("Length"), f.size, "length")
          + (long ? numField("width", t("Width"), f.width, "length") : "")
          + numField("height", t("Height"), f.height, "length")
          + (tool === "dimple" || tool === "rib" ? numField("draft", t("Draft angle"), f.draft ?? { v: 0 }, "angle") : "")
          + (long ? numField("angle", t("Rotation angle"), f.angle ?? { v: 0 }, "angle") : "")
          + help(t("The form keeps the sheet's thickness and stands out of the picked face. The flat pattern leaves it out and marks its outline; an extruded hole leaves its pre-pierce hole."))),
    };
  }
  if (f.type === "smunfold" || f.type === "smfold") {
    const unf = f.type === "smunfold";
    const bends = `<p class="pm-count" data-sm-bends>${esc(f.bends.length ? t("{n} bend|{n} bends", { n: f.bends.length }) : unf ? t("All bends") : t("All unfolded bends"))}</p>`
      + (f.bends.length ? `<button class="btn small" data-sm="clear">${esc(unf ? t("Collect all bends") : t("All unfolded bends"))}</button>` : "");
    return {
      title: unf ? t("Unfold") : t("Fold"),
      body: (unf ? group(t("Fixed face"), `<p class="pm-count" data-sm-faces>${esc(f.face ? t("Picked face") : t("The first face of the sheet; click a flat face to keep it in place"))}</p>`
        + (f.face ? `<button class="btn small" data-sm="fclear">${esc(t("Use the first face"))}</button>` : "")) : "")
        + group(unf ? t("Bends to unfold") : t("Bends to fold"), bends
          + help(unf ? t("Click bends in the view to unfold only those. Cut across the flat bends with ordinary features, then add a Fold.")
            : t("Click bends in the view to fold only those. Cuts made across them while flat wrap onto the bends; lengths on the neutral surface are kept."))),
    };
  }
  if (f.type === "smcross") {
    return {
      title: t("Cross Break"),
      body: group(t("Faces"), `<p class="pm-count" data-sm-faces>${esc(f.faces.length ? t("{n} face|{n} faces", { n: f.faces.length }) : t("click flat faces of the sheet (top or bottom)"))}</p>`
        + (f.faces.length ? `<button class="btn small" data-sm="clear">${esc(t("Clear faces"))}</button>` : ""))
        + group(t("Break parameters"), numField("radius", t("Break radius"), f.radius, "length") + numField("angle", t("Break angle"), f.angle, "angle")
          + chk("flip", f.flip, t("Reverse direction"))
          + help(t("Two lines from corner to corner of each face, raised towards the picked side. The break is drawn on the model and the flat pattern; the solid stays flat."))),
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
export function bindSmPanel(pm: HTMLElement, f: SheetFeature, upd: (fn: () => void, structural?: boolean) => void, dxf: () => void, toastBad: (msg: string) => void, unitF = 1, T = 1) {
  pm.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("[data-sm]").forEach(el => {
    const key = el.dataset.sm!;
    if (el instanceof HTMLButtonElement) {
      el.addEventListener("click", () => {
        if (key === "dxf") dxf();
        if (key === "clear" && (f.type === "smflange" || f.type === "smhem" || f.type === "smcorner" || f.type === "smmiter" || f.type === "smswept")) upd(() => { f.edges = []; }, true);
        if (key === "clear" && (f.type === "smclosed" || f.type === "smcross")) upd(() => { f.faces = []; }, true);
        if (key === "clear" && f.type === "smform") upd(() => { f.pts = []; }, true);
        if (key === "clear" && (f.type === "smunfold" || f.type === "smfold")) upd(() => { f.bends = []; }, true);
        if (key === "clear" && f.type === "smrelief") upd(() => { f.corners = []; }, true);
        if (key === "fclear" && f.type === "smunfold") upd(() => { delete f.face; }, true);
        if (key.startsWith("rm:") && f.type === "smform") upd(() => { f.pts.splice(Number(key.slice(3)), 1); }, true);
      });
      return;
    }
    el.addEventListener("change", () => {
      const val = el instanceof HTMLInputElement && el.type === "checkbox" ? el.checked : el.value;
      if (f.type === "smloft") {
        const v = Number(String(val).replace(",", "."));
        const ok = key === "k" ? v >= 0 && v <= 1 : Number.isInteger(v) && v >= 1 && v <= 64;
        if (!Number.isFinite(v) || !ok) { el.setAttribute("aria-invalid", "true"); toastBad(key === "k" ? t("The K-factor must be between 0 and 1.") : t("Use a whole number of facets from 1 to 64.")); return; }
        el.removeAttribute("aria-invalid");
        upd(() => { if (key === "k") f.k = v; else if (v === 8) delete f.facets; else f.facets = v; });
        return;
      }
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
      if (f.type === "smmiter" || f.type === "smswept") {
        if (key === "customR") upd(() => { if (val) f.radius = { v: 2 }; else delete f.radius; }, true);
        return;
      }
      if (f.type === "smform") {
        if (key === "tool") { upd(() => { Object.assign(f, formSizes(val as FormTool, T)); if (val === "xhole" || val === "dimple") delete f.angle; if (val === "louver" || val === "xhole") delete f.draft; }, true); return; }
        const m = /^p([xy]):(\d+)$/.exec(key);
        if (m) {
          const v = Number(String(val).replace(",", ".")) / unitF;
          if (!Number.isFinite(v)) { el.setAttribute("aria-invalid", "true"); toastBad(t("Not a number")); return; }
          el.removeAttribute("aria-invalid");
          upd(() => { const p = f.pts[Number(m[2])]; if (p) p[m[1] === "x" ? 0 : 1] = v; });
        }
        return;
      }
      if (f.type === "smgusset") {
        if (key === "gmid") upd(() => { if (val) delete f.at; else f.at = { v: 10 }; }, true);
        return;
      }
      if (f.type === "smrelief") {
        if (key === "kind") upd(() => { f.kind = val === "circle" ? "circle" : val === "tear" ? "tear" : "rect"; }, true);
        if (key === "useRatio") upd(() => { if (val) delete f.size; else f.size = { v: +((f.ratio ?? 0.5) * T).toFixed(3) }; }, true);
        if (key === "rratio") {
          const v = Number(String(val).replace(",", "."));
          if (!Number.isFinite(v) || !(v > 0 && v <= 10)) { el.setAttribute("aria-invalid", "true"); toastBad(t("The value must be more than 0.")); return; }
          el.removeAttribute("aria-invalid");
          upd(() => { if (v === 0.5) delete f.ratio; else f.ratio = v; });
        }
        if (key.startsWith("rc:")) {
          const keys = [...pm.querySelectorAll<HTMLInputElement>('[data-sm^="rc:"]')];
          // Ticked boxes are the corners; all of them ticked (or none) means every corner.
          const on = keys.filter(x => x.checked).map(x => x.dataset.sm!.slice(3));
          upd(() => { f.corners = on.length === keys.length ? [] : on; }, true);
        }
        return;
      }
      if (f.type === "smclosed") {
        if (key === "kind") upd(() => { f.kind = val === "underlap" ? "underlap" : "overlap"; });
        return;
      }
      if (f.type === "smcorner") {
        if (key === "kind") upd(() => { f.kind = val === "chamfer" ? "chamfer" : "fillet"; }, true);
        return;
      }
      if (f.type === "smhem") {
        if (key === "kind") upd(() => { f.kind = val as SmHemFeature["kind"]; if (f.kind === "open") f.gap ??= { v: 1 }; else delete f.gap; }, true);
        if (key === "position") upd(() => { if (val === "outside") f.position = "outside"; else delete f.position; });
      }
    });
  });
}
