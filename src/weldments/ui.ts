// Weldments in the part modeller (FR-FT-121): the Weldments ▾ commands, their PropertyManager panels,
// picking in the view, and the cut list dialog. The controller calls these through a small context.
import type { FaceRef, Feature, Num, PartDoc, SketchFeature, Sketch3dFeature, V3 } from "../model/types";
import type { Rebuild } from "../model/kernelClient";
import { t } from "../i18n";
import { toast } from "../ui";
import { featureLabel } from "../model/controller";
import { units, UNITS } from "../tools/units";
import { ANCHORS, PROFILE_TYPES, profileSizes, type Anchor, type ProfileType } from "./profiles";
import { sketchProfile } from "../sketch/profile";
import type { CutItem, EndCapFeature, GussetFeature, MemberFeature, MemberGroup, TrimExtendFeature, WeldBeadFeature, WeldFeature, WeldSegRef } from "./types";
import { cornerKey } from "./types";

export type WeldTool = "member" | "trimext" | "endcap" | "gusset" | "weldbead";
export const WELD_TOOL_SET: ReadonlySet<string> = new Set(["member", "trimext", "endcap", "gusset", "weldbead"]);
export const isWeldFeature = (f: Feature): f is WeldFeature => WELD_TOOL_SET.has(f.type);

