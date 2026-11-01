// Help dialog: features, measuring tools and keyboard shortcuts, in English and Russian.
// The dialog shell is in index.html (#help); this fills #help-body for the current language.

import { lang, type Lang } from "./i18n";
import { bindTabs } from "./ui";

type Tab = { id: string; title: string; html: string };

const kbd = (s: string) => s.split(" ").map(k => (/^[+/,·–]$/.test(k) || k === "/" ? ` ${k} ` : `<kbd>${k}</kbd>`)).join("");
const table = (rows: [string, string][]) => `<table class="keys">${rows.map(([k, v]) => `<tr><td>${kbd(k)}</td><td>${v}</td></tr>`).join("")}</table>`;

const EN: Tab[] = [
  {
    id: "start", title: "Start",
    html: `
<p><strong>MöbiusCAD</strong> opens 3D CAD models and printed circuit boards in the browser. Files are read on your computer and never uploaded.</p>
<h4>Opening files</h4>
<ul>
  <li><b>Open file</b> (<kbd>Ctrl</kbd>+<kbd>O</kbd>) or drag files onto the window.</li>
  <li><b>3D models</b>: STEP (AP203, AP214, AP242), IGES and BREP. The mesh quality (Draft, Normal, Fine) in the header applies to the next file you open.</li>
  <li><b>PCBs</b>: Gerber RS-274X / X2 layers, Excellon drill files, or a .zip with a whole set. Open several files at once to see them as one board.</li>
</ul>
<h4>Screen layout</h4>
<ul>
  <li><b>Header</b>: open file, the open file's name and status, view controls, language (EN / RU), theme and this help.</li>
  <li><b>Left panel</b>: model tree or PCB layers, and the list of saved measurements. Hide it with <kbd>Ctrl</kbd>+<kbd>[</kbd>.</li>
  <li><b>Right panel</b>: properties and tools. Hide it with <kbd>Ctrl</kbd>+<kbd>]</kbd>. On a phone, the PCB panels open from the bottom bar.</li>
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
  <li><b>Axes</b> shows X, Y, Z from the model origin; <b>AO</b> adds ambient occlusion shading.</li>
</ul>
<h4>Model tree and properties</h4>
<ul>
  <li>Click a part in the tree or the model to select it; double-click zooms to it. The eye button hides or shows a part.</li>
  <li>The filter accepts a name or a condition: <code>size&gt;50</code>, <code>vol&lt;1000</code> (in the current units).</li>
  <li><b>Properties</b> shows the file header (protocol, author, PMI), part size, volume and area, and the selected face or edge. Isolate, hide, recolour or make a part transparent there.</li>
</ul>
<h4>Section</h4>
<p>Add up to three cutting planes: parallel to XY, YZ or XZ, on a selected planar face, through three picked points, or facing the view. Drag the arrow or the rings of the gizmo, or type an offset and angles. Caps fill the cut (with ANSI31 hatching, optionally in each part's colour), and the cut curves can be snapped to for measuring. <b>Snap to cut only</b> limits snapping to the section.</p>
<h4>Exploded view, mass and export</h4>
<ul>
  <li><b>Exploded view</b> moves parts apart with the slider; <b>Move selected part</b> drags one part with a gizmo.</li>
  <li><b>Mass properties</b>: pick a material or type a density to get volume, mass, area, centre of mass and bounding box of the visible or selected parts.</li>
  <li><b>Export</b>: PNG (also transparent, 2× to 4×), STL, OBJ, glTF and a PDF inspection report with the view, model data, mass and measurements.</li>
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
  <li><b>Board</b> shows the size, copper and hole statistics. <b>Measure as 3D model</b> opens the board body in the 3D tools (thickness, hole diameters, sections, mass, STL); <b>Back to PCB</b> returns.</li>
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
  ["D M R C L A N B", "Point–point, min distance, radius, centre–centre, length, angle, point, bounding box"],
  ["I / H / U", "Isolate / hide the selected part / show all"],
  ["Del", "Delete the selected measurement"],
  ["Esc", "Cancel the tool, clear the selection"],
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
  {
    id: "about", title: "About",
    html: `
<p><strong>MöbiusCAD</strong> v${__APP_VERSION__}: STEP, IGES and BREP models and Gerber / Excellon PCBs in the browser. Files never leave your computer.</p>
<p>Geometry is read with OpenCASCADE (occt-import-js, WebAssembly). Faces and edges are rebuilt from the B-rep tessellation, so planes, cylinders, circles and arcs are recognised analytically; distances on freeform surfaces are measured on the mesh.</p>
<p>Internal units are millimetres; units and decimals only change how values are shown.</p>`,
  },
];

const RU: Tab[] = [
  {
    id: "start", title: "Начало",
    html: `
<p><strong>MöbiusCAD</strong> открывает 3D-модели САПР и печатные платы прямо в браузере. Файлы читаются на вашем компьютере и никуда не загружаются.</p>
<h4>Открытие файлов</h4>
<ul>
  <li><b>Открыть файл</b> (<kbd>Ctrl</kbd>+<kbd>O</kbd>) или перетащите файлы в окно.</li>
  <li><b>3D-модели</b>: STEP (AP203, AP214, AP242), IGES и BREP. Качество сетки (черновое, обычное, точное) в заголовке применяется к следующему открытому файлу.</li>
  <li><b>Печатные платы</b>: слои Gerber RS-274X / X2, файлы сверловки Excellon или .zip с полным комплектом. Откройте несколько файлов сразу, чтобы увидеть их как одну плату.</li>
</ul>
<h4>Устройство экрана</h4>
<ul>
  <li><b>Заголовок</b>: открытие файла, имя и состояние открытого файла, управление видом, язык (EN / RU), тема и эта справка.</li>
  <li><b>Левая панель</b>: дерево модели или слои платы и список сохранённых измерений. Скрыть: <kbd>Ctrl</kbd>+<kbd>[</kbd>.</li>
  <li><b>Правая панель</b>: свойства и инструменты. Скрыть: <kbd>Ctrl</kbd>+<kbd>]</kbd>. На телефоне панели платы открываются с нижней панели.</li>
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
  <li><b>Оси</b> показывают X, Y, Z от начала координат модели; <b>AO</b> добавляет затенение (ambient occlusion).</li>
</ul>
<h4>Дерево модели и свойства</h4>
<ul>
  <li>Щёлкните деталь в дереве или на модели, чтобы выбрать её; двойной щелчок приближает к ней. Кнопка-глаз скрывает или показывает деталь.</li>
  <li>Фильтр принимает имя или условие: <code>size&gt;50</code>, <code>vol&lt;1000</code> (в текущих единицах).</li>
  <li><b>Свойства</b> показывают заголовок файла (протокол, автор, PMI), размер, объём и площадь детали, а также выбранную грань или ребро. Там же деталь можно изолировать, скрыть, перекрасить или сделать прозрачной.</li>
</ul>
<h4>Сечение</h4>
<p>Добавьте до трёх секущих плоскостей: параллельно XY, YZ или XZ, по выбранной плоской грани, через три указанные точки или перпендикулярно взгляду. Тяните стрелку или кольца манипулятора либо введите смещение и углы. Заглушки закрашивают разрез (со штриховкой ANSI31, по желанию цветом детали), а к линиям разреза можно привязываться при измерениях. <b>Привязка только к разрезу</b> ограничивает привязку сечением.</p>
<h4>Разнесённый вид, масса и экспорт</h4>
<ul>
  <li><b>Разнесённый вид</b> раздвигает детали ползунком; <b>Переместить деталь</b> двигает одну деталь манипулятором.</li>
  <li><b>Массовые характеристики</b>: выберите материал или введите плотность и получите объём, массу, площадь, центр масс и габариты видимых или выбранных деталей.</li>
  <li><b>Экспорт</b>: PNG (в том числе прозрачный, 2×–4×), STL, OBJ, glTF и PDF-отчёт контроля с видом, данными модели, массой и измерениями.</li>
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
  <li><b>Плата</b> показывает размер, статистику меди и отверстий. <b>Измерить как 3D-модель</b> открывает тело платы в 3D-инструментах (толщина, диаметры отверстий, сечения, масса, STL); <b>Назад к плате</b> возвращает.</li>
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
  ["D M R C L A N B", "Точка–точка, мин. расстояние, радиус, центр–центр, длина, угол, точка, габариты"],
  ["I / H / U", "Изолировать / скрыть выбранную деталь / показать все"],
  ["Del", "Удалить выбранное измерение"],
  ["Esc", "Отменить инструмент, снять выбор"],
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
  {
    id: "about", title: "О программе",
    html: `
<p><strong>MöbiusCAD</strong> v${__APP_VERSION__}: модели STEP, IGES и BREP и печатные платы Gerber / Excellon в браузере. Файлы не покидают ваш компьютер.</p>
<p>Геометрия читается с помощью OpenCASCADE (occt-import-js, WebAssembly). Грани и рёбра восстанавливаются из триангуляции B-rep, поэтому плоскости, цилиндры, окружности и дуги распознаются аналитически; расстояния на поверхностях свободной формы измеряются по сетке.</p>
<p>Внутренние единицы: миллиметры; единицы и число знаков меняют только отображение значений.</p>`,
  },
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
}
