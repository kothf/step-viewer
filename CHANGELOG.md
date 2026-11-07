# Changelog

All notable changes to MöbiusCAD (formerly STEP Viewer) are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.47.0] - 2026-11-07

### Added
- **Offline start** (FR-STO-030). A service worker keeps this version's app files and the STEP reader in the browser after the first visit, so MöbiusCAD starts without a network connection. The full OpenCASCADE build (50 MB, for modelling and exact geometry) is kept the first time it loads. Each release gets its own cache and the old one is removed. The page itself is always fetched fresh when online, so new versions show at once. A one-time note says when offline start is ready.

## [1.46.0] - 2026-11-07

### Added
- **Coordinate system** reference feature (FR-REF-005), under Plane ▾. Pick an origin (a vertex, or a reference point in the tree; the part origin if none), a Z direction and an X direction (a straight or round edge, a flat or round face, or a reference axis). Each direction can be reversed, and X is made square to Z. It shows as a red/green/blue triad. Right-click it in the tree and choose **Use for measurements and export**: positions, ΔX/ΔY/ΔZ, the centre of mass in Mass properties and STL/OBJ/glTF exports are then in that frame. The frame follows the model through rebuilds.
- Mesh exports (STL, OBJ, glTF) now use the active coordinate system, whichever way it was set.

## [1.45.0] - 2026-11-07

### Added
- **Under-defined analysis** in the sketcher (FR-SLV-010). Select a sketch item and orange arrows show the directions it can still move. A point free in the plane gets four arrows, and a point that can only slide along a line or circle gets two. A fully defined item shows none. The solver works these out from the free motions (null space) of its constraint system.

## [1.44.0] - 2026-11-07

### Added
- **Snapshots** (FR-STO-005). Every save of a part outside a vault also keeps a snapshot in this browser, up to the last 20 per part. The new ▾ next to Save opens **Save as…** and **Snapshots…**. Snapshots… lists them by time and size, with **Restore**, which puts the part back to that save as one undoable step, and **Open as copy**. A vaulted part points you to its History instead.

## [1.43.0] - 2026-11-07

### Added
- **Mass property override** (FR-MAT-004). Part properties has a new "Override mass properties" option for purchased or simplified parts. Enter the real mass in kg and, if you like, the centre of mass in mm. Mass properties then shows those values marked "(overridden)", and the centre-of-mass marker moves to the entered point. Any value left empty stays calculated. The override is saved in the part file.

## [1.42.0] - 2026-11-07

### Added
- **Multiple radius fillet** (FR-FT-031). Tick "Multiple radius fillet" in the Fillet panel and each picked edge gets its own radius field in the edge list. Every edge shows its own callout in the view (R1, R2…), which you can click to type that edge's size. Edges you don't change use the default radius. Unticking it puts every edge back on one radius.

## [1.41.0] - 2026-11-07

### Added
- **More extrude end conditions** (FR-FT-012). **Up to next** stops at the next face the profile meets: a boss fills the gap up to the body, and a cut goes through the material until it first opens into a void. **Up to vertex** ends level with a picked vertex (click near the end of an edge) or a reference point, extruding toward it.
- **Start from** for extrudes (FR-FT-013): the sketch plane, an **Offset** from it (the drag arrow moves with it), a parallel **face or plane**, or level with a **vertex**. It works with every end condition.

## [1.40.0] - 2026-11-07

### Added
- **Vault backup and storage** (FR-PDM-007/008).
  - **Export ZIP** saves the whole vault, or only the latest versions: settings, history, audit trail, stored versions and working files.
  - **Import vault ZIP…** on the Vault tab's start screen turns a backup into a new vault in this browser, so a vault moves between computers.
  - **Storage** lists the space each file takes, with every stored version counted once. **Purge old versions** keeps the last *n* versions of each file. Older versions stay in the history, marked "purged", but their content is deleted. Purges are logged in the audit trail.

## [1.39.0] - 2026-11-07

### Added
- **Local vault** (FRS 12.5, FR-PDM-001…016, 060, P2 first slice). The new **Vault** tab in the left panel creates or opens a vault. A vault can live in this browser's private storage, which every browser has, or in a folder on disk (Chromium). It keeps every version of every file in a hidden `.mcadvault/` folder beside the working files. Each version's bytes are stored once, under their SHA-256. Each file has a record, and every action is appended to an audit log.
  - **Save part to vault** puts the open part in as version 1, checked out to you. **Add files…** vaults any file, such as STEP, PDF, DXF or images.
  - **Check out / Check in / Undo check-out**. A vaulted file is read-only until you check it out: a bar above the feature tree offers Check out, and Save refuses to write over the vault copy. Check in asks for a comment and can keep the file checked out; an unchanged file makes no new version. The title shows the version and the lock, and the file list shows the version, a lock badge with the user, and "modified".
  - **History** lists every version with date, user, comment and size, plus the file's events. From there you can open any version read-only, or **Roll back**, which adds a new version with the old content, so history is never rewritten.
  - **Get latest**, the **Audit trail** (with CSV export) and an **Integrity check** for missing or damaged versions and unused objects.
  - Set your user name at the top of the tab; check-outs also record which browser made them.

## [1.38.0] - 2026-11-07

### Added
- **Modelled (helical) threads** (FR-FT-055). Tick "Modelled (helical) thread" in the Cosmetic thread panel to cut the real thread form into the part, for 3D printing. It cuts a 60° V groove along a helix at the size's pitch over the thread length (or up to the end of the cylinder). Internal threads cut from the tap drill out to the major diameter, and external threads cut from the shaft in to the minor diameter. The groove starts one pitch outside the end face so it runs out cleanly. It takes several seconds to rebuild, so leave it off while you are still designing.

## [1.37.0] - 2026-11-07

### Added
- **Main planes in the view.** The Top, Front and Right planes are now always drawn, faintly, so you can pick them in the view as well as in the tree. Click one away from the model to select it; the context toolbar offers Sketch and Normal to. Hide or show each one from its right-click menu in the tree.
- **Show sketches used by features.** A sketch that an extrude or revolve uses is still hidden by default, as in SolidWorks, but Show in its right-click menu draws it over the body again (Hide puts it away).
- **Normal to button and N shortcut.** Normal to, next to the standard views, and the **N** key turn the view square to the selected flat face, the selected plane or the open sketch; pressing again shows the other side. The point/normal measurement moved from N to **V**.
- **Centre and midpoint inference.** Hovering a circle or arc edge shows its centre, and hovering a straight edge its midpoint, as a faint marker (as in SolidWorks). Move onto the marker to pick it, even when the model hides that point, as at the far end of a hole.

