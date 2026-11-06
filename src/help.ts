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
    ? `<p>Модели STEP, IGES, BREP и SolidWorks, сетки STL, OBJ и 3MF и печатные платы Gerber / Excellon в браузере. Файлы не покидают ваш компьютер.</p>
<p>Геометрия читается с помощью OpenCASCADE (occt-import-js, WebAssembly). Грани и рёбра восстанавливаются из триангуляции B-rep, поэтому плоскости, цилиндры, окружности и дуги распознаются аналитически; затем полное ядро (opencascade.js) в фоне заменяет объёмы, площади, длины, радиусы и кривизну точными значениями B-rep. Расстояния на поверхностях свободной формы измеряются по сетке. Внутренние единицы: миллиметры; единицы и число знаков меняют только отображение значений.</p>`
    : `<p>STEP, IGES, BREP and SolidWorks models, STL, OBJ and 3MF meshes and Gerber / Excellon PCBs in the browser. Files never leave your computer.</p>
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
  <tr><td>⊕ Point / normal <kbd>N</kbd></td><td>Coordinates of a point and the surface normal there</td></tr>
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
  <li><b>Dimension</b>: click a line, circle or arc (or two items), then where the value goes, and type it. Values accept units and arithmetic, such as <code>25.4 mm</code>, <code>1in</code>, <code>100/3</code> or <code>30deg</code>. Double-click a dimension to change it.</li>
  <li>Select items (Ctrl+click for more) to add relations in the panel: parallel, perpendicular, equal, tangent, concentric, midpoint, symmetric, fix. <b>Construction</b> (Q) turns lines into reference geometry, for example a revolve axis.</li>
  <li>The panel lists the sketch's relations: click one to select it, ✕ deletes it.</li>
  <li>Colours: blue can still move, black is fully defined, red is over-defined. The panel shows the remaining degrees of freedom. Drag geometry to try it.</li>
  <li>✓ or <kbd>Enter</kbd> leaves the sketch; ✕ asks before discarding its changes.</li>
</ul>
<h4>Features</h4>
<ul>
  <li><b>Extrude</b> and <b>Cut</b> use a closed sketch: blind depth, mid plane, through all or up to a face or plane, with a second direction and reverse. A cut goes into the material; <b>Flip side to cut</b> keeps what is inside the profile instead.</li>
  <li>Drag the orange arrow on the model to set the depth with the mouse (Shift: finer steps). Select an extrude in the tree and drag its arrow to change it at once.</li>
  <li><b>Plane</b> makes a reference plane offset from a plane or flat face, or at an angle about a straight edge. Sketch on it like on the standard planes.</li>
  <li><b>Revolve</b> turns a sketch around one of its lines (a construction line is taken first), by any angle.</li>
  <li><b>Fillet</b> and <b>Chamfer</b>: click edges, or a face for all its edges (or pick an edge first), and set the size. A chamfer can use two distances or a distance and an angle; <b>Keep features that fit</b> skips edges a fillet cannot round.</li>
  <li>The view shows the result while you type; ✓ or <kbd>Enter</kbd> keeps it, ✕ or <kbd>Esc</kbd> cancels.</li>
  <li>Double-click a feature in the tree to edit it. Later features follow the faces and edges they were built on. A row's buttons suppress or delete it; deleting asks before taking dependent features too.</li>
  <li>Right-click a row (or Shift+F10) for more: edit, rename (F2), suppress, roll back. Drag the blue <b>rollback bar</b> (or focus it and use the arrow keys) to look at the part at an earlier step; new features go in at the bar.</li>
  <li>Double-click the part name for its properties: part number, description, revision, material and colour. The mass panel then uses the material and lists the principal moments of inertia.</li>
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
  ["D M R C L A N B T", "Point–point, min distance, radius, centre–centre, length, angle, point, bounding box, note"],
  ["I / H / U", "Isolate / hide the selected part / show all"],
  ["Del", "Delete the selected measurement"],
  ["Esc", "Cancel the tool, clear the selection"],
])}
<h4>Part modelling</h4>
${table([
  ["S L R C A P D", "Sketch: select, line, rectangle, circle, arc, point, dimension"],
  ["G T F", "Sketch: polygon, trim, fillet"],
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
  <tr><td>⊕ Точка / нормаль <kbd>N</kbd></td><td>Координаты точки и нормаль к поверхности в ней</td></tr>
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
  <li><b>Размер</b>: щёлкните отрезок, окружность или дугу (или два элемента), затем место для значения и введите его. Можно писать единицы и арифметику: <code>25,4 мм</code>, <code>1 дюйм</code> как <code translate="no">1in</code>, <code>100/3</code>, <code>30°</code>. Двойной щелчок по размеру меняет его.</li>
  <li>Выберите элементы (Ctrl+щелчок добавляет), чтобы добавить взаимосвязи на панели: параллельность, перпендикулярность, равенство, касательность, концентричность, середина, симметричность, фиксация. <b>Вспомогательная</b> (Q) делает отрезки справочной геометрией, например осью вращения.</li>
  <li>Панель перечисляет взаимосвязи эскиза: щелчок выбирает, ✕ удаляет.</li>
  <li>Цвета: синее ещё может двигаться, чёрное полностью определено, красное переопределено. Панель показывает оставшиеся степени свободы. Перетащите геометрию, чтобы проверить.</li>
  <li>✓ или <kbd>Enter</kbd> выходит из эскиза; ✕ спрашивает, прежде чем отменить изменения.</li>
</ul>
<h4>Элементы</h4>
<ul>
  <li><b>Вытягивание</b> и <b>Вырез</b> строятся по замкнутому эскизу: на глубину, от средней плоскости, насквозь или до грани или плоскости, со вторым направлением и обратным направлением. Вырез идёт в материал; <b>Сменить сторону выреза</b> оставляет то, что внутри контура.</li>
  <li>Перетащите оранжевую стрелку на модели, чтобы задать глубину мышью (Shift: мельче шаг). Выберите вытягивание в дереве и тяните его стрелку, чтобы сразу изменить его.</li>
  <li><b>Плоскость</b> создаёт справочную плоскость со смещением от плоскости или плоской грани либо под углом вокруг прямого ребра. На ней можно рисовать эскиз, как на стандартных плоскостях.</li>
  <li><b>Вращение</b> поворачивает эскиз вокруг одного из его отрезков (сначала берётся вспомогательный) на любой угол.</li>
  <li><b>Скругление</b> и <b>Фаска</b>: щёлкайте рёбра или грань (все её рёбра) либо выберите ребро заранее и задайте размер. Фаска бывает с двумя расстояниями или с расстоянием и углом; <b>Сохранять подходящие</b> пропускает рёбра, которые скругление не может обработать.</li>
  <li>Вид показывает результат во время ввода; ✓ или <kbd>Enter</kbd> применяет, ✕ или <kbd>Esc</kbd> отменяет.</li>
  <li>Двойной щелчок по элементу в дереве открывает его для правки. Следующие элементы следуют за гранями и рёбрами, на которых построены. Кнопки строки гасят или удаляют элемент; удаление спрашивает, прежде чем удалить зависимые элементы.</li>
  <li>Правый щелчок по строке (или Shift+F10) открывает меню: изменить, переименовать (F2), погасить, откатить. Перетащите синюю <b>полосу отката</b> (или выделите её и нажимайте стрелки), чтобы увидеть деталь на более раннем шаге; новые элементы вставляются у полосы.</li>
  <li>Двойной щелчок по имени детали открывает её свойства: обозначение, описание, ревизию, материал и цвет. Панель массы берёт этот материал и показывает главные моменты инерции.</li>
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
  ["D M R C L A N B T", "Точка–точка, мин. расстояние, радиус, центр–центр, длина, угол, точка, габариты, заметка"],
  ["I / H / U", "Изолировать / скрыть выбранную деталь / показать все"],
  ["Del", "Удалить выбранное измерение"],
  ["Esc", "Отменить инструмент, снять выбор"],
])}
<h4>Моделирование детали</h4>
${table([
  ["S L R C A P D", "Эскиз: выбор, отрезок, прямоугольник, окружность, дуга, точка, размер"],
  ["G T F", "Эскиз: многоугольник, отсечь, скругление"],
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
