// View navigation habits of mechanical CAD (FRS 13.13, FR-UI-101..104): arrow keys turn and pan the view,
// Z / Shift+Z zoom, Alt+Z goes back to the previous view, a double middle click fits, Zoom to area draws a box,
// Zoom to selection frames what is picked, and Space opens the orientation picker at the cursor.
import { Magnifier } from "./Magnifier";
import * as THREE from "three";
import type { Viewer } from "./Viewer";
import { t } from "../i18n";
import { toast } from "../ui";

export interface NavHost {
  viewer: Viewer;
  /** A 3D model is shown and no other view (PCB, drawing) has the keys. */
  active(): boolean;
  /** Standard view directions (target → camera). */
  views: Record<string, THREE.Vector3>;
  normalTo(): void;
  /** World box of the current selection, or null when nothing is picked. */
  selectionBox(): THREE.Box3 | null;
  /** The model point under the screen point (a vertex, an edge or a face), for the rotation centre (FR-UI-100). */
  pointAt?(x: number, y: number): THREE.Vector3 | null;
}

/** Degrees per arrow press, and the pan step as a fraction of the view height. */
const TURN = 15, PAN = 0.1, ZOOM = 0.8;

export interface Navigation {
  zoomToSelection(): void;
  startZoomArea(): void;
  previousView(): void;
  openPicker(at?: { x: number; y: number }): void;
  closePicker(): void;
  /** The magnifying glass (FR-SEL-010). */
  magnifier: Magnifier;
}

