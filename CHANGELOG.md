# Changelog

All notable changes to STEP Viewer are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/kothf/step-viewer/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/kothf/step-viewer/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/kothf/step-viewer/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/kothf/step-viewer/releases/tag/v1.0.0