- **Shaded cosmetic threads** (FR-FT-054). Cosmetic threads and tapped holes now show a helical thread texture on the cylinder over the thread's length, as SolidWorks' shaded cosmetic threads do, as well as the dashed circles. The stripes follow the thread's pitch.
- **Pinned measurements follow the model.** In a part you are modelling, a pinned measurement remembers the faces and edges it was taken on, by their persistent names, and measures them again after every rebuild, like a SolidWorks reference dimension. Widen the block, and the pinned edge length changes with it. If the geometry is gone, the measurement keeps its old value and is marked "out of date".

### Fixed
- **Hole wizard snapping.** A hole clicked near the origin now lands exactly on it (the origin projected onto the hole's face), and clicks also snap to model vertices, arc centres, midpoints and quadrant points lying on the face. Before, the point was rounded from wherever the cursor hit, so it was a little off.

## [1.36.0] - 2026-11-07

### Added
- **Selection helpers for Fillet and Chamfer** (FR-SEL-005). Right-click an edge while picking edges and choose one of three helpers. Select loop takes the boundary of the face under the cursor that runs through the edge. Select tangency takes the smooth chain. The third helper takes every round edge of the same radius, or every straight edge of the same length, such as all the holes of one size.

## [1.35.0] - 2026-11-07

### Added
- **Spline in sketches** (FR-SK-019), in the Line ▾ menu: click the points the curve passes through. A double-click ends it, and clicking the first point again closes it. It is a smooth (C2) cubic interpolating spline, parametrised by chord length. Its points are ordinary sketch points, so dragging, dimensions and relations on them reshape the curve. Closed splines, or open ones joined to other curves, make regions that extrude, revolve and cut as a single exact B-spline face. Splines also work with sketch mirror, patterns, move, rotate, scale and box selection.

## [1.34.0] - 2026-11-07

### Added
- **Ellipse and partial ellipse in sketches** (FR-SK-018), in the Circle ▾ menu. Click the centre, the end of the major axis, then a point on the ellipse; a partial ellipse also takes a start and an end and runs counter-clockwise. The centre and the two axis points are sketch points, so you dimension and relate them like any other: the solver keeps the minor axis square to the major one and the arc ends on the curve. Points can be made coincident with an ellipse or concentric to it. Ellipses extrude, revolve and cut as exact OCCT ellipses, and they follow sketch mirror, patterns, move, rotate, scale and box selection.

## [1.33.0] - 2026-11-07

### Added
- **Hole favourites** (FR-FT-056): in the Hole panel, Save as favourite keeps the current definition under a name. That covers the type, size, fit, diameters, counterbore or countersink, thread depth and end condition. Choosing a favourite applies it in one step, and Delete favourite removes it. Favourites are kept in this browser and work across parts.

## [1.32.0] - 2026-11-07

### Added
- **Cosmetic thread** (FR-FT-054): pick a round edge of a hole or a shaft. The feature works out whether the thread is internal or external, fills in the nearest ISO metric size (matched by tap drill for holes and by nominal diameter for shafts) and draws the thread as dashed circles. Internal threads show the major diameter and external ones the minor diameter. The length runs to the end of the cylinder or is set by a value. The geometry is unchanged.

### Fixed
- A revolve set to Up to face or plane now counts the plane or face as its parent, so reordering and parent marks take it into account.

## [1.31.0] - 2026-11-07

### Added
- **Tangent propagation** for Fillet and Chamfer (FR-SEL-005): clicking an edge also picks the edges that run on smoothly from it, such as the whole rounded outline of a plate. It is on by default, as in SolidWorks, and there is a checkbox for it in the panel.
- **Feature tree filter** (FR-HIS-011): type in the box above the Features tree to show only the features whose name matches. A folder stays visible while any of its features match.

## [1.30.0] - 2026-11-07

### Added
- **Folders in the Features tree** (FR-HIS-009): right-click a feature and choose Add to new folder, or add it to the folder of the feature above or below. A click on the folder opens or closes it (also Enter, ← and →), double-click or F2 renames it, and deleting a folder keeps its features.
- **Freeze bar** (FR-HIS-024): Freeze up to here on a feature's menu keeps that feature and everything above it as built; they are not rebuilt and can't be edited, suppressed, deleted or moved until you choose Unfreeze all. Features below the bar still rebuild on the frozen body.

## [1.29.0] - 2026-11-07

### Added
- **Linear and circular sketch patterns** (FR-SK-038): select sketch entities and click Linear pattern or Circular pattern in the sketch toolbar. A PropertyManager sets spacing, instances and angle for one or two directions, or the centre, instances and total angle (equal spacing or a fixed step); the green preview updates as you type. Each copy keeps an equal relation to its seed (lines in a linear pattern also stay parallel). A lone point selected with the entities is taken as the circular pattern's centre.
- **Move, copy, rotate and scale sketch entities** (FR-SK-039): Move (delta X/Y), Rotate (centre and angle) and Scale (centre and factor) with the same live preview. Copy adds transformed copies; in place, Keep relations decides whether relations and dimensions to the rest of the sketch stay (and pull back) or are removed. Dimensions inside a scaled selection scale with it.
- **Revolve options** (FR-FT-022): Revolve type Blind, Mid plane or **Up to face or plane** (a flat face or plane through the axis; the revolve stops where the profile first meets it), **Direction 2** with its own angle, and **Thin feature** (a wall inside, outside or centred on the profile).

## [1.28.0] - 2026-11-07

### Added
- Extrude end conditions (FR-FT-012): **Offset from surface** stops short of a face or plane by a distance (or goes past it, reversed), and cuts get **Through all - both**.
- **Draft while extruding** (FR-FT-014): the side faces taper inward or outward by an angle, for blind and mid-plane extrudes.
- **Thin feature** (FR-FT-015): an extrude can make a wall of a set thickness along a closed profile, inside it, outside it (rounded outer corners) or centred on it.

## [1.27.0] - 2026-11-07

### Added
- **DXF into a sketch** (FR-SK-040, AT-P2-5): the DXF button in the sketch toolbar imports lines, arcs, circles and polylines (bulges become arcs) into the open sketch, scaled from the file's units. Shared end points join, so closed outlines extrude straight away.
- **Sketch mirror** (FR-SK-037): select entities and the line to mirror about, then click Mirror. The copies are tied to the originals with symmetric relations (circles also equal), so they follow when the originals change.

### Fixed
- A sketch region with a hole inside it (a circle in a rectangle, say) could extrude with the hole's volume added instead of removed. Hole contours are now always wound against the outer one.

## [1.26.0] - 2026-11-07

### Added
- **Configurations** (FR-CFG-001/002): variants of a part from ◇ at the top of the Features tree. Each keeps its own dimension and parameter values, instance counts, variables, suppressed features and material; switching rebuilds the part, and undo can switch back.
- **Reorder features** (FR-HIS-006): drag a feature in the tree onto another, or press Alt+↑/↓. A sketch used only by the moved feature goes with it. A move that would put a feature before something it uses is refused with the reason.
- **Parent/child marks** (FR-HIS-007): with a feature selected, ↑ marks the features it uses and ↓ the ones that use it.

## [1.25.0] - 2026-11-07

### Added
- **Equations** (FR-PAR-001..005): global variables (length, angle or plain number, with a comment) in a panel opened from Σ at the top of the Features tree. Any value box takes a variable's name or an expression of them, like `Width/2 + 5`.
- **Draft** (FR-FT-061): tapers the picked faces by an angle about a neutral plane (a flat face or a plane); the faces keep their size where they cross it, and Reverse direction tapers the other way.
- Sketch dimensions have names (`D1@Sketch1`) that other values and variables can use.
- Expressions are kept with each value and re-evaluated whenever a variable or a referenced dimension changes; sketches whose dimensions change are solved again. Circular references and unknown names are shown as errors next to the variable.

### Fixed
- Hole wizard: clicks made before the face's frame is ready are no longer lost (only one of two quick clicks became a hole).
- Input errors such as an unknown name are translated in the Russian interface.

## [1.24.0] - 2026-11-07

### Added
- **Hole wizard** (FR-FT-050..053): simple, counterbore, countersink and tapped holes, blind (with a 118° drill point or a flat bottom) or through all. Click a flat face, then click where each hole goes; click a hole again to remove it.
- ISO metric sizes M2–M24 (FR-FT-051) fill the sizes: ISO 273 clearance holes (close, normal or loose), counterbores for ISO 4762 cap screws, 90° countersinks for ISO 10642, and tap drills. Typing a size makes the hole custom.
- Tapped holes show a dashed **cosmetic thread** at the major diameter and keep the thread size, pitch and depth.
- Holes can be patterned and mirrored like other cuts.

## [1.23.0] - 2026-11-07

### Added
- **Shell** (FR-FT-060): hollows the body to a wall thickness, inward or outward; click the faces to leave open, or none for a closed hollow body.
- **Linear pattern** (FR-FT-070): copies of extrudes, cuts, revolves, mirrors or patterns along one or two directions (an edge, a face's normal or a reference axis), with spacing, instance count and instances to skip.
- **Circular pattern** (FR-FT-071): copies about an axis (a round edge or face, a straight edge or a reference axis), spread equally over an angle or at a set angle apart.
- **Mirror** (FR-FT-072): mirrors the picked features, or the whole body when none are picked, about a plane or flat face.
- Copies that miss the body, or land where material is already gone, are skipped with a warning listing them (FR-FT-075). Pick the features to copy by clicking their faces or their rows in the tree; the pattern tools share a ▾ button on the feature bar.

### Fixed
- The header refits its tools when the text inside it changes (the open file or its status), not only when the window is resized, so it no longer overflows at 1280–1366 px.

## [1.22.0] - 2026-11-07

### Added
- **Context toolbar** (FR-UI-026): clicking a face or an edge of a part opens a small bar by the cursor, as in SolidWorks: Sketch and Normal to on a flat face, Fillet and Chamfer on an edge (they start with that edge), and Edit sketch / Edit feature for the feature that made it. It fades as the pointer moves away.
- **Selection filter** (FR-SEL-003): F5 or the Filter button turns faces, edges or vertices off so clicks pick only what is wanted, in measuring and modelling alike; Clear resets it.
- **Select other** (FR-SEL-004): Alt+click picks the face hidden behind the one under the cursor; Alt+click again at the same spot for the next.

## [1.21.0] - 2026-11-07

### Added
- Reference **Axis** (FR-REF-003) from a straight edge, a cylindrical or conical face, or two planes, and reference **Point** (FR-REF-004) at a vertex, an arc or circle centre, a face centre or an edge midpoint. Both sit under the Plane ▾ flyout, show in the tree and can be hidden.
- **S shortcut bar** (FR-UI-025): press S to open the most-used commands at the cursor, sketch tools in a sketch and features otherwise.
- **Box selection** in sketches (FR-SEL-002): drag left to right to select what lies fully inside, right to left to also catch what the box crosses.

### Changed
- S no longer switches to Select in a sketch; Esc does.

## [1.20.0] - 2026-11-07

### Added
- Sketch **Slot** (W, FR-SK-017): two centres, then the width; two lines and two end arcs, tangent and equal, on a construction centre line.
- Sketch **Extend** (E, FR-SK-031) lengthens a line or arc to the next curve, and **Split** (FR-SK-032) cuts it in two where you click.
- Sketch **Chamfer** (FR-SK-033): bevels the corner of two lines by the distance set in the panel.
- **Offset entities** (O, FR-SK-034): offsets a circle, or a whole chain of joined lines and arcs, to the cursor's side with a live preview; corners are re-joined and arcs stay concentric.
- **Convert entities** (FR-SK-035): copies the model edges you click, or all edges of a face, into the sketch as fixed lines, circles and arcs.

### Changed
- The sketch toolbar groups related tools behind a ▾ flyout, as in SolidWorks (Rectangle, Circle, Arc, Trim/Extend/Split, Fillet/Chamfer, Offset/Convert); each button shows the last tool picked from it, and Dimension sits next to Select. The bar wraps instead of running under the view cube.

## [1.19.4] - 2026-11-07

### Added
- Revolve angle handle: an orange arc about the axis with a grip at the end angle. Drag it round the axis to set the angle (1° steps, Shift for 0.1°, up to a full turn; Mid plane sweeps both ways). Selecting a revolve in the tree and dragging its grip edits it at once as one undo step, like the extrude arrow.
- Cut preview: while a cut (extrude or revolve) is open, the material it removes is shown as a see-through yellow body with its outline, as in SolidWorks.

### Fixed
- Dragging a handle keeps working when the pointer leaves the 3D view; the release is no longer lost.

## [1.19.3] - 2026-11-07

### Changed
- Feature panels are laid out like SolidWorks' PropertyManager: ✓/✕ at the top, then titled groups (Extrude: From, Direction 1, Direction 2; Revolve: Axis of revolution, Direction 1, Profile; Fillet and Chamfer: Items, Parameters, Options; Plane: First reference, Placement).
- Fillet and Chamfer list the picked edges ("Edge 1", "Edge 2"…) with a remove button on each, and show the whole new rounded or bevelled face as a see-through yellow ghost over the body.
- An extrude or revolve being edited shows its new faces tinted yellow, as a preview.
- While drawing in a sketch, a label at the cursor gives the live size (length and angle, radius, width × height).

### Fixed
- A value being typed in a feature panel is no longer put back to the old one when a rebuild finishes before Enter is pressed.

## [1.19.2] - 2026-11-06

### Fixed
- Fillet and Chamfer preview live again, SolidWorks style: while edges are picked on the body, the new faces show in see-through yellow and a callout at the first edge gives the radius or distances; it follows every change of edges or size. A size that does not fit shows its error in the panel at once.

## [1.19.1] - 2026-11-06

### Fixed
- **New part** on the start screen hides the start card at once, instead of leaving it up until the geometry kernel has loaded.

## [1.19.0] - 2026-11-06

### Added
- Drag to extrude or cut: an orange arrow on the model sets the depth of an Extrude or Cut with the mouse while its panel is open, with a live preview and the value beside the arrow (Shift: finer steps). Select an extrude in the tree and drag its arrow to change it at once, as one undo step (FRS FR-FT-017, FR-UI-027).
- Reference planes (**Plane**): offset from a standard plane, a flat face or another plane, or at an angle about a straight edge. Sketches go on them like on the standard planes, and they are drawn in the view (FR-REF-002).
- Extrude and Cut **Up to face or plane**, and **Flip side to cut** to keep the material inside the profile (FR-FT-011, FR-FT-016).
- Chamfer with two distances, or a distance and an angle, with a flip of the measuring face; Fillet **Keep features that fit** skips edges it cannot round and says how many (FR-FT-034, FR-FT-040).
- Sketch tools: 3-point circle, 3-point arc, polygon (3 to 64 sides on a construction circle), trim up to the nearest crossings, and sketch fillet with tangent relations and a radius dimension; the sketch panel lists every relation with select and delete (FR-SK-014..016, 030, 033, 055).
- Feature tree: rollback bar (drag it, or use the arrow keys), F2 rename, a right-click menu (edit, edit sketch, rename, suppress, hide plane, roll back, delete), sketches nested under the feature that uses them, the selected feature's faces highlighted in the view, and warnings shown in amber (FR-HIS-002..008).
- Part properties (double-click the part name): name, title, part number, description, revision, author, material and colour. The material presets the mass panel, which now lists the principal moments and axes of inertia of a modelled part from the exact geometry (FR-DOC-007, FR-MAT-001..003).
- An empty part shows buttons to start a sketch on Top, Front or Right (FR-HLP-005).
- Views: Ctrl+1 to Ctrl+7 for the standard views, Ctrl+8 normal to the sketch or the selected flat face (again for the other side); Ctrl+B rebuilds and Ctrl+Q rebuilds everything with a fresh kernel (FR-UI-030/031, FR-HIS-020).
- Leaving a sketch makes its edits one undo step on the part (FR-UND-003); starting Extrude from inside a sketch leaves the sketch and uses it (FR-SK-004); an edge picked with Smart measure is taken by Fillet and Chamfer (FR-SEL-006).

### Changed
- New sketches and features go in at the rollback bar.
- Clicking a face picks it even where a standard plane is drawn in front of it.

## [1.18.0] - 2026-11-06

### Added
- Part modelling, the first slice of the parametric modeller in [docs/FRS-modelling.md](docs/FRS-modelling.md) (phases P0 and P1). **New part** (the page icon next to Open, or on the start screen) starts a part with a feature history; the **Features** tab lists the origin planes, sketches and features, and a command bar over the view holds the commands, SolidWorks style, with ✓ / ✕ in the corner of the view.
- Sketcher on Top (XY), Front (XZ), Right (YZ) or any flat face: lines, corner and centre rectangles, circles, arcs and points, with snapping and automatic horizontal, vertical and coincident relations. Smart dimensions take units and arithmetic (`25.4 mm`, `1in`, `100/3`, `30deg`). Relations: coincident, horizontal, vertical, parallel, perpendicular, collinear, equal, tangent, concentric, midpoint, symmetric, fix, plus construction geometry. A constraint solver shows free (blue), fully defined (black) and over-defined (red) geometry and the degrees of freedom left, and geometry can be dragged.
- Features: Extrude and Cut (blind, mid plane, through all, second direction, reverse), Revolve (boss or cut, any angle, around a sketch line), Fillet and Chamfer on edges picked in the view (a face picks all its edges). The view previews the result while values are typed. Faces and edges keep their names through edits, so changing an early feature rebuilds the later ones on the moved faces.
- Edit any feature by double-clicking it, suppress or delete it (dependent features are named first), undo and redo every step (Ctrl+Z / Ctrl+Y, 200 steps).
- Part files: **Save** (Ctrl+S) writes a `.mcadprt` file (a zip with the feature history as JSON, stable for version control), and Open reads it back. **STEP** exports the solid. Unsaved changes are kept in the browser and offered for recovery on the start screen after a crash or a closed tab.
- Modelled parts use the existing tools: Smart measure, sections, mass properties and exports work on them with exact geometry.
- The geometry kernel is full OpenCASCADE (opencascade.js) in a worker, which keeps the part's history cached so edits near the end rebuild fast; a worker that crashes or grows too large is restarted from the document.
- Unit tests for the kernel, the sketch solver, expressions and documents (`npm run test:unit`, run in CI), and modelling checks in the smoke test.
- Help has a Modelling page, and the new interface is in Russian too.

### Changed
- The Parasolid parser from parasolid-kit is now kept in this repository (`native/parasolid-core`) instead of being fetched from GitHub at build time, so it can be fixed here. It reads all test files exactly as before.

## [1.17.0] - 2026-11-06

### Added
- Section button: press **Section** in the header and click a face. A flat face puts the plane on that face; a cylinder cuts through its axis, square to the view. The face under the pointer is highlighted while choosing and Esc cancels. The plane's sheet and drag arrows are anchored at the click instead of the model centre.

## [1.16.0] - 2026-11-06

### Added
- SolidWorks parts (.sldprt) and assemblies (.sldasm) open directly, with no SolidWorks needed. MöbiusCAD reads the Parasolid model stored inside each part and rebuilds it as exact geometry (planes, cylinders, cones, spheres, tori, fillets, B-splines and intersection curves), so measurements, sections, mass properties and STEP export all work as on a STEP file. Parts made from imported STEP bodies and files from before SolidWorks 2015 open too.
- Assemblies are put together from their component list with each part's placement, sub-assemblies included, and keep their tree and part names. Drop the assembly with its part files, or drag the whole folder onto the window; parts that are missing are named in a notice and left out.
- When a file has no geometry that can be read, SolidWorks' own preview picture is shown instead.
- The Parasolid reader is parasolid-kit (MIT / Apache-2.0), compiled to WebAssembly (about 190 KB compressed) and loaded only when a SolidWorks file is opened.

## [1.15.0] - 2026-11-06

### Added
- Drag arrows on section planes. A new section plane appears as a see-through sheet with two arrows along its normal, one on each side, at the middle of the cut. Drag either arrow to slide the plane through the model; the caps, cut curves, cut area and the offset in the Section panel follow live, and the camera stays put. The arrows keep the same size on screen at any zoom and turn orange under the pointer. **↕** on a plane brings them back after Esc, and **⟳** swaps them for the rotation rings.

## [1.14.1] - 2026-11-06

### Changed
- One header row. The measuring tools and the right-panel pages (Properties, Section, Explode, Mass, Export) moved from the strip under the header into the header itself, next to the display modes, projection and Fit, which are now icons (hover for the name and key). The header stays one row from 1366 px wide, in English and Russian: when space runs short the page labels fold into icons, then the Display label, then the name beside the logo (the logo's tooltip keeps it). Only narrower windows and phones put the tools on a second row.
- A **Display** menu in the header holds what used to be loose controls: **Origin axes** and **Ambient occlusion** (was Axes and AO, now with a short note on what ambient occlusion does), mesh quality, and the measurement units, decimals and colour.

## [1.14.0] - 2026-11-06

### Changed
- Tools are always in view. A tool strip under the header holds every measuring tool (Smart, point–point, min distance, radius, diameter, centre–centre, edge length, angle, 3-point angle, point / normal, bounding box, note), the right-panel pages (**Properties**, **Section**, **Explode**, **Mass**, **Export**) and the units, decimals and measurement colour, so nothing needs scrolling to reach. The right panel shows one page at a time instead of a long stack of sections; click the open page again to hide the panel. Labels fold into icons on narrower screens (hover for the name and key), and on phones the strip wraps onto two rows. Adding a section plane from anywhere brings up the Section page.

## [1.13.2] - 2026-11-06

### Changed
- The app version is shown under the MöbiusCAD name in the 3D view's header on screens 1360 px wide and up (1366 px laptops included; it used to need 1600 px). On narrower screens the logo's tooltip shows the name and version.

## [1.13.1] - 2026-11-06

### Changed
- STEP, IGES and BREP files open faster. OpenCASCADE now loads and warms up while the page is idle, so the first file no longer waits for it (a 0.6 MB, 41-part assembly shows in 2.4 s instead of 3.5 s; small parts open about twice as fast), and rebuilding faces and edges from the mesh takes about 40% less time.
- Exact values arrive sooner. The exact-geometry kernel is kept running between files instead of being restarted for each one (its start-up took 4–5 s every time), starts as soon as you pick or drag a file, and on machines with 6 or more cores reads the file alongside the import instead of after it. The part's surface area is now the sum of its exact face areas, saving a second integration. On the same assembly exact values now arrive about 10 s after opening the first file (was 15 s) and about 4.3 s after opening each file after that (was 9.3 s).

## [1.13.0] - 2026-11-05

### Added
- Exact geometry: once a STEP, IGES or BREP model is open, a full OpenCASCADE kernel (opencascade.js, WebAssembly, about 15 MB compressed and cached by the browser) reads the file again in the background and matches its faces and edges to the ones on screen. Volume, centre of mass, surface and face areas, edge lengths, circle and arc radii come from the B-rep from then on, cones and tori are recognised, freeform faces get their real curvature, and the Smart card says where the values come from. There is no switch: measurements just become exact, and the status bar shows when the kernel is ready.
- STEP export (**STEP** in Export): the whole model with its assembly, names and colours, or only the visible parts when some are hidden. PCB sets export the board body (outline, cut-outs, slots and holes, at the board thickness) as a STEP solid from the PCB Export panel.
- Section profile to DXF and SVG: **DXF** and **SVG** buttons on each section plane save its cut curves as a 2D drawing in millimetres (DXF R12 for CAD, laser or waterjet; SVG at 1:1), one layer per part. Lines stay lines, holes become true circles and arcs.
- Notes: the **✎ Note** tool (`T`) places a text note with a leader on the model. Drag the note to move it, double-click to edit it. Notes are saved with the measurements and drawn into PNG exports and the PDF report.
- Open STL, OBJ and 3MF mesh files. Their triangles are grouped into planar and curved faces, so planes, holes (cylinders), spheres, edges and circles can be measured like a STEP model, along with sections, mass properties and the other tools.

## [1.12.0] - 2026-11-01

### Added
- About / Credits in Help (the **About** tab): the logo and version, who made it, links to the blog post, the source on GitHub and this changelog, the libraries MöbiusCAD is built on, and a collapsible list of every open-source package in the build with its version, licence and authors, in both languages. The list is generated by the build from the packages that actually end up in the bundle, so it can't go out of date, and the full licence texts ship in `THIRD-PARTY-LICENSES.txt` next to `index.html`. It ends with the MIT licence and a no-warranty note: measurements come from the tessellated model, so check critical dimensions against the original before ordering parts or boards.

## [1.11.0] - 2026-11-01

### Added
- English / Russian interface. The **EN / RU** button in the header switches every label, tooltip, screen-reader name, hint, result card, measurement list and dialog at once, without reloading or losing the open model or board, and the choice is remembered (the first visit follows the browser language; `?lang=ru` or `?lang=en` in the URL also works). Stored measurements switch too. PDF reports and CSV / JSON exports stay in English.
- Help (the **?** button, `F1` or `?`): sections on getting started, the 3D model view, measuring, the PCB view and all keyboard shortcuts, plus an About page, in both languages.
- First-use tips: a short hint the first time you open a model or board, get a Smart result, measure two holes, add a section, use the 3D board or the tree filter. Each shows once; **Turn off tips** stops them and **Show tips** in Help turns them back on.

### Fixed
- The model view header no longer runs off the right edge between 1024 and 1600 px wide (the theme, help and panel buttons were cut off at 1280 px): below 1600 px it shows the logo without the name, a short **Open** and only **Fit** of the standard views (the others stay on the view cube and keys), with tighter buttons below 1280 px.

## [1.10.1] - 2026-10-31

### Fixed
- 3D board no longer flickers or shows streaky traces while rotating. Each side is now one surface with the copper, solder mask and silkscreen composited into its texture (with mipmaps), instead of stacked layers that fought over depth and thin alpha-tested traces that shimmered. Copper under the mask shows as lighter green, exposed copper stays metallic.

## [1.10.0] - 2026-10-31

### Added
- 3D board view for Gerber sets: a 2D / 3D switch in the PCB header (keys `2` and `3`). The board outline is extruded to the board thickness (1.6 mm by default, set under Board) with its cut-outs and drilled holes, plated holes get copper barrels, and copper, solder mask and silkscreen are drawn on both sides in their physical colours (or the colour picked in the layer list). Drag orbits, right or middle drag pans and the wheel zooms, as in the model view; Fit, zoom and Bottom view work in 3D too, and the layer list still shows and hides layers.
- Measuring on the 3D board: Smart, Point–point, Clearance, Polyline and Area work with snapping on the side you look at (only that side's layers, drills and outline are picked), share the measurement list with the flat view, and PNG export captures the 3D view.
- **Measure as 3D model** (Board panel) opens the board body in the model view, so its tools work on the PCB: thickness, hole diameters and pitch, angles, sections, mass properties, STL / OBJ / glTF export. **Back to PCB** returns to the layers.

### Fixed
- README and package homepage link to the app's new address, aerocat.tech/tools/mobiuscad/.

## [1.9.0] - 2026-10-31

### Changed
- The app is now called **MöbiusCAD** (formerly STEP Viewer): new name in the header, page title, help dialog, PDF inspection report and release titles. The repository, archive name and URL path (`/tools/step-viewer/`) stay the same.

### Added
- MöbiusCAD logo in the header, as the favicon (16/32/48 px), Apple touch icon and in a web app manifest (192/512 px icons), so the app can be installed with its own name and icon.

## [1.8.0] - 2026-10-31

### Added
- UI/UX standards, mainly for the PCB view. Header shows the open file with a status badge (loading, open, error) and stays above everything. The side panels collapse with the hamburger / panel buttons or Ctrl+[ and Ctrl+] (⌘ on macOS), and the state is remembered per screen size.
- Responsive PCB layout: full panels from 1280 px; from 768 to 1279 px the layer panel floats over the board and the tool panel stays docked; below 768 px a bottom navigation bar (Board, Layers, Results, Tools) opens the panels as full-screen sheets.
- Toasts stack in the bottom-right corner: information and success close after 4 s, warnings and errors stay until you dismiss them.
- Dialogs have a blurred backdrop, keep keyboard focus inside, close with Esc and return focus. Help also closes on a backdrop click; "Clear all" measurements now asks in a dialog that a stray backdrop click can't dismiss (PCB and 3D).
- Keyboard access: every PCB control is reachable with Tab and shows a 2 px focus ring; layers reorder with Alt+↑ / Alt+↓; measurement lists use real buttons; the 3D model tree works with the arrow keys, Enter and H; tabs switch with ←/→. Icon buttons, swatches and badges have text labels for screen readers, and form fields are linked to their labels.
- Empty states with an illustration and a call to action for the layer list, the measurement lists and the model tree; skeleton placeholders in the panels when loading takes longer than 300 ms; a spinner on PNG/SVG export, PDF report and mass calculation.
- Inline validation for the density field in Mass properties (red message under the field, announced to screen readers).

### Changed
- Colour tokens meet WCAG 2.1 AA contrast in light and dark themes (muted text, accent, error red #D32F2F). Font stack starts with Inter; PCB panels use 14 px body text. Hover, pressed, focus and disabled states on buttons and fields, with 180 ms ease-in-out transitions; export and clear buttons are disabled while there is nothing to export.

## [1.7.1] - 2026-10-31

### Changed
- PCB layer panel is simpler: each layer has only show/hide, colour and drag-to-reorder. The opacity slider, the per-layer remove button and the "+ Add layers" toolbar button are gone; every layer of an opened set is shown.

## [1.7.0] - 2026-10-31

### Added
- PCB / Gerber view. Open Gerber RS-274X and Gerber X2 layers, Excellon drill files (`.drl`, `.txt`, `.xln`) or a `.zip` of a whole set; several files can be dropped at once and more added later. Layer types come from X2 file functions or common file names (KiCad, Altium/Protel, Eagle). Standard and macro apertures, arcs, regions, clear polarity, step and repeat, G85 and routed slots and inch or metric drill formats are read in a worker, so large sets don't freeze the page (a 10 MB, 270,000-object layer opens in a few seconds).
- Layer panel: visibility, colour, opacity, drag-to-reorder stacking, remove; show or hide all. Dark 2D canvas with zoom to cursor, pan (drag, Space+drag, middle drag, pinch), fit, zoom buttons and a mirrored bottom view.
- Measuring on PCB geometry: Smart (one click: pad aperture and size, track width and length, arc radius and sweep, hole diameter and plating, region area, X2 net, pin and pad function; two clicks: pitch and edge-to-edge clearance), point to point with ΔX/ΔY legs, clearance, polyline length and polygon area. Shift+click a pad, region or closed outline such as the board edge for its exact area, arcs included.
- PCB snapping to corners and track ends, midpoints, pad and hole centres, track edges and the perpendicular foot on a track edge, each switchable; a live tooltip at the cursor; units mm, inch or mil with 0 to 4 decimals.
- PCB measurement list (show/hide, delete, clear, CSV), board summary (size, track and pad counts, holes, smallest hole, narrowest track) and PNG or SVG export of the view with the measurements.

## [1.6.1] - 2026-10-31

### Fixed
- The marker on the first pick of a two-click measurement stays the same size on screen when zooming. It was a solid dot sized to the model, so zooming in grew it into a disc that covered the geometry behind it; it is now a small hollow ring that leaves the picked point and its surroundings visible. The centre-of-gravity marker keeps a constant screen size too.

## [1.6.0] - 2026-10-31

### Changed
- Picking respects what you can see. In Shaded, Shaded+Edges and HLR, vertices, edges, centres and faces hidden behind a body (or behind a section cap) are no longer snapped or highlighted; Wire and X-ray still pick through the model.
- Hover and selection edge highlights hide behind the model in opaque modes instead of drawing through it.
- More accurate snapping in dense scenes: faces under a ring of probes around the cursor contribute their edges, so an edge right beside the cursor is found even when the face under the cursor belongs to another part, and an edge half hidden behind its own body snaps on the half that shows. In X-ray every face along the cursor ray contributes.

## [1.5.1] - 2026-10-31

### Fixed
- Smart measure no longer freezes on two big faces, such as the two sides of a PCB with many holes: face-to-face distance now walks both faces' BVHs and stops as soon as it finds the plane gap. Board thickness on a 4,000-triangle face takes milliseconds instead of about 30 seconds.
- Edge-to-face distance uses the face's BVH too, so a long edge against a big face no longer stalls.

## [1.5.0] - 2026-10-31

### Removed
- Draft angle and wall thickness analysis, along with the Analysis panel. Mass properties are unchanged.

## [1.4.0] - 2026-10-30

### Added
- Every two-point distance (point to point, centre to centre and pitch, edge to edge, point or centre to a line or plane, shortest distance) draws thin red, green and blue ΔX, ΔY and ΔZ legs, each with its own dimension label. The legs follow the active CSYS and appear in PNG and PDF snapshots.
- X, Y, Z axes from the model origin (0, 0, 0), with letters at the tips. Toggle them with "Axes" in the toolbar (remembered).

### Changed
- Orthographic projection is the default; the last choice is remembered.
- The readout card is docked in the bottom-left corner by default; ⇱ floats it beside the measurement.
- Releases can be started from GitHub's Actions tab (Release → Run workflow): it tags `main` itself after the tests pass, so no tag push is needed. The release reuses the CI result of the commit instead of testing again, and CI on `main` now runs every commit at once.

## [1.3.0] - 2026-10-30

### Added
- Smart measure covers the full single and two-entity matrix:
  - Straight edge: midpoint alongside length, direction and ΔX/ΔY/ΔZ. Arc: the normal of its plane.
  - Planar face: perimeter (all loops). Cylinder: length along the axis and a point on the axis.
  - Freeform face: smallest and largest radius of curvature, estimated from the tessellation.
  - Whole part ("⬚ Whole part" in the readout): bounding box, volume, surface area and centre of gravity.
  - Point to straight edge or plane: perpendicular distance to the infinite line or plane, with the foot point and whether it lies on the edge or its extension.
  - Parallel edges: alignment offset. Non-parallel straight edges: intersection point, real or on the extension, or the skew distance between the lines. Non-parallel planes: direction of the intersection line and a point on it.
  - Two round features: minimum edge-to-edge and maximum outer span next to centre to centre, with a Centre to centre / Minimum / Maximum switch in the readout that redraws the dimension, and the axis relation (parallel, concentric, perpendicular, skewed).
- Point-to-point distance draws its ΔX, ΔY and ΔZ legs along the axes in red, green and blue.
- The readout card has its own units and decimals switches. Click any value in it to copy it (a single length or angle is copied as the bare number).
- Feet as a display unit, and a Decimals setting (auto or 0 to 6 places).
- JSON export of measurements: raw values in millimetres and radians, world points, every detail row, and the text as displayed.
- User coordinate system: "⌖ CSYS here" in the readout sets a frame on a planar face (Z its normal, X along its longest edge), a straight edge (X along it), a circle or cylinder (Z its axis) or a vertex. Coordinates, directions and ΔX/ΔY/ΔZ everywhere (readout, properties, status bar, the axis legs) re-project at once; "Global CSYS" goes back. Exports keep world values.
- Quadrant snaps (0°, 90°, 180°, 270°) on circles and arcs, ranked with midpoints.
- Intersection snaps (red X): where a face's straight edges would meet past a fillet or chamfer, offered on that face and on the fillet beside it.
- The readout card floats beside the measurement and follows it as the view turns; ⇲ docks it in the corner (remembered).
- Measurements record their component (tree path and part number), shown in a new Component column of the CSV export and PDF report.

### Changed
- Snap markers: vertex a solid orange square, midpoint a green triangle, quadrant a green diamond, centre a cyan circle with crosshair, intersection a red X, face a blue diamond. Snap radius 15 px; circle centres rank with vertices.

## [1.2.0] - 2026-10-30

### Added
- Smart measure, now the default tool: click one point, edge or face for its size (diameter, radius, length, area, position), then a second to measure between them. It chooses the measurement itself: pitch or centre distance for holes, bosses, arcs and cylinders; normal distance for parallel faces and lines; centre to face or line; angle for non-parallel entities; otherwise the shortest distance, with the other values listed as details. Pin keeps a result; clicking empty space or Esc clears it.
- Round planar faces (disc tops, washers) count as circles, and a half-arc of a split circle reads as the full circle.
- Version number under the app name.

### Changed
- Measurement labels on the model are one compact line; details show in a readout card in the corner of the viewport, so results no longer cover the model. The floating toolbar is gone; "Section here" moved to the readout.
- CSV and PDF exports use each measurement's specific title.

### Fixed
- Shortest distance between parallel planar faces returned the plane gap even when the faces do not overlap (two coplanar faces gave 0 mm). It now measures between the faces and lists the plane gap separately.

## [1.1.0] - 2026-10-30

### Added
- Section profiles: where a plane cuts the model, the cut curves are computed, drawn on top of the caps and classified like model edges (line, circle, arc, curve). Cylinders cut square to their axis and spheres give exact circles with the surface's radius and centre.
- Measuring on the cut: snapping to profile curves, their vertices, midpoints and circle centres, and to points on the cap faces. "Snap to cut only" restricts snapping to the section plane; otherwise cut features join the normal 3D snaps.
- Cut area per plane (net of holes), with the number of curves and circles.
- 3-point section plane; planes named XY / YZ / XZ; up to 3 planes at once.
- Plane gizmo: drag the arrow to move or the rings to tilt the plane; numeric offset with a step and −/+ buttons; azimuth and elevation of the normal in degrees.
- ANSI31 hatching on caps (on by default) and caps coloured per part.

## [1.0.0] - 2026-10-30

### Added
- Opens STEP (AP203, AP214, AP242), IGES and BREP files in the browser with OpenCASCADE (occt-import-js, WebAssembly) in a worker; nothing is uploaded.
- B-rep topology rebuilt from the tessellation: faces classified as plane, cylinder or sphere; edges as line, circle, arc or curve, with exact radii, centres, axes and lengths.
- Display modes: shaded with edges, shaded, wireframe, hidden line, X-ray; perspective and orthographic; NavCube with 26 clickable views; view presets; optional ambient occlusion; light and dark themes.
- Measurements with snapping to vertices, midpoints, circle centres, face centres, edges and faces: point to point, shortest distance (point, edge, face in any pair), radius, diameter, centre to centre and hole pitch, edge and arc length, angle between edges/faces, 3-point angle, point coordinates with surface normal, bounding box. Colours, show/hide, saved per file in the browser, CSV and PDF export.
- Contextual floating toolbar for the selected face or edge.
- Multi-plane section (X, Y, Z, from a face, from the view) with solid stencil caps, numeric offsets and flipping.
- Exploded view from the assembly hierarchy and manual part dragging.
- Mass properties (volume, mass with material presets, surface area, centre of mass, bounding box).
- Draft angle and wall thickness heatmaps.
- Model tree with show/hide, isolate, colour and opacity per part or sub-assembly, and filters by name, size and volume.
- STEP header, schema, product revisions, materials and PMI entity counts shown as model metadata.
- Export: PNG (2-4x, optional transparent background, with labels), STL, OBJ, glTF (GLB), PDF inspection report.

[Unreleased]: https://github.com/kothf/step-viewer/compare/v1.47.0...HEAD
[1.47.0]: https://github.com/kothf/step-viewer/compare/v1.46.0...v1.47.0
[1.46.0]: https://github.com/kothf/step-viewer/compare/v1.45.0...v1.46.0
[1.45.0]: https://github.com/kothf/step-viewer/compare/v1.44.0...v1.45.0
[1.44.0]: https://github.com/kothf/step-viewer/compare/v1.43.0...v1.44.0
[1.43.0]: https://github.com/kothf/step-viewer/compare/v1.42.0...v1.43.0
[1.42.0]: https://github.com/kothf/step-viewer/compare/v1.41.0...v1.42.0
[1.41.0]: https://github.com/kothf/step-viewer/compare/v1.40.0...v1.41.0
[1.40.0]: https://github.com/kothf/step-viewer/compare/v1.39.0...v1.40.0
[1.39.0]: https://github.com/kothf/step-viewer/compare/v1.38.0...v1.39.0
[1.38.0]: https://github.com/kothf/step-viewer/compare/v1.37.0...v1.38.0
[1.37.0]: https://github.com/kothf/step-viewer/compare/v1.36.0...v1.37.0
[1.36.0]: https://github.com/kothf/step-viewer/compare/v1.35.0...v1.36.0
[1.35.0]: https://github.com/kothf/step-viewer/compare/v1.34.0...v1.35.0
[1.34.0]: https://github.com/kothf/step-viewer/compare/v1.33.0...v1.34.0
[1.33.0]: https://github.com/kothf/step-viewer/compare/v1.32.0...v1.33.0
[1.32.0]: https://github.com/kothf/step-viewer/compare/v1.31.0...v1.32.0
[1.31.0]: https://github.com/kothf/step-viewer/compare/v1.30.0...v1.31.0
[1.30.0]: https://github.com/kothf/step-viewer/compare/v1.29.0...v1.30.0
[1.29.0]: https://github.com/kothf/step-viewer/compare/v1.28.0...v1.29.0
[1.28.0]: https://github.com/kothf/step-viewer/compare/v1.27.0...v1.28.0
[1.27.0]: https://github.com/kothf/step-viewer/compare/v1.26.0...v1.27.0
[1.26.0]: https://github.com/kothf/step-viewer/compare/v1.25.0...v1.26.0
[1.25.0]: https://github.com/kothf/step-viewer/compare/v1.24.0...v1.25.0
[1.24.0]: https://github.com/kothf/step-viewer/compare/v1.23.0...v1.24.0
[1.23.0]: https://github.com/kothf/step-viewer/compare/v1.22.0...v1.23.0
[1.22.0]: https://github.com/kothf/step-viewer/compare/v1.21.0...v1.22.0
[1.21.0]: https://github.com/kothf/step-viewer/compare/v1.20.0...v1.21.0
[1.20.0]: https://github.com/kothf/step-viewer/compare/v1.19.4...v1.20.0
[1.19.4]: https://github.com/kothf/step-viewer/compare/v1.19.3...v1.19.4
[1.19.3]: https://github.com/kothf/step-viewer/compare/v1.19.2...v1.19.3
[1.19.2]: https://github.com/kothf/step-viewer/compare/v1.19.1...v1.19.2
[1.19.1]: https://github.com/kothf/step-viewer/compare/v1.19.0...v1.19.1
[1.19.0]: https://github.com/kothf/step-viewer/compare/v1.18.0...v1.19.0
[1.18.0]: https://github.com/kothf/step-viewer/compare/v1.17.0...v1.18.0
[1.17.0]: https://github.com/kothf/step-viewer/compare/v1.16.0...v1.17.0
[1.16.0]: https://github.com/kothf/step-viewer/compare/v1.15.0...v1.16.0
[1.15.0]: https://github.com/kothf/step-viewer/compare/v1.14.1...v1.15.0
[1.14.1]: https://github.com/kothf/step-viewer/compare/v1.14.0...v1.14.1
[1.14.0]: https://github.com/kothf/step-viewer/compare/v1.13.2...v1.14.0
[1.13.2]: https://github.com/kothf/step-viewer/compare/v1.13.1...v1.13.2
[1.13.1]: https://github.com/kothf/step-viewer/compare/v1.13.0...v1.13.1
[1.13.0]: https://github.com/kothf/step-viewer/compare/v1.12.0...v1.13.0
[1.12.0]: https://github.com/kothf/step-viewer/compare/v1.11.0...v1.12.0
[1.11.0]: https://github.com/kothf/step-viewer/compare/v1.10.1...v1.11.0
[1.10.1]: https://github.com/kothf/step-viewer/compare/v1.10.0...v1.10.1
[1.10.0]: https://github.com/kothf/step-viewer/compare/v1.9.0...v1.10.0
[1.9.0]: https://github.com/kothf/step-viewer/compare/v1.8.0...v1.9.0
[1.8.0]: https://github.com/kothf/step-viewer/compare/v1.7.1...v1.8.0
[1.7.1]: https://github.com/kothf/step-viewer/compare/v1.7.0...v1.7.1
[1.7.0]: https://github.com/kothf/step-viewer/compare/v1.6.1...v1.7.0
[1.6.1]: https://github.com/kothf/step-viewer/compare/v1.6.0...v1.6.1
[1.6.0]: https://github.com/kothf/step-viewer/compare/v1.5.1...v1.6.0
[1.5.1]: https://github.com/kothf/step-viewer/compare/v1.5.0...v1.5.1
[1.5.0]: https://github.com/kothf/step-viewer/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/kothf/step-viewer/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/kothf/step-viewer/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/kothf/step-viewer/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/kothf/step-viewer/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/kothf/step-viewer/releases/tag/v1.0.0
