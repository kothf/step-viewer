// Assembly mode (FRS 10, P4 slice 1): the assembly tree, Insert component, move/rotate (drag in the
// view or type the pose), fixed/floating, hide, delete, save and open .mcadasm. The kernel places the
// components (src/kernel/assembly.ts) and the viewer shows one part per component, so the measuring
// tools work across components as for an imported assembly.
import * as THREE from "three";
import { ModelKernel } from "../model/kernelClient";
import { newPart, uid } from "../model/doc";
import { PART_EXT, unpackPart } from "../model/file";
import { t, onLangChange } from "../i18n";
import { confirmModal, toast } from "../ui";
import { ASM_EXT, packAsm, unpackAsm } from "./file";
import { IDENTITY, compose, eulerXYZ, fromPose, translation } from "./math";
import type { AsmComponentStatus, AsmDoc, Component } from "./types";
import type { BodyProps, PartDoc, V3 } from "../model/types";
import type { PartData, TreeNode } from "../topology";
import type { Viewer } from "../viewer/Viewer";

export interface AsmHost {
  viewer: Viewer;
  vp: HTMLElement;
  /** Shows the placed components (one part each); `first` fits the view like a newly opened file. */
  show(parts: PartData[], tree: TreeNode, first: boolean): void;
  /** The component part index under a screen point, if any. */
  partAt(x: number, y: number): { idx: number; point: V3 } | null;
  setDoc(label: string): void;
  selectLeftTab(tab: string): void;
  /** Another document kind takes over (the part modeller closes). */
  leaveOthers(): void;
  appVersion: string;
}

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const FOREIGN = /\.(step|stp|iges|igs|brep)$/i;

export class AsmController {
  doc: AsmDoc | null = null;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private savedAt = "";
  private fileName = "";
  private handle: FileSystemFileHandle | null = null;
  private kernel: ModelKernel;
  /** The components shown, in viewer part order. */
  private shownIds: string[] = [];
  private statuses: AsmComponentStatus[] = [];
  props: BodyProps | null = null;
  private selected: string | null = null;
  /** The move panel's component, when open. */
  private moving: string | null = null;
  private building = false;
  private again = false;
  private first = true;
  private drag: { id: string; idx: number; plane: THREE.Plane; start: THREE.Vector3; delta: THREE.Vector3; moved: boolean } | null = null;
  /** Resolves when the rebuild in flight and any queued one are done (tests wait on it). */
  idle: Promise<void> = Promise.resolve();

  constructor(private host: AsmHost, occtBase: string) {
    this.kernel = new ModelKernel(occtBase);
    this.kernel.onCrash = () => toast(t("The geometry kernel stopped; it was restarted."), "warn");
    this.bindDom();
    onLangChange(() => { delete $("#asm-pm").dataset.id; if (this.doc) this.renderAll(); });
  }

  get active() { return !!this.doc; }
  get dirty() { return !!this.doc && JSON.stringify(this.doc) !== this.savedAt; }
  isAsmName(name: string) { return name.toLowerCase().endsWith(ASM_EXT); }

  // ---------- open, new, close ----------

  newAssembly() {
    this.load({ schema: 1, kind: "assembly", id: uid("a_"), name: "Assembly1", units: { length: "mm", decimals: 2 }, components: [], parts: {} }, "", null);
    toast(t("New assembly: insert a part or a STEP model as the first component; it is fixed at the origin."));
  }

  async openFile(file: File | { name: string; data: ArrayBuffer }, handle: FileSystemFileHandle | null = null) {
    const buf = file instanceof File ? await file.arrayBuffer() : file.data;
    try { this.load(await unpackAsm(buf), file.name, handle); }
    catch (err) { toast(t("Could not open {name}: {err}", { name: file.name, err: t((err as Error).message) }), true); }
  }

