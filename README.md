# STEP Viewer

A STEP viewer for mechanical engineers, technicians and inspectors that runs entirely in the browser. OpenCASCADE parses the file in a Web Worker (WebAssembly), so **the model never leaves your computer**.

**Live:** [aerocat.tech/tools/step-viewer](https://aerocat.tech/tools/step-viewer/) · [GitHub Pages](https://kothf.github.io/step-viewer/)

## Features

- **Formats**: STEP AP203 / AP214 / AP242 (`.step`, `.stp`), IGES, BREP. Assembly tree, part names and colours are kept.
- **Topology-aware**: faces and edges are rebuilt from the B-rep tessellation and classified (plane, cylinder, sphere; line, circle, arc). Radii, centres, axes and lengths come from the analytic fit, not from triangles.
- **Display**: shaded + edges, shaded, wireframe, hidden line, X-ray; perspective / orthographic; NavCube (26 views) and view presets; ambient occlusion; light and dark themes.
- **Measure** with snapping to vertices, midpoints, circle centres, face centres, edges and faces:
  - point to point (with ΔX/ΔY/ΔZ), shortest distance between any two points, edges or faces
  - radius, diameter, centre to centre, hole pitch (axis to axis), edge and arc length (with sweep)
  - angle between edges/faces/axes, 3-point angle
  - point coordinates and surface normal, bounding box
  - colour-coded, pinned per file in the browser, exported as CSV or a PDF inspection report
- **Contextual toolbar**: click a hole edge and get Radius / Diameter / Centre to…; click a planar face and get Distance to… / Angle to… / Section here.
- **Sections**: X, Y, Z, from a face or from the view; several at once; solid caps (stencil buffer); slider plus numeric offset; flip.
- **Exploded view** following the assembly hierarchy, plus dragging single parts.
- **Mass properties**: volume, mass (material presets or custom density), surface area, centre of mass, bounding box.
- **Analysis**: draft angle against a pull direction; wall thickness by ray casting.
- **Model tree**: show/hide, isolate, colour and opacity per part or sub-assembly; filter by name, `size>50`, `vol<1000`.
- **Metadata**: STEP header, protocol, product revisions, materials, AP242 PMI entity counts.
- **Export**: PNG at 2–4× (optionally transparent, labels included), STL, OBJ, glTF (GLB), PDF report.

## Keyboard

| Key | Action |
| --- | --- |
| Left / right drag, wheel | Orbit / pan / zoom to cursor |
| `F`, `0` | Fit, isometric |
| `1`–`5` | Display modes |
| `P` / `O` | Perspective / orthographic |
| `D` `M` `R` `C` `L` `A` `N` `B` | Distance, min distance, radius, centre–centre, length, angle, point, bounding box |
| `I` / `H` / `U` | Isolate / hide selected / show all |
| `Del` | Delete the selected measurement |
| `Esc` | Cancel the tool, clear the selection |

You can also open a model by URL: `index.html?url=path/to/model.step` (same origin or CORS-enabled).

## Limits

- Distances between curved freeform faces are measured on the tessellation (choose *Fine mesh* for tighter results). Planes, cylinders, circles and lines are exact.
- AP242 PMI/GD&T and material entities are listed but not drawn.
- Volume and mass assume closed solids; open shells are flagged.

## Development

```bash
npm install
npm run dev        # http://localhost:5173
npm run package    # dist/step-viewer/ + dist/step-viewer-<version>.tar.gz
npm test           # headless-Chromium smoke test of the packaged build
```

Stack: TypeScript, Vite, Three.js, three-mesh-bvh, occt-import-js (OpenCASCADE 7.x as WebAssembly), jsPDF.

### Releasing

1. Bump `version` in `package.json` and add a section to `CHANGELOG.md`.
2. Tag and push: `git tag v1.1.0 && git push origin v1.1.0`.
3. The Release workflow tests the build, publishes `step-viewer-<version>.tar.gz` (+ `.sha256`) as a GitHub release and deploys GitHub Pages. aerocat.tech pins the release in its `vendor.json`.

## License

[MIT](LICENSE) © 2026 Andrey Dumchin.

The `occt/` folder of a build contains [occt-import-js](https://github.com/kovacsv/occt-import-js) and [Open CASCADE Technology](https://dev.opencascade.org/), unmodified, under LGPL-2.1 (with the Open CASCADE exception); their license files ship next to them.
