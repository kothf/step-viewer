# Changelog

All notable changes to STEP Viewer are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/kothf/step-viewer/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/kothf/step-viewer/releases/tag/v1.0.0