  private load(doc: AsmDoc, fileName: string, handle: FileSystemFileHandle | null) {
    this.host.leaveOthers();
    this.doc = doc;
    this.savedAt = JSON.stringify(doc);
    this.undoStack = [];
    this.redoStack = [];
    this.fileName = fileName;
    this.handle = handle;
    this.selected = null;
    this.moving = null;
    this.first = true;
    document.getElementById("app")!.classList.add("asm");
    $("#empty").hidden = true;
    this.host.viewer.emptySize = 50;
    $("#t-asm").hidden = false;
    this.host.selectLeftTab("asm");
    this.kernel.warm();
    this.renderAll();
    this.rebuild();
  }

  close() {
    if (!this.doc) return;
    this.doc = null;
    this.drag = null;
    this.kernel.stop();
    document.getElementById("app")!.classList.remove("asm");
    this.host.viewer.emptySize = 1;
    $("#t-asm").hidden = true;
    $("#asm-bar").hidden = true;
    this.host.selectLeftTab("tree");
  }

  private label() { return `${this.fileName || `${this.doc!.name}${ASM_EXT}`}${this.dirty ? " •" : ""}`; }

  // ---------- changes, undo ----------

  /** Applies a change as one undo step and rebuilds. */
  change(fn: (d: AsmDoc) => void) {
    if (!this.doc) return;
    const before = JSON.stringify(this.doc);
    const next = JSON.parse(before) as AsmDoc;
    fn(next);
    if (JSON.stringify(next) === before) return;
    this.undoStack.push(before);
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
    this.doc = next;
    this.renderAll();
    this.rebuild();
  }

  undo() { this.step(this.undoStack, this.redoStack); }
  redo() { this.step(this.redoStack, this.undoStack); }
  private step(from: string[], to: string[]) {
    const s = from.pop();
    if (!s || !this.doc) return;
    to.push(JSON.stringify(this.doc));
    this.doc = JSON.parse(s);
    if (this.moving && !this.doc!.components.some(c => c.id === this.moving)) this.moving = null;
    this.renderAll();
    this.rebuild();
  }

  // ---------- rebuild ----------

  /** Places the components in the kernel and shows them; while one runs, the newest request waits. */
  rebuild() {
    if (!this.doc) return;
    if (this.building) { this.again = true; return; }
    this.building = true;
    this.idle = (async () => {
      do {
        this.again = false;
        const doc = this.doc;
        if (!doc) break;
        $("#asm-busy").hidden = false;
        try {
          const r = await this.kernel.assembly(doc);
          if (this.doc !== doc && this.again) continue;
          this.statuses = r.statuses;
          this.props = r.props;
          this.shownIds = r.parts.map(p => p.id);
          const tree: TreeNode = { name: doc.name, parts: [], children: r.parts.map((p, i) => ({ name: p.data.name, parts: [i], children: [] })) };
          this.host.show(r.parts.map(p => p.data), tree, this.first && r.parts.length > 0);
          if (r.parts.length) this.first = false;
        } catch (err) { toast(t("The assembly could not be rebuilt: {err}", { err: (err as Error).message }), true); }
      } while (this.again);
      $("#asm-busy").hidden = true;
      this.building = false;
      this.renderTree();
    })();
  }

  // ---------- commands ----------

