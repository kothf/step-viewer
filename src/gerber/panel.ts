// Side panels for the PCB view: layer list (visibility, colour, order),
// measurement manager, tools, units and the readout card.

import type { GerberView, GMeasure, GTool } from "./GerberView";
import type { GUnit } from "./model";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function bindGerberPanel(g: GerberView, opts: { copy: (text: string) => void }) {
  // Tabs
  document.querySelectorAll<HTMLButtonElement>("#g-left .g-tabs button").forEach(b => b.addEventListener("click", () => {
    document.querySelectorAll("#g-left .g-tabs button").forEach(x => x.classList.toggle("on", x === b));
    document.querySelectorAll("#g-left .g-tab").forEach(t => t.classList.toggle("on", t.id === `g-tab-${b.dataset.tab}`));
  }));
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
  $("#g-all-on").addEventListener("click", () => g.layers.forEach((_, i) => g.setLayerStyle(i, { visible: true })));
  $("#g-all-off").addEventListener("click", () => g.layers.forEach((_, i) => g.setLayerStyle(i, { visible: false })));
  $("#g-png").addEventListener("click", () => g.png());
  $("#g-svg").addEventListener("click", () => g.exportSvg());
  $("#g-csv").addEventListener("click", () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([g.csv()], { type: "text/csv" }));
    a.download = `${(g.name || "pcb").replace(/\.[^.]+$/, "")}-measurements.csv`;
    a.click();
  });
  $("#g-clear").addEventListener("click", () => g.clearMeasurements());

  let dragFrom = -1;
  const renderLayers = () => {
    const host = $("#g-layers");
    host.innerHTML = "";
    g.layers.forEach((l, i) => {
      const row = document.createElement("div");
      row.className = "g-layer" + (l.visible ? "" : " off");
      row.draggable = true;
      row.title = `${l.L.name}\n${l.L.objs.length.toLocaleString()} objects · ${l.L.format === "excellon" ? "Excellon" : "Gerber"}, ${l.L.units}${l.L.warnings.length ? "\n" + l.L.warnings.join("\n") : ""}`;
      row.innerHTML = `<span class="grip" title="Drag to reorder">⋮⋮</span>
        <button class="eye" title="Show / hide">${l.visible ? "◉" : "○"}</button>
        <input type="color" value="${l.color}" title="Layer colour" />
        <span class="g-name"><b>${esc(l.L.label)}</b><small>${esc(l.L.name)}${l.L.warnings.length ? " ⚠" : ""}</small></span>
`;
      row.querySelector(".eye")!.addEventListener("click", () => g.setLayerStyle(i, { visible: !l.visible }));
      row.querySelector<HTMLInputElement>("input[type=color]")!.addEventListener("input", e => g.setLayerStyle(i, { color: (e.target as HTMLInputElement).value }));
      row.addEventListener("dragstart", e => { dragFrom = i; e.dataTransfer!.effectAllowed = "move"; e.dataTransfer!.setData("text/plain", String(i)); row.classList.add("dragging"); });
      row.addEventListener("dragend", () => row.classList.remove("dragging"));
      row.addEventListener("dragover", e => { if (dragFrom < 0) return; e.preventDefault(); e.stopPropagation(); row.classList.add("drop"); });
      row.addEventListener("dragleave", () => row.classList.remove("drop"));
      row.addEventListener("drop", e => { e.preventDefault(); e.stopPropagation(); row.classList.remove("drop"); if (dragFrom >= 0 && dragFrom !== i) g.moveLayer(dragFrom, i); dragFrom = -1; });
      host.appendChild(row);
    });
    if (!g.layers.length) host.innerHTML = `<p class="muted pad">No layers.</p>`;
  };

  const renderMeasures = () => {
    $("#g-m-count").textContent = String(g.measurements.length);
    const host = $("#g-m-list");
    host.innerHTML = "";
    if (!g.measurements.length) { host.innerHTML = `<p class="muted pad">Measurements you take appear here.</p>`; return; }
    g.measurements.forEach((m, i) => {
      const el = document.createElement("div");
      el.className = "m-item" + (m.id === g.selected ? " sel" : "") + (m.visible ? "" : " off");
      el.style.setProperty("--c", "#22d3ee");
      el.innerHTML = `<span class="dot"></span><span class="t">${i + 1}. ${esc(m.title)}</span><span class="val">${esc(m.text())}</span>
        <span class="acts"><button class="vis" title="Show / hide">${m.visible ? "◉" : "○"}</button><button class="del" title="Delete">✕</button></span>`;
      el.addEventListener("click", () => { g.selected = m.id; g.drawOverlay(); renderAll(); });
      el.querySelector(".vis")!.addEventListener("click", e => { e.stopPropagation(); m.visible = !m.visible; g.drawOverlay(); renderAll(); });
      el.querySelector(".del")!.addEventListener("click", e => { e.stopPropagation(); g.deleteMeasurement(m.id); });
      host.appendChild(el);
    });
  };

  const renderReadout = () => {
    const box = $("#g-readout");
    const m: GMeasure | null = g.live ?? g.measurements.find(x => x.id === g.selected) ?? null;
    if (!m) { box.hidden = true; return; }
    box.hidden = false;
    const isLive = m === g.live;
    box.innerHTML = `<div class="ttl"><span>${esc(m.title)}</span><button class="x" title="Close (Esc)">✕</button></div>
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
    const hint = $("#g-hint");
    hint.innerHTML = TOOL_HINTS[g.tool];
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
