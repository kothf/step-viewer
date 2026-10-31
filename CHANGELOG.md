# Changelog

All notable changes to MöbiusCAD (formerly STEP Viewer) are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/kothf/step-viewer/compare/v1.10.0...HEAD
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