  /** Insert component (FR-ASM-002): a part or a STEP/IGES/BREP model, embedded. */
  insertComponent(file?: File) {
    if (!this.doc) return;
    const run = async (f: File) => {
      let pd: PartDoc;
      try {
        if (f.name.toLowerCase().endsWith(PART_EXT)) pd = await unpackPart(await f.arrayBuffer());
        else if (FOREIGN.test(f.name)) {
          if (f.size > 100 * 1024 * 1024) { toast(t("The file is too large to import (over 100 MB)."), true); return; }
          $("#asm-busy").hidden = false;
          const r = await this.kernel.importBody(await f.arrayBuffer(), f.name);
          if (!r.faces) { toast(t("No faces or solids were found in the file."), true); return; }
          const base = f.name.replace(/\.[^.]+$/, "");
          pd = newPart(base);
          pd.features.push({ id: "i", type: "import", name: "Imported1", file: f.name, brep: r.brep, ...(r.solids ? {} : { heal: true, tol: { v: 0.1 } }) });
        } else { toast(t("Insert a MöbiusCAD part, or a STEP, IGES or BREP model."), true); return; }
      } catch (err) { toast(t("The file could not be read: {msg}", { msg: (err as Error).message }), true); return; }
      finally { $("#asm-busy").hidden = true; }
      // Components are named after their file, as in SolidWorks.
      const base = f.name.replace(/\.[^.]+$/, "") || pd.name;
      // The same document again shares its source (FR-ASM-005).
      const json = JSON.stringify(pd);
      const key = Object.entries(this.doc!.parts).find(([, p]) => JSON.stringify(p.doc) === json)?.[0] ?? uid("p_");
      const n = this.doc!.components.filter(c => c.part === key).length + 1;
      const id = uid("c_");
      const firstOne = !this.doc!.components.length;
      // Later components go beside what is there, along X.
      const box = this.host.viewer.parts.length ? this.host.viewer.computeBounds() : null;
      const at: V3 = firstOne || !box ? [0, 0, 0] : [box.max.x + Math.max(10, (box.max.x - box.min.x) * 0.2), 0, 0];
      this.change(d => {
        d.parts[key] ??= { name: base, file: f.name, doc: pd };
        d.components.push({ id, name: `${base}<${n}>`, part: key, tf: firstOne ? IDENTITY : translation(at), ...(firstOne ? { fixed: true } : {}) });
      });
      this.selected = id;
      this.renderTree();
    };
    if (file) { void run(file); return; }
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = `${PART_EXT},.step,.stp,.iges,.igs,.brep`;
    inp.addEventListener("change", () => { const f = inp.files?.[0]; if (f) void run(f); });
    inp.click();
  }

  private comp(id: string | null) { return id ? this.doc?.components.find(c => c.id === id) ?? null : null; }

  setFixed(id: string, fixed: boolean) { this.change(d => { const c = d.components.find(x => x.id === id); if (c) { if (fixed) c.fixed = true; else delete c.fixed; } }); }
  setHidden(id: string, hidden: boolean) { this.change(d => { const c = d.components.find(x => x.id === id); if (c) { if (hidden) c.hidden = true; else delete c.hidden; } }); }

  async deleteComponent(id: string) {
    const c = this.comp(id);
    if (!c || !(await confirmModal(t("Delete {name} from the assembly?", { name: c.name })))) return;
    this.change(d => {
      d.components = d.components.filter(x => x.id !== id);
      // A part no component uses any more leaves the file.
      for (const k of Object.keys(d.parts)) if (!d.components.some(x => x.part === k)) delete d.parts[k];
    });
    if (this.moving === id) this.moving = null;
    if (this.selected === id) this.selected = null;
    this.renderAll();
  }

  /** The move panel (FR-MATE-002): position and rotation typed, or the component dragged in the view. */
  moveComponent(id: string) {
    if (!this.comp(id)) return;
    this.moving = id;
    this.selected = id;
    this.renderAll();
  }

  async save(as = false) {
    if (!this.doc) return;
    const bytes = await packAsm(this.doc, `MöbiusCAD ${this.host.appVersion}`);
    const blob = new Blob([bytes as BlobPart], { type: "application/zip" });
    const suggested = this.fileName || `${this.doc.name}${ASM_EXT}`;
    const w = window as Window & { showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle> };
    try {
      if (w.showSaveFilePicker) {
        if (!this.handle || as) this.handle = await w.showSaveFilePicker({ suggestedName: suggested, types: [{ description: "MöbiusCAD assembly", accept: { "application/zip": [ASM_EXT] } }] });
        const out = await (this.handle as FileSystemFileHandle & { createWritable(): Promise<FileSystemWritableFileStream> }).createWritable();
        await out.write(blob);
        await out.close();
        this.fileName = this.handle.name;
      } else {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = suggested;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        this.fileName = suggested;
      }
    } catch (err) { if ((err as Error).name !== "AbortError") toast(t("Could not save: {err}", { err: (err as Error).message }), true); return; }
    this.savedAt = JSON.stringify(this.doc);
    this.renderAll();
    toast(t("Saved {name}", { name: this.fileName }), "success");
  }

  /** The bytes of the open assembly, as saved. */
  bytes() { return this.doc ? packAsm(this.doc, `MöbiusCAD ${this.host.appVersion}`) : null; }

