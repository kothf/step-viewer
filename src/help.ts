// Help dialog: features, measuring tools and keyboard shortcuts, in English and Russian.
// The dialog shell is in index.html (#help); this fills #help-body for the current language.

import { lang, type Lang } from "./i18n";
import { bindTabs } from "./ui";

type Tab = { id: string; title: string; html: string };

const kbd = (s: string) => s.split(" ").map(k => (/^[+/,·–]$/.test(k) || k === "/" ? ` ${k} ` : `<kbd>${k}</kbd>`)).join("");
const table = (rows: [string, string][]) => `<table class="keys">${rows.map(([k, v]) => `<tr><td>${kbd(k)}</td><td>${v}</td></tr>`).join("")}</table>`;

// ---------- About / Credits ----------
// The open-source list comes from credits.json, which the build writes from the packages that
// actually end up in the bundle (scripts/credits-plugin.mjs), so it can't go out of date.

type Credit = { name: string; version: string; license: string; author: string; url: string; note?: string };
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const REPO = "https://github.com/kothf/step-viewer";
const ext = (href: string, text: string) => `<a href="${href}" target="_blank" rel="noopener">${text}</a>`;
// the libraries MöbiusCAD is built on, named up front; the full list is below them
const MAIN = ["three", "occt-import-js", "opencascade.js", "Open CASCADE Technology", "parasolid-kit (parasolid-core)", "three-mesh-bvh", "jspdf", "fflate"];
const SHOWN: Record<string, string> = { three: "three.js", jspdf: "jsPDF" };
const MAIN_WHAT: Record<string, [string, string]> = {
  "three": ["3D rendering", "3D-графика"],
  "occt-import-js": ["STEP / IGES / BREP import (WebAssembly)", "импорт STEP / IGES / BREP (WebAssembly)"],
  "opencascade.js": ["exact geometry and STEP export (full OpenCASCADE, WebAssembly)", "точная геометрия и экспорт в STEP (полное ядро OpenCASCADE, WebAssembly)"],
  "Open CASCADE Technology": ["CAD geometry kernel inside occt-import-js and opencascade.js", "геометрическое ядро САПР внутри occt-import-js и opencascade.js"],
  "three-mesh-bvh": ["fast picking and snapping", "быстрый выбор и привязки"],
  "parasolid-kit (parasolid-core)": ["reading the Parasolid geometry inside SolidWorks files (WebAssembly)", "чтение геометрии Parasolid внутри файлов SolidWorks (WebAssembly)"],
  "jspdf": ["PDF reports", "PDF-отчёты"],
  "fflate": ["reading .zip PCB sets", "чтение .zip с платами"],
};

function about(l: Lang) {
  const ru = l === "ru";
  const blog = ru ? "https://aerocat.tech/ru/posts/mobiuscad/" : "https://aerocat.tech/posts/mobiuscad/";
  return `
<div class="about-head">
  <img src="icons/logo-mark.png" width="56" height="56" alt="" />
  <div><div class="about-name" translate="no">MöbiusCAD <span>v${__APP_VERSION__}</span></div>
  <div class="about-by">${ru ? "Автор" : "Made by"} <span translate="no">Andrey Dumchin</span> · ${ext("https://aerocat.tech/", "<span translate=\"no\">aerocat.tech</span>")}</div>
  <div class="about-links">${ext(blog, ru ? "Статья в блоге" : "Blog post")} · ${ext(REPO, ru ? "Исходный код на <span translate=\"no\">GitHub</span>" : "Source on GitHub")} · ${ext(`${REPO}/blob/main/CHANGELOG.md`, ru ? "Что нового" : "What's new")}</div></div>
</div>
${ru
    ? `<p>Модели STEP, IGES, BREP и SolidWorks, сетки STL, OBJ и 3MF и печатные платы Gerber / Excellon в браузере. Файлы не покидают ваш компьютер. После первого открытия приложение запускается и без сети.</p>
<p>Геометрия читается с помощью OpenCASCADE (occt-import-js, WebAssembly). Грани и рёбра восстанавливаются из триангуляции B-rep, поэтому плоскости, цилиндры, окружности и дуги распознаются аналитически; затем полное ядро (opencascade.js) в фоне заменяет объёмы, площади, длины, радиусы и кривизну точными значениями B-rep. Расстояния на поверхностях свободной формы измеряются по сетке. Внутренние единицы: миллиметры; единицы и число знаков меняют только отображение значений.</p>`
    : `<p>STEP, IGES, BREP and SolidWorks models, STL, OBJ and 3MF meshes and Gerber / Excellon PCBs in the browser. Files never leave your computer. After the first visit it also starts offline.</p>
<p>Geometry is read with OpenCASCADE (occt-import-js, WebAssembly). Faces and edges are rebuilt from the B-rep tessellation, so planes, cylinders, circles and arcs are recognised analytically; then the full kernel (opencascade.js) replaces volumes, areas, lengths, radii and curvature with exact B-rep values in the background. Distances on freeform surfaces are measured on the mesh. Internal units are millimetres; units and decimals only change how values are shown.</p>`}
<h4>${ru ? "Создано с помощью" : "Built with"}</h4>
<ul class="credits-main" data-credits-main><li>${ru ? "Загрузка…" : "Loading…"}</li></ul>
<details class="credits-all">
  <summary>${ru ? "Все открытые библиотеки и лицензии" : "All open-source libraries and licences"}&nbsp;<span data-credits-count></span></summary>
  <table class="credits-table" data-credits-table translate="no"></table>
  <p>${ru ? "Полные тексты лицензий" : "Full licence texts"}: ${ext("THIRD-PARTY-LICENSES.txt", "<span translate=\"no\">THIRD-PARTY-LICENSES.txt</span>")}. ${ru
    ? "<span translate=\"no\">OpenCASCADE</span> распространяется по <span translate=\"no\">LGPL-2.1</span> без изменений, в папке <code translate=\"no\">occt/</code>, его можно заменить своей сборкой."
    : "OpenCASCADE is shipped unmodified under the LGPL-2.1 in the <code translate=\"no\">occt/</code> folder and can be replaced with your own build."}</p>
</details>
<h4>${ru ? "Шрифты и значки" : "Fonts and icons"}</h4>
<p>${ru
    ? "Используются системные шрифты устройства; значки на кнопках — символы Юникода. Логотип MöbiusCAD нарисовал автор."
    : "The interface uses your device's system fonts, and the button icons are Unicode symbols. The MöbiusCAD logo was drawn by the author."}</p>
<h4>${ru ? "Лицензия и отказ от гарантий" : "Licence and disclaimer"}</h4>
<p>${ru
    ? `MöbiusCAD распространяется по лицензии ${ext(`${REPO}/blob/main/LICENSE`, "<span translate=\"no\">MIT</span>")} «как есть», без каких-либо гарантий. Размеры считаются по триангулированной модели, поэтому критичные размеры проверяйте по исходной модели или чертежу, прежде чем заказывать детали или платы.`
    : `MöbiusCAD is released under the ${ext(`${REPO}/blob/main/LICENSE`, "MIT licence")}, "as is", without warranty of any kind. Measurements are taken from the tessellated model, so check critical dimensions against the original CAD model or drawing before you order parts or boards.`}</p>`;
}

let credits: Promise<Credit[]> | null = null;
const loadCredits = (): Promise<Credit[]> => (credits ??= fetch("credits.json")
  .then(r => (r.ok ? (r.json() as Promise<Credit[]>) : Promise.reject(new Error(String(r.status)))))
  .catch((e: unknown) => { credits = null; throw e; }));

function fillCredits(host: HTMLElement) {
  const ru = lang() === "ru";
  const main = host.querySelector<HTMLElement>("[data-credits-main]");
  const table = host.querySelector<HTMLElement>("[data-credits-table]");
  if (!main || !table) return;
  loadCredits().then(list => {
    const by = new Map(list.map(c => [c.name, c]));
    main.innerHTML = MAIN.filter(n => by.has(n)).map(n => {
      const c = by.get(n)!;
      return `<li><a href="${esc(c.url)}" target="_blank" rel="noopener" translate="no">${esc(SHOWN[n] ?? c.name)}</a> <span translate="no">(${esc(c.license)}, ${esc(c.author)})</span>: ${MAIN_WHAT[n][ru ? 1 : 0]}</li>`;
    }).join("");
    host.querySelector<HTMLElement>("[data-credits-count]")!.textContent = `(${list.length})`;
    table.innerHTML = `<tr><th>${ru ? "Библиотека" : "Library"}</th><th>${ru ? "Версия" : "Version"}</th><th>${ru ? "Лицензия" : "Licence"}</th><th>${ru ? "Авторы" : "Authors"}</th></tr>` +
      list.map(c => `<tr><td><a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.name)}</a></td><td>${esc(c.version)}</td><td>${esc(c.license)}</td><td>${esc(c.author)}</td></tr>`).join("");
  }).catch(() => {
    main.innerHTML = `<li>${ru ? "Список библиотек не загрузился; он есть в файле" : "The library list didn't load; it is in"} <a href="THIRD-PARTY-LICENSES.txt" target="_blank" rel="noopener" translate="no">THIRD-PARTY-LICENSES.txt</a>.</li>`;
  });
}