/** What the weldment UI needs from the controller. */
export interface WeldCtx {
  doc: PartDoc;
  /** Features before the one being edited. */
  before: Feature[];
  selected: string | null;
  last: Rebuild | null;
  faceAt(x: number, y: number): { faceId: number; point: V3 } | null;
  faceRef(faceId: number): FaceRef | null;
  faceType(faceId: number): string | undefined;
  changed(): void;
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const S = (d: string) => `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

/** Weldments ▾ (the last item opens the cut list). */
export const WELD_TOOLS = (): [string, string, string][] => [
  ["member", t("Structural Member"), t("Structural member: a standard profile along sketch lines, with mitred or butted corners")],
  ["trimext", t("Trim/Extend"), t("Trim/Extend: cut members back to, or lengthen them up to, a face or another body")],
  ["endcap", t("End Cap"), t("End cap: a plate closing the open end of a member")],
  ["gusset", t("Gusset"), t("Gusset: a corner plate between two flat faces that meet")],
  ["weldbead", t("Fillet Bead"), t("Fillet weld bead where two sets of faces meet")],
  ["cutlist", t("Cut List…"), t("Cut list: members with lengths and end angles, plates and welds, with quantities and mass")],
];

export const WELD_ICONS: Record<string, string> = {
  member: S('<path d="M2 13L13 2"/><path d="M4 14l10-10M2 11l9-9"/><rect x="1.5" y="10.5" width="4" height="4" fill="currentColor" fill-opacity=".25"/>'),
  trimext: S('<path d="M11 2v12"/><path d="M2 6h7M2 10h7"/><path d="M9 6l2 2-2 2" stroke-dasharray="1.5 1.2"/>'),
  endcap: S('<path d="M2 5h8v6H2"/><path d="M10 3.5h3v9h-3z" fill="currentColor" fill-opacity=".3"/>'),
  gusset: S('<path d="M3 2v12h11"/><path d="M3 6l0 8h8z" fill="currentColor" fill-opacity=".3"/>'),
  weldbead: S('<path d="M2 14h12M6 14V2"/><path d="M6 10l4 4H6z" fill="currentColor" fill-opacity=".45"/>'),
  cutlist: S('<path d="M3 3h10M3 6.5h10M3 10h10M3 13.5h6"/>'),
};

/** Sketches and 3D sketches with lines (member paths), before the edited feature. */
function pathSketches(ctx: WeldCtx): (SketchFeature | Sketch3dFeature)[] {
  return ctx.before.filter((x): x is SketchFeature | Sketch3dFeature => (x.type === "sketch" && x.ents.some(e => (e.t === "line" || e.t === "arc") && !e.cons)) || (x.type === "sketch3d" && x.segs.some(s => s.t === "line")));
}
/** A path sketch's usable lines and arcs (construction geometry is left out). */
function pathLines(sk: SketchFeature | Sketch3dFeature): string[] {
  return sk.type === "sketch" ? sk.ents.filter(e => (e.t === "line" || e.t === "arc") && !e.cons).map(e => e.id) : sk.segs.filter(s => s.t === "line").map(s => s.id);
}
/** "Line 2" or "Arc 3": a path segment as the panel names it (numbered in the sketch's order). */
function segLabel(sk: SketchFeature | Sketch3dFeature, ent: string): string {
  const n = pathLines(sk).indexOf(ent) + 1;
  return sk.type === "sketch" && sk.ents.find(e => e.id === ent)?.t === "arc" ? t("Arc {n}", { n }) : t("Line {n}", { n });
}

/** The corners between a member's segments: the segments that share an end point, by the sketch's point ids. */
function memberCorners(sk: SketchFeature | Sketch3dFeature, ents: string[]): string[][] {
  const at = new Map<string, string[]>();
  for (const ent of ents) {
    const ends = sk.type === "sketch"
      ? (() => { const e = sk.ents.find(x => x.id === ent); return e?.t === "line" || e?.t === "arc" ? [e.a, e.b] : []; })()
      : sk.segs.find(x => x.id === ent)?.pts.slice(0, 2) ?? [];
    for (const p of ends) at.set(p, [...(at.get(p) ?? []), ent]);
  }
  return [...at.values()].filter(l => l.length > 1);
}

/** 2D sketches with a closed region (custom member profiles), before the edited feature; not the path sketch. */
function profileSketches(ctx: WeldCtx, path?: string): SketchFeature[] {
  return ctx.before.filter((x): x is SketchFeature => x.type === "sketch" && x.id !== path && !x.suppressed && sketchProfile(x).faces.length > 0);
}

/** A new weldment feature with sensible picks (FR-FT-121). */
export function weldDraft(ctx: WeldCtx, type: WeldTool, id: string, name: string, face: number | null): Feature | null {
  const fr = face != null ? ctx.faceRef(face) : null;
  if (type === "member") {
    const paths = pathSketches(ctx);
    // The selected sketch, else the last 3D sketch or sketch with lines (SolidWorks: sketch the frame, then Structural Member).
    const sk = paths.find(s => s.id === ctx.selected) ?? paths.at(-1);
    if (!sk) { toast(t("Draw a sketch or a 3D sketch with lines first: the members run along them."), true); return null; }
    return { id, type, name, profile: "shs", size: "40x40x3", segs: pathLines(sk).map(ent => ({ sketch: sk.id, ent })), corner: "miter" } satisfies MemberFeature;
  }
  if (!ctx.last?.data) { toast(t("There is no body yet."), true); return null; }
  if (type === "trimext") return { id, type, name, bodies: fr && memberFace(ctx, fr.name) ? [fr] : [], kind: "face" } satisfies TrimExtendFeature;
  const flat = fr && face != null && ctx.faceType(face) === "plane" ? fr : null;
  if (type === "endcap") return { id, type, name, faces: flat ? [flat] : [], thickness: { v: 5 }, inset: { v: 0 } } satisfies EndCapFeature;
  if (type === "gusset") return { id, type, name, face1: flat ?? undefined, d1: { v: 50 }, d2: { v: 50 }, thickness: { v: 5 }, shape: "tri", loc: "mid" } satisfies GussetFeature;
  return { id, type, name, faces1: flat ? [flat] : [], faces2: [], size: { v: 4 } } satisfies WeldBeadFeature;
}

/** Which box a new weldment feature's view clicks fill first. */
export function weldFocus(f: Feature): string | undefined {
  if (f.type === "trimext") return f.bodies.length ? "wbound" : "wbodies";
  if (f.type === "endcap") return "wfaces";
  if (f.type === "gusset" || f.type === "weldbead") return (f.type === "gusset" ? f.face1 : f.faces1.length) ? "wf2" : "wf1";
  return undefined;
}

/** What is still missing before ✓, as an English message key (null: ready). */
export function weldMissing(f: Feature): string | null {
  if (f.type === "member" && !f.segs.length) return "Pick the sketch lines the member runs along.";
  if (f.type === "member" && f.profile === "sketch" && !f.psketch) return "Pick a closed sketch for the profile.";
  if (f.type === "trimext" && !f.bodies.length) return "Pick the member bodies to trim.";
  if (f.type === "trimext" && !f.boundary) return "Pick the boundary: a flat face or a body.";
  if (f.type === "endcap" && !f.faces.length) return "Pick the end faces of members to cap.";
  if (f.type === "gusset" && (!f.face1 || !f.face2)) return "Pick two flat faces that meet at a corner.";
  if (f.type === "weldbead" && (!f.faces1.length || !f.faces2.length)) return "Pick the faces of set 1 and set 2: the bead runs where they meet.";
  return null;
}

/** A face of a structural member body: the member's id and the segment. */
function memberFace(ctx: WeldCtx, name: string): { id: string; ent: string } | null {
  const [id, ent] = name.split(":");
  const f = ctx.doc.features.find(x => x.id === id);
  return f?.type === "member" && f.segs.some(s => s.ent === ent) ? { id, ent } : null;
}

const ANCHOR_LABEL: Record<Anchor, string> = { tl: "Top left", t: "Top centre", tr: "Top right", l: "Middle left", c: "Centre", r: "Middle right", bl: "Bottom left", b: "Bottom centre", br: "Bottom right" };

type Field = (key: string, label: string, n: Num, q: "length" | "angle") => string;
type Chk = (k: string, on: boolean | undefined, label: string) => string;
type Group = (legend: string, inner: string) => string;

/** The PropertyManager of a weldment feature. */
export function weldPanel(f: WeldFeature, ctx: WeldCtx, focus: string | undefined, group: Group, numField: Field, chk: Chk): { title: string; body: string } {
  const sel = (k: string, label: string, opts: [string, string][], cur: string) => `<label class="pm-field"><span>${esc(label)}</span><select data-k="${k}">${opts.map(([v, l]) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label>`;
  const box = (fo: string, label: string, value: string) => `<div class="pm-field"><span>${esc(label)}</span><button class="pm-box${focus === fo ? " focus" : ""}" data-focus="${fo}" translate="no">${esc(value)}</button></div>`;
  const faces = (n: number) => t("{n} face|{n} faces", { n });
  const help = (s: string) => `<p class="pm-help muted">${esc(s)}</p>`;
  if (f.type === "member") {
    const paths = pathSketches(ctx);
    const cur = f.segs[0]?.sketch ?? "";
    const sk = paths.find(s => s.id === cur);
    const lines = sk ? pathLines(sk) : [];
    const on = new Set(f.segs.map(s => s.ent));
    const corners = sk ? memberCorners(sk, f.segs.map(x => x.ent)) : [];
    const groups = f.groups ?? [];
    const gOf = (ent: string) => groups.findIndex(g => g.ents.includes(ent)) + 1;
    const gSel = (ent: string) => f.segs.length < 2 ? "" : `<select data-k="wgroup:${esc(ent)}" aria-label="${esc(t("Group of {seg}", { seg: segLabel(sk!, ent) }))}">${Array.from({ length: groups.length + 1 }, (_, i) => `<option value="${i}"${gOf(ent) === i ? " selected" : ""}>${esc(t("Group {n}", { n: i + 1 }))}</option>`).join("")}<option value="new">${esc(t("New group"))}</option></select>`;
    const segList = lines.map(ent => `<div class="wseg-row"><label class="chk pm-chk"><input type="checkbox" data-wseg="${esc(ent)}"${on.has(ent) ? " checked" : ""} />${esc(segLabel(sk!, ent))}</label>${on.has(ent) ? gSel(ent) : ""}</div>`).join("");
    const anchorOpts: [string, string][] = [...(f.profile === "sketch" ? [["o", t("Sketch origin")] as [string, string]] : []), ...ANCHORS.map((a): [string, string] => [a, t(ANCHOR_LABEL[a])])];
    const defAnchor = f.profile === "sketch" ? "o" : "c";
    const groupBoxes = groups.map((g, i) => group(t("Group {n}", { n: i + 2 }),
      `<p class="pm-count">${esc(g.ents.map(e => segLabel(sk!, e)).join(", "))}</p>`
      + sel(`wganchor:${i}`, t("Profile position"), anchorOpts, g.anchor ?? defAnchor)
      + numField(`groups.${i}.angle`, t("Rotation angle"), g.angle ?? { v: 0 }, "angle")
      + chk(`wgmirror:${i}`, g.mirror, t("Mirror profile")))).join("");
    return {
      title: t("Structural Member"),
      body: group(t("Selections"), sel("wtype", t("Type"), [...PROFILE_TYPES.map(([v, l]): [string, string] => [v, t(l)]), ["sketch", t("Custom profile (sketch)")]], f.profile)
        + (f.profile === "sketch"
          ? sel("wpsketch", t("Profile sketch"), [["", t("None")], ...profileSketches(ctx, cur).map((s): [string, string] => [s.id, featureLabel(s.name)])], f.psketch ?? "")
            + help(t("A closed sketch drawn at the origin: its largest region is the profile, the sketch origin sits on the path."))
          : `<label class="pm-field"><span>${esc(t("Size"))}</span><select data-k="wsize" translate="no">${profileSizes(f.profile).map(s => `<option${s === f.size ? " selected" : ""}>${esc(s)}</option>`).join("")}</select></label>`))
        + group(t("Path segments"), sel("wsketch", t("Sketch"), paths.map(s => [s.id, featureLabel(s.name)]), cur)
          + `<p class="pm-count">${esc(t("{n} segment|{n} segments", { n: f.segs.length }))}</p>${segList}`
          + help(t("Each segment becomes its own body; where two segments meet end to end the corner is treated.")))
        + group(t("Settings"), sel("corner", t("Corner treatment"), [["miter", t("End miter")], ["butt1", t("End butt 1")], ["butt2", t("End butt 2")], ["none", t("None")]], f.corner)
          + chk("wGap", (f.gap?.v ?? 0) > 0, t("Weld gap")) + ((f.gap?.v ?? 0) > 0 ? numField("gap", t("Gap"), f.gap!, "length") : "")
          + (groups.length ? `<p class="pm-count">${esc(t("Group {n}", { n: 1 }))}</p>` : "")
          + sel("anchor", t("Profile position"), anchorOpts, f.anchor ?? defAnchor)
          + numField("angle", t("Rotation angle"), f.angle ?? { v: 0 }, "angle")
          + chk("mirror", f.mirror, t("Mirror profile"))
          + (f.segs.length > 1 && !groups.length ? help(t("To place some segments' profile differently, put them in a new group with the list above.")) : ""))
        + groupBoxes
        + (corners.length ? group(t("Corners"), corners.map(c => {
          const key = cornerKey(c);
          const label = c.map(ent => segLabel(sk!, ent)).join(" / ");
          const opts: [string, string][] = [["", t("As set above")], ...(c.length === 2 ? [["miter", t("End miter")] as [string, string]] : []), ["butt1", t("End butt 1")], ["butt2", t("End butt 2")], ["none", t("None")]];
          return sel(`wcorner:${key}`, label, opts, f.corners?.[key] ?? "");
        }).join("") + help(t("A corner set here keeps its own treatment when the one above changes."))) : "")
        + group(t("Cut list"), `<label class="pm-field"><span>${esc(t("Description"))}</span><input type="text" data-k="wdesc" value="${esc(f.desc ?? "")}" placeholder="${esc(f.profile === "sketch" ? t("Profile sketch") : f.size)}" /></label>`),
    };
  }
  if (f.type === "trimext") {
    return {
      title: t("Trim/Extend"),
      body: group(t("Corner type"), sel("wkind", t("Trim to"), [["face", t("Face or plane")], ["body", t("Body")]], f.kind))
        + group(t("Bodies to be trimmed"), box("wbodies", t("Bodies"), t("{n} body|{n} bodies", { n: f.bodies.length }))
          + (f.bodies.length ? `<button class="btn small" data-k="wclear" data-wlist="bodies">${esc(t("Clear selections"))}</button>` : "")
          + help(t("Click faces of the members to trim or extend.")))
        + group(t("Trimming boundary"), box("wbound", f.kind === "face" ? t("Face") : t("Body"), f.boundary ? t("Picked") : t("None"))
          + chk("allowExt", !f.noExtend, t("Allow extension"))
          + help(f.kind === "face" ? t("Click a flat face: members are cut at its plane, or lengthened up to it.") : t("Click any face of the body the members stop at."))),
    };
  }
  if (f.type === "endcap") {
    return {
      title: t("End Cap"),
      body: group(t("Parameters"), box("wfaces", t("Faces"), faces(f.faces.length))
        + (f.faces.length ? `<button class="btn small" data-k="wclear" data-wlist="faces">${esc(t("Clear faces"))}</button>` : "")
        + numField("thickness", t("Thickness"), f.thickness, "length")
        + chk("inward", f.inward, t("Thickness inward"))
        + help(t("Click the flat end faces of members. Drag the arrow to change the thickness.")))
        + group(t("Offset"), chk("wInset", f.inset.v > 0, t("Inset from the edges")) + (f.inset.v > 0 ? numField("inset", t("Inset"), f.inset, "length") : ""))
        + group(t("Corner treatment"), chk("wChamfer", !!f.chamfer, t("Chamfer corners")) + (f.chamfer ? numField("chamfer", t("Distance"), f.chamfer, "length") : "")),
    };
  }
  if (f.type === "gusset") {
    return {
      title: t("Gusset"),
      body: group(t("Supporting faces"), box("wf1", t("Face 1"), f.face1 ? t("Picked") : t("None")) + box("wf2", t("Face 2"), f.face2 ? t("Picked") : t("None"))
        + help(t("Click two flat faces that meet at a corner, such as a beam and a post.")))
        + group(t("Profile"), sel("wshape", t("Shape"), [["tri", t("Triangular")], ["poly", t("Polygonal")]], f.shape)
          + numField("d1", t("Length along face 1"), f.d1, "length") + numField("d2", t("Length along face 2"), f.d2, "length")
          + (f.shape === "poly" ? numField("d3", t("End width"), f.d3 ?? { v: 10 }, "length") : "")
          + numField("thickness", t("Thickness"), f.thickness, "length")
          + chk("wChamfer", !!f.chamfer, t("Chamfer the inner corner")) + (f.chamfer ? numField("chamfer", t("Distance"), f.chamfer, "length") : ""))
        + group(t("Location"), sel("wloc", t("Location"), [["mid", t("Mid point")], ["start", t("Start")], ["end", t("End")]], f.loc)),
    };
  }
  return {
    title: t("Fillet Bead"),
    body: group(t("Settings"), numField("size", t("Bead size"), f.size, "length") + chk("wTangent", f.tangent !== false, t("Tangent propagation")))
      + group(t("Face set 1"), box("wf1", t("Faces"), faces(f.faces1.length)) + (f.faces1.length ? `<button class="btn small" data-k="wclear" data-wlist="faces1">${esc(t("Clear faces"))}</button>` : ""))
      + group(t("Face set 2"), box("wf2", t("Faces"), faces(f.faces2.length)) + (f.faces2.length ? `<button class="btn small" data-k="wclear" data-wlist="faces2">${esc(t("Clear faces"))}</button>` : "")
        + help(t("Click flat or cylindrical faces: the bead runs along the straight and round edges where set 1 meets set 2. With tangent propagation it follows on round corners."))),
  };
}

/** Store a member's groups: empty groups dropped, none left = no `groups`. */
function setGroups(f: MemberFeature, gs: MemberGroup[]) {
  const kept = gs.filter(g => g.ents.length);
  if (kept.length) f.groups = kept; else delete f.groups;
}

/** A panel field of a weldment feature changed: the change to make (null: the controller's default handling). */
export function weldChange(f: WeldFeature, k: string, val: string | boolean, ctx: WeldCtx): (() => void) | null {
  if (f.type === "member") {
    if (k === "wtype") return () => {
      if (val === "sketch") {
        f.profile = "sketch";
        f.psketch ??= profileSketches(ctx, f.segs[0]?.sketch).at(-1)?.id;
        delete f.anchor;
        return;
      }
      if (f.profile === "sketch") delete f.anchor;
      f.profile = val as ProfileType;
      const sizes = profileSizes(f.profile);
      if (!sizes.includes(f.size)) f.size = sizes[Math.min(sizes.length - 1, Math.floor(sizes.length / 3))];
    };
    if (k === "wpsketch") return () => { if (val) f.psketch = String(val); else delete f.psketch; };
    if (k === "wsize") return () => { f.size = String(val); };
    if (k === "wsketch") return () => { const sk = pathSketches(ctx).find(s => s.id === val); f.segs = sk ? pathLines(sk).map(ent => ({ sketch: sk.id, ent })) : []; delete f.groups; };
    if (k === "corner") return () => { f.corner = val as MemberFeature["corner"]; };
    if (k.startsWith("wcorner:")) return () => {
      const key = k.slice(8), c = { ...f.corners };
      if (val) c[key] = val as MemberFeature["corner"]; else delete c[key];
      if (Object.keys(c).length) f.corners = c; else delete f.corners;
    };
    if (k === "wGap") return () => { if (val) f.gap = { v: 2 }; else delete f.gap; };
    if (k === "wdesc") return () => { const s = String(val).trim(); if (s) f.desc = s; else delete f.desc; };
    if (k === "anchor") return () => { if (val === (f.profile === "sketch" ? "o" : "c")) delete f.anchor; else f.anchor = val as Anchor; };
    if (k.startsWith("wgroup:")) return () => {
      const ent = k.slice(7), gs = (f.groups ?? []).map(g => ({ ...g, ents: g.ents.filter(e => e !== ent) }));
      if (val === "new") gs.push({ ents: [ent], ...(f.anchor ? { anchor: f.anchor } : {}), ...(f.angle ? { angle: { ...f.angle } } : {}), ...(f.mirror ? { mirror: true } : {}) });
      else if (+val > 0) gs[+val - 1]?.ents.push(ent);
      setGroups(f, gs);
    };
    if (k.startsWith("wganchor:")) return () => { const g = f.groups?.[+k.slice(9)]; if (!g) return; if (val === (f.profile === "sketch" ? "o" : "c")) delete g.anchor; else g.anchor = val as Anchor; };
    if (k.startsWith("wgmirror:")) return () => { const g = f.groups?.[+k.slice(9)]; if (!g) return; if (val) g.mirror = true; else delete g.mirror; };
  }
  if (f.type === "trimext") {
    if (k === "wkind") return () => { f.kind = val as "face" | "body"; delete f.boundary; };
    if (k === "allowExt") return () => { if (val) delete f.noExtend; else f.noExtend = true; };
  }
  if (f.type === "endcap") {
    if (k === "wInset") return () => { f.inset = { v: val ? 2 : 0 }; };
    if (k === "wChamfer") return () => { if (val) f.chamfer = { v: 3 }; else delete f.chamfer; };
  }
  if (f.type === "gusset") {
    if (k === "wshape") return () => { f.shape = val as "tri" | "poly"; if (f.shape === "poly") f.d3 ??= { v: Math.round(Math.min(f.d1.v, f.d2.v) / 4) || 5 }; else delete f.d3; };
    if (k === "wloc") return () => { f.loc = val as GussetFeature["loc"]; };
    if (k === "wChamfer") return () => { if (val) f.chamfer = { v: 5 }; else delete f.chamfer; };
  }
  if (f.type === "weldbead" && k === "wTangent") return () => { if (val) delete f.tangent; else f.tangent = false; };
  return null;
}

/** Extra panel wiring: segment checkboxes and the clear buttons. */
export function bindWeldPanel(pm: HTMLElement, f: WeldFeature, ctx: WeldCtx) {
  pm.querySelectorAll<HTMLInputElement>("input[data-wseg]").forEach(inp => inp.addEventListener("change", () => {
    if (f.type !== "member") return;
    const sketch = f.segs[0]?.sketch ?? pathSketches(ctx)[0]?.id;
    const sk = pathSketches(ctx).find(s => s.id === sketch);
    if (!sk) return;
    const on = new Set(f.segs.map(s => s.ent));
    if (inp.checked) on.add(inp.dataset.wseg!); else on.delete(inp.dataset.wseg!);
    // Keep the sketch's order (corners are found between segments in any order, but names stay put).
    f.segs = pathLines(sk).filter(e => on.has(e)).map((ent): WeldSegRef => ({ sketch: sk.id, ent }));
    setGroups(f, (f.groups ?? []).map(g => ({ ...g, ents: g.ents.filter(e => on.has(e)) })));
    if (!f.segs.length) f.segs = [];
    ctx.changed();
  }));
  pm.querySelectorAll<HTMLButtonElement>("button[data-wlist]").forEach(b => b.addEventListener("click", () => {
    const list = b.dataset.wlist!;
    (f as unknown as Record<string, unknown>)[list] = [];
    ctx.changed();
  }));
}

/** A click in the view while a weldment feature is open. Returns the new focus (or the old one). */
export function weldPick(ctx: WeldCtx, e: PointerEvent, f: WeldFeature, focus: string | undefined): string | undefined {
  if (f.type === "member") { toast(t("Tick the path segments in the panel.")); return focus; }
  const hit = ctx.faceAt(e.clientX, e.clientY);
  const fr = hit ? ctx.faceRef(hit.faceId) : null;
  if (!hit || !fr || fr.name.startsWith(`${f.id}:`)) { toast(t("Pick a face.")); return focus; }
  const flat = ctx.faceType(hit.faceId) === "plane";
  const toggle = (list: FaceRef[]) => {
    const i = list.findIndex(x => x.name === fr.name && (!x.hint || !fr.hint || Math.hypot(x.hint[0] - fr.hint[0], x.hint[1] - fr.hint[1], x.hint[2] - fr.hint[2]) < 1e-3));
    if (i >= 0) list.splice(i, 1); else list.push(fr);
  };
  let next = focus;
  if (f.type === "trimext") {
    if ((focus ?? "wbodies") === "wbodies") {
      const mf = memberFace(ctx, fr.name);
      if (!mf) { toast(t("Only structural member bodies can be trimmed: pick a face of a member.")); return focus; }
      // One pick per member segment: a second click on it takes it out.
      const i = f.bodies.findIndex(x => { const o = memberFace(ctx, x.name); return o?.id === mf.id && o.ent === mf.ent; });
      if (i >= 0) f.bodies.splice(i, 1); else f.bodies.push(fr);
    } else {
      if (f.kind === "face" && !flat) { toast(t("Pick a flat face.")); return focus; }
      f.boundary = fr;
    }
  } else if (f.type === "endcap") {
    if (!flat) { toast(t("Pick a flat face.")); return focus; }
    toggle(f.faces);
  } else if (f.type === "gusset") {
    if (!flat) { toast(t("Pick a flat face.")); return focus; }
    if ((focus ?? "wf1") === "wf1") { f.face1 = fr; next = "wf2"; } else f.face2 = fr;
  } else {
    if (!flat && ctx.faceType(hit.faceId) !== "cylinder") { toast(t("Pick a flat or cylindrical face.")); return focus; }
    toggle((focus ?? "wf1") === "wf1" ? f.faces1 : f.faces2);
  }
  return next;
}

// ---------- cut list ----------

/** Display rows of a cut list: item number, quantity, description, length, angles, mass each. */
function rowsOf(items: CutItem[], density: number) {
  const L = (mm: number | undefined) => mm == null ? "" : (mm * UNITS[units.current].f).toLocaleString(undefined, { maximumFractionDigits: 1 });
  return items.map((c, i) => {
    const desc = c.kind === "member" ? c.desc : c.kind === "plate" ? t("Plate {t} × {w} × {l}", { t: c.plate![2], w: c.plate![0], l: c.plate![1] }) : t("Fillet weld, leg {s}", { s: c.desc });
    const kg = (c.volume * density) / 1e6;
    return { item: i + 1, qty: c.kind === "bead" ? 1 : c.qty, desc, length: L(c.length), a1: c.kind === "member" ? String(c.angle1 ?? 0) : "", a2: c.kind === "member" ? String(c.angle2 ?? 0) : "", kg: c.kind === "bead" ? kg : kg, total: c.kind === "bead" ? kg : kg * c.qty };
  });
}

/** The weldment cut list as CSV (English, like the other exports; lengths in mm). */
export function cutListCsv(items: CutItem[], density: number): string {
  const q = (v: string | number) => { const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [["Item", "Qty", "Description", "Length (mm)", "Angle 1 (deg)", "Angle 2 (deg)", "Mass each (kg)", "Mass (kg)"].join(",")];
  items.forEach((c, i) => {
    const desc = c.kind === "member" ? c.desc : c.kind === "plate" ? `Plate ${c.plate![2]} x ${c.plate![0]} x ${c.plate![1]}` : `Fillet weld, leg ${c.desc}`;
    const kg = (c.volume * density) / 1e6, qty = c.kind === "bead" ? 1 : c.qty;
    lines.push([i + 1, qty, desc, c.length ?? "", c.kind === "member" ? c.angle1 ?? 0 : "", c.kind === "member" ? c.angle2 ?? 0 : "", kg.toFixed(4), (kg * (c.kind === "bead" ? 1 : c.qty)).toFixed(4)].map(q).join(","));
  });
  return `${lines.join("\r\n")}\r\n`;
}

const STEEL = 7.85;

/** Opens the cut list dialog for the part's current cut list. */
export function showCutList(items: CutItem[] | undefined, doc: PartDoc) {
  const dlg = document.querySelector<HTMLDialogElement>("#wld-cut");
  if (!dlg) return;
  if (!items?.length) { toast(t("There are no weldment members yet: add a Structural Member first."), true); return; }
  const density = doc.material?.density ?? STEEL;
  const rows = rowsOf(items, density);
  const kg = (m: number) => m.toLocaleString(undefined, { maximumFractionDigits: 3 });
  const total = rows.reduce((s, r) => s + r.total, 0);
  dlg.querySelector<HTMLElement>("#wld-cut-body")!.innerHTML = `<table class="v-table"><thead><tr><th>${esc(t("Item"))}</th><th>${esc(t("Qty"))}</th><th>${esc(t("Description"))}</th><th>${esc(t("Length"))} (${esc(units.current)})</th><th>${esc(t("Angle 1"))}</th><th>${esc(t("Angle 2"))}</th><th>${esc(t("Mass (kg)"))}</th></tr></thead><tbody>`
    + rows.map(r => `<tr><td>${r.item}</td><td>${r.qty}</td><td translate="no">${esc(r.desc)}</td><td>${r.length}</td><td>${r.a1}</td><td>${r.a2}</td><td>${kg(r.total)}</td></tr>`).join("")
    + `</tbody></table><p class="muted" data-wtotal>${esc(t("Total mass {m} kg", { m: kg(total) }))}${doc.material ? "" : ` · ${esc(t("Steel assumed (7.85 g/cm³): set the part's material in Properties."))}`}</p>`;
  dlg.querySelector<HTMLButtonElement>("[data-a=close]")!.onclick = () => dlg.close();
  dlg.querySelector<HTMLButtonElement>("[data-a=csv]")!.onclick = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([cutListCsv(items, density)], { type: "text/csv" }));
    a.download = `${doc.name}-cut-list.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  dlg.showModal();
  dlg.querySelector<HTMLButtonElement>("[data-a=close]")!.focus();
}
