// Side panels for the PCB view: layer list (visibility, colour, order),
// measurement manager, tools, units and the readout card.

import type { GerberView, GMeasure, GTool } from "./GerberView";
import type { GUnit } from "./model";
import { bindTabs, busy, confirmModal, emptyState, type Panels } from "../ui";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function bindGerberPanel(g: GerberView, opts: { copy: (text: string) => void; open: () => void; openBody: () => void; panels: Panels }) {
  // Tabs
  const selectTab = bindTabs($("#g-left .g-tabs"), tab => {
    document.querySelectorAll("#g-left .g-tab").forEach(t => t.classList.toggle("on", t.id === `g-tab-${tab}`));
    $("#g-left-title").textContent = tab === "layers" ? "Layers" : "Measurements";
  });
  opts.panels.setGerberTabSelector(selectTab);
  /** Empty-state action: start Smart measure and show the board. */
  const startSmart = () => { g.setTool("smart"); opts.panels.revealBoard(); $("#g-overlay").focus(); };
  // Tools, units, snaps
  document.querySelectorAll<HTMLButtonElement>("#g-tools button").forEach(b => b.addEventListener("click", () => g.setTool(b.dataset.gtool as GTool)));
  $<HTMLSelectElement>("#g-units").addEventListener("change", e => g.setUnits((e.target as HTMLSelectElement).value as GUnit));
  $<HTMLSelectElement>("#g-decimals").addEventListener("change", e => g.setDecimals(+(e.target as HTMLSelectElement).value));
  $<HTMLInputElement>("#g-snap").addEventListener("change", e => { g.snapOn = (e.target as HTMLInputElement).checked; });
  document.querySelectorAll<HTMLInputElement>("[data-gsnap]").forEach(i => i.addEventListener("change", () => { (g.snapKinds as Record<string, boolean>)[i.dataset.gsnap!] = i.checked; }));
  // View buttons
  document.querySelectorAll<HTMLButtonElement>("[data-gview]").forEach(b => b.addEventListener("click", () => {
    const a = b.dataset.gview;
    const vp = $("#gerber").getBoundingClientRect();
    if (a === "fit") g.fit();
    else if (a === "in") g.zoomAt(vp.width / 2, vp.height / 2, 1.4);
    else if (a === "out") g.zoomAt(vp.width / 2, vp.height / 2, 1 / 1.4);
    else if (a === "flip") g.setMirror(!g.view.mirror);
  }));
  document.querySelectorAll<HTMLButtonElement>("[data-gdim]").forEach(b => b.addEventListener("click", () => g.set3d(b.dataset.gdim === "3d")));
  const thick = $<HTMLInputElement>("#g-thick");
  thick.addEventListener("change", () => { const v = parseFloat(thick.value); thick.value = String(g.setThickness(isFinite(v) ? v : 1.6)); });
  $("#g-body").addEventListener("click", e => busy(e.currentTarget as HTMLElement, () => opts.openBody()));
  $("#g-all-on").addEventListener("click", () => g.layers.forEach((_, i) => g.setLayerStyle(i, { visible: true })));
  $("#g-all-off").addEventListener("click", () => g.layers.forEach((_, i) => g.setLayerStyle(i, { visible: false })));
  $("#g-png").addEventListener("click", e => busy(e.currentTarget as HTMLElement, () => g.png()));
  $("#g-svg").addEventListener("click", e => busy(e.currentTarget as HTMLElement, () => g.exportSvg()));
  $("#g-csv").addEventListener("click", () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([g.csv()], { type: "text/csv" }));
    a.download = `${(g.name || "pcb").replace(/\.[^.]+$/, "")}-measurements.csv`;
    a.click();
  });
  $("#g-clear").addEventListener("click", async () => {
    const n = g.measurements.length;
    if (n && await confirmModal(n === 1 ? "Delete the measurement on this board?" : `Delete all ${n} measurements on this board?`, "Delete all")) g.clearMeasurements();
  });

  let dragFrom = -1;
  const renderLayers = () => {
    const host = $("#g-layers");
    host.innerHTML = "";
    g.layers.forEach((l, i) => {
      const row = document.createElement("div");
      row.className = "g-layer" + (l.visible ? "" : " off");
      row.draggable = true;
      row.setAttribute("role", "listitem");
      row.title = `${l.L.name}\n${l.L.objs.length.toLocaleString()} objects · ${l.L.format === "excellon" ? "Excellon" : "Gerber"}, ${l.L.units}${l.L.warnings.length ? "\n" + l.L.warnings.join("\n") : ""}`;
      const name = esc(l.L.label);
      row.innerHTML = `<button class="grip" title="Drag, or Alt+↑ / Alt+↓, to reorder" aria-label="Reorder ${name}: Alt+Up or Alt+Down">⋮⋮</button>
        <button class="eye" title="Show / hide" aria-label="${l.visible ? "Hide" : "Show"} ${name}" aria-pressed="${l.visible}">${l.visible ? "◉" : "○"}</button>
        <input type="color" value="${l.color}" title="Layer colour" aria-label="Colour of ${name}" />
        <span class="g-name"><b>${name}</b><small>${esc(l.L.name)}${l.L.warnings.length ? ` <span role="img" aria-label="has warnings">⚠</span>` : ""}</small></span>
`;
      row.querySelector(".eye")!.addEventListener("click", () => { g.setLayerStyle(i, { visible: !l.visible }); refocus(i, ".eye"); });
      row.addEventListener("keydown", e => {
        const grip = (e.target as HTMLElement).classList.contains("grip");
        const d = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
        if (!d || !(e.altKey || grip)) return;
        e.preventDefault();
        const j = i + d;
        if (j < 0 || j >= g.layers.length) return;
        g.moveLayer(i, j);
        refocus(j, ".grip");
      });
      row.querySelector<HTMLInputElement>("input[type=color]")!.addEventListener("input", e => g.setLayerStyle(i, { color: (e.target as HTMLInputElement).value }));
      row.addEventListener("dragstart", e => { dragFrom = i; e.dataTransfer!.effectAllowed = "move"; e.dataTransfer!.setData("text/plain", String(i)); row.classList.add("dragging"); });
      row.addEventListener("dragend", () => row.classList.remove("dragging"));
      row.addEventListener("dragover", e => { if (dragFrom < 0) return; e.preventDefault(); e.stopPropagation(); row.classList.add("drop"); });
      row.addEventListener("dragleave", () => row.classList.remove("drop"));
      row.addEventListener("drop", e => { e.preventDefault(); e.stopPropagation(); row.classList.remove("drop"); if (dragFrom >= 0 && dragFrom !== i) g.moveLayer(dragFrom, i); dragFrom = -1; });
      host.appendChild(row);
    });
    if (!g.layers.length) emptyState(host, { icon: "layers", title: "No layers yet", text: "Open Gerber, Excellon drill files or a zipped set to see the board.", cta: "Open files", action: opts.open });
    for (const id of ["#g-all-on", "#g-all-off"]) $<HTMLButtonElement>(id).disabled = !g.layers.length;
  };
  /** After a re-render, puts keyboard focus back on the same control of a layer row. */
  const refocus = (i: number, sel: string) => {
    if (layersSig !== g.layers.map(l => `${l.id}:${l.visible}`).join("|")) { layersSig = g.layers.map(l => `${l.id}:${l.visible}`).join("|"); renderLayers(); }
    document.querySelectorAll<HTMLElement>("#g-layers .g-layer")[i]?.querySelector<HTMLElement>(sel)?.focus();
  };

  const renderMeasures = () => {
    $("#g-m-count").textContent = String(g.measurements.length);
    const host = $("#g-m-list");
    host.innerHTML = "";
    const none = !g.measurements.length;
    for (const id of ["#g-csv", "#g-clear"]) $<HTMLButtonElement>(id).disabled = none;
    if (none) { emptyState(host, { icon: "ruler", title: "No measurements yet", text: "Click a pad, track or hole with Smart measure; pin a result to keep it here.", cta: "Start Smart measure", action: startSmart }); return; }
    const focused = document.activeElement?.closest("#g-m-list .m-item") ? [...host.children].indexOf(document.activeElement.closest(".m-item")!) : -1;
    const focusSel = document.activeElement?.classList.contains("vis") ? ".vis" : ".m-main";
    g.measurements.forEach((m, i) => {
      const el = document.createElement("div");
      el.className = "m-item" + (m.id === g.selected ? " sel" : "") + (m.visible ? "" : " off");
      el.setAttribute("role", "listitem");
      el.style.setProperty("--c", "#22d3ee");
      const title = `${i + 1}. ${m.title}`, val = m.text();
      el.innerHTML = `<span class="dot" aria-hidden="true"></span><button class="m-main" aria-pressed="${m.id === g.selected}" title="${esc(`${title}: ${val}`)}"><span class="t">${esc(title)}</span><span class="val">${esc(val)}</span></button>
        <span class="acts"><button class="vis" title="Show / hide" aria-label="${m.visible ? "Hide" : "Show"} measurement ${i + 1}" aria-pressed="${m.visible}">${m.visible ? "◉" : "○"}</button><button class="del" title="Delete" aria-label="Delete measurement ${i + 1}">✕</button></span>`;
      el.querySelector(".m-main")!.addEventListener("click", () => { g.selected = m.id; g.drawOverlay(); renderAll(); });
      el.querySelector(".vis")!.addEventListener("click", e => { e.stopPropagation(); m.visible = !m.visible; g.drawOverlay(); renderAll(); });
      el.querySelector(".del")!.addEventListener("click", e => { e.stopPropagation(); g.deleteMeasurement(m.id); });
      host.appendChild(el);
    });
    if (focused >= 0) (host.children[Math.min(focused, host.children.length - 1)] as HTMLElement | undefined)?.querySelector<HTMLElement>(focusSel)?.focus();
  };

  const renderReadout = () => {
    const box = $("#g-readout");
    const m: GMeasure | null = g.live ?? g.measurements.find(x => x.id === g.selected) ?? null;
    if (!m) { box.hidden = true; return; }
    box.hidden = false;
    const isLive = m === g.live;
    box.innerHTML = `<div class="ttl"><span>${esc(m.title)}</span><button class="x" title="Close (Esc)" aria-label="Close result">✕</button></div>
      <div class="val"><span class="cp" title="Click to copy">${esc(m.text())}</span></div>
      <div class="det">${m.rows().map(([k, v]) => `<div>${esc(k)}: <span class="cp" title="Click to copy">${esc(v)}</span></div>`).join("")}</div>
      <div class="acts">${isLive ? `<button class="btn small" data-a="pin" title="Keep this result (P)">Pin</button>` : ""}
      ${!isLive ? `<button class="btn small danger" data-a="del">Delete</button>` : ""}
      ${isLive && m.feats?.length === 1 ? `<button class="btn small" data-a="area" title="Area of this shape or closed outline (Shift+click)">Area</button>` : ""}</div>`;
    box.querySelector(".x")!.addEventListener("click", () => { if (isLive) { g.live = null; g.picks = []; } else g.selected = null; g.drawOverlay(); renderAll(); });
    box.querySelectorAll<HTMLElement>(".cp").forEach(c => c.addEventListener("click", () => opts.copy(c.textContent ?? "")));
    box.querySelector("[data-a=pin]")?.addEventListener("click", () => g.pinLive());
    box.querySelector("[data-a=del]")?.addEventListener("click", () => g.deleteMeasurement(m.id));
    box.querySelector("[data-a=area]")?.addEventListener("click", () => { const a = g.shapeArea(m.feats![0]); if (a) { g.live = null; g.picks = []; g.addMeasurement(a); } });
  };

  const renderStats = () => {
    const s = g.stats();
    const L = (v: number | null) => (v === null ? "–" : g.fmtLen(v));
    const rows: [string, string][] = [];
    if (s.bb) rows.push(["Board", `${g.fmtLen(s.bb[2] - s.bb[0], false)} × ${g.fmtLen(s.bb[3] - s.bb[1])}`]);
    rows.push(["Layers", String(g.layers.length)], ["Copper tracks", s.tracks.toLocaleString()], ["Copper pads", s.pads.toLocaleString()]);
    if (s.holes) rows.push(["Holes", `${s.holes.toLocaleString()} (${s.drillSizes} sizes)`], ["Smallest hole", L(s.minHole)]);
    if (s.minTrack !== null) rows.push(["Narrowest track", L(s.minTrack)]);
    $("#g-stats").innerHTML = rows.map(([k, v]) => `<span class="k">${esc(k)}</span><span class="v">${esc(v)}</span>`).join("");
  };

  const renderAll = () => {
    document.querySelectorAll<HTMLButtonElement>("#g-tools button").forEach(b => b.classList.toggle("on", b.dataset.gtool === g.tool));
    $<HTMLSelectElement>("#g-units").value = g.unit;
    $<HTMLSelectElement>("#g-decimals").value = String(g.decimals);
    $("[data-gview=flip]").classList.toggle("on", g.view.mirror);
    $("[data-gview=flip]").setAttribute("aria-pressed", String(g.view.mirror));
    document.querySelectorAll<HTMLButtonElement>("#g-tools button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.gtool === g.tool)));
    for (const id of ["#g-png", "#g-svg", "#g-body"]) $<HTMLButtonElement>(id).disabled = !g.layers.length;
    document.querySelectorAll<HTMLButtonElement>("[data-gdim]").forEach(b => { const on = (b.dataset.gdim === "3d") === g.is3d; b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on)); });
    const hint = $("#g-hint");
    hint.innerHTML = TOOL_HINTS[g.tool] + (g.is3d ? ". Drag to orbit, right-drag to pan" : "");
    renderMeasures();
    renderReadout();
  };
  let layersSig = "";
  g.onChange(() => {
    const sig = g.layers.map(l => `${l.id}:${l.visible}`).join("|");
    if (sig !== layersSig) { layersSig = sig; renderLayers(); }
    renderStats();
    renderAll();
  });
  renderAll();
}

const TOOL_HINTS: Record<GTool, string> = {
  smart: "<b>Smart</b>: click a pad, track, hole or region for its size, then a second one for pitch and clearance. Shift+click: area",
  distance: "<b>Point to point</b> (M): click two points. Snaps to corners, pad centres and track edges",
  clearance: "<b>Clearance</b> (C): click two features for the edge-to-edge gap",
  polyline: "<b>Polyline</b> (L): click points; Enter or double-click finishes, Backspace removes the last",
  area: "<b>Area</b> (A): click corners, close on the first point or Enter. Shift+click a closed shape for its area",
};