const EN: Tab[] = [
  {
    id: "start", title: "Start",
    html: `
<p><strong>MöbiusCAD</strong> opens 3D CAD models and printed circuit boards in the browser. Files are read on your computer and never uploaded.</p>
<h4>Opening files</h4>
<ul>
  <li><b>Open file</b> (<kbd>Ctrl</kbd>+<kbd>O</kbd>) or drag files onto the window.</li>
  <li><b>3D models</b>: STEP (AP203, AP214, AP242), IGES and BREP. The mesh quality (Draft, Normal, Fine) in the <b>Display</b> menu applies to the next file you open.</li>
  <li><b>SolidWorks</b>: parts (.sldprt) and assemblies (.sldasm), read as exact geometry, so every tool and STEP export work on them. Drop an assembly together with its part files, or drag its whole folder; parts that are missing are named and left out. If a file has no readable geometry, its SolidWorks preview is shown instead.</li>
  <li><b>Mesh files</b>: STL, OBJ and 3MF. They hold only triangles, so MöbiusCAD groups them into flat and curved faces first; holes, cylinders and spheres are still recognised, but there are no exact values or STEP export. Sizes are read as millimetres.</li>
  <li><b>PCBs</b>: Gerber RS-274X / X2 layers, Excellon drill files, or a .zip with a whole set. Open several files at once to see them as one board.</li>
</ul>
<h4>Screen layout</h4>
<ul>
  <li><b>Header</b>: open file, the open file's name and status, view controls, language (EN / RU), theme and this help.</li>
  <li><b>Left panel</b>: model tree or PCB layers, and the list of saved measurements. Hide it with <kbd>Ctrl</kbd>+<kbd>[</kbd>.</li>
  <li><b>Tools</b> (3D model, in the header): every measuring tool and the right-panel pages (Properties, Section, Explode, Mass, Export), always in view, next to the display modes, projection and Fit. Units, decimals, measurement colour, mesh quality, origin axes and ambient occlusion are in the <b>Display</b> menu. Hover an icon for its name and key; on narrow windows the tools move to a second row.</li>
  <li><b>Right panel</b>: the page picked in the header; click the open page again to hide the panel, or press <kbd>Ctrl</kbd>+<kbd>]</kbd>. On a phone, the PCB panels open from the bottom bar.</li>
  <li><b>Status bar</b>: snapping options, the snapped point and its coordinates.</li>
</ul>
<h4>Language</h4>
<p>The <b>EN / RU</b> button in the header switches the interface between English and Russian; the choice is remembered. PDF reports and CSV / JSON exports stay in English so they read the same everywhere.</p>`,
  },
  {
    id: "model", title: "3D model",
    html: `
<h4>View</h4>
<ul>
  <li>Left drag orbits, right drag pans, the wheel zooms to the cursor. The cube in the corner turns the view to a face or corner.</li>
  <li><b>Display modes</b>: Shaded+Edges, Shaded, Wire, HLR (hidden lines removed) and X-ray; <b>Persp</b> / <b>Ortho</b> projection; standard views Fit, Iso, Front, Top, Right.</li>
  <li>The <b>Display</b> menu in the header: <b>Origin axes</b> shows X, Y, Z from the model origin; <b>Ambient occlusion</b> adds soft contact shadows in corners and gaps (slower on large models, off while sectioning).</li>
</ul>
<h4>Model tree and properties</h4>
<ul>
  <li>Click a part in the tree or the model to select it; double-click zooms to it. The eye button hides or shows a part.</li>
  <li>The filter accepts a name or a condition: <code>size&gt;50</code>, <code>vol&lt;1000</code> (in the current units).</li>
  <li><b>Properties</b> shows the file header (protocol, author, PMI), part size, volume and area, and the selected face or edge. Isolate, hide, recolour or make a part transparent there.</li>
</ul>
<h4>Exact geometry</h4>
<p>A model opens on its mesh, so you can measure at once. In the background the full OpenCASCADE kernel (about 15 MB, downloaded once and then cached by the browser) reads the file again; when the status bar shows <b>● Exact geometry</b>, volumes, mass, areas, edge and curve lengths, radii, cone angles and curvature come from the true B-rep surfaces and curves. Nothing needs to be switched on.</p>
<h4>Section</h4>
<p>Press <b>Section</b> in the header and click a face: a flat face puts the cutting plane on it, a cylinder cuts through its axis. You can also add up to three cutting planes: parallel to XY, YZ or XZ, on a selected planar face, through three picked points, or facing the view. A new plane shows as a see-through sheet with two arrows along its normal: drag either arrow to slide the cut through the model (<b>↕</b> brings the arrows back, <b>⟳</b> swaps them for rotation rings, Esc hides them), or type an offset and angles. Caps fill the cut (with ANSI31 hatching, optionally in each part's colour), and the cut curves can be snapped to for measuring. <b>Snap to cut only</b> limits snapping to the section. <b>DXF</b> and <b>SVG</b> on a plane save its cut curves as a 2D drawing in millimetres, with true circles and arcs (XY, YZ and XZ planes keep the world axes).</p>
<h4>Exploded view, mass and export</h4>
<ul>
  <li><b>Exploded view</b> moves parts apart with the slider; <b>Move selected part</b> drags one part with a gizmo.</li>
  <li><b>Mass properties</b>: pick a material or type a density to get volume, mass, area, centre of mass and bounding box of the visible or selected parts.</li>
  <li><b>Export</b>: <b>STEP</b> (the whole model with its assembly, names and colours, or only the visible parts), PNG (also transparent, 2× to 4×), STL, OBJ, glTF and a PDF inspection report with the view, model data, mass and measurements.</li>
</ul>`,
  },
  {
    id: "measure", title: "Measuring",
    html: `
<h4>Smart measure (default)</h4>
<p>Click one point, edge or face to see its size: a hole's diameter, an edge's length, a face's area, a part's volume. Click a second entity to get the relation between the two: distance, pitch, angle, gap or offset. The result stays on screen until the next click; <b>📌 Pin</b> keeps it in the list. <kbd>Esc</kbd> clears.</p>
<ul>
  <li>The value is on the model; details are in the result card. Click any value in the card to copy it.</li>
  <li>For two holes or circles, the card switches between <b>Centre to centre</b>, <b>Minimum</b> (edge to edge) and <b>Maximum</b> (overall span).</li>
  <li><b>✂ Section here</b> cuts on a picked planar face; <b>⬚ Whole part</b> shows the part's size and volume; <b>⌖ CSYS here</b> makes the picked face, edge, circle or vertex the coordinate system for all coordinates and ΔX / ΔY / ΔZ.</li>
</ul>
<h4>Dedicated tools</h4>
<table class="keys">
  <tr><td>↔ Point–point <kbd>D</kbd></td><td>Distance between two points, with ΔX, ΔY, ΔZ</td></tr>
  <tr><td>⇤ Min distance <kbd>M</kbd></td><td>Shortest distance between points, edges or faces</td></tr>
  <tr><td>R Radius <kbd>R</kbd> · Ø Diameter</td><td>Of a circular edge, arc, cylinder or sphere</td></tr>
  <tr><td>⊙ Centre–centre <kbd>C</kbd></td><td>Distance between hole centres, or pitch between parallel axes</td></tr>
  <tr><td>⌒ Edge length <kbd>L</kbd></td><td>Length of a straight or curved edge, with radius and sweep for arcs</td></tr>
  <tr><td>∠ Angle <kbd>A</kbd> · ∡ 3-point angle</td><td>Between edges or faces, or through three points</td></tr>
  <tr><td>⊕ Point / normal <kbd>V</kbd></td><td>Coordinates of a point and the surface normal there</td></tr>
  <tr><td>▭ Bounding box <kbd>B</kbd></td><td>Overall size of the visible or selected parts</td></tr>
  <tr><td>✎ Note <kbd>T</kbd></td><td>A text note with a leader to a point on the model. Drag the box to move it, double-click to edit; notes show in PNG and the PDF report</td></tr>
</table>
<h4>Snapping, units and results</h4>
<ul>
  <li>The cursor snaps to vertices, midpoints, centres (also arc quadrants and virtual corners) and edges; turn kinds on or off in the status bar.</li>
  <li><b>Units</b> (mm, cm, m, in, ft) and <b>Decimals</b> change every value at once, also in the result card.</li>
  <li>Saved measurements are kept per file in this browser. Export them as CSV, JSON or in the PDF report; <b>Clear all</b> asks first.</li>
</ul>`,
  },
  {
    id: "pcb", title: "PCB",
    html: `
<h4>Layers</h4>
<ul>
  <li>Layers are recognised from Gerber X2 attributes or file names (copper, solder mask, silkscreen, paste, outline, drill) and coloured by type.</li>
  <li>Show or hide a layer, change its colour, and drag (or <kbd>Alt</kbd>+<kbd>↑</kbd> / <kbd>↓</kbd>) to restack; the top of the list draws on top.</li>
  <li><b>Bottom view</b> mirrors the board as seen from below. <b>2D</b> / <b>3D</b> switches between the flat layers and a 3D board with thickness, holes, mask and silkscreen.</li>
</ul>
<h4>Measuring on a board</h4>
<table class="keys">
  <tr><td>✦ Smart <kbd>Q</kbd></td><td>Click a pad, track, hole or region for its size, net and aperture; a second one gives pitch and clearance</td></tr>
  <tr><td>↔ Point–point <kbd>M</kbd></td><td>Two points with ΔX / ΔY; snaps to corners, pad centres and track edges</td></tr>
  <tr><td>⇤ Clearance <kbd>C</kbd></td><td>Edge-to-edge gap between two features</td></tr>
  <tr><td>⌇ Polyline <kbd>L</kbd></td><td>Path length; <kbd>Enter</kbd> or double-click finishes, <kbd>Backspace</kbd> removes the last point</td></tr>
  <tr><td>▱ Area <kbd>A</kbd></td><td>Area of a polygon you click; <kbd>Shift</kbd>+click a pad, region or closed outline for its area</td></tr>
</table>
<ul>
  <li>Units for boards are mm, in or mil. <kbd>P</kbd> pins the Smart result; the list exports to CSV, the view to PNG or SVG.</li>
  <li><b>Board</b> shows the size, copper and hole statistics. <b>Measure as 3D model</b> opens the board body in the 3D tools (thickness, hole diameters, sections, mass, STL); <b>Back to PCB</b> returns. <b>STEP</b> under Export saves the board body as a solid with true round holes for mechanical CAD.</li>
</ul>`,
  },
  {
    id: "model", title: "Modelling",
    html: `
<p><b>New part</b> (the page icon next to Open, or on the start screen) starts a parametric part: sketches and features in a history you can edit at any time. The <b>Features</b> tab on the left lists them; the bar over the view holds the commands.</p>
<h4>Sketch</h4>
<ul>
  <li><b>Sketch</b>, then pick <b>Top (XY)</b>, <b>Front (XZ)</b>, <b>Right (YZ)</b> or a flat face of the part (a face picked with Smart measure is used at once). The view turns to face the sketch.</li>
  <li>Draw with <b>Line</b>, <b>Rectangle</b>, <b>Centre rectangle</b>, <b>Circle</b>, <b>3-point circle</b>, <b>Arc</b>, <b>3-point arc</b>, <b>Polygon</b> (sides in the panel) and <b>Point</b>. <b>Trim</b> (T) removes the clicked piece of a curve up to where it crosses others; <b>Fillet</b> (F) rounds the corner of two lines with the radius set in the panel. Points snap to ends, centres, curves and the origin; horizontal, vertical and coincident relations are added as you draw.</li>
  <li>Tools with a <b>▾</b> hold related ones (Rectangle, Circle, Arc, Trim, Fillet, Offset); the button keeps the last one you picked. <b>Slot</b> (W): click both centres, then the width. <b>Ellipse</b> (in the Circle ▾ menu): click the centre, the end of the major axis, then a point on the ellipse; <b>Partial ellipse</b> adds a start and an end, counter-clockwise. Dimension an ellipse between its centre and its axis points. <b>Spline</b> (in the Line ▾ menu): click the points it passes through; double-click ends it, clicking the first point again closes it. Drag a point to reshape it. <b>Extend</b> (E) lengthens a line or arc to the next curve; <b>Split</b> cuts it in two where you click; sketch <b>Chamfer</b> bevels the corner of two lines. <b>Offset entities</b> (O): move to the side to offset to and click a curve; a chain of joined lines and arcs is offset as a whole, corners re-joined. <b>Convert entities</b> copies the model edges you click (or all edges of a face) into the sketch, fixed in place. <b>Intersection curve</b> (in the Offset ▾ menu) adds, fixed, the curves where the sketch plane cuts the faces you click: lines on flat faces, circles and arcs on round faces square to the sketch, splines elsewhere.</li>
  <li><b>Dimension</b>: click a line, circle or arc (or two items), then where the value goes, and type it. Values accept units and arithmetic, such as <code>25.4 mm</code>, <code>1in</code>, <code>100/3</code> or <code>30deg</code>. Double-click a dimension to change it. Dimension from a point (or a parallel line) to a construction line (centerline), picking the point first, and place the value on the far side of the centerline: it becomes a ⌀ diameter, as for a revolve profile. Horizontal and Vertical ordinate (in the Dimension ▾ menu) dimension a row of points from one base: click the base, where the values go, then each point.</li>
  <li>Select items (Ctrl+click for more) to add relations in the panel: parallel, perpendicular, equal, tangent, concentric, midpoint, symmetric, fix. <b>Construction</b> (Q) turns lines into reference geometry, for example a revolve axis.</li>
  <li>The panel lists the sketch's relations: click one to select it, ✕ deletes it.</li>
  <li>Colours: blue can still move, black is fully defined, red is over-defined. The panel shows the remaining degrees of freedom. Select an item to see orange arrows where it can still move. Drag geometry to try it.</li>
  <li>When a sketch is over-defined, the <b>Sketch assistant</b> in the panel lists the relations and dimensions whose deletion makes it solve again. <b>Show</b> highlights them in the sketch, and <b>Delete</b> removes them.</li>
  <li>Two selected points can be joined with <b>Merge points</b>: the second is replaced by the first everywhere. Select a point and two curves for the <b>Intersection</b> relation, which keeps the point where they cross.</li>
  <li><b>Convert entities</b> copies model edges into the sketch with an <b>On edge</b> relation: they follow their edge when the model changes. If the edge disappears the relation is <b>dangling</b> (olive): drag its glyph onto another edge, or use <b>Re-attach</b> in the panel, or delete the relation to keep the curve free. Right-click a sketch in the tree for <b>Edit sketch plane</b> to move it to another plane or face.</li>
  <li>Hover a dimension to see its full name, such as <code>D1@Sketch1</code>, which equations and other values can use. Select one dimension to rename it in the panel (expressions follow); <b>Show dimension names</b> puts the names on the sketch. Drag a dimension's value to move its text.</li>
  <li>✓ or <kbd>Enter</kbd> leaves the sketch; ✕ asks before discarding its changes.</li>
</ul>
<h4>Features</h4>
<ul>
  <li><b>Sweep ▾</b> holds Sweep, Cut-Sweep, Loft, Cut-Loft and Helix/Spiral. <b>Helix/Spiral</b> starts on the circle of a sketch and runs along its normal: pitch and revolutions, height and revolutions, or height and pitch, with start angle, clockwise, reverse and taper. <b>Sweep</b> moves a closed profile sketch, or a circle of a set diameter (circular profile, for springs, wires and tubes), along a path: a helix or a sketch's chain of curves; Follow path or Keep normal constant. <b>Loft</b> joins two or more closed profiles in order (usually on parallel planes), smooth or with straight sections, optionally closed back to the first.</li>
  <li><b>Rib</b> (in Sweep ▾) turns an open sketch line or arc chain into a wall that runs to the body: thickness on the first side, both sides or the second side; <b>Parallel to sketch</b> grows it in the sketch plane (the usual corner gusset on a sketch through the part), <b>Normal to sketch</b> along the normal (ribs across a hollow, sketched above it). It goes the way that meets the body; <b>Flip material side</b> tries the other way first.</li>
  <li><b>Split Line</b> (in Sweep ▾) projects a sketch along its normal, both ways, and splits the faces it crosses (or only the faces you click), so each piece can take its own colour, draft or mate. The body keeps its shape.</li>
  <li><b>Multibody</b>: untick <b>Merge result</b> on an extrude or revolve to make a new body. <b>Combine</b> adds bodies, subtracts tool bodies from a main body or keeps what they share; <b>Split</b> cuts bodies with a plane into separate bodies; <b>Body-Move/Copy</b> translates and rotates bodies (or copies them); <b>Body-Delete/Keep</b> removes bodies. Pick a body by clicking any face of it.</li>
  <li><b>Solid Bodies</b> folder at the top of the Features tree: each body with show/hide, colour and delete; double-click a body to rename it. Hidden bodies leave the view but still count in mass properties.</li>
  <li><b>Insert body</b> (Sweep ▾): a STEP, IGES or BREP file goes into the part as an Imported feature, stored in the part file. Tick <b>Check and heal</b> to sew faces whose edges are closer than the tolerance and close them into solids; the panel reports free edges and validity before and after.</li>
  <li><b>Scale</b> (Sweep ▾): scales the picked bodies (all when none are picked) about their centroid or the origin, by one factor or per axis.</li>
  <li><b>Extrude</b> and <b>Cut</b> use a closed sketch: blind depth, mid plane, through all or up to a face or plane, with a second direction and reverse. A cut goes into the material; <b>Flip side to cut</b> keeps what is inside the profile instead.</li>
  <li>Drag the orange arrow on the model to set the depth with the mouse (Shift: finer steps). Select an extrude in the tree and drag its arrow to change it at once.</li>
  <li>A revolve has an orange grip at the end of its sweep: drag it round the axis to set the angle (1° steps, Shift: 0.1°). A cut shows the material it removes as a see-through yellow body while it is open.</li>
  <li><b>Plane</b> makes a reference plane offset from a plane or flat face, or at an angle about a straight edge. Sketch on it like on the standard planes.</li>
  <li><b>Plane ▾</b> also holds <b>Axis</b> (along a straight edge, the axis of a cylinder or cone, or where two planes meet) and <b>Point</b> (a vertex, an arc centre, the centre of a face or the midpoint of an edge). They follow the model when it changes; hide them from the row menu.</li>
  <li><b>Coordinate system</b> (also under Plane ▾) takes an origin (a vertex or a reference point; the part origin if none), a Z direction and an X direction (edges, faces or axes; Y follows). Right-click it in the tree and choose <b>Use for measurements and export</b>: coordinates, ΔX/ΔY/ΔZ, the centre of mass and STL/OBJ/glTF exports are then given in it, and it follows the model when it changes.</li>
  <li>Press <b>S</b> over the view for the shortcut bar: the part commands, or the sketch tools while sketching. In a sketch, drag from empty space to box-select: left to right takes what is fully inside, right to left anything the box touches.</li>
  <li>Click a face or an edge of the part for the <b>context toolbar</b> by the cursor: Sketch and Normal to on a flat face, Fillet and Chamfer on an edge, and Edit sketch / Edit feature for the feature that made it. It fades as you move away.</li>
  <li><b>F5</b> or <b>Filter</b> opens the selection filter: turn faces, edges or vertices off so clicks pick only what you need, in measuring and modelling alike. Clear picks everything again. <b>Alt+click</b> selects the face hidden behind the one under the cursor; Alt+click again at the same spot for the next.</li>
  <li><b>Shell</b> hollows the body to a wall thickness; click the faces to leave open. <b>Linear pattern</b>, <b>Circular pattern</b> and <b>Mirror</b> (under the pattern ▾ button) copy features: click a face of a hole or boss (or its row in the tree), then an edge, face or axis for the direction, or a plane for the mirror. Copies that miss the body are skipped with a warning; list instances to leave out under Instances to skip.</li>
  <li><b>Hole</b> (hole wizard): click a flat face, then click where each hole goes (click a hole again to remove it). Pick Simple, Counterbore, Countersink or Tapped and an ISO size (M2–M24) to fill the sizes, or type your own. Tapped holes are drilled at the tap drill size and show a dashed cosmetic thread. <b>Heat-set insert</b> (M2–M8) makes the straight, flat-bottomed hole that common brass inserts for 3D-printed plastic ask for, 1 mm deeper than the insert, and tells you the least wall to leave around it.</li>
  <li><b>Draft</b>: pick the neutral plane (a flat face or a plane), then the faces to taper, and type the angle. The faces keep their size where they cross the neutral plane; Reverse direction tapers them the other way.</li>
  <li><b>Sketch Mirror</b>: select entities and the line to mirror about (a construction line wins), then click Mirror. The copies stay symmetric to the originals. <b>DXF</b> imports a drawing's lines, arcs, circles and polylines into the open sketch, in the file's units.</li>
  <li><b>Extrude options</b>: end conditions Offset from surface (stop short of a face or plane) and, for cuts, Through all - both; Draft tapers the sides inward or outward; Thin feature makes a wall along the profile (inside, outside or centred) instead of a solid. Revolve has the same Thin feature, Direction 2 and Up to face or plane (a plane through the axis).</li>
  <li><b>Up to next</b> stops at the next face the profile meets (for a boss, it fills the gap up to the body). <b>Up to vertex</b> ends level with a vertex or reference point. <b>Start from</b> moves the start of an extrude off the sketch plane: by an offset, to a parallel face or plane, or level with a vertex.</li>
  <li><b>Sketch patterns</b>: select entities and click Linear pattern (count and spacing in one or two directions) or Circular pattern (count and total angle about the origin, or about a point you also select). The green preview follows the values; the copies stay equal to the originals. Move, Rotate and Scale work the same way, in place or as copies.</li>
  <li><b>Planes and sketch visibility</b>: the Top, Front and Right planes are drawn faintly in the view; click one (off the model) to select it and get Sketch and Normal to. Hide or show them, and any sketch, from the tree's right-click menu: a sketch used by a feature is hidden until you show it. <kbd>N</kbd> (or Normal to under the views) looks square at the selected flat face, plane or the open sketch; press it again for the other side. In the Hole wizard, clicks snap to the origin and to model vertices, arc centres and midpoints on the face. Hovering a circle edge shows its centre, and a straight edge its midpoint, as a faint marker you can then pick. Cosmetic threads and tapped holes are shaded with a thread texture; tick Modelled (helical) thread in the thread's panel to cut the real thread into the part (for 3D printing). Measurements pinned in a part you are modelling are measured again after every change; one whose face or edge is gone is marked out of date.</li>
  <li><b>Vault</b>: the Vault tab keeps every version of your files. Create a vault in the browser (or in a folder, in Chrome and Edge), then Save part to vault or Add files. A vaulted file is read-only until you Check out; Check in with a comment makes the next version. History opens old versions and rolls back (as a new version); the Audit trail lists every action, and the Integrity check verifies the stored versions. Export ZIP backs the vault up (Import vault ZIP restores it, in any browser); Storage shows the space used and purges old versions.</li>
  <li><b>Vault lifecycle</b>: every vault file has a state (Work in progress, In review, Released, Change pending, Obsolete). Change state moves it: Submit for review, then Approve gives the next revision (A, B, C …) and writes it into the part's properties; Change reopens a released file for the next revision. Only files in Work in progress or Change pending can be checked out. Data card edits the part number, description, material and other fields (New number takes the next one from the numbering scheme). Contains and Where used show which files use which, with a bill of materials; History compares two versions (data card, features, parameters). Rename / move updates the files that use it, Copy tree copies an assembly with chosen parts under new names, Delete goes to the Recycle bin. Search finds files by name, any field, state or revision, and saves searches. Vault settings set the revision scheme, numbering, data card fields and user roles.</li>
  <li><b>Vault teamwork</b>: Request change… on a file starts a change request (ECO) with a reason and the affected files. Change orders lists them: Approve moves released files to Change pending, and Close and release takes them through review to a new revision together, records the order's number and keeps a release package. Release packages export the released versions as a ZIP with a list. Notifications show what others did since your last visit and what was addressed to you. Workflow edits the states and transitions (revision, role, comment, required fields), and exports or imports them as JSON. In a shared vault on a synced folder, the earliest check-out wins, a check-in over a newer version is refused (save your work as a new file or discard it), and an Admin can break a stale lock.</li>
  <li><b>Folders and freeze bar</b>: right-click a feature to put it in a folder (click the folder to open or close it) or to freeze the part up to it; frozen features are not rebuilt until you unfreeze them. The box above the tree filters features by name. Fillet and Chamfer pick the whole tangent chain of a clicked edge (Tangent propagation). Right-click an edge while picking them for Select loop (the face boundary through it), Select tangency, or the edges of the same size (all holes of one radius, say). <b>Multiple radius fillet</b> gives each edge its own radius: type it in the edge list or click the edge's callout.</li>
  <li><b>Cosmetic thread</b>: click a round edge of a hole or shaft; the nearest ISO size is filled in and the thread is drawn as dashed circles, without changing the geometry. In the Hole panel, Save as favourite keeps a hole definition to reuse.</li>
  <li><b>Equations</b> (Σ at the top of the Features tree): global variables, like Width = 80 or Holes = 4, that any value box can use by name (Width/2). Sketch dimensions are named like D1@Sketch1 and can drive other values too. Change a variable and everything that uses it rebuilds; the panel lists every equation in the part.</li>
  <li><b>Configurations</b> (◇ at the top of the tree): variants of the part, such as long and short. Each keeps its own dimension and parameter values, variables, suppressed features and material. Add one, change values while it is active, and click ○ to switch.</li>
  <li><b>Reorder</b>: drag a feature in the tree onto another (upper half: before it, lower half: after it), or press Alt+↑/↓. A move that would put a feature before something it uses is refused with the reason. With a feature selected, ↑ marks what it uses and ↓ what uses it.</li>
  <li><b>Revolve</b> turns a sketch around one of its lines (a construction line is taken first), by any angle.</li>
  <li><b>Fillet</b> and <b>Chamfer</b>: click edges, or a face for all its edges (or pick an edge first), and set the size. A chamfer can use two distances or a distance and an angle; <b>Keep features that fit</b> skips edges a fillet cannot round.</li>
  <li><b>Fillet type</b>: a <b>Face fillet</b> rounds the edges where face set 1 meets face set 2; a <b>Full round fillet</b> turns the centre faces between two parallel side faces into a half round touching both (pick side 1, centre, side 2).</li>
  <li>The view shows the result while you type; ✓ or <kbd>Enter</kbd> keeps it, ✕ or <kbd>Esc</kbd> cancels.</li>
  <li>Double-click a feature in the tree to edit it. Later features follow the faces and edges they were built on. A row's buttons suppress or delete it; deleting asks before taking dependent features too.</li>
  <li>Right-click a row (or Shift+F10) for more: edit, rename (F2), suppress, roll back. Drag the blue <b>rollback bar</b> (or focus it and use the arrow keys) to look at the part at an earlier step; new features go in at the bar.</li>
  <li>Double-click the part name for its properties: part number, description, revision, material and colour. The mass panel then uses the material and lists the principal moments of inertia. <b>Override mass properties</b> enters the real mass and centre of mass of a purchased part.</li>
  <li><b>Snapshots</b>: every save keeps a snapshot of the part in this browser (the last 20). Open them from the ▾ next to Save to restore one or open it as a copy.</li>
</ul>
<h4>Files</h4>
<ul>
  <li><b>Save</b> (<kbd>Ctrl</kbd>+<kbd>S</kbd>) writes a <code translate="no">.mcadprt</code> part file; open it again with Open. <b>STEP</b> exports the solid for other CAD programs.</li>
  <li>Unsaved changes are kept in the browser: after a crash or a closed tab the start screen offers to recover them.</li>
  <li>All the measuring, section, mass and export tools work on the part as on an opened model.</li>
</ul>`,
  },
  {
    id: "keys", title: "Shortcuts",
    html: `
<h4>3D model</h4>
${table([
  ["Left-drag / Right-drag / Wheel", "Orbit / pan / zoom to the cursor"],
  ["F , 0", "Fit, isometric view"],
  ["1 – 5", "Display modes"],
  ["P / O", "Perspective / orthographic"],
  ["N", "Normal to the selected flat face or the sketch (again: the other side)"],
  ["D M R C L A V B T", "Point–point, min distance, radius, centre–centre, length, angle, point, bounding box, note"],
  ["I / H / U", "Isolate / hide the selected part / show all"],
  ["Del", "Delete the selected measurement"],
  ["Esc", "Cancel the tool, clear the selection"],
])}
<h4>Part modelling</h4>
${table([
  ["S", "Shortcut bar at the cursor: the sketch tools, or the part commands"],
  ["F5", "Selection filter: faces, edges, vertices"],
  ["Alt+click", "Select other: the next face behind the cursor"],
  ["L R C A P D", "Sketch: line, rectangle, circle, arc, point, dimension (Esc: back to select)"],
  ["G T F", "Sketch: polygon, trim, fillet"],
  ["E O W", "Sketch: extend, offset entities, slot"],
  ["F2", "Rename the selected feature"],
  ["Ctrl+B / Ctrl+Q", "Rebuild / force rebuild of all features"],
  ["Ctrl+1 … Ctrl+7", "Front, back, left, right, top, bottom, isometric view"],
  ["Ctrl+8", "Normal to the sketch or the selected face (again: the other side)"],
  ["Q", "Construction geometry on / off"],
  ["Enter / Esc", "OK (leave the sketch) / cancel"],
  ["Ctrl+Z / Ctrl+Y", "Undo / redo"],
  ["Ctrl+S", "Save the part"],
])}
<h4>PCB</h4>
${table([
  ["Wheel / Drag , Space+drag", "Zoom to the cursor / pan"],
  ["Q M C L A", "Smart, point–point, clearance, polyline, area"],
  ["Enter , Backspace", "Finish a polyline or area, remove the last point"],
  ["Shift+click", "Area of a pad, region or closed outline"],
  ["P / Del", "Pin the Smart result / delete the selected measurement"],
  ["F , B , + / −", "Fit, bottom view, zoom"],
  ["Alt+↑ / Alt+↓", "Move the focused layer up / down"],
  ["2 / 3", "Flat layers / 3D board"],
])}
<h4>Everywhere</h4>
${table([
  ["Ctrl+O", "Open files"],
  ["Ctrl+[ / Ctrl+]", "Hide or show the left / right panel (⌘ on macOS)"],
  ["F1 / ?", "This help"],
  ["Tab , Shift+Tab , Enter , Space", "Move between controls and press them"],
])}`,
  },
  { id: "about", title: "About", html: about("en") },
];