export function bindNavigation(host: NavHost): Navigation {
  const { viewer } = host;
  const canvas = viewer.renderer.domElement;
  const pointer = { x: -1, y: -1 };
  const magnifier = new Magnifier(viewer);
  window.addEventListener("pointermove", e => { pointer.x = e.clientX; pointer.y = e.clientY; }, { passive: true });

  // The keys act when nothing that takes keys has focus: the page itself or the view.
  const free = (e: KeyboardEvent) => {
    const el = e.target as HTMLElement;
    return el === document.body || el === document.documentElement || el === canvas || el.id === "viewport";
  };
  const arrowsFree = (e: KeyboardEvent) => {
    const el = e.target as HTMLElement;
    if (free(e)) return true;
    // A plain command button keeps focus after a click (Mate, a tree row's button…): its arrows still turn the view,
    // unless it sits in a widget that moves focus with them (those prevent the default before this runs).
    return el.tagName === "BUTTON" && !el.closest("[role=menu], [role=menubar], [role=tablist], [role=radiogroup], [role=listbox], [role=toolbar], dialog");
  };

  const zoomToSelection = () => {
    const b = host.selectionBox();
    if (!b || b.isEmpty()) { toast(t("Select a face, an edge or a part first.")); return; }
    // A single flat face or a straight edge has no depth: give the box a little so the fit has a sphere.
    const s = b.getSize(new THREE.Vector3());
    const pad = Math.max(s.x, s.y, s.z, 1e-3) * 0.05;
    viewer.fit(true, b.clone().expandByScalar(pad));
  };

  const previousView = () => { if (!viewer.previousView()) toast(t("No previous view.")); };

  // ---------- Zoom to area ----------
  let area: { x: number; y: number; box: HTMLDivElement | null } | null = null;
  let areaArmed = false;
  const endArea = () => {
    area?.box?.remove();
    area = null;
    areaArmed = false;
    viewer.controls.enabled = true;
    canvas.style.cursor = "";
  };
  const startZoomArea = () => {
    if (!host.active()) return;
    areaArmed = true;
    viewer.controls.enabled = false;
    canvas.style.cursor = "crosshair";
    toast(t("Zoom to area: drag a box over the part of the view to fill the screen (Esc cancels)."));
  };
  // Capture on the window: the box drag must not reach the sketcher, the picking or the orbit controls.
  const onCanvas = (e: PointerEvent) => e.target === canvas;
  window.addEventListener("pointerdown", e => {
    if (!areaArmed || !onCanvas(e) || e.button !== 0) return;
    e.stopPropagation(); e.preventDefault();
    const box = document.createElement("div");
    box.className = "nav-area";
    document.body.appendChild(box);
    area = { x: e.clientX, y: e.clientY, box };
    const place = (x: number, y: number) => {
      box.style.left = `${Math.min(area!.x, x)}px`; box.style.top = `${Math.min(area!.y, y)}px`;
      box.style.width = `${Math.abs(x - area!.x)}px`; box.style.height = `${Math.abs(y - area!.y)}px`;
    };
    place(e.clientX, e.clientY);
  }, true);
  window.addEventListener("pointermove", e => {
    if (!area?.box) return;
    e.stopPropagation();
    const b = area.box, x = e.clientX, y = e.clientY;
    b.style.left = `${Math.min(area.x, x)}px`; b.style.top = `${Math.min(area.y, y)}px`;
    b.style.width = `${Math.abs(x - area.x)}px`; b.style.height = `${Math.abs(y - area.y)}px`;
  }, true);
  window.addEventListener("pointerup", e => {
    if (!area) return;
    e.stopPropagation();
    const r = canvas.getBoundingClientRect();
    const a = area;
    endArea();
    viewer.zoomToRect(a.x - r.left, a.y - r.top, e.clientX - r.left, e.clientY - r.top);
  }, true);

  // ---------- double middle click fits ----------
  let lastMiddle = { t: -1e9, x: 0, y: 0 };
  canvas.addEventListener("pointerdown", e => {
    if (e.button !== 1 || !host.active()) return;
    const now = performance.now();
    if (now - lastMiddle.t < 400 && Math.hypot(e.clientX - lastMiddle.x, e.clientY - lastMiddle.y) < 6) {
      viewer.fit();
      lastMiddle.t = -1e9;
      return;
    }
    lastMiddle = { t: now, x: e.clientX, y: e.clientY };
  });

  // ---------- rotation centre (FR-UI-100): a middle click without a drag ----------
  let midDown: { x: number; y: number; t: number } | null = null;
  canvas.addEventListener("pointerdown", e => { midDown = e.button === 1 && host.active() ? { x: e.clientX, y: e.clientY, t: performance.now() } : null; });
  window.addEventListener("pointerup", e => {
    const d = midDown;
    midDown = null;
    if (!d || e.button !== 1 || performance.now() - d.t > 500 || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;
    const p = host.pointAt?.(e.clientX, e.clientY) ?? null;
    if (!p && !viewer.pivot) return;
    viewer.setPivot(p);
  });

  // ---------- orientation picker (Space) ----------
  let picker: HTMLElement | null = null;
  let back: HTMLElement | null = null;
  const closePicker = () => {
    picker?.remove();
    picker = null;
    back?.focus?.();
    back = null;
  };
  const openPicker = (at?: { x: number; y: number }) => {
    if (picker) { closePicker(); return; }
    if (!host.active()) return;
    back = document.activeElement as HTMLElement | null;
    const r = canvas.getBoundingClientRect();
    const p = at ?? (pointer.x >= r.left && pointer.x <= r.right && pointer.y >= r.top && pointer.y <= r.bottom ? pointer : { x: r.left + r.width / 2, y: r.top + r.height / 2 });
    const el = document.createElement("div");
    el.className = "nav-pick";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", t("View orientation"));
    const v = (id: string, label: string, cls = "") => `<button type="button" class="${cls}" data-nv="${id}">${t(label)}</button>`;
    // The six faces laid out as an unfolded cube around Front, then the other commands.
    el.innerHTML = `<div class="nav-pick-t">${t("View orientation")}</div>`
      + `<div class="nav-cube"><span></span>${v("top", "Top")}<span></span><span></span>`
      + `${v("left", "Left")}${v("front", "Front", "main")}${v("right", "Right")}${v("back", "Back")}`
      + `<span></span>${v("bottom", "Bottom")}<span></span><span></span></div>`
      + `<div class="nav-more">${v("iso", "Isometric")}${v("normal", "Normal to")}${v("fit", "Zoom to fit")}`
      + `${v("sel", "Zoom to selection")}${v("area", "Zoom to area")}${v("prev", "Previous view")}</div>`;
    document.body.appendChild(el);
    const w = el.offsetWidth, h = el.offsetHeight;
    el.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, p.x - w / 2))}px`;
    el.style.top = `${Math.max(8, Math.min(window.innerHeight - h - 8, p.y - h / 2))}px`;
    el.querySelector<HTMLButtonElement>(".main")?.focus();
    el.addEventListener("click", e => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-nv]");
      if (!b) return;
      const id = b.dataset.nv!;
      closePicker();
      if (id === "normal") host.normalTo();
      else if (id === "fit") viewer.fit();
      else if (id === "sel") zoomToSelection();
      else if (id === "area") startZoomArea();
      else if (id === "prev") previousView();
      else viewer.viewFrom(host.views[id]);
    });
    el.addEventListener("keydown", e => {
      const btns = [...el.querySelectorAll<HTMLButtonElement>("button")];
      const i = btns.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === "Escape" || e.key === " " && !(document.activeElement instanceof HTMLButtonElement)) { e.preventDefault(); e.stopPropagation(); closePicker(); }
      else if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); e.stopPropagation(); btns[(i + 1) % btns.length].focus(); }
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); e.stopPropagation(); btns[(i - 1 + btns.length) % btns.length].focus(); }
      else if (e.key === "Tab") { e.preventDefault(); btns[(i + (e.shiftKey ? -1 : 1) + btns.length) % btns.length].focus(); }
    });
    picker = el;
  };
  // A click anywhere else closes the picker.
  document.addEventListener("pointerdown", e => { if (picker && !picker.contains(e.target as Node)) closePicker(); }, true);

  // ---------- keys ----------
  window.addEventListener("keydown", e => {
    if (e.defaultPrevented) return;
    if (areaArmed && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); endArea(); return; }
    const k = e.key;
    const arrow = k === "ArrowLeft" || k === "ArrowRight" || k === "ArrowUp" || k === "ArrowDown";
    if (!(arrow ? arrowsFree(e) : free(e)) || !host.active() || e.metaKey) return;
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    if (arrow && !e.altKey) {
      stop();
      const sx = k === "ArrowLeft" ? -1 : k === "ArrowRight" ? 1 : 0, sy = k === "ArrowUp" ? 1 : k === "ArrowDown" ? -1 : 0;
      if (e.ctrlKey) viewer.panView(sx * PAN, sy * PAN);
      else { const a = e.shiftKey ? 90 : TURN; viewer.rotateView(sx * a, sy * a); }
      return;
    }
    if (e.ctrlKey) return;
    if (e.altKey && (k === "z" || k === "Z" || e.code === "KeyZ")) { stop(); previousView(); return; }
    if (e.altKey) return;
    if (e.code === "KeyZ") { stop(); viewer.zoomView(e.shiftKey ? ZOOM : 1 / ZOOM); return; }
    if (e.code === "KeyG" && !e.shiftKey && !e.repeat) {
      stop();
      if (magnifier.open) { magnifier.close(); return; }
      const r = canvas.getBoundingClientRect();
      const on = pointer.x >= r.left && pointer.x <= r.right && pointer.y >= r.top && pointer.y <= r.bottom;
      magnifier.show(on ? pointer.x : (r.left + r.right) / 2, on ? pointer.y : (r.top + r.bottom) / 2);
      return;
    }
    if (k === " " && !e.repeat) { stop(); openPicker(); }
  });

  return { zoomToSelection, startZoomArea, previousView, openPicker, closePicker, magnifier };
}