  // ---------- view dragging (FR-MATE-001) ----------

  private bindDom() {
    document.getElementById("new-asm")?.addEventListener("click", () => this.newAssembly());
    document.addEventListener("keydown", e => {
      if (!this.doc || !(e.ctrlKey || e.metaKey) || e.altKey) return;
      const tg = e.target as HTMLElement;
      if (tg.closest("input, textarea, select, [contenteditable=true], dialog[open]")) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) { e.preventDefault(); this.undo(); }
      else if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); this.redo(); }
      else if (k === "s") { e.preventDefault(); void this.save(e.shiftKey); }
    });
    const vp = this.host.vp;
    const canvas = () => this.host.viewer.renderer.domElement;
    const ray = (e: PointerEvent) => {
      const r = canvas().getBoundingClientRect();
      const rc = new THREE.Raycaster();
      rc.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.host.viewer.camera);
      return rc.ray;
    };
    vp.addEventListener("pointerdown", e => {
      if (!this.doc || e.button !== 0 || e.target !== canvas()) return;
      const hit = this.host.partAt(e.clientX, e.clientY);
      if (!hit) return;
      const id = this.shownIds[hit.idx], c = this.comp(id);
      if (!c) return;
      this.selected = id;
      if (c.fixed) { this.renderTree(); return; }
      // Left-drag on a floating component moves it in the view plane; the orbit controls never see it.
      e.stopPropagation();
      e.preventDefault();
      const n = this.host.viewer.camera.getWorldDirection(new THREE.Vector3());
      const p = new THREE.Vector3(...hit.point);
      this.drag = { id, idx: hit.idx, plane: new THREE.Plane().setFromNormalAndCoplanarPoint(n, p), start: p, delta: new THREE.Vector3(), moved: false };
      canvas().setPointerCapture?.(e.pointerId);
    }, true);
    vp.addEventListener("pointermove", e => {
      const d = this.drag;
      if (!d) return;
      e.stopPropagation();
      const q = ray(e).intersectPlane(d.plane, new THREE.Vector3());
      if (!q) return;
      d.delta.copy(q).sub(d.start);
      d.moved = d.delta.lengthSq() > 1e-12;
      const part = this.host.viewer.parts[d.idx];
      if (part) { part.group.position.copy(d.delta); this.host.viewer.invalidate(); }
    }, true);
    vp.addEventListener("pointerup", e => {
      const d = this.drag;
      if (!d) return;
      e.stopPropagation();
      this.drag = null;
      if (!d.moved) { this.renderTree(); return; }
      const v: V3 = [d.delta.x, d.delta.y, d.delta.z];
      this.change(doc => { const c = doc.components.find(x => x.id === d.id); if (c) c.tf = compose(translation(v), c.tf); });
    }, true);
  }

  // ---------- rendering ----------

  renderAll() {
    if (!this.doc) return;
    this.renderBar();
    this.renderTree();
    this.renderPanel();
    this.host.setDoc(this.label());
    document.title = `${this.doc.name} · MöbiusCAD`;
  }

  private renderBar() {
    const bar = $("#asm-bar");
    bar.hidden = !this.doc;
    if (!this.doc) return;
    const sel = this.comp(this.selected);
    const b = (c: string, label: string, title: string, dis = false) => `<button class="mc-b" data-ac="${c}" title="${esc(title)}"${dis ? " disabled" : ""}><span class="mc-l">${esc(label)}</span></button>`;
    $("#asm-tools").innerHTML = b("insert", t("Insert component"), t("Insert component: a part, STEP, IGES or BREP model"))
      + b("move", t("Move component"), t("Move or rotate the selected component (or drag it in the view)"), !sel || !!sel.fixed)
      + b("fix", sel?.fixed ? t("Float") : t("Fix"), t("Fix or float the selected component"), !sel)
      + b("undo", t("Undo"), t("Undo (Ctrl+Z)"), !this.undoStack.length) + b("redo", t("Redo"), t("Redo (Ctrl+Y)"), !this.redoStack.length)
      + b("save", t("Save"), t("Save the assembly (.mcadasm)"));
    $("#asm-tools").querySelectorAll<HTMLButtonElement>("[data-ac]").forEach(x => x.addEventListener("click", () => this.command(x.dataset.ac!)));
    const n = this.doc.components.length;
    $("#asm-status").textContent = n ? t("{n} component|{n} components", { n }) : t("Insert a part or a STEP model to start.");
  }

  command(c: string) {
    const sel = this.comp(this.selected);
    if (c === "insert") this.insertComponent();
    else if (c === "move" && sel) this.moveComponent(sel.id);
    else if (c === "fix" && sel) this.setFixed(sel.id, !sel.fixed);
    else if (c === "undo") this.undo();
    else if (c === "redo") this.redo();
    else if (c === "save") void this.save();
  }

  private renderTree() {
    const box = $("#asm-tree");
    if (!this.doc) { box.innerHTML = ""; return; }
    const st = new Map(this.statuses.map(s => [s.id, s]));
    const row = (id: string, icon: string, label: string, cls = "", extra = "") =>
      `<div class="ft-row${cls}${this.selected === id ? " sel" : ""}" role="treeitem" aria-selected="${this.selected === id}" tabindex="${this.selected === id ? 0 : -1}" data-id="${esc(id)}"><span class="ft-ico" aria-hidden="true">${icon}</span><span class="ft-name" translate="no">${esc(label)}</span>${extra}</div>`;
    let html = row("asm", "◆", this.doc.name, " ft-root");
    html += `<div class="ft-group" role="group">${row("origin", "⊹", t("Origin"), " ft-plane")}</div>`;
    for (const c of this.doc.components) {
      const s = st.get(c.id);
      // SolidWorks marks: (f) fixed, (-) floating (under-defined).
      const mark = c.fixed ? "(f) " : "(-) ";
      const err = s && !s.ok ? `<span class="ft-err" title="${esc(s.message ?? "")}" role="img" aria-label="${esc(t("Error"))}: ${esc(s.message ?? "")}">⚠</span>` : "";
      const tools = `<span class="ft-tools"><button class="icon" tabindex="-1" data-a="hide" title="${esc(c.hidden ? t("Show component") : t("Hide component"))}" aria-label="${esc(c.hidden ? t("Show component") : t("Hide component"))}">${c.hidden ? "◌" : "◉"}</button><button class="icon" tabindex="-1" data-a="del" title="${esc(t("Delete"))}" aria-label="${esc(t("Delete"))}">✕</button></span>`;
      html += row(c.id, "▣", mark + c.name, `${c.hidden ? " sup" : ""} ft-comp`, err + tools);
    }
    if (!this.doc.components.length) html += `<p class="pm-help muted pad">${esc(t("Insert a part or a STEP model to start."))}</p>`;
    box.innerHTML = html;
    box.querySelectorAll<HTMLElement>(".ft-row").forEach(r => {
      const id = r.dataset.id!;
      r.addEventListener("click", e => {
        const a = (e.target as HTMLElement).closest<HTMLElement>("[data-a]")?.dataset.a;
        const c = this.comp(id);
        if (c && a === "hide") { this.setHidden(id, !c.hidden); return; }
        if (c && a === "del") { void this.deleteComponent(id); return; }
        this.selected = c ? id : null;
        this.renderTree();
        this.renderBar();
      });
      r.addEventListener("dblclick", () => { const c = this.comp(id); if (c && !c.fixed) this.moveComponent(id); });
      r.addEventListener("contextmenu", e => { e.preventDefault(); const c = this.comp(id); if (c) this.menu(c, e.clientX, e.clientY); });
    });
  }

  private menu(c: Component, x: number, y: number) {
    document.getElementById("asm-menu")?.remove();
    const m = document.createElement("div");
    m.id = "asm-menu";
    m.className = "ctx-menu";
    m.setAttribute("role", "menu");
    const items: [string, () => void][] = [
      [c.fixed ? t("Float") : t("Fix"), () => this.setFixed(c.id, !c.fixed)],
      ...(c.fixed ? [] : [[t("Move component"), () => this.moveComponent(c.id)] as [string, () => void]]),
      [c.hidden ? t("Show component") : t("Hide component"), () => this.setHidden(c.id, !c.hidden)],
      [t("Delete"), () => void this.deleteComponent(c.id)],
    ];
    m.innerHTML = items.map(([l], i) => `<button role="menuitem" data-i="${i}">${esc(l)}</button>`).join("");
    m.style.left = `${x}px`;
    m.style.top = `${y}px`;
    document.body.appendChild(m);
    m.querySelectorAll<HTMLButtonElement>("button").forEach(b => b.addEventListener("click", () => { m.remove(); items[Number(b.dataset.i)][1](); }));
    setTimeout(() => document.addEventListener("pointerdown", ev => { if (!m.contains(ev.target as Node)) m.remove(); }, { once: true }), 0);
    m.querySelector<HTMLButtonElement>("button")?.focus();
  }

  private renderPanel() {
    const pm = $("#asm-pm");
    const c = this.comp(this.moving);
    pm.hidden = !c;
    if (!c) { pm.innerHTML = ""; delete pm.dataset.id; return; }
    const p: V3 = [c.tf[3], c.tf[7], c.tf[11]], r = eulerXYZ(c.tf);
    const now: Record<string, number> = { x: p[0], y: p[1], z: p[2], rx: r[0], ry: r[1], rz: r[2] };
    const fmt = (v: number) => String(Math.round(v * 1e6) / 1e6);
    // The same component: refresh the values in place, so typing on into the next box is not lost.
    if (pm.dataset.id === c.id) {
      pm.querySelectorAll<HTMLInputElement>("input[data-pose]").forEach(i => { if (i !== document.activeElement && Number(i.value.replace(",", ".")) !== now[i.dataset.pose!]) i.value = fmt(now[i.dataset.pose!]); });
      return;
    }
    pm.dataset.id = c.id;
    const f = (k: string, label: string, v: number, unit: string) => `<label class="pm-field"><span>${esc(label)}</span><span class="pm-in"><input type="text" inputmode="decimal" data-pose="${k}" value="${esc(fmt(v))}" spellcheck="false" /><span class="muted">${unit}</span></span></label>`;
    pm.innerHTML = `<div class="pm-head"><h3>${esc(t("Move component"))}</h3><button class="icon" data-a="ok" title="${esc(t("OK (Enter)"))}" aria-label="${esc(t("OK (Enter)"))}">✓</button></div>`
      + `<p class="pm-help" translate="no">${esc(c.name)}</p>`
      + `<fieldset class="pm-sec"><legend>${esc(t("Position"))}</legend>${f("x", "X", p[0], "mm")}${f("y", "Y", p[1], "mm")}${f("z", "Z", p[2], "mm")}</fieldset>`
      + `<fieldset class="pm-sec"><legend>${esc(t("Rotation"))}</legend>${f("rx", t("About X"), r[0], "°")}${f("ry", t("About Y"), r[1], "°")}${f("rz", t("About Z"), r[2], "°")}</fieldset>`
      + `<p class="pm-help muted">${esc(t("Or drag the component in the view."))}</p>`;
    pm.querySelector("[data-a=ok]")!.addEventListener("click", () => { this.moving = null; this.renderPanel(); });
    pm.onkeydown = e => { if (e.key === "Escape") { this.moving = null; this.renderPanel(); } };
    pm.querySelectorAll<HTMLInputElement>("input[data-pose]").forEach(inp => {
      const apply = () => {
        const vals: Record<string, number> = {};
        for (const i of pm.querySelectorAll<HTMLInputElement>("input[data-pose]")) {
          const v = Number(i.value.replace(",", "."));
          if (!Number.isFinite(v)) { i.setAttribute("aria-invalid", "true"); return; }
          i.removeAttribute("aria-invalid");
          vals[i.dataset.pose!] = v;
        }
        const tf = fromPose([vals.x, vals.y, vals.z], [vals.rx, vals.ry, vals.rz]);
        this.change(d => { const x = d.components.find(k => k.id === c.id); if (x) x.tf = tf; });
      };
      inp.addEventListener("change", apply);
      inp.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); apply(); this.moving = null; this.renderPanel(); } });
    });
  }
}