const RU: Tab[] = [
  {
    id: "start", title: "Начало",
    html: `
<p><strong>MöbiusCAD</strong> открывает 3D-модели САПР и печатные платы прямо в браузере. Файлы читаются на вашем компьютере и никуда не загружаются.</p>
<h4>Открытие файлов</h4>
<ul>
  <li><b>Открыть файл</b> (<kbd>Ctrl</kbd>+<kbd>O</kbd>) или перетащите файлы в окно.</li>
  <li><b>3D-модели</b>: STEP (AP203, AP214, AP242), IGES и BREP. Качество сетки (черновое, обычное, точное) в меню <b>Отображение</b> применяется к следующему открытому файлу.</li>
  <li><b>SolidWorks</b>: детали (.sldprt) и сборки (.sldasm) читаются как точная геометрия, поэтому с ними работают все инструменты и экспорт в STEP. Перетащите сборку вместе с файлами деталей или целую папку; недостающие детали перечисляются и пропускаются. Если в файле нет читаемой геометрии, показывается его эскиз из SolidWorks.</li>
  <li><b>Сеточные файлы</b>: STL, OBJ и 3MF. В них только треугольники, поэтому MöbiusCAD сначала собирает их в плоские и кривые грани; отверстия, цилиндры и сферы всё равно распознаются, но точных значений и экспорта в STEP нет. Размеры читаются в миллиметрах.</li>
  <li><b>Печатные платы</b>: слои Gerber RS-274X / X2, файлы сверловки Excellon или .zip с полным комплектом. Откройте несколько файлов сразу, чтобы увидеть их как одну плату.</li>
</ul>
<h4>Устройство экрана</h4>
<ul>
  <li><b>Заголовок</b>: открытие файла, имя и состояние открытого файла, управление видом, язык (EN / RU), тема и эта справка.</li>
  <li><b>Левая панель</b>: дерево модели или слои платы и список сохранённых измерений. Скрыть: <kbd>Ctrl</kbd>+<kbd>[</kbd>.</li>
  <li><b>Инструменты</b> (3D-модель, в заголовке): все инструменты измерения и страницы правой панели (Свойства, Сечение, Разнести, Масса, Экспорт), всегда на виду, рядом с режимами отображения, проекцией и «Вписать». Единицы, знаки, цвет измерения, качество сетки, оси и затенение — в меню <b>Отображение</b>. Наведите на значок, чтобы увидеть название и клавишу; в узком окне инструменты переходят во вторую строку.</li>
  <li><b>Правая панель</b>: страница, выбранная в заголовке; повторный щелчок по открытой странице скрывает панель, также <kbd>Ctrl</kbd>+<kbd>]</kbd>. На телефоне панели платы открываются с нижней панели.</li>
  <li><b>Строка состояния</b>: настройки привязки, найденная точка и её координаты.</li>
</ul>
<h4>Язык</h4>
<p>Кнопка <b>EN / RU</b> в заголовке переключает интерфейс между английским и русским; выбор запоминается. PDF-отчёты и экспорт CSV / JSON остаются на английском, чтобы одинаково читаться везде.</p>`,
  },
  {
    id: "model", title: "3D-модель",
    html: `
<h4>Вид</h4>
<ul>
  <li>Левая кнопка мыши вращает, правая сдвигает, колесо масштабирует к курсору. Куб в углу поворачивает вид к грани или углу.</li>
  <li><b>Режимы отображения</b>: тонировка с рёбрами, тонировка, каркас, HLR (без невидимых линий) и рентген; проекция <b>Персп.</b> / <b>Орто</b>; стандартные виды: вписать, изометрия, спереди, сверху, справа.</li>
  <li>Меню <b>Отображение</b> в заголовке: <b>Оси начала координат</b> показывают X, Y, Z от начала координат модели; <b>Затенение</b> добавляет мягкие тени в углах и зазорах (медленнее на больших моделях, при сечении выключено).</li>
</ul>
<h4>Дерево модели и свойства</h4>
<ul>
  <li>Щёлкните деталь в дереве или на модели, чтобы выбрать её; двойной щелчок приближает к ней. Кнопка-глаз скрывает или показывает деталь.</li>
  <li>Фильтр принимает имя или условие: <code>size&gt;50</code>, <code>vol&lt;1000</code> (в текущих единицах).</li>
  <li><b>Свойства</b> показывают заголовок файла (протокол, автор, PMI), размер, объём и площадь детали, а также выбранную грань или ребро. Там же деталь можно изолировать, скрыть, перекрасить или сделать прозрачной.</li>
</ul>
<h4>Точная геометрия</h4>
<p>Модель открывается по сетке, так что измерять можно сразу. В фоне полное ядро OpenCASCADE (около 15 МБ, загружается один раз, дальше браузер берёт его из кэша) читает файл ещё раз; когда в строке состояния появится <b>● Точная геометрия</b>, объёмы, масса, площади, длины рёбер и кривых, радиусы, углы конусов и кривизна берутся из настоящих поверхностей и кривых B-rep. Ничего включать не нужно.</p>
<h4>Сечение</h4>
<p>Нажмите <b>Сечение</b> в заголовке и щёлкните грань: плоская грань задаёт секущую плоскость по ней, цилиндр режется по своей оси. Также можно добавить до трёх секущих плоскостей: параллельно XY, YZ или XZ, по выбранной плоской грани, через три указанные точки или перпендикулярно взгляду. Новая плоскость показывается полупрозрачной с двумя стрелками по нормали: тяните любую из них, чтобы двигать разрез через модель (<b>↕</b> возвращает стрелки, <b>⟳</b> меняет их на кольца поворота, Esc скрывает), либо введите смещение и углы. Заглушки закрашивают разрез (со штриховкой ANSI31, по желанию цветом детали), а к линиям разреза можно привязываться при измерениях. <b>Привязка только к разрезу</b> ограничивает привязку сечением. Кнопки <b>DXF</b> и <b>SVG</b> у плоскости сохраняют линии разреза как 2D-чертёж в миллиметрах с настоящими окружностями и дугами (у плоскостей XY, YZ и XZ сохраняются мировые оси).</p>
<h4>Разнесённый вид, масса и экспорт</h4>
<ul>
  <li><b>Разнесённый вид</b> раздвигает детали ползунком; <b>Переместить деталь</b> двигает одну деталь манипулятором.</li>
  <li><b>Массовые характеристики</b>: выберите материал или введите плотность и получите объём, массу, площадь, центр масс и габариты видимых или выбранных деталей.</li>
  <li><b>Экспорт</b>: <b>STEP</b> (вся модель со сборкой, именами и цветами или только видимые детали), PNG (в том числе прозрачный, 2×–4×), STL, OBJ, glTF и PDF-отчёт контроля с видом, данными модели, массой и измерениями.</li>
</ul>`,
  },
  {
    id: "measure", title: "Измерения",
    html: `
<h4>Умное измерение (по умолчанию)</h4>
<p>Щёлкните точку, ребро или грань, чтобы увидеть размер: диаметр отверстия, длину ребра, площадь грани, объём детали. Щёлкните второй элемент, чтобы получить связь между ними: расстояние, шаг, угол, зазор или смещение. Результат держится до следующего щелчка; <b>📌 Закрепить</b> сохраняет его в списке. <kbd>Esc</kbd> сбрасывает.</p>
<ul>
  <li>Значение показано на модели, подробности в карточке результата. Щёлкните любое значение в карточке, чтобы скопировать его.</li>
  <li>Для двух отверстий или окружностей карточка переключает <b>Центр–центр</b>, <b>Минимум</b> (кромка–кромка) и <b>Максимум</b> (общий размер).</li>
  <li><b>✂ Сечение здесь</b> режет по выбранной плоской грани; <b>⬚ Вся деталь</b> показывает размер и объём детали; <b>⌖ СК здесь</b> делает выбранную грань, ребро, окружность или вершину системой координат для всех координат и ΔX / ΔY / ΔZ.</li>
</ul>
<h4>Отдельные инструменты</h4>
<table class="keys">
  <tr><td>↔ Точка–точка <kbd>D</kbd></td><td>Расстояние между двумя точками, с ΔX, ΔY, ΔZ</td></tr>
  <tr><td>⇤ Мин. расстояние <kbd>M</kbd></td><td>Кратчайшее расстояние между точками, рёбрами или гранями</td></tr>
  <tr><td>R Радиус <kbd>R</kbd> · Ø Диаметр</td><td>Окружности, дуги, цилиндра или сферы</td></tr>
  <tr><td>⊙ Центр–центр <kbd>C</kbd></td><td>Расстояние между центрами отверстий или шаг между параллельными осями</td></tr>
  <tr><td>⌒ Длина ребра <kbd>L</kbd></td><td>Длина прямого или криволинейного ребра, для дуг с радиусом и углом</td></tr>
  <tr><td>∠ Угол <kbd>A</kbd> · ∡ Угол по 3 точкам</td><td>Между рёбрами или гранями либо через три точки</td></tr>
  <tr><td>⊕ Точка / нормаль <kbd>V</kbd></td><td>Координаты точки и нормаль к поверхности в ней</td></tr>
  <tr><td>▭ Габариты <kbd>B</kbd></td><td>Общий размер видимых или выбранных деталей</td></tr>
  <tr><td>✎ Заметка <kbd>T</kbd></td><td>Текстовая заметка с выноской к точке на модели. Перетащите рамку, чтобы сдвинуть её, двойной щелчок меняет текст; заметки видны в PNG и PDF-отчёте</td></tr>
</table>
<h4>Привязка, единицы и результаты</h4>
<ul>
  <li>Курсор привязывается к вершинам, серединам, центрам (а также к квадрантам дуг и виртуальным углам) и рёбрам; типы привязки включаются в строке состояния.</li>
  <li><b>Единицы</b> (mm, cm, m, in, ft) и <b>Знаки</b> меняют сразу все значения, в том числе в карточке результата.</li>
  <li>Сохранённые измерения хранятся для каждого файла в этом браузере. Их можно выгрузить в CSV, JSON или PDF-отчёт; <b>Очистить всё</b> сначала спрашивает подтверждение.</li>
</ul>`,
  },
  {
    id: "pcb", title: "Плата",
    html: `
<h4>Слои</h4>
<ul>
  <li>Слои распознаются по атрибутам Gerber X2 или по именам файлов (медь, паяльная маска, шелкография, паста, контур, сверловка) и окрашиваются по типу.</li>
  <li>Слой можно скрыть или показать, сменить цвет и перетащить (или <kbd>Alt</kbd>+<kbd>↑</kbd> / <kbd>↓</kbd>), чтобы изменить порядок; верхний в списке рисуется поверх.</li>
  <li><b>Вид снизу</b> зеркалит плату, как если смотреть снизу. <b>2D</b> / <b>3D</b> переключает плоские слои и 3D-плату с толщиной, отверстиями, маской и шелкографией.</li>
</ul>
<h4>Измерения на плате</h4>
<table class="keys">
  <tr><td>✦ Умное <kbd>Q</kbd></td><td>Щелчок по площадке, дорожке, отверстию или полигону даёт размер, цепь и апертуру; второй щелчок даёт шаг и зазор</td></tr>
  <tr><td>↔ Точка–точка <kbd>M</kbd></td><td>Две точки с ΔX / ΔY; привязка к углам, центрам площадок и краям дорожек</td></tr>
  <tr><td>⇤ Зазор <kbd>C</kbd></td><td>Зазор кромка–кромка между двумя объектами</td></tr>
  <tr><td>⌇ Ломаная <kbd>L</kbd></td><td>Длина пути; <kbd>Enter</kbd> или двойной щелчок завершает, <kbd>Backspace</kbd> убирает последнюю точку</td></tr>
  <tr><td>▱ Площадь <kbd>A</kbd></td><td>Площадь указанного многоугольника; <kbd>Shift</kbd>+щелчок по площадке, полигону или замкнутому контуру даёт его площадь</td></tr>
</table>
<ul>
  <li>Единицы для плат: mm, in или mil. <kbd>P</kbd> закрепляет результат умного измерения; список выгружается в CSV, вид в PNG или SVG.</li>
  <li><b>Плата</b> показывает размер, статистику меди и отверстий. <b>Измерить как 3D-модель</b> открывает тело платы в 3D-инструментах (толщина, диаметры отверстий, сечения, масса, STL); <b>Назад к плате</b> возвращает. <b>STEP</b> в разделе «Экспорт» сохраняет тело платы как твёрдое тело с настоящими круглыми отверстиями для механической САПР.</li>
</ul>`,
  },
  {
    id: "model", title: "Моделирование",
    html: `
<p><b>Новая деталь</b> (значок страницы рядом с «Открыть» или на начальном экране) начинает параметрическую деталь: эскизы и элементы в истории, которую можно менять в любой момент. Они перечислены на вкладке <b>Элементы</b> слева; команды на панели над видом.</p>
<h4>Эскиз</h4>
<ul>
  <li><b>Эскиз</b>, затем выберите <b>Сверху (XY)</b>, <b>Спереди (XZ)</b>, <b>Справа (YZ)</b> или плоскую грань детали (грань, выбранная умным измерением, берётся сразу). Вид поворачивается к эскизу.</li>
  <li>Рисуйте инструментами <b>Отрезок</b>, <b>Прямоугольник</b>, <b>Прямоугольник от центра</b>, <b>Окружность</b>, <b>Окружность по 3 точкам</b>, <b>Дуга</b>, <b>Дуга по 3 точкам</b>, <b>Многоугольник</b> (число сторон на панели) и <b>Точка</b>. <b>Отсечь</b> (T) удаляет щёлкнутый участок кривой до пересечений с другими; <b>Скругление</b> (F) скругляет угол двух отрезков радиусом с панели. Точки привязываются к концам, центрам, кривым и началу координат; взаимосвязи горизонтальности, вертикальности и совпадения добавляются при рисовании.</li>
  <li>Кнопки со значком <b>▾</b> объединяют родственные инструменты (прямоугольник, окружность, дуга, отсечение, скругление, смещение); на кнопке остаётся последний выбранный. <b>Паз</b> (W): щёлкните оба центра, затем ширину. <b>Эллипс</b> (в меню «Окружность ▾»): щёлкните центр, конец большой оси, затем точку на эллипсе; <b>частичный эллипс</b> добавляет начало и конец, против часовой стрелки. Размеры эллипса ставятся от центра до точек его осей. <b>Сплайн</b> (в меню «Отрезок ▾»): щёлкайте точки, через которые он проходит; двойной щелчок завершает его, повторный щелчок по первой точке замыкает. Перетаскивайте точки, чтобы изменить форму. <b>Удлинить</b> (E) продлевает отрезок или дугу до следующей кривой; <b>Разбить</b> делит её на две в месте щелчка; <b>Фаска</b> в эскизе срезает угол двух отрезков. <b>Смещение объектов</b> (O): наведите курсор на нужную сторону и щёлкните кривую; цепочка соединённых отрезков и дуг смещается целиком, углы сопрягаются заново. <b>Преобразование объектов</b> копирует щёлкнутые рёбра модели (или все рёбра грани) в эскиз и фиксирует их. <b>Кривая пересечения</b> (в меню «Смещение ▾») добавляет и фиксирует кривые, по которым плоскость эскиза пересекает щёлкнутые грани: отрезки на плоских гранях, окружности и дуги на круглых гранях, перпендикулярных эскизу, сплайны на остальных.</li>
  <li><b>Размер</b>: щёлкните отрезок, окружность или дугу (или два элемента), затем место для значения и введите его. Можно писать единицы и арифметику: <code>25,4 мм</code>, <code>1 дюйм</code> как <code translate="no">1in</code>, <code>100/3</code>, <code>30°</code>. Двойной щелчок по размеру меняет его. Размер от точки (или параллельной линии) до вспомогательной линии (осевой), начиная с точки и поставленный по другую сторону осевой, становится диаметром ⌀, как для профиля вращения. Горизонтальный и вертикальный ординатный размер (в меню Размер ▾) задают ряд точек от одной базы: щёлкните базу, место для значений, затем каждую точку.</li>
  <li>Выберите элементы (Ctrl+щелчок добавляет), чтобы добавить взаимосвязи на панели: параллельность, перпендикулярность, равенство, касательность, концентричность, середина, симметричность, фиксация. <b>Вспомогательная</b> (Q) делает отрезки справочной геометрией, например осью вращения.</li>
  <li>Панель перечисляет взаимосвязи эскиза: щелчок выбирает, ✕ удаляет.</li>
  <li>Цвета: синее ещё может двигаться, чёрное полностью определено, красное переопределено. Панель показывает оставшиеся степени свободы. Выберите элемент: оранжевые стрелки покажут, куда он ещё может двигаться. Перетащите геометрию, чтобы проверить.</li>
  <li>Если эскиз переопределён, <b>Помощник эскиза</b> на панели перечисляет взаимосвязи и размеры, удаление которых снова делает его решаемым. <b>Показать</b> выделяет их в эскизе, <b>Удалить</b> убирает их.</li>
  <li>Две выбранные точки можно соединить кнопкой <b>Объединить точки</b>: вторая всюду заменяется первой. Выберите точку и две кривые для взаимосвязи <b>Пересечение</b>: точка остаётся там, где они пересекаются.</li>
  <li><b>Преобразование объектов</b> копирует рёбра модели в эскиз со взаимосвязью <b>На ребре</b>: при изменении модели кривые следуют за своими рёбрами. Если ребро исчезло, взаимосвязь становится <b>висячей</b> (оливковой): перетащите её значок на другое ребро, нажмите <b>Присоединить заново</b> на панели или удалите взаимосвязь, чтобы кривая стала свободной. Правый щелчок по эскизу в дереве, <b>Изменить плоскость эскиза</b>, переносит его на другую плоскость или грань.</li>
  <li>Наведите указатель на размер, чтобы увидеть его полное имя, например <code>D1@Sketch1</code>: его можно использовать в уравнениях и других значениях. Выберите один размер, чтобы переименовать его на панели (выражения меняются вместе с ним); <b>Показывать имена размеров</b> выводит имена на эскиз. Перетащите значение размера, чтобы переместить текст.</li>
  <li>✓ или <kbd>Enter</kbd> выходит из эскиза; ✕ спрашивает, прежде чем отменить изменения.</li>
</ul>
<h4>Элементы</h4>
<ul>
  <li><b>По траектории ▾</b> содержит элементы По траектории, Вырез по траектории, По сечениям, Вырез по сечениям и Спираль. <b>Спираль</b> начинается на окружности эскиза и идёт вдоль его нормали: шаг и витки, высота и витки или высота и шаг, с начальным углом, направлением по часовой стрелке, обратным направлением и конусностью. <b>По траектории</b> проводит замкнутый профиль из эскиза или окружность заданного диаметра (круговой профиль, для пружин, проводов и труб) вдоль траектории: спирали или цепочки кривых эскиза; профиль следует траектории или сохраняет нормаль. <b>По сечениям</b> соединяет два или больше замкнутых профилей по порядку (обычно на параллельных плоскостях), плавно или прямыми сечениями, с возможностью замкнуть на первый.</li>
  <li><b>Ребро</b> (в меню По траектории ▾) делает из открытой цепочки линий или дуг эскиза стенку до тела: толщина на первую сторону, на обе или на вторую; <b>Параллельно эскизу</b> растит его в плоскости эскиза (обычная косынка в углу, эскиз на плоскости через деталь), <b>Перпендикулярно эскизу</b> — вдоль нормали (рёбра поперёк полости, эскиз над ней). Оно идёт туда, где встречает тело; <b>Сменить сторону материала</b> сначала пробует другую сторону.</li>
  <li><b>Линия разъёма</b> (в меню По траектории ▾) проецирует эскиз вдоль его нормали в обе стороны и делит грани, которые он пересекает (или только выбранные), чтобы каждой части можно было задать свой цвет, уклон или сопряжение. Форма тела не меняется.</li>
  <li><b>Несколько тел</b>: снимите <b>Объединить результат</b> у вытягивания или вращения, чтобы создать новое тело. <b>Комбинировать</b> складывает тела, вычитает тела-инструменты из основного или оставляет общее; <b>Разбить</b> режет тела плоскостью на отдельные тела; <b>Переместить/копировать тело</b> сдвигает и поворачивает тела (или копирует их); <b>Удалить/сохранить тело</b> убирает тела. Тело выбирается щелчком по любой его грани.</li>
  <li>Папка <b>Твёрдые тела</b> вверху дерева: у каждого тела показ/скрытие, цвет и удаление; двойной щелчок переименовывает. Скрытые тела пропадают из вида, но учитываются в массовых характеристиках.</li>
  <li><b>Вставить тело</b> (Sweep ▾): файл STEP, IGES или BREP добавляется в деталь как импортированный элемент и хранится в файле детали. <b>Проверить и исправить</b> сшивает грани, рёбра которых ближе допуска, и замыкает их в твёрдые тела; панель показывает свободные рёбра и корректность до и после.</li>
  <li><b>Масштаб</b> (Sweep ▾): масштабирует выбранные тела (все, если ничего не выбрано) относительно их центра масс или начала координат, одним коэффициентом или по осям.</li>
  <li><b>Вытягивание</b> и <b>Вырез</b> строятся по замкнутому эскизу: на глубину, от средней плоскости, насквозь или до грани или плоскости, со вторым направлением и обратным направлением. Вырез идёт в материал; <b>Сменить сторону выреза</b> оставляет то, что внутри контура.</li>
  <li>Перетащите оранжевую стрелку на модели, чтобы задать глубину мышью (Shift: мельче шаг). Выберите вытягивание в дереве и тяните его стрелку, чтобы сразу изменить его.</li>
  <li>У вращения есть оранжевый маркер в конце дуги: тяните его вокруг оси, чтобы задать угол (шаг 1°, Shift: 0,1°). Вырез, пока он открыт, показывает удаляемый материал полупрозрачным жёлтым телом.</li>
  <li><b>Плоскость</b> создаёт справочную плоскость со смещением от плоскости или плоской грани либо под углом вокруг прямого ребра. На ней можно рисовать эскиз, как на стандартных плоскостях.</li>
  <li>В меню <b>Плоскость ▾</b> есть также <b>Ось</b> (вдоль прямого ребра, по оси цилиндра или конуса или на пересечении двух плоскостей) и <b>Точка</b> (вершина, центр дуги, центр грани или середина ребра). Они следуют за моделью при изменениях; скрыть их можно из меню строки.</li>
  <li><b>Система координат</b> (тоже в Плоскость ▾) задаётся началом (вершина или справочная точка; без него начало координат детали), направлением Z и направлением X (рёбра, грани или оси; Y следует из них). Щёлкните её правой кнопкой в дереве и выберите <b>Использовать для измерений и экспорта</b>: координаты, ΔX/ΔY/ΔZ, центр масс и экспорт STL/OBJ/glTF будут даны в ней, и она следует за моделью при изменениях.</li>
  <li>Нажмите <b>S</b> над видом — появится панель быстрого доступа: команды детали или, в эскизе, инструменты эскиза. В эскизе протяните рамку с пустого места: слева направо выбирается то, что целиком внутри, справа налево — всё, чего касается рамка.</li>
  <li>Щелчок по грани или ребру детали открывает у курсора <b>контекстную панель</b>: «Эскиз» и «Перпендикулярно» на плоской грани, «Скругление» и «Фаска» на ребре, а также «Изменить эскиз» / «Изменить элемент» для создавшего её элемента. Панель гаснет, когда курсор уходит.</li>
  <li><b>F5</b> или кнопка <b>«Фильтр»</b> открывает фильтр выбора: отключите грани, рёбра или вершины, чтобы щелчок выбирал только нужное — и при измерении, и при моделировании. «Сбросить» снова разрешает всё. <b>Alt+щелчок</b> выбирает грань, скрытую за гранью под курсором; повторный Alt+щелчок в том же месте — следующую.</li>
  <li><b>Оболочка</b> делает тело полым с заданной толщиной стенки; щёлкните грани, которые останутся открытыми. <b>Линейный массив</b>, <b>Круговой массив</b> и <b>Зеркальное отражение</b> (кнопка массива ▾) копируют элементы: щёлкните грань отверстия или бобышки (или строку в дереве), затем ребро, грань или ось для направления либо плоскость для отражения. Копии вне тела пропускаются с предупреждением; ненужные экземпляры перечислите в поле «Пропускаемые экземпляры».</li>
  <li><b>Отверстие</b> (мастер отверстий): щёлкните плоскую грань, затем места отверстий (повторный щелчок убирает отверстие). Выберите простое, с цековкой, с зенковкой или резьбовое и размер ISO (M2–M24) — размеры заполнятся сами, или введите свои. Резьбовые отверстия сверлятся под резьбу и показывают условную резьбу пунктиром. <b>Термовставка</b> (M2–M8) делает прямое отверстие с плоским дном под распространённые латунные вставки для печатного пластика, на 1 мм глубже вставки, и подсказывает наименьшую стенку вокруг.</li>
  <li><b>Уклон</b>: выберите нейтральную плоскость (плоскую грань или плоскость), затем грани и введите угол. Грани сохраняют размер там, где пересекают нейтральную плоскость; «Обратное направление» наклоняет их в другую сторону.</li>
  <li><b>Зеркало в эскизе</b>: выберите объекты и линию отражения (вспомогательная линия в приоритете) и нажмите «Зеркало». Копии остаются симметричными оригиналам. <b>DXF</b> импортирует отрезки, дуги, окружности и полилинии чертежа в открытый эскиз в единицах файла.</li>
  <li><b>Параметры вытягивания</b>: граничные условия «На расстоянии от поверхности» (не доходя до грани или плоскости) и, для вырезов, «Насквозь в обе стороны»; «Уклон» сужает или расширяет боковые грани; «Тонкостенный элемент» делает стенку вдоль контура (внутрь, наружу или по центру) вместо сплошного тела. У поворота есть такие же «Тонкостенный элемент», «Направление 2» и «До поверхности или плоскости» (плоскость через ось).</li>
  <li><b>До следующей</b> останавливается на следующей грани на пути профиля (бобышка заполняет зазор до тела). <b>До вершины</b> заканчивается на уровне вершины или вспомогательной точки. <b>Начать от</b> переносит начало вытягивания с плоскости эскиза: на смещение, на параллельную грань или плоскость или на уровень вершины.</li>
  <li><b>Массивы в эскизе</b>: выберите объекты и нажмите «Линейный массив» (число и шаг в одном или двух направлениях) или «Круговой массив» (число и общий угол вокруг начала координат или выбранной точки). Зелёный предпросмотр следует за значениями; копии остаются равными оригиналам. «Переместить», «Повернуть» и «Масштаб» работают так же, на месте или с копированием.</li>
  <li><b>Плоскости и видимость эскизов</b>: плоскости «Сверху», «Спереди» и «Справа» показаны в виде бледно; щёлкните одну (вне модели), чтобы выбрать её и получить «Эскиз» и «Нормально к». Скрыть или показать их, как и любой эскиз, можно из контекстного меню дерева: эскиз, использованный элементом, скрыт, пока вы его не покажете. <kbd>N</kbd> (или «Нормально к» среди видов) разворачивает вид перпендикулярно выбранной плоской грани, плоскости или открытому эскизу; повторно — с другой стороны. В мастере отверстий щелчки привязываются к началу координат и к вершинам, центрам дуг и серединам рёбер модели на грани. При наведении на круглую кромку показывается её центр, на прямую — середина; к этой бледной метке затем можно привязаться. Условная резьба и резьбовые отверстия показаны текстурой резьбы; флажок «Моделированная (винтовая) резьба» в панели резьбы вырезает настоящую резьбу в детали (для 3D-печати). Измерения, закреплённые в моделируемой детали, пересчитываются после каждого изменения; если их грань или кромка исчезла, измерение помечается как устаревшее.</li>
  <li><b>Хранилище</b>: вкладка «Хранилище» сохраняет все версии файлов. Создайте хранилище в браузере (или в папке, в Chrome и Edge), затем «Сохранить деталь в хранилище» или «Добавить файлы». Файл в хранилище доступен только для чтения, пока вы его не извлечёте; «Зарегистрировать» с комментарием создаёт следующую версию. «История» открывает старые версии и откатывает к ним (новой версией); журнал аудита показывает все действия, а проверка целостности проверяет сохранённые версии. «Экспорт архива» делает резервную копию («Импорт хранилища из архива» восстанавливает её в любом браузере); «Место» показывает занятый объём и очищает старые версии.</li>
  <li><b>Жизненный цикл в хранилище</b>: у каждого файла есть состояние («В работе», «На проверке», «Выпущен», «Изменяется», «Аннулирован»). «Сменить состояние» переводит его: «На проверку», затем «Утвердить» даёт следующую редакцию (A, B, C …) и записывает её в свойства детали; «Изменить» открывает выпущенный файл для следующей редакции. Извлечь можно только файлы «В работе» и «Изменяется». «Карточка» правит обозначение, наименование, материал и другие поля («Новый номер» берёт следующий по схеме нумерации). «Состав» и «Где используется» показывают, какие файлы где применены, со спецификацией; «История» сравнивает две версии (карточка, элементы, параметры). «Переименовать / переместить» обновляет ссылающиеся файлы, «Копировать дерево» копирует сборку с выбранными деталями под новыми именами, удалённое попадает в «Корзину». «Поиск» находит файлы по имени, любому полю, состоянию или редакции и сохраняет поиски. В «Настройках хранилища» задаются схема редакций, нумерация, поля карточки и роли пользователей.</li>
  <li><b>Совместная работа в хранилище</b>: «Запросить изменение…» на файле создаёт запрос на изменение с причиной и затрагиваемыми файлами. «Извещения об изменении» показывают их: «Утвердить» переводит выпущенные файлы в «Изменяется», а «Закрыть и выпустить» проводит их через проверку к новой редакции вместе, записывает номер извещения и сохраняет комплект выпуска. «Комплекты выпуска» выгружают выпущенные версии архивом со списком. «Уведомления» показывают, что сделали другие с вашего прошлого визита и что адресовано вам. «Процесс» редактирует состояния и переходы (редакция, роль, комментарий, обязательные поля) и сохраняет или загружает их в JSON. В общем хранилище в синхронизируемой папке побеждает тот, кто извлёк раньше; регистрация поверх более новой версии отклоняется (сохраните работу как новый файл или отбросьте её), а администратор может снять устаревшую блокировку.</li>
  <li><b>Папки и полоса заморозки</b>: щёлкните элемент правой кнопкой, чтобы положить его в папку (щелчок по папке открывает и закрывает её) или заморозить деталь до него; замороженные элементы не перестраиваются, пока вы их не разморозите. Поле над деревом фильтрует элементы по имени. Скругление и фаска выбирают всю цепочку касательных рёбер (распространение по касательной). Щёлкните кромку правой кнопкой при выборе: «Выбрать контур» (граница грани через неё), «Выбрать касательные» или кромки того же размера (например, все отверстия одного радиуса). <b>Скругление с разными радиусами</b> задаёт каждому ребру свой радиус: введите его в списке рёбер или щёлкните выноску ребра.</li>
  <li><b>Условное изображение резьбы</b>: щёлкните круглую кромку отверстия или вала; подставляется ближайший размер ISO, резьба показывается штриховыми окружностями без изменения геометрии. В панели отверстия «Сохранить в избранное» запоминает определение отверстия для повторного использования.</li>
  <li><b>Уравнения</b> (Σ вверху дерева элементов): глобальные переменные, например Width = 80 или Holes = 4, которые можно использовать по имени в любом поле значения (Width/2). Размеры эскизов называются как D1@Sketch1 и тоже могут управлять другими значениями. Измените переменную — и всё, что её использует, перестроится; на панели видны все уравнения детали.</li>
  <li><b>Конфигурации</b> (◇ вверху дерева): варианты детали, например длинный и короткий. Каждая хранит свои значения размеров и параметров, переменные, погашенные элементы и материал. Добавьте конфигурацию, меняйте значения, пока она активна, и щёлкните ○, чтобы переключиться.</li>
  <li><b>Порядок элементов</b>: перетащите элемент в дереве на другой (верхняя половина — перед ним, нижняя — после) или нажмите Alt+↑/↓. Перенос, при котором элемент окажется перед тем, что он использует, отклоняется с объяснением. У выбранного элемента ↑ отмечает то, что он использует, а ↓ — то, что использует его.</li>
  <li><b>Вращение</b> поворачивает эскиз вокруг одного из его отрезков (сначала берётся вспомогательный) на любой угол.</li>
  <li><b>Скругление</b> и <b>Фаска</b>: щёлкайте рёбра или грань (все её рёбра) либо выберите ребро заранее и задайте размер. Фаска бывает с двумя расстояниями или с расстоянием и углом; <b>Сохранять подходящие</b> пропускает рёбра, которые скругление не может обработать.</li>
  <li><b>Тип скругления</b>: <b>Скругление граней</b> скругляет рёбра, где набор граней 1 встречается с набором 2; <b>Полное скругление</b> превращает центральные грани между двумя параллельными боковыми в полукруг, касающийся обеих (выберите сторону 1, центр, сторону 2).</li>
  <li>Вид показывает результат во время ввода; ✓ или <kbd>Enter</kbd> применяет, ✕ или <kbd>Esc</kbd> отменяет.</li>
  <li>Двойной щелчок по элементу в дереве открывает его для правки. Следующие элементы следуют за гранями и рёбрами, на которых построены. Кнопки строки гасят или удаляют элемент; удаление спрашивает, прежде чем удалить зависимые элементы.</li>
  <li>Правый щелчок по строке (или Shift+F10) открывает меню: изменить, переименовать (F2), погасить, откатить. Перетащите синюю <b>полосу отката</b> (или выделите её и нажимайте стрелки), чтобы увидеть деталь на более раннем шаге; новые элементы вставляются у полосы.</li>
  <li>Двойной щелчок по имени детали открывает её свойства: обозначение, описание, ревизию, материал и цвет. Панель массы берёт этот материал и показывает главные моменты инерции. <b>Задать массовые характеристики вручную</b> позволяет ввести реальные массу и центр масс покупной детали.</li>
  <li><b>Снимки</b>: каждое сохранение оставляет снимок детали в этом браузере (последние 20). Откройте их через ▾ рядом с «Сохранить», чтобы восстановить снимок или открыть его как копию.</li>
</ul>
<h4>Файлы</h4>
<ul>
  <li><b>Сохранить</b> (<kbd>Ctrl</kbd>+<kbd>S</kbd>) записывает файл детали <code translate="no">.mcadprt</code>; откройте его снова кнопкой «Открыть». <b>STEP</b> экспортирует тело для других CAD-программ.</li>
  <li>Несохранённые изменения хранятся в браузере: после сбоя или закрытой вкладки начальный экран предложит их восстановить.</li>
  <li>Все инструменты измерений, сечений, массы и экспорта работают с деталью так же, как с открытой моделью.</li>
</ul>`,
  },
  {
    id: "keys", title: "Клавиши",
    html: `
<h4>3D-модель</h4>
${table([
  ["Левая / Правая / Колесо", "Вращать / сдвигать / масштабировать к курсору"],
  ["F , 0", "Вписать, изометрия"],
  ["1 – 5", "Режимы отображения"],
  ["P / O", "Перспектива / ортогональная проекция"],
  ["N", "Нормально к выбранной плоской грани или эскизу (повторно — с другой стороны)"],
  ["D M R C L A V B T", "Точка–точка, мин. расстояние, радиус, центр–центр, длина, угол, точка, габариты, заметка"],
  ["I / H / U", "Изолировать / скрыть выбранную деталь / показать все"],
  ["Del", "Удалить выбранное измерение"],
  ["Esc", "Отменить инструмент, снять выбор"],
])}
<h4>Моделирование детали</h4>
${table([
  ["S", "Панель быстрого доступа у курсора: инструменты эскиза или команды детали"],
  ["F5", "Фильтр выбора: грани, рёбра, вершины"],
  ["Alt+щелчок", "Выбрать другое: следующая грань за курсором"],
  ["L R C A P D", "Эскиз: отрезок, прямоугольник, окружность, дуга, точка, размер (Esc — снова выбор)"],
  ["G T F", "Эскиз: многоугольник, отсечь, скругление"],
  ["E O W", "Эскиз: удлинить, смещение объектов, паз"],
  ["F2", "Переименовать выбранный элемент"],
  ["Ctrl+B / Ctrl+Q", "Перестроить / перестроить все элементы заново"],
  ["Ctrl+1 … Ctrl+7", "Вид спереди, сзади, слева, справа, сверху, снизу, изометрия"],
  ["Ctrl+8", "Перпендикулярно эскизу или выбранной грани (повторно: с другой стороны)"],
  ["Q", "Вспомогательная геометрия: вкл. / выкл."],
  ["Enter / Esc", "ОК (выйти из эскиза) / отмена"],
  ["Ctrl+Z / Ctrl+Y", "Отменить / повторить"],
  ["Ctrl+S", "Сохранить деталь"],
])}
<h4>Плата</h4>
${table([
  ["Колесо / Перетаскивание , Пробел+перетаскивание", "Масштаб к курсору / сдвиг"],
  ["Q M C L A", "Умное, точка–точка, зазор, ломаная, площадь"],
  ["Enter , Backspace", "Завершить ломаную или площадь, убрать последнюю точку"],
  ["Shift+щелчок", "Площадь площадки, полигона или замкнутого контура"],
  ["P / Del", "Закрепить результат / удалить выбранное измерение"],
  ["F , B , + / −", "Вписать, вид снизу, масштаб"],
  ["Alt+↑ / Alt+↓", "Переместить слой в фокусе вверх / вниз"],
  ["2 / 3", "Плоские слои / 3D-плата"],
])}
<h4>Везде</h4>
${table([
  ["Ctrl+O", "Открыть файлы"],
  ["Ctrl+[ / Ctrl+]", "Скрыть или показать левую / правую панель (⌘ на macOS)"],
  ["F1 / ?", "Эта справка"],
  ["Tab , Shift+Tab , Enter , Пробел", "Переход между элементами и нажатие"],
])}`,
  },
  { id: "about", title: "О программе", html: about("ru") },
];

const HELP: Record<Lang, Tab[]> = { en: EN, ru: RU };
let selected = "start";

/** Fills the help dialog body for the current language, keeping the open tab. */
export function renderHelp(host: HTMLElement) {
  const tabs = HELP[lang()];
  host.innerHTML = `<div class="tabs help-tabs" role="tablist" aria-label="${lang() === "ru" ? "Разделы справки" : "Help sections"}">${tabs.map(tb =>
    `<button role="tab" data-tab="${tb.id}" id="ht-${tb.id}" aria-controls="hp-${tb.id}" aria-selected="false" tabindex="-1">${tb.title}</button>`).join("")}</div>
    ${tabs.map(tb => `<section class="help-page" role="tabpanel" id="hp-${tb.id}" aria-labelledby="ht-${tb.id}" tabindex="0" hidden>${tb.html}</section>`).join("")}`;
  const select = bindTabs(host.querySelector<HTMLElement>(".help-tabs")!, id => {
    selected = id;
    host.querySelectorAll<HTMLElement>(".help-page").forEach(p => (p.hidden = p.id !== `hp-${id}`));
  });
  select(selected);
  fillCredits(host);
}
