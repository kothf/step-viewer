# MöbiusCAD Modelling: Functional Requirements Specification

| | |
| --- | --- |
| Document | FRS-MCAD-MOD, Functional Requirements Specification for parametric modelling in MöbiusCAD |
| Version | 0.3 (draft; 2026-11-08 adds section 13.13 and Appendix F from the UI/UX parity audit, and Appendix G, the implementation status audit) |
| Date | 2026-11-06 |
| Owner | Andrey Dumchin |
| Product baseline | MöbiusCAD 1.17.0 (viewer: STEP/IGES/BREP/SLDPRT/SLDASM/mesh, PCB view) |
| Status | Draft. Open decisions are listed in section 18. |

---

## Contents

1. [Introduction](#1-introduction)
2. [Reference product analysis (SolidWorks)](#2-reference-product-analysis-solidworks)
3. [Baseline: what MöbiusCAD already has](#3-baseline-what-möbiuscad-already-has)
4. [Product overview](#4-product-overview)
5. [Phases and release plan](#5-phases-and-release-plan)
6. [Architecture requirements](#6-architecture-requirements)
7. [Functional requirements: documents, workspace, history](#7-functional-requirements-documents-workspace-history)
8. [Functional requirements: sketcher](#8-functional-requirements-sketcher)
9. [Functional requirements: part features](#9-functional-requirements-part-features)
10. [Functional requirements: assemblies](#10-functional-requirements-assemblies)
11. [Functional requirements: drawings](#11-functional-requirements-drawings)
12. [Functional requirements: files, storage, interoperability, PDM](#12-functional-requirements-files-storage-interoperability)
13. [Functional requirements: user interface](#13-functional-requirements-user-interface)
14. [Non-functional requirements](#14-non-functional-requirements)
15. [Data model](#15-data-model)
16. [Verification and acceptance](#16-verification-and-acceptance)
17. [Risks](#17-risks)
18. [Open decisions](#18-open-decisions)
19. [Appendices](#19-appendices)

---

## 1. Introduction

### 1.1 Purpose

This document specifies what MöbiusCAD must do to become a parametric, feature-based 3D CAD modeller for mechanical parts, assemblies and drawings, running entirely in the browser. It is the reference for design, implementation, testing and acceptance of every modelling phase. It does not prescribe code structure beyond the architecture constraints in section 6.

### 1.2 Scope

In scope:

- 2D sketching with geometric relations and driving dimensions, solved by a constraint solver.
- Feature-based solid modelling of parts with an editable, re-playable feature history.
- Reference geometry, parameters, equations and configurations.
- Assemblies built from parts and sub-assemblies, positioned by mates.
- 2D engineering drawings generated from parts and assemblies.
- A native document format, local storage, and exchange through STEP, DXF, STL, 3MF and PDF.
- Product data management without a server: a vault with check-out/check-in, versions, revisions, lifecycle workflow, where-used, data cards, change orders and audit trail (section 12.5).
- Integration of everything above with the existing viewer: measuring, sections, mass properties, exploded view, export, EN/RU interface.

Out of scope for this FRS (may get their own documents later): simulation/FEA, CAM, rendering beyond the existing viewer, PCB/ECAD editing (the PCB view stays a viewer), routing (pipes, cables), weldments beyond the structural basics listed, mould tools, server-based PDM with real access control (P7), plug-in API for third parties.

### 1.3 Product principle

MöbiusCAD uses the workflow that mechanical engineers already know from history-based CAD (SolidWorks, Onshape, Inventor, FreeCAD): sketch, feature, history tree, mates, drawings. SolidWorks is the functional benchmark used to judge completeness (section 2).

For the user interface Andrey chose (2026-11-06) to **combine** SolidWorks' interaction model with MöbiusCAD's existing interface: a SolidWorks user should find the same layout and habits (feature tree on the left, a feature editing panel that takes the tree's place, tabbed command bar, OK/Cancel in the corner of the view, S-key shortcut bar, right-drag mouse gestures, heads-up view toolbar, drag handles on the model, Enter/Esc behaviour), while the look stays MöbiusCAD's own: header, colour tokens, light/dark themes, icons, panels, toasts, dialogs, EN/RU text and accessibility rules from the 1.8.0 UI/UX standards. Section 13 specifies this.

MöbiusCAD is an **original product**: its own name, icons, artwork, wording and file format. Layout conventions and interaction patterns shared across CAD tools are adopted; SolidWorks' icons, bitmaps, help text, templates and file formats are not reproduced. Reading SLDPRT/SLDASM as geometry (shipped in 1.16.0) is interoperability, not imitation.

### 1.4 Definitions and abbreviations

| Term | Meaning |
| --- | --- |
| B-rep | Boundary representation: solids described by faces, edges, vertices with exact geometry. |
| Body | One connected solid (or surface) in a part. A part may contain several bodies. |
| DOF | Degrees of freedom left in a sketch or an assembly. |
| Driving dimension | A dimension that controls geometry. A **driven** (reference) dimension only reports a value. |
| Feature | One step of the part history (sketch, extrude, fillet, ...). |
| Feature tree | The ordered list of features of a part, or of components and mates of an assembly. |
| Rollback | Temporarily evaluating the history only up to a chosen feature. |
| Rebuild | Re-evaluating features in order to produce the current geometry. |
| Relation | A geometric constraint between sketch entities (coincident, parallel, ...). |
| Mate | A geometric constraint between components of an assembly. |
| Topological naming | The way a feature remembers which face/edge it used, across rebuilds. |
| OCCT | Open CASCADE Technology, the geometry kernel (via opencascade.js and occt-import-js). |
| WASM | WebAssembly. |
| OPFS | Origin Private File System, browser storage for files. |
| FSA | File System Access API (open/save to real files and folders, Chromium browsers). |
| HLR | Hidden line removal, used to make drawing views. |
| PMI | Product manufacturing information (dimensions and tolerances in 3D). |
| PDM | Product data management: vault, versions, revisions, workflow (section 12.5). |
| Version / Revision | Every check-in makes a new numbered version; a revision (A, B …) is the label given to a released version. |
| ECR / ECO | Engineering change request / order. |

### 1.5 Requirement notation

Each requirement has an identifier, a priority and a phase:

- **ID**: `FR-<area>-<nnn>` for functional, `NFR-<area>-<nnn>` for non-functional. Areas: DOC, HIS, UND, SK (sketcher), SLV (solver), FT (features), REF (reference geometry), PAR (parameters), CFG (configurations), TN (topological naming), BODY, MAT (materials/properties), ASM, MATE, DRW, IO, STO, UI, SEL, MEA, I18N, HLP.
- **Priority**: **M** must (phase is not done without it), **S** should, **C** could.
- **Phase**: P0 to P7, see section 5.

"Shall" marks a binding requirement, "should" a recommendation, "may" an option. Lengths are millimetres and angles radians internally (existing convention, `units.ts`), shown in the document units.

### 1.6 Related documents

- `CLAUDE.md` (code map and conventions), `README.md`, `CHANGELOG.md`.
- UI/UX standards (1.8.0): contrast, focus, breakpoints 1280/768, toasts, dialogs. Enforced by axe-core in `tests/smoke.mjs`.
- Exact geometry kernel (1.13.0): `src/kernel/occ.ts`, `client.ts`, `kernel.worker.ts`.
- SolidWorks import (1.16.0): `src/sw/`, `src/kernel/parasolid.ts`, `src/kernel/solidworks.ts`.

---

## 2. Reference product analysis (SolidWorks)

SolidWorks (Dassault Systèmes) is the most used mechanical CAD in small and medium engineering companies, and the benchmark Andrey chose. This section lists its functionality by area, so each MöbiusCAD requirement can be traced to a capability users expect. The column "MöbiusCAD" gives the phase in which an equivalent arrives, or "—" when it is out of scope. Product names are trademarks of their owners and are used here only for reference.

> **Trademark notice.** SOLIDWORKS is a registered trademark of Dassault Systèmes SolidWorks Corporation; Onshape is a trademark of PTC Inc.; other names belong to their owners. They are named in this document only to describe and compare functionality. MöbiusCAD is not affiliated with, endorsed or sponsored by them. Product rule: the app itself does not use these names in its branding or UI labels, nor their logos, icons, artwork or help text; factual mentions such as "Open SolidWorks parts (.sldprt)" in file-format lists are allowed.

### 2.1 Workflow model

SolidWorks is history-based and parametric: a **part** is a sequence of features in the FeatureManager design tree, each feature driven by sketches and dimensions; changing a dimension rebuilds the part. Parts are inserted into **assemblies** and positioned by mates; **drawings** are 2D views projected from the 3D models and stay associative (a model change updates the drawing). Three document types (`.sldprt`, `.sldasm`, `.slddrw`) reference each other by file path. UI elements: CommandManager (tabbed ribbon), FeatureManager tree, PropertyManager (left panel to edit a feature), Heads-up View toolbar, shortcut bar (S key), mouse gestures, confirmation corner (OK/Cancel in the graphics area), Instant3D (drag arrows to change sizes), rollback bar.

MöbiusCAD keeps the same workflow model (history-based parts, mated assemblies, associative drawings) and the same interaction habits, mapped onto its existing interface (section 13), with one native container format with an extension per document kind (section 12).

### 2.2 Sketching

| SolidWorks capability | Notes | MöbiusCAD |
| --- | --- | --- |
| Sketch on plane or planar face | Front/Top/Right planes, any planar face, reference planes | P1 |
| Line, centerline, midpoint line | Chained lines with tangent arc switching | P1 |
| Rectangle: corner, center, 3-point corner, 3-point center, parallelogram | | P1 (corner, center), P2 (3-point, parallelogram) |
| Slot: straight, center straight, 3-point arc, center arc | | P2 |
| Circle (center, perimeter), arc (center, tangent, 3-point) | | P1 |
| Ellipse, partial ellipse, parabola, conic | | P2 (ellipse), P5 (parabola, conic) |
| Spline, style spline, equation-driven curve | | P2 (interpolating spline), P5 (others) |
| Polygon | Inscribed / circumscribed | P1 |
| Fillet, chamfer (sketch) | | P1 |
| Point, text | Text for embossing | P1 (point), P4 (text) |
| Offset entities, convert entities, intersection curve | Project model edges | P1 (offset, convert), P2 (intersection) |
| Trim (power trim), extend, split | | P1 |
| Mirror, dynamic mirror, linear/circular sketch pattern, move/rotate/scale/copy/stretch | | P2 |
| Construction geometry | Toggle any entity | P1 |
| Relations: horizontal, vertical, collinear, perpendicular, parallel, tangent, concentric, coradial, midpoint, intersection, coincident, equal, symmetric, fix, pierce, merge, along X/Y | Automatic relations while drawing | P1 (core set), P2 (pierce, along, curvature) |
| Smart Dimension: linear, angular, radial, diameter, arc length, ordinal | Driving/driven, equations in boxes | P1 (except ordinal P2) |
| Fully defined / under / over defined colours; DOF readout | Blue / black / red / yellow | P1 |
| Display/Delete Relations, SketchXpert (conflict resolution) | | P1 (list/delete), P2 (assistant) |
| Shaded sketch contours, contour selection, regions | Pick regions for extrude | P1 |
| 3D sketch | Lines/splines in space | P5 |
| Blocks (sketch blocks), sketch picture, DXF/DWG import into sketch | | P2 (DXF import), P5 (blocks, picture) |
| Layout sketch driving several features | Shared sketches | P1 (sketch reuse) |

### 2.3 Part features

| SolidWorks capability | Notes | MöbiusCAD |
| --- | --- | --- |
| Extruded Boss/Base, Extruded Cut | End conditions: Blind, Through All, Up To Next, Up To Vertex, Up To Surface, Offset From Surface, Up To Body, Mid Plane; Direction 2; draft; thin feature; start from plane/surface/offset | P1 (Blind, Through All, Mid Plane, Up To Face, both directions, cut/boss), P2 (others, draft, thin) |
| Revolved Boss/Cut | One/two directions, thin | P1 |
| Swept Boss/Cut | Profile + path, guide curves, twist | P3 (basic), P5 (guides, twist) |
| Lofted Boss/Cut | Profiles, guide curves, centerline, start/end constraints | P3 (basic), P5 (guides) |
| Boundary Boss/Cut | | P5 |
| Fillet | Constant, variable, face fillet, full round, setback, FilletXpert | P1 (constant edge), P3 (face, full round, variable) |
| Chamfer | Distance-distance, angle-distance, vertex, offset face | P1 (equal distance, distance-angle), P3 (others) |
| Hole Wizard | Counterbore, countersink, hole, tapped, pipe tap, legacy, slot; standards ISO/ANSI; position by sketch points | P2 |
| Advanced Hole, thread feature, cosmetic thread | | P2 (cosmetic thread), P5 (modelled thread) |
| Shell | Remove faces, multi-thickness | P2 |
| Draft | Neutral plane, parting line, step | P2 (neutral plane) |
| Rib | | P3 |
| Linear, circular, mirror pattern; curve-driven, sketch-driven, table-driven, fill, variable patterns | Features, faces or bodies | P2 (linear, circular, mirror), P3 (sketch-driven), P5 (others) |
| Dome, wrap, deform, flex, indent, scale | | P5 |
| Reference geometry: plane, axis, coordinate system, point, mate reference | | P1 (plane, axis, point), P2 (coordinate system) |
| Curves: split line, projected, composite, helix/spiral, curve through points | | P3 (helix, split line), P5 (others) |
| Multibody: combine, intersect, split, delete/keep body, move/copy body, insert part | | P3 |
| Surfaces: extrude/revolve/sweep/loft surface, offset, knit, fill, trim, extend, thicken, delete face, replace face | | P5 |
| Direct editing: move face, delete face (on imported bodies) | FeatureWorks recognises imported features | P5 |
| Sheet metal: base flange, edge flange, miter flange, hem, jog, sketched bend, flatten, forming tools | | P6 |
| Weldments: structural members from profiles, trim/extend, gussets, cut list | | P6 (basic) |
| Mold tools | | — |
| Equations, global variables, linked dimensions | | P2 |
| Configurations, design tables | Variants of a part | P2 (configurations), P5 (table import) |
| Materials, mass properties, appearances, decals | | P1 (material, mass, colour), P5 (decals) |
| Measure, section view, interference, draft analysis, thickness analysis, curvature, zebra | | already in viewer (measure, section, mass), P3 (interference), P5 (draft, zebra, thickness) |
| Feature freeze, suppress/unsuppress, rollback, reorder, parent/child, What's Wrong dialog | | P1 (rollback, suppress, errors), P2 (reorder, parent/child) |
| Instant3D (drag handles), Heads-up dimensions | | P1 (drag handles on extrude), P2 (more) |

### 2.4 Assemblies

| SolidWorks capability | Notes | MöbiusCAD |
| --- | --- | --- |
| Insert components, fixed/floating, sub-assemblies (rigid/flexible) | | P4 |
| Standard mates: coincident, parallel, perpendicular, tangent, concentric, lock, distance, angle | Flip alignment | P4 |
| Advanced mates: profile center, symmetric, width, path, linear coupler, limit distance/angle | | P4 (limit, symmetric, width), P5 (others) |
| Mechanical mates: cam, slot, hinge, gear, rack and pinion, screw, universal joint | | P5 (hinge, slot, gear, screw), — (cam) |
| SmartMates (drag with Alt), mate references, magnetic mates | | P4 (inferred mates while dragging), P5 (references) |
| Move/rotate component, collision detection while dragging, physical dynamics | | P4 (move/rotate, collision stop), — (dynamics) |
| Interference detection, clearance verification, hole alignment | | P4 (interference), P5 (clearance, hole alignment) |
| Component patterns (linear, circular, feature-driven), mirror components | | P4 (linear, circular), P5 (feature-driven, mirror) |
| Toolbox (standard fasteners library) | | P5 (small ISO library) |
| In-context design (edit part in assembly, external references) | | P5 |
| Assembly features (cut/hole through several parts) | | P5 |
| Exploded views with steps, explode lines | Viewer already has explode | P4 (stored explode steps) |
| BOM, display states, configurations, Large Assembly Mode, lightweight, SpeedPak, selective open | | P4 (BOM, display states), P5 (configurations, lightweight) |
| Motion study (animation, motor) | | P6 (simple animator) |

### 2.5 Drawings

| SolidWorks capability | Notes | MöbiusCAD |
| --- | --- | --- |
| Sheets, sheet formats, templates, title block with properties | ISO, ANSI, GOST templates | P5 |
| Standard 3 views, model view, projected, isometric | First/third angle | P5 |
| Section, aligned section, half section, detail, broken-out, break, crop, auxiliary views | | P5 (section, detail, auxiliary), P6 (others) |
| Model items import, smart dimension, ordinate, baseline, chain, hole callout | | P5 |
| Annotations: notes, balloons, auto balloons, surface finish, weld symbols, GD&T, datums, centre marks, centerlines, cosmetic threads | | P5 (notes, balloons, centre marks, centerlines, GD&T frames, datums, surface finish), — (weld symbols) |
| BOM table, hole table, revision table, general tables | | P5 (BOM, revision), P6 (hole table) |
| Layers, line styles, hidden lines, tangent edges display | | P5 |
| Export PDF, DXF/DWG, eDrawings | | P5 (PDF, DXF, SVG), — (DWG, eDrawings) |
| Detached drawings, auto-generate drawings | | — |

### 2.6 Files, data and other

| SolidWorks capability | MöbiusCAD |
| --- | --- |
| Native files referencing each other by path; Pack and Go | P0 (one container, `.mcadprt`/`.mcadasm`/`.mcaddrw`, embedded or linked parts), P4 (pack) |
| Import STEP, IGES, Parasolid, ACIS, DXF/DWG, STL, 3MF; Import Diagnostics | already (STEP, IGES, BREP, SLDPRT, STL, OBJ, 3MF), P2 (DXF to sketch), P3 (heal imported bodies) |
| Export STEP AP203/AP214/AP242, IGES, Parasolid, STL, 3MF, glTF, PDF 3D | already (STEP, STL, OBJ, glTF), P1 (STEP of modelled parts), P3 (3MF) |
| Custom properties (part number, description, material, revision) | P1 |
| Design Library, Toolbox | P5 |
| Simulation, Flow, Plastics, CAM, Electrical, PDM | — |
| Macros and API | P6 (scripting console, read-only first) |
| PDM Standard / Professional (EPDM): vault, check-in/out, versions, revisions, workflows and transitions, data cards, numbering, search, where-used, version-aware BOMs, copy tree, ECO, notifications, audit | P2 (vault, versions, audit), P4 (revisions, workflow, references, data cards, search, BOM per revision), P5 (workflow editor, ECO, shared vault), P7 (server) |
| PDM replication, cold storage, web portal, ERP integration | — |

### 2.7 What SolidWorks users value and expect (inputs for UX)

- Predictable rebuilds: editing an early dimension keeps fillets and holes on the "same" edges (topological naming).
- Fast sketching with automatic relations and clear defined/undefined colouring.
- Dimension entry at the point of creation (a dimension box opens when you place a dimension).
- Escape-to-cancel, Enter-to-confirm, right-click context menus, the S-key shortcut bar, keyboard shortcuts for views.
- The tree is the "source of truth": every feature can be edited, suppressed, rolled back, renamed.
- Clear error reporting: a failed feature is marked, the rest of the part still shows, a "what's wrong" explanation names the reference that broke.
- Mass properties and measure at any time; section views while modelling.
- Common hole standards and drawing standards available without setup.

---

## 3. Baseline: what MöbiusCAD already has

The modeller builds on version 1.17.0. Reusing these parts is a requirement (NFR-MNT-002), not a suggestion.

| Area | Existing module | Reuse in modelling |
| --- | --- | --- |
| Exact kernel | `src/kernel/occ.ts` (`Kernel`), full OCCT via opencascade.js (~15 MB compressed WASM), running in `kernel.worker.ts`, compiled once by `client.ts` | Becomes the modelling kernel. Today a fresh worker serves each file and is recycled above 1 GB heap; modelling needs a long-lived worker per open document (section 6.3). |
| Fast import | `src/worker/import.worker.ts` (occt-import-js) | Unchanged for viewing and for "Import body" features. |
| Topology on the mesh | `src/topology.ts`: welded tessellation, faces and edges, classification | Bodies produced by the kernel are tessellated in the worker with face/edge ids attached, filling the same `PartData` structure so measure/snap/section keep working. |
| Rendering | `src/viewer/Viewer.ts` (scene, cameras, display modes, explode), `NavCube.ts` | Graphics area for part, assembly and sketch modes. Display modes, NavCube, themes kept. |
| Sections | `src/viewer/Section.ts`, `SectionProfile.ts` | Section view while modelling; cut profile export. |
| Picking and snapping | `src/tools/Snapper.ts`, three-mesh-bvh (`indirect: true`) | Selection of faces/edges/vertices for features and mates; sketch inference on model geometry. |
| Measurement | `src/tools/measure.ts` (`smartMeasure`), `Annotations.ts` | Available in every mode. Measured values may be copied into dimension boxes. |
| Mass properties | `src/tools/analysis.ts` (materials, density) | Part and assembly mass properties; material list becomes the part material catalogue. |
| User coordinate systems | `src/tools/csys.ts` | Reused for reference coordinate systems and for reporting values. |
| Export | `src/tools/exporters.ts`, `Kernel.writeStep`, `profileExport.ts` (DXF R12/SVG) | STEP export of modelled parts/assemblies; DXF writer extended for sketches and drawings. |
| Section drag arrows | 1.15.0 handles | Pattern for on-canvas drag handles (extrude depth, fillet radius). |
| UI kit | `src/ui.ts` (toasts, dialogs with focus trap, tabs, panels, sheets, busy buttons, empty states), `style.css` tokens | All new panels and dialogs. |
| i18n | `src/i18n.ts`, `src/i18n.ru.ts`, DOM translation by MutationObserver | Every new string, EN and RU. |
| Help and tips | `src/help.ts`, `src/hints.ts` | New Help sections for modelling, first-use tips for sketcher and features. |
| SolidWorks import | `src/sw/*`, `parasolid.ts`, `solidworks.ts` | SLDPRT/SLDASM open as dumb solids that can be used as base bodies or assembly components. |
| Tests | `tests/smoke.mjs` (packaged build, headless Chromium, axe-core, layout checks) | Extended with modelling checks; a unit test runner is added for the solver and data model (NFR-QA-001). |

Gaps the modeller must fill: no editable document model, no undo/redo, no persistence except measurements in localStorage, no sketch solver, no feature evaluation, no persistent kernel session, no topological naming, no drawing generator.

---

## 4. Product overview

### 4.1 User classes

| User | Needs | Typical session |
| --- | --- | --- |
| Mechanical design engineer | Parts and small assemblies, drawings for manufacturing, STEP to suppliers | 1–4 h, desktop, mouse with wheel, 1920×1080 or larger |
| Maker / hobbyist | 3D-printable parts, STL/3MF export, simple assemblies | Short sessions, laptop, touchpad possible |
| Inspector / technician (current users) | Viewing and measuring supplier models; small edits (add a hole, cut a section) | Mostly viewer; occasional edit of an imported body |
| Student | Learning sketch/feature workflow without installation | Laptop, Chromebook |

### 4.2 Operating environment

- Desktop browsers, current and previous major version: Chrome, Edge, Firefox, Safari (macOS). Chromium browsers get FSA folder access; others use download/upload and OPFS (FR-STO).
- WebAssembly with SIMD; SharedArrayBuffer is **not** required (the app is served from aerocat.tech and GitHub Pages without COOP/COEP headers).
- Minimum hardware for the modelling targets in section 14: 4-core CPU, 8 GB RAM, WebGL2.
- Tablets (≥768 px): view, measure, edit parameters and dimensions of existing features (P5: full sketching with pen).
- Phones (<768 px): view and measure only; modelling commands hidden with a note.
- Works offline once loaded (existing static app; a service worker for full offline use is FR-STO-030).

### 4.3 Constraints

- **C-1** Everything runs client-side. No model data, file name or telemetry leaves the browser (existing promise in README).
- **C-2** Licences: app code MIT; OCCT/opencascade.js/occt-import-js LGPL-2.1, shipped unmodified and replaceable; any added solver library must be compatible with distributing in a static web app (see D-2).
- **C-3** Single static deployment (GitHub Pages and aerocat.tech `/tools/mobiuscad/`), released by the existing Release workflow.
- **C-4** The viewer must not get slower to open because of the modeller: modelling code and assets load on demand (NFR-PERF-001).
- **C-5** One author for commits and releases (Andrey Dumchin).

### 4.4 Assumptions and dependencies

- **A-1** The opencascade.js full build already shipped includes the modelling algorithms needed (BRepPrimAPI, BRepAlgoAPI, BRepFilletAPI, BRepOffsetAPI, BRepFeat, HLRBRep, BRepExtrema, ShapeFix, BRepCheck, GProp, STEPCAFControl, TNaming/TDF). To be confirmed by the P0 spike (FR-ARC-001); if a class is missing, a custom opencascade.js build is made (risk R-3).
- **A-2** WASM heap is limited to about 2–4 GB per worker by browsers; OCCT objects must be deleted explicitly.
- **A-3** A 2D constraint solver is available as WASM (FreeCAD's PlaneGCS via `@salusoft89/planegcs`) or is written in TypeScript (D-2).

---

## 5. Phases and release plan

Each phase ships as one or more minor versions through the normal release flow. A phase is complete when all its **M** requirements pass their acceptance tests (section 16). The viewer keeps working at every step.

| Phase | Name | Content | Exit criteria |
| --- | --- | --- | --- |
| **P0** | Foundations | Kernel spike, document model, persistent kernel session, command/undo framework, native file save/open, "Model" mode switch, unit test runner | AT-P0-1..4 |
| **P1** | MVP part modelling | Sketcher with core entities, relations, dimensions and solver; extrude/revolve (boss and cut); fillet; chamfer; reference planes/axes/points; feature tree with edit, rollback, suppress, delete; topological naming v1; material and mass; STEP/STL export of the part | AT-P1-1..8 (the "bracket" scenario) |
| **P2** | Productive parts | Hole wizard, cosmetic thread, shell, draft, linear/circular/mirror patterns, more sketch tools (slots, ellipse, spline, sketch patterns/mirror, DXF import), more end conditions, thin features, parameters/equations, configurations, reorder, parent/child, editing imported bodies as base; **local vault** with check-out/check-in, versions, history, roll back, audit trail | AT-P2-1..6, AT-PDM-1..2 |
| **P3** | Advanced parts | Sweep, loft, rib, helix, split line, multibody (combine, split, move/copy, delete body), variable/face fillets, 3MF export, imported body healing | AT-P3-1..4 |
| **P4** | Assemblies | Components (native, STEP, SLDPRT), sub-assemblies, standard mates + limit/width/symmetric, mate solver with drag, interference, component patterns, BOM, stored exploded views, assembly STEP export with structure; **revisions and default lifecycle workflow**, where-used/contains, version-aware references and BOMs, copy tree, rename with reference update, data cards, numbering, search, version compare | AT-P4-1..6, AT-PDM-3..6 |
| **P5** | Drawings and extras | Drawing documents: sheets, templates, title block, standard/projected/section/detail/auxiliary views, dimensions and annotations, BOM and revision tables, PDF/DXF/SVG export; mechanical mates (hinge, slot, gear, screw); fastener library; in-context references; surfaces; direct edit; 3D sketch; **workflow editor, change orders (ECO), release packages, shared-folder vault** | AT-P5-1..6, AT-PDM-7..8 |
| **P6** | Specialist | Sheet metal, basic weldments, simple motion animator, scripting console | per feature |
| **P7** | Server vault and collaboration (optional) | Server PDM with authenticated users and permissions, git backend for vaults, real-time co-editing; any sharing beyond files needs a separate decision (C-1) | separate FRS |

Status on 2026-11-08 (1.87.0): P0–P4 are built and released; P5 drawings, surfaces, direct editing and most part options are built; P6 and P7 have not started. Appendix G lists every requirement of P1–P5 that the code does not yet meet.

Indicative effort for one developer with AI assistance: P0 3–4 weeks, P1 8–12 weeks, P2 8 weeks, P3 6 weeks, P4 8–10 weeks, P5 10–12 weeks. These are planning numbers, not commitments.

---

## 6. Architecture requirements

### 6.1 Overview

```
 main thread                                            kernel worker (per document)
 ┌──────────────────────────────────────────┐           ┌────────────────────────────────┐
 │ UI (panels, tree, dialogs, i18n)         │           │ opencascade.js (full OCCT)     │
 │ Commands + undo stack                    │  messages │ Feature evaluators             │
 │ Document model (JSON, source of truth) ──┼──────────▶│ Shape cache per feature        │
 │ Sketch solver (WASM, own worker or main) │           │ Topological naming resolver    │
 │ Viewer (three.js), Snapper, measure      │◀──────────┼─ Tessellation + ids, errors,   │
 │ Storage (OPFS / FSA / download)          │  meshes   │   mass props, STEP/HLR output  │
 └──────────────────────────────────────────┘           └────────────────────────────────┘
```

### 6.2 Source of truth

- **FR-ARC-001** (P0, M) A spike shall confirm that the shipped opencascade.js build exposes every OCCT class listed in A-1 and that a 20-feature part (box, cuts, fillets) evaluates in the browser. The result is recorded in `docs/` before P1 starts.
- **FR-ARC-002** (P0, M) The document model (section 15) shall be the only source of truth. Geometry, meshes, drawing views and BOMs are derived data and may be discarded and rebuilt at any time.
- **FR-ARC-003** (P0, M) All edits shall go through commands (`Command { do, undo, label }`) acting on the document model, never on derived geometry directly. This gives undo/redo, autosave and dirty tracking in one place.
- **FR-ARC-004** (P0, M) The document model shall be plain serialisable data (JSON-compatible), with stable ids for every feature, sketch entity, relation, dimension, parameter, component and mate.

### 6.3 Kernel session

- **FR-ARC-010** (P0, M) Each open part document shall have one long-lived kernel worker that keeps the evaluated shape of each feature (shape cache), so editing feature *k* re-evaluates only *k* and later features.
- **FR-ARC-011** (P0, M) The worker shall free OCCT objects it no longer needs (`delete()` on handles) and report its heap size after each rebuild. Above a threshold (default 1.5 GB, configurable) the client shall start a fresh worker and rebuild from the document in the background, swapping when done; the user keeps working on the old view meanwhile.
- **FR-ARC-012** (P0, M) A kernel crash, WASM trap or out-of-memory shall not lose the document: the client restarts the worker, rebuilds, and shows a non-blocking notice. The failing feature is marked if it can be identified.
- **FR-ARC-013** (P0, M) Rebuilds shall be cancellable: a new edit during a rebuild cancels the remaining evaluation (checked between features) and starts again from the earliest changed feature.
- **FR-ARC-014** (P1, M) The worker shall return per body: tessellation with B-rep face ids per triangle and edge polylines with edge ids (so `topology.ts` welding is not needed for modelled bodies), exact face/edge classification as in `FacePatch`/`EdgePatch`, bounding box, and mass properties on request.
- **FR-ARC-015** (P1, S) Tessellation tolerance shall follow the existing mesh quality presets (coarse/normal/fine), with a preview tolerance used while dragging.
- **FR-ARC-016** (P4, M) Assemblies shall use one worker per assembly that loads each distinct part's evaluated shape once and places instances by transforms (no geometry copy per instance).

### 6.4 Sketch solver

- **FR-ARC-020** (P0, M) The constraint solver shall run off the UI thread or finish within 8 ms per solve on the main thread for sketches up to 200 entities (NFR-PERF-010); if not, it runs in its own worker with the latest drag position winning.
- **FR-ARC-021** (P0, M) The solver choice (PlaneGCS WASM vs own TypeScript Newton/Levenberg–Marquardt with Jacobian rank analysis) shall be settled by the P0 spike using the solver acceptance set in section 16.3 and the licence check in D-2.
- **FR-ARC-022** (P1, M) The solver interface shall be internal (`solve(sketch, drag?) → {positions, status, dof, conflicting[], redundant[]}`) so the implementation can be replaced.

### 6.5 Rendering integration

- **FR-ARC-030** (P1, M) Modelled bodies shall appear as `Part`s in the existing `Viewer`, so display modes, NavCube, sections, measure, snapping, exploded view and export work on them unchanged.
- **FR-ARC-031** (P1, M) The sketch shall be drawn as an overlay in the sketch plane (lines, points, dimensions, relation glyphs) with constant screen-space line widths and picking tolerances.
- **FR-ARC-032** (P1, S) Feature previews (yellow-tinted transparent body) shall come from the kernel at preview tolerance; for extrude and revolve with only depth changes, the client may extrude the profile itself for instant feedback and replace it with the kernel result when ready.

### 6.6 Code organisation

- **FR-ARC-040** (P0, S) New code shall live under `src/model/` (document, commands, undo, storage, rebuild orchestration), `src/sketch/` (entities, tools, solver adapter, overlay), `src/kernel/` (feature evaluators beside `occ.ts`), `src/asm/` (P4), `src/drawing/` (P5). The viewer-only bundle shall not import them (dynamic `import()` on entering a modelling mode).

---

## 7. Functional requirements: documents, workspace, history

### 7.1 Documents and modes

- **FR-DOC-001** (P0, M) The app shall support document kinds **Part**, **Assembly** (P4) and **Drawing** (P5), plus the existing read-only **Imported model** (STEP/IGES/BREP/mesh/SolidWorks) and **PCB** views.
- **FR-DOC-002** (P0, M) A **New** menu shall create a Part (P0), Assembly (P4) or Drawing (P5) from a template: units (mm, cm, m, in, ft), angle unit (deg/rad), decimals, standard planes and origin, default material (none), drawing standard (ISO/ANSI) where relevant.
- **FR-DOC-003** (P0, M) Several documents may be open at once in tabs; each tab has its own undo stack, kernel worker, selection and view. Switching tabs keeps camera and selection. Memory limit: at most 4 part/assembly kernels alive at once (LRU, others are rebuilt on activation).
- **FR-DOC-004** (P1, M) An imported model shall offer **Edit as part**: it becomes a new Part whose first feature is an *Imported body* (exact B-rep from the kernel, names and colours kept); later features can cut, fillet or add to it. The original file is not changed.
- **FR-DOC-005** (P0, M) Each document shall show its name, a dirty marker (●) when unsaved, and its kind in the tab and the window title.
- **FR-DOC-006** (P0, M) Closing a dirty document shall ask Save / Don't save / Cancel (existing confirm dialog in `ui.ts`).
- **FR-DOC-007** (P1, M) Document properties shall include: title, part number, description, revision, author, material, custom properties (key/value, text/number/date), units. They feed drawing title blocks and BOMs.

### 7.2 Feature tree

- **FR-HIS-001** (P1, M) Each part shall show a feature tree: document name, annotations folder (P5), material, origin and standard planes, then features in history order. Bodies are listed in a **Bodies** folder (P3: one folder per solid/surface body).
- **FR-HIS-002** (P1, M) Each feature row shows icon, name (editable, double-click or F2), and state: OK, warning (amber), error (red), suppressed (grey, struck through), rolled back (dimmed below the rollback bar).
- **FR-HIS-003** (P1, M) Selecting a row highlights the feature's faces in the view; selecting geometry in the view highlights the feature that created it (and scrolls to it).
- **FR-HIS-004** (P1, M) Context menu per feature: Edit feature, Edit sketch, Suppress/Unsuppress, Roll back to here, Roll forward, Rename, Delete (with option to delete absorbed sketches), Show/Hide sketch, Properties, What's wrong (when errored).
- **FR-HIS-005** (P1, M) A rollback bar shall be draggable in the tree; features below it are not evaluated; new features are inserted at the bar.
- **FR-HIS-006** (P2, M) Features can be reordered by dragging when the move keeps every reference valid (a feature cannot move above a feature it references); invalid drops are refused with a reason.
- **FR-HIS-007** (P2, S) Parent/child view: for the selected feature, list the features and sketches it uses and that use it.
- **FR-HIS-008** (P1, M) Sketches used by a feature are shown nested under it ("absorbed"); a sketch used by several features stays at top level and each feature lists it.
- **FR-HIS-009** (P2, S) Folders in the tree (user groups of features), collapsible.
- **FR-HIS-010** (P1, M) Double-clicking a feature shows its driving dimensions on the model; clicking a dimension value edits it in place and rebuilds (on Enter).
- **FR-HIS-011** (P1, S) Tree filter by name (reuse the model tree filter input).

### 7.3 Rebuild

- **FR-HIS-020** (P1, M) After any change the part rebuilds automatically from the earliest affected feature. A manual **Rebuild** (Ctrl+B) and **Force rebuild all** (Ctrl+Q) are available.
- **FR-HIS-021** (P1, M) A failing feature shall not stop the rebuild of later features that do not depend on it; dependants of a failed feature are marked "parent failed" and skipped. The last good geometry stays on screen while rebuilding.
- **FR-HIS-022** (P1, M) Each error carries a code and a plain-language message in EN/RU (Appendix C), e.g. "Fillet radius 8 mm is too large for edge Edge<3> (adjacent face is 6 mm wide)", plus the references involved; **What's wrong** lists all errors and warnings, each linking to the feature.
- **FR-HIS-023** (P1, M) Rebuild progress shall show in the status bar (feature *n* of *m*) when it takes longer than 300 ms; the UI stays responsive.
- **FR-HIS-024** (P2, S) Optional **Freeze** bar: features above it are not re-evaluated (shape cache kept and saved).

### 7.4 Undo and redo

- **FR-UND-001** (P0, M) Every document change is undoable: Ctrl+Z / Ctrl+Y (Ctrl+Shift+Z), toolbar buttons with the command name in the tooltip ("Undo Extrude1 depth 20 → 25").
- **FR-UND-002** (P0, M) Undo depth at least 200 steps per document; the stack survives save but not closing the document (P7: persisted history).
- **FR-UND-003** (P1, M) Inside the sketcher, undo works per sketch operation; leaving the sketch collapses its operations into one "Edit sketch" step on the part stack, still undoable as a whole.
- **FR-UND-004** (P0, M) View changes (camera, selection, visibility of measurement labels) are not part of the undo stack. Hide/show of bodies and components is undoable.

### 7.5 Selection

- **FR-SEL-001** (P1, M) Selection of faces, edges, vertices, sketch entities, sketch regions, bodies, features (via tree), planes, axes, points, components and mates (P4), with preselection highlight on hover (reuse Snapper logic).
- **FR-SEL-002** (P1, M) Ctrl+click adds/removes; Esc clears; box selection (left to right: fully inside; right to left: crossing).
- **FR-SEL-003** (P1, M) Selection filter (toolbar and F5): faces, edges, vertices, sketch entities, planes/axes, bodies, components.
- **FR-SEL-004** (P1, M) **Select other** (Alt+click or right-click → Select other) cycles through hidden entities under the cursor.
- **FR-SEL-005** (P2, S) Selection helpers: select tangent chain, select loop, select all fillets of a feature, select by type.
- **FR-SEL-006** (P1, M) Feature commands accept pre-selection (select edges, then press Fillet) and post-selection (press Fillet, then pick).

### 7.6 Parameters, equations, configurations

- **FR-PAR-001** (P2, M) Global variables (name, expression, unit, comment) per document, shown in a Parameters panel.
- **FR-PAR-002** (P2, M) Any numeric input (dimension, feature parameter) accepts an expression: arithmetic, `+ - * / ^ ( )`, functions `sin cos tan asin acos atan atan2 sqrt abs min max round floor ceil pi`, unit suffixes (`25.4mm`, `1in`, `30deg`), global variables and other dimensions by name (`D1@Sketch1`, or a user name). Expressions are kept; the evaluated value is shown.
- **FR-PAR-003** (P2, M) Expressions are evaluated in dependency order; circular references are reported and refused.
- **FR-PAR-004** (P1, M) Even before P2, every numeric box accepts plain arithmetic and unit suffixes (e.g. `10+2.5`, `1in`).
- **FR-PAR-005** (P2, S) Equations panel lists every expression-driven value with its result; deleting a feature removes equations that only target it (and asks if others reference it).
- **FR-CFG-001** (P2, M) Configurations: named variants of a part, each overriding parameter values, dimension values, suppression state of features, material and custom properties.
- **FR-CFG-002** (P2, M) The active configuration is chosen from a list; rebuild follows. Assemblies (P4) and drawings (P5) choose the configuration per component/view.
- **FR-CFG-003** (P5, C) Configuration table import/export as CSV.

### 7.7 Materials and properties

- **FR-MAT-001** (P1, M) Material per part (and per body, P3) chosen from the existing material list (density), extended with: name, density, Young's modulus, Poisson, yield strength, colour hint. Custom materials are saved in the document and in a local library.
- **FR-MAT-002** (P1, M) Mass properties panel (existing) works on the modelled part using exact kernel values: volume, area, mass, centre of mass, principal moments and axes of inertia (new), relative to origin or a chosen coordinate system.
- **FR-MAT-003** (P1, M) Appearance: colour and opacity per part, body (P3), feature and face; stored in the document and exported to STEP.
- **FR-MAT-004** (P2, S) Mass property override (user-entered mass/COM for purchased parts), flagged in BOM.

### 7.8 Reference geometry

- **FR-REF-001** (P1, M) Origin and three standard planes (named XY/Top, XZ/Front, YZ/Right in the active language; the app's own naming shall be decided in D-6) and three axes, hidden by default except in sketch selection.
- **FR-REF-002** (P1, M) Reference plane by: offset from plane/face (distance, flip, number of planes), angle to plane/face about an edge/axis, through three points, through a line and a point, normal to a curve at a point, mid-plane between two parallel faces/planes, tangent to a cylindrical face at an angle/through a line (P2).
- **FR-REF-003** (P1, M) Reference axis by: line/edge, two points, two planes' intersection, cylinder/cone axis, point and face normal.
- **FR-REF-004** (P1, M) Reference point by: vertex, arc/circle centre, face centre (centroid), intersection of edge and plane, point on edge at distance/ratio, projection onto face.
- **FR-REF-005** (P2, M) Reference coordinate system by origin point and axis directions; usable as export frame (STEP/STL) and for mass properties; shared with `csys.ts`.
- **FR-REF-006** (P1, M) Reference geometry is resizable on screen, shows its name on hover, and can be hidden/shown individually or all (View → Hide all planes).

---

## 8. Functional requirements: sketcher

### 8.1 Entering and leaving a sketch

- **FR-SK-001** (P1, M) **Sketch** starts on a selected plane or planar face; without a selection it asks for one, showing the standard planes. The view turns normal to the sketch plane (option: off), and the sketch toolbar replaces the feature toolbar.
- **FR-SK-002** (P1, M) The sketch has a local 2D coordinate system: origin projected from the part origin; X axis aligned with the plane's natural direction (standard planes) or a chosen edge (P2: "Sketch orientation" option).
- **FR-SK-003** (P1, M) Leaving the sketch: **Exit sketch** (confirm corner, or Ctrl+Enter / the sketch button again) keeps changes; **Discard** (with confirmation if changed) reverts to the state at entry.
- **FR-SK-004** (P1, M) Starting a feature (e.g. Extrude) while in a sketch exits the sketch and uses it as the feature's profile.
- **FR-SK-005** (P1, M) Editing an existing sketch rolls the model back to just before that sketch; geometry after it is hidden or shown transparent (option).
- **FR-SK-006** (P1, S) Section view option "Section at sketch plane" (reuse `Section.ts`) to sketch inside a part.
- **FR-SK-007** (P1, M) The sketch plane of a sketch can be changed later (**Edit sketch plane**); relations to external geometry that no longer resolve become errors (FR-SK-064).

### 8.2 Sketch entities

- **FR-SK-010** (P1, M) Point.
- **FR-SK-011** (P1, M) Line: click-click chains; click-drag-release makes a single line; double-click or Esc ends the chain; moving back to the last end point switches to a tangent arc (A key toggles arc mode explicitly).
- **FR-SK-012** (P1, M) Construction line (centerline): any entity can be toggled construction (Q key, or a property). Construction entities do not form profiles.
- **FR-SK-013** (P1, M) Rectangle: corner-corner, centre-corner; produces 4 lines with horizontal/vertical and coincident relations. P2: 3-point corner, 3-point centre, parallelogram. **Done (1.152.0).**
- **FR-SK-014** (P1, M) Circle: centre-radius, 3-point (P2: perimeter tangent circle).
- **FR-SK-015** (P1, M) Arc: centre-start-end, 3-point, tangent arc from an endpoint.
- **FR-SK-016** (P1, M) Polygon: n sides (3–64), inscribed/circumscribed, centre + vertex; adds construction circle and equal relations.
- **FR-SK-017** (P2, M) Slot: straight (overall/centre-to-centre), centre straight, 3-point arc slot, centre arc slot; with width dimension. **Done (1.144.0)**: `slot`/`cslot`/`aslot`/`aslot3` tools, live preview, width + length/radius dims with the Modify box.
- **FR-SK-018** (P2, M) Ellipse and elliptical arc.
- **FR-SK-019** (P2, M) Spline: interpolating through points, with optional tangency handles at ends and points; degree 3; P5: control-polygon spline and curvature handles. **Control-polygon (style) spline done (1.162.0); curvature handles open.**
- **FR-SK-020** (P4, S) Text: font (bundled open fonts), height, along a curve option; usable for extrude/cut (embossing).
- **FR-SK-021** (P5, C) Conic, parabola, equation-driven curve `y = f(x)` or parametric. **Done (1.157.0).**
- **FR-SK-022** (P1, M) Each entity has properties shown in the side panel when selected: coordinates/length/radius/angle (editable as fix-to-value, which adds a dimension or moves the geometry if under-defined), construction flag, relations list.

### 8.3 Sketch tools

- **FR-SK-030** (P1, M) Trim: smart trim by clicking a segment (removes it up to the nearest intersections), and drag-through trim over several segments.
- **FR-SK-031** (P1, M) Extend to the nearest intersection.
- **FR-SK-032** (P1, M) Split entity at a point.
- **FR-SK-033** (P1, M) Sketch fillet (radius) and sketch chamfer (distance, distance-angle) at a corner, keeping relations and adding a radius/distance dimension.
- **FR-SK-034** (P1, M) Offset entities: selected chain or loop, distance, side, both sides, cap ends (arc/line); keeps an offset relation so the result follows the source (P2) or is static (P1).
- **FR-SK-035** (P1, M) Convert entities (project model edges, loops of a face, or other sketches' entities into this sketch) with an "on edge" relation that follows the model.
- **FR-SK-036** (P2, M) Intersection curve: intersection of the sketch plane with selected faces/bodies.
- **FR-SK-037** (P2, M) Mirror entities about a line (adds symmetric relations); dynamic mirror while drawing.
- **FR-SK-038** (P2, M) Linear and circular sketch patterns with count and spacing as dimensions; instances keep equal relations to the seed.
- **FR-SK-039** (P2, M) Move, copy, rotate, scale entities (numeric and by drag; relations to unselected geometry are kept or removed by choice).
- **FR-SK-040** (P2, M) Import DXF (R12–2018 lines, arcs, circles, polylines with bulges, splines, ellipses; layers selectable; units) into the active sketch, reusing the parser for profile export where possible.
- **FR-SK-041** (P1, S) Grid (optional), with snap to grid (off by default).
- **FR-SK-042** (P1, M) Sketch inference while drawing: snap to end points, mid points, centres, quadrants, intersections, nearest on curve, model vertices/edges/face centres projected to the sketch plane (reuse Snapper). Dotted inference lines for horizontal/vertical alignment with existing points.

### 8.4 Relations

- **FR-SK-050** (P1, M) Supported relations (P1):

| Relation | Entities |
| --- | --- |
| Coincident | point–point, point–curve |
| Horizontal / Vertical | line; two points |
| Parallel / Perpendicular | two lines |
| Collinear | two lines |
| Tangent | line–arc/circle, arc–arc, (P2) spline–any |
| Concentric | arcs/circles/points |
| Coradial | two arcs/circles (same centre and radius) |
| Equal | lines (length), arcs/circles (radius) |
| Midpoint | point–line |
| Symmetric | two points/lines/arcs about a construction line |
| Fixed | any entity (locks in place) |
| On edge / On model | sketch entity–projected model edge or vertex (external reference) |

- **FR-SK-051** (P2, M) Additional relations: pierce (sketch point onto a curve not in the plane), intersection (point at intersection of two curves), along X/Y of another point, curvature continuity (spline), equal curvature, merge points.
- **FR-SK-052** (P1, M) Automatic relations while drawing (horizontal, vertical, coincident, tangent, perpendicular, parallel to inferred lines), shown as glyphs near the cursor; holding Ctrl (or a toggle) suppresses them.
- **FR-SK-053** (P1, M) Relations are shown as small glyphs next to the entities (toggle), with hover highlighting of the related entities; clicking a glyph selects the relation; Del deletes it.
- **FR-SK-054** (P1, M) **Add relation**: select entities, the panel lists only relations valid for that selection.
- **FR-SK-055** (P1, M) **Relations list** panel: all relations of the sketch with status (satisfied, conflicting, redundant, dangling), filter to selection, delete.

### 8.5 Dimensions

- **FR-SK-060** (P1, M) One smart dimension tool infers the type from the selection: length of a line; distance point–point, point–line, line–line (parallel); horizontal/vertical distance (by cursor position); angle between two lines (four quadrants by cursor); radius/diameter of arcs/circles (toggle); arc length (arc + both end points); distance from a circle's centre, near side or far side (Shift).
- **FR-SK-061** (P1, M) Placing a dimension opens an inline value box at the dimension (Enter to apply, Esc to keep the current value); the box accepts expressions (FR-PAR-004).
- **FR-SK-062** (P1, M) Driving vs driven: a dimension that would over-define the sketch is offered as driven (reference, shown in grey, in parentheses) or rejected.
- **FR-SK-063** (P2, M) Ordinate dimensions (horizontal/vertical chains from a base) and symmetric/diameter dimensions about a centerline (for revolve profiles).
- **FR-SK-064** (P1, M) Dimensions and relations to external (model) geometry become **dangling** when the referenced edge disappears; dangling items are shown in a distinct colour and can be re-attached by dragging the end onto new geometry or deleted.
- **FR-SK-065** (P1, M) Dimension names (`D1@Sketch2`) are shown on hover and are editable; they are usable in expressions (P2).
- **FR-SK-066** (P1, S) Dimension text positions are draggable and stored; the text follows the sheet units/decimals of the document.

### 8.6 Solver behaviour

- **FR-SLV-001** (P1, M) After every change (new entity, relation, dimension, drag) the solver finds positions satisfying all relations and driving dimensions with the least movement from the current positions.
- **FR-SLV-002** (P1, M) Status colouring: under-defined entities in one colour, fully defined in another, over-defined/conflicting in red, unsolvable in a warning colour; colours from tokens checked for contrast in both themes. The status bar shows "Under defined, 3 DOF" / "Fully defined" / "Over defined".
- **FR-SLV-003** (P1, M) Dragging an under-defined entity moves it and everything connected through relations in real time (≥30 fps for 200 entities); fully fixed entities do not move.
- **FR-SLV-004** (P1, M) When a new relation or dimension makes the system inconsistent, it is not applied; the user sees which existing relations conflict (highlighted) and may choose: make the new one driven, delete a conflicting one, or cancel.
- **FR-SLV-005** (P1, M) Redundant constraints (consistent but unnecessary) are reported and may be kept as driven.
- **FR-SLV-006** (P1, M) Solving is deterministic: the same document always produces the same positions (no random restarts without a fixed seed).
- **FR-SLV-007** (P1, M) Large value changes (e.g. a dimension from 10 to 1000) are applied in steps if the direct solve fails, to avoid flipping arcs and lines (continuation).
- **FR-SLV-008** (P1, S) Solver tolerance: 1e-9 mm on positions, 1e-10 rad on angles; residual reported in debug.
- **FR-SLV-009** (P2, S) **Sketch assistant**: for over-defined sketches, proposes sets of relations/dimensions whose removal fixes the conflict, with preview.
- **FR-SLV-010** (P2, S) Under-defined analysis: show the free directions (arrows) of a selected entity.

### 8.7 Profiles and regions

- **FR-SK-070** (P1, M) The sketcher finds closed regions automatically (planar arrangement of non-construction curves with intersections), including nested loops (holes) and regions bounded by several curves crossing each other.
- **FR-SK-071** (P1, M) Regions are shaded inside the sketch (option) and selectable for features; a feature may use the whole sketch (all outer regions with holes) or chosen regions only.
- **FR-SK-072** (P1, M) Open contours are allowed for thin features (P2), surfaces (P5), sweeps paths and revolve axes; invalid profiles (self-intersection, open where closed needed, zero-length segments, duplicate overlapping entities) are listed with a highlight of the offending location.
- **FR-SK-073** (P1, M) **Check sketch for feature**: reports whether the sketch is valid for a chosen feature type before starting it.

### 8.8 3D sketch

- **FR-SK-080** (P5, S) 3D sketch: lines, splines, points in space, with relations along X/Y/Z, parallel to plane, coincident, and dimensions. Used for sweep paths and weldment members.

---

## 9. Functional requirements: part features

### 9.1 Common behaviour of every feature

- **FR-FT-001** (P1, M) Each feature is created and edited in the **feature panel** (section 13.4): inputs grouped in collapsible boxes, live preview in the view, OK (Enter) / Cancel (Esc) / Preview toggle / Help.
- **FR-FT-002** (P1, M) Preview updates within the budgets of NFR-PERF-020 after each input change; while dragging a handle, preview uses the coarse tolerance.
- **FR-FT-003** (P1, M) If the kernel cannot build the feature with the current inputs, the panel shows the reason inline (red, `#D32F2F` token per UI standards) and OK is disabled; the last valid preview stays visible dimmed.
- **FR-FT-004** (P1, M) Every numeric input accepts units and expressions (FR-PAR-002/004), has a spin control with a sensible step, and shows a drag handle on the model where meaningful (depth, radius, angle, distance).
- **FR-FT-005** (P1, M) References chosen for a feature (faces, edges, planes, sketches) are listed in selection boxes; clicking an item highlights it; Del removes it; an item that no longer resolves is shown as missing (FR-TN-004).
- **FR-FT-006** (P1, M) **Merge result** option for boss features in multibody parts (P3; in P1 bosses always merge with the single body).
- **FR-FT-007** (P3, M) **Feature scope** for cuts and bosses in multibody parts: all bodies or selected bodies.
- **FR-FT-008** (P1, M) Feature names are generated per type and language-neutral in storage (`Extrude1`), shown translated in the tree (`Вытягивание1`) per the i18n rule that stored data stays English.
- **FR-FT-009** (P1, M) Each feature records the kernel operation result: OK, warning (e.g. "1 edge skipped"), or error with code.

### 9.2 Extrude (boss and cut)

- **FR-FT-010** (P1, M) Inputs: profile (sketch or selected regions; P2: planar face), direction 1, optional direction 2, boss/cut toggle, reverse direction, merge result.
- **FR-FT-011** (P1, M) End conditions in P1: **Blind** (depth), **Through all** (cut; boss up to the far bounding box), **Mid plane** (symmetric depth), **Up to face/plane** (selected planar or curved face).
- **FR-FT-012** (P2, M) End conditions in P2: **Up to next**, **Up to vertex**, **Offset from face** (distance, reverse offset), **Up to body**, **Through all both**.
- **FR-FT-013** (P2, M) **Start from**: sketch plane, offset distance, face/plane, vertex.
- **FR-FT-014** (P2, M) **Draft** while extruding: angle, inward/outward, per direction.
- **FR-FT-015** (P2, M) **Thin feature**: wall thickness from an open or closed profile, one side / mid-plane / two sides with two thicknesses; cap ends with thickness for closed profiles.
- **FR-FT-016** (P1, M) Cut option **Flip side to cut** (keep outside of the profile).
- **FR-FT-017** (P1, M) On-model handles: arrow per direction for depth (drag, snap to vertices/faces like the 1.15.0 section arrows); clicking the arrow's value label edits it.
- **FR-FT-018** (P1, M) Kernel mapping: `BRepPrimAPI_MakePrism` on faces built from the sketch regions (`BRepBuilderAPI_MakeFace` with wires from the sketch curves), then `BRepAlgoAPI_Fuse`/`Cut`; up-to-face via `BRepFeat_MakePrism` or prism + cut by the face's half-space, chosen in the P0 spike.

### 9.3 Revolve (boss and cut)

- **FR-FT-020** (P1, M) Inputs: profile, axis (construction line in the sketch, sketch line, model edge, reference axis; a single construction line in the sketch is picked automatically), angle (default 360°), direction 2 angle, mid-plane option, reverse.
- **FR-FT-021** (P1, M) Profiles crossing the axis are rejected with a clear message.
- **FR-FT-022** (P2, M) Up to face/vertex end conditions; thin revolve.
- **FR-FT-023** (P1, M) Handle: angle arc arrow on the model.

### 9.4 Fillet

- **FR-FT-030** (P1, M) Constant-radius fillet on selected edges, or on all edges of selected faces or features; option **Tangent propagation** (default on).
- **FR-FT-031** (P1, M) Preview shows the fillet with the radius label; several radii in one feature via **multiple radius** list (P2).
- **FR-FT-032** (P3, M) Variable-radius fillet (radii at vertices and points along the edge), face fillet between two face sets (with hold line, P5), full round fillet between three face sets.
- **FR-FT-033** (P3, S) Setback fillets at corners where three or more filleted edges meet.
- **FR-FT-034** (P1, M) Errors name the edge(s) that failed; option **Keep features that fit**: skip failing edges with a warning instead of failing the whole fillet.
- **FR-FT-035** (P1, M) Kernel mapping: `BRepFilletAPI_MakeFillet` (rolling ball); `BRepFilletAPI_MakeFillet` with laws for variable radius.

### 9.5 Chamfer

- **FR-FT-040** (P1, M) Edge chamfer: equal distance, distance–angle (with flip of the reference face).
- **FR-FT-041** (P3, M) Two distances, vertex chamfer (three distances), offset-face chamfer.
- **FR-FT-042** (P1, M) Kernel mapping: `BRepFilletAPI_MakeChamfer`.

### 9.6 Holes and threads

- **FR-FT-050** (P2, M) **Hole** feature with types: simple, counterbore, countersink, counterdrilled, tapped, clearance (close/normal/loose), slot; end conditions blind / through all / up to face / up to next; drill-point angle (118° default) or flat bottom.
- **FR-FT-051** (P2, M) Standards: ISO metric (M1.6–M64, coarse and fine pitches), ISO clearance holes (ISO 273), counterbores for ISO 4762 socket head cap screws, countersinks for ISO 10642 / ISO 2009 (90°); ANSI inch (UNC/UNF #0–1", counterbore for socket head, 82° countersink). Data tables shipped as JSON, extensible by the user (P5).
- **FR-FT-052** (P2, M) Placement: the user clicks points on a planar face (a sketch is created underneath with points that can be dimensioned and related), or picks sketch points of an existing sketch; multiple holes per feature.
- **FR-FT-053** (P2, M) Tapped holes show a **cosmetic thread** (texture or dashed circle) and store thread data (designation, pitch, depth, class) for drawings (hole callouts) and STEP export as a property; geometry is the tap drill diameter.
- **FR-FT-054** (P2, M) **Cosmetic thread** feature on any cylindrical edge (internal or external), same data.
- **FR-FT-055** (P5, S) Modelled (helical) thread feature for 3D printing, from the same tables.
- **FR-FT-056** (P2, S) Favourites: save a hole definition under a name and reuse it.

### 9.7 Shell, draft, rib

- **FR-FT-060** (P2, M) **Shell**: thickness, faces to remove, inward/outward, multi-thickness faces (P3). Kernel: `BRepOffsetAPI_MakeThickSolid`.
- **FR-FT-061** (P2, M) **Draft**: neutral plane, faces to draft, angle, tangent propagation. Kernel: `BRepOffsetAPI_DraftAngle`. Parting-line draft (P5).
- **FR-FT-062** (P3, M) **Rib**: open sketch profile, thickness (one side / both / mid), extrusion direction parallel or normal to the sketch, draft. Kernel: `BRepFeat_MakeLinearForm` or own construction.

### 9.8 Patterns and mirror

- **FR-FT-070** (P2, M) **Linear pattern** of features, faces or bodies (P3): one or two directions (edge, axis, dimension, plane normal), spacing or total extent, count, skip instances (click to skip), pattern seed only in direction 2.
- **FR-FT-071** (P2, M) **Circular pattern**: axis (axis, cylindrical face, circular edge, angular dimension), count, angle (equal spacing over 360° or total angle), second direction (symmetric), skip instances.
- **FR-FT-072** (P2, M) **Mirror** features, faces or bodies about a plane or planar face.
- **FR-FT-073** (P3, M) **Sketch-driven pattern** (instances at sketch points) and **table-driven** (CSV coordinates, P5).
- **FR-FT-074** (P2, M) Geometry pattern option: copy the resulting geometry (fast) vs. re-evaluate the features at each instance (respects end conditions such as up-to-face).
- **FR-FT-075** (P2, M) Instances that fail (fall outside the part) are skipped with a warning listing them.

### 9.9 Sweep, loft and curves

- **FR-FT-080** (P3, M) **Sweep** (boss/cut): closed profile, path (sketch curve, edges, helix); orientation follow path / keep normal constant; P5: guide curves, twist along path, start/end tangency. Kernel: `BRepOffsetAPI_MakePipeShell`.
- **FR-FT-081** (P3, M) **Circular profile sweep**: diameter along a path without a profile sketch (for tubes, wires, springs).
- **FR-FT-082** (P3, M) **Loft** (boss/cut): two or more closed profiles in order, start/end constraints (none, normal to profile), connector points to fix twisting, close loft; P5: guide curves, centreline. Kernel: `BRepOffsetAPI_ThruSections`.
- **FR-FT-083** (P3, M) **Helix/spiral** curve: from a circle in a sketch; pitch and revolutions, or height and pitch, or height and revolutions; taper angle; clockwise/counter-clockwise; variable pitch (P5).
- **FR-FT-084** (P3, S) **Split line**: project a sketch onto faces to split them (for face-specific colours, drafts, mates).
- **FR-FT-085** (P5, S) Projected curve, composite curve, curve through XYZ points (CSV import).

### 9.10 Multibody operations

- **FR-BODY-001** (P3, M) A part may contain several solid bodies (and surface bodies in P5); the Bodies folder lists them with show/hide, colour, material, rename, delete (as a history feature).
- **FR-BODY-002** (P3, M) **Combine**: add, subtract (main body minus tool bodies), common.
- **FR-BODY-003** (P3, M) **Split**: by plane, face or sketch; keep chosen pieces; optionally save pieces as new part documents (P4).
- **FR-BODY-004** (P3, M) **Move/Copy body**: translate by delta or between points, rotate about axis, or position with mates-like constraints (P4 engine).
- **FR-BODY-005** (P3, M) **Insert part**: brings another part document (or STEP/SLDPRT) as a body, linked or broken link, with transform.
- **FR-BODY-006** (P3, M) **Scale** (uniform or per axis, about origin/centroid/coordinate system).
- **FR-BODY-007** (P3, S) **Intersect** (regions between bodies and surfaces) and **Indent** (P5).

### 9.11 Surfaces and direct editing (P5)

- **FR-FT-100** (P5, S) Surface extrude, revolve, sweep, loft, planar surface, offset surface, knit (with "try to form solid"), fill (n-sided patch), trim, extend, thicken, delete face (delete and patch / delete and fill).
- **FR-FT-101** (P5, S) Direct editing on any body, including imported ones: **Move face** (offset / translate / rotate), **Delete face** (heal), **Replace face**. Kernel: `BRepOffsetAPI_MakeOffsetShape` / `BRepAlgoAPI_Defeaturing`.
- **FR-FT-102** (P5, C) Feature recognition on imported bodies: holes (cylinders through), fillets, chamfers, extrusions, turning them into editable features.

### 9.12 Specialist features (P6)

- **FR-FT-120** (P6, S) Sheet metal: base flange/tab, edge flange, miter flange, hem, jog, sketched bend, closed corner, break corner, unfold/fold, flat pattern with bend lines and K-factor/bend allowance tables, flat pattern DXF export.
- **FR-FT-121** (P6, C) Weldments: structural members from a profile library (ISO/EN rectangular tube, angle, channel, I-beam) along 3D sketch segments, trim/extend, end caps, gussets, cut list with lengths.
- **FR-FT-122** (P6, C) Simple motion: animate a mate's distance/angle over time and record a video (WebM) of the view.

### 9.13 Imported body as a feature

- **FR-FT-130** (P1, M) **Imported body** feature holds the exact B-rep of an imported STEP/IGES/BREP/SLDPRT file (stored as BREP text inside the document, FR-IO-003) with its name and colours.
- **FR-FT-131** (P3, S) **Check and heal**: `BRepCheck_Analyzer` report (invalid faces, gaps, open shells) and `ShapeFix` healing with a tolerance; result reported before/after.
- **FR-FT-132** (P1, M) Imported mesh bodies (STL/OBJ/3MF) cannot be modelled in P1–P4; the UI says so (convert-to-B-rep is P5, C).

### 9.14 Topological naming

- **FR-TN-001** (P1, M) Every reference from a feature or sketch to model topology (face, edge, vertex) shall be stored as a **persistent reference**, not as an index: the feature that created the entity, the role in that feature (e.g. extrude *side face from sketch curve c7*, *start cap*, *end cap*, *fillet face from edge E*), plus a geometric signature (type, normal/axis, centroid, area or length, bounding box) for disambiguation.
- **FR-TN-002** (P1, M) The kernel adapter shall build each feature's naming map from OCCT history (`BRepBuilderAPI_MakeShape::Generated/Modified/IsDeleted`, `BRepTools_History`) and from the sketch entity ids, so that faces generated from the same sketch curve keep their identity when dimensions change.
- **FR-TN-003** (P1, M) Resolution on rebuild: (1) follow the history chain; (2) if several candidates, pick the best geometric match above a threshold; (3) if none or ambiguous, the reference is **missing** and the feature errors with "Reference lost: Edge of Extrude1 (side of line L3)".
- **FR-TN-004** (P1, M) Missing references are listed in the feature panel and can be replaced by picking new geometry ("repair"); the rest of the feature's references stay.
- **FR-TN-005** (P1, M) Acceptance tests AT-P1-5/6 (changing sizes keeps fillets on the same edges; adding a feature earlier in the tree does not move later fillets) are mandatory for P1.
- **FR-TN-006** (P2, S) Split faces (a face cut in two by a later feature) shall keep their references for features that referenced the original face when one piece is the clear match; otherwise both pieces are used where that makes sense (fillet on a split edge: both pieces).

---

## 10. Functional requirements: assemblies

### 10.1 Components

- **FR-ASM-001** (P4, M) An assembly contains components: part documents, sub-assemblies, and foreign models (STEP/IGES/BREP/SLDPRT/SLDASM/mesh) used as rigid components.
- **FR-ASM-002** (P4, M) **Insert component**: from open documents, recent files, the project folder (FSA), or a file picker that lists `.mcadprt`, `.mcadasm` and foreign models (no drawings); placed by click, or at the origin (first component fixed at origin by default).
- **FR-ASM-003** (P4, M) Components can be **linked** (reference to a document by project-relative path and content hash) or **embedded** (copied into the assembly file). The choice is per component and changeable (FR-IO-011).
- **FR-ASM-004** (P4, M) Each component instance has: name (`Bracket<2>`), referenced document and configuration, transform, fixed/floating, visibility, colour override, suppressed (excluded from geometry, BOM by option).
- **FR-ASM-005** (P4, M) The same part inserted several times shares one evaluated shape (FR-ARC-016).
- **FR-ASM-006** (P4, M) Sub-assemblies are rigid by default; **flexible** lets their own mates solve inside the parent.
- **FR-ASM-007** (P4, M) **Open part** / **Edit part in place** (P5 for in-context with references to other components).
- **FR-ASM-008** (P4, M) **Replace component** keeps mates where references can be matched (by persistent names, then by geometry), reports the rest.
- **FR-ASM-009** (P4, M) The assembly tree shows components (expandable to their features read-only), a Mates folder, patterns, exploded views; component rows show DOF state: fixed (f), under-defined (–), fully defined, over-defined (+), errors.

### 10.2 Positioning and mates

- **FR-MATE-001** (P4, M) Free drag of floating components: left-drag moves in the view plane, right-drag (or a toggle) rotates about the component's centre; constrained by existing mates.
- **FR-MATE-002** (P4, M) **Move/rotate** with a triad (arrows, rings) and numeric deltas; **Collision detection** option stops the drag on contact (for selected components or all).
- **FR-MATE-003** (P4, M) Standard mates:

| Mate | Typical references | Options |
| --- | --- | --- |
| Coincident | face–face, face–point, edge–face, point–point, plane–plane | aligned / anti-aligned |
| Parallel | faces, planes, edges, axes | aligned / anti-aligned |
| Perpendicular | faces, planes, edges, axes | |
| Tangent | cylinder/sphere/cone–plane, cylinder–cylinder | |
| Concentric | cylinders, cones, circular edges, axes | lock rotation |
| Distance | faces, planes, points, axes, cylinders | value, flip |
| Angle | faces, planes, edges, axes | value, flip, reference direction |
| Lock | two components | |

- **FR-MATE-004** (P4, M) Advanced mates in P4: **Limit distance** and **Limit angle** (min/max), **Symmetric** (two entities about a plane), **Width** (centre a tab between two faces).
- **FR-MATE-005** (P5, S) Mechanical mates: hinge (concentric + coincident, optional angle limit), slot (cylinder/pin in a slot), gear (ratio between two rotations), rack and pinion, screw (pitch), universal joint, path mate (point along a curve), linear coupler, profile centre.
- **FR-MATE-006** (P4, M) **Quick mate**: after picking two references the app proposes the likely mate types (as a small toolbar at the cursor) with the first valid one previewed; Enter accepts.
- **FR-MATE-007** (P4, S) **Inferred mating while dragging** (hold Alt): drop a cylinder on a hole to make concentric + coincident; a face on a face to make coincident.
- **FR-MATE-008** (P4, M) Mate solver: solves rigid-body positions for all mates, minimal movement from the current state, reports per component DOF and over-defined/conflicting mates (red) without moving anything when inconsistent.
- **FR-MATE-009** (P4, M) Mates can be edited (references, type, values, flip), suppressed, deleted; mate errors name the components and references.
- **FR-MATE-010** (P4, M) Mate references use the persistent references of FR-TN, so a part change keeps mates where possible.
- **FR-MATE-011** (P5, S) Mate references stored in parts (named mating geometry) used automatically on insert.

### 10.3 Assembly tools

- **FR-ASM-020** (P4, M) **Interference detection**: pairs of components whose solids overlap, with interference volume, list and highlight; options: treat coincidence as interference, include fasteners, ignore hidden.
- **FR-ASM-021** (P5, S) **Clearance check** between selected components below a value (reuse `BRepExtrema_DistShapeShape`).
- **FR-ASM-022** (P4, M) **Component patterns**: linear and circular (as part patterns, with components); **pattern driven by a part feature pattern** (P5); **mirror components** (P5, with opposite-hand option).
- **FR-ASM-023** (P4, M) **Exploded views**: steps (components, direction, distance/rotation) stored in the document, several named views, animate collapse/explode, explode lines (P5). The existing auto explode becomes "Auto explode" producing steps.
- **FR-ASM-024** (P4, M) **BOM**: flat or indented, quantity per document and configuration, columns from custom properties (part number, description, material, mass), CSV export; numbering kept stable for drawing balloons.
- **FR-ASM-025** (P4, S) **Display states**: named sets of visibility, colour and transparency per component.
- **FR-ASM-026** (P5, S) Assembly configurations (suppression, component configuration, mate values).
- **FR-ASM-027** (P5, S) Assembly features: cut extrude and hole through several components, existing only in the assembly.
- **FR-ASM-028** (P5, S) Small fastener library (ISO 4762, ISO 4017/4014, ISO 7380, ISO 4032 nuts, ISO 7089 washers, M2–M20), generated parametrically as parts with configurations per size; insert with auto-mate on a hole (concentric + coincident).
- **FR-ASM-029** (P4, M) Mass properties of the assembly (existing panel) with per-component materials.
- **FR-ASM-030** (P5, S) In-context design: edit a part inside the assembly, sketch on another component's faces, with external references listed and lockable ("lock external references").
- **FR-ASM-031** (P4, S) Large assemblies: components beyond 300 load as lightweight (mesh only, from cache) until edited; the viewer's existing performance work applies.

---

## 11. Functional requirements: drawings

### 11.1 Sheets and templates

- **FR-DRW-001** (P5, M) A drawing document has one or more sheets; each sheet has a size (ISO A4–A0, ANSI A–E, custom), orientation, scale, projection type (first angle ISO default / third angle ANSI), and a sheet format (border, zones, title block).
- **FR-DRW-002** (P5, M) Shipped formats: ISO 7200 title block A4–A0 and ANSI Y14.1 A–D; GOST 2.104 (form 1) as an option for RU users (S). Formats are SVG templates with named fields.
- **FR-DRW-003** (P5, M) Title block fields come from document properties of the drawing and of the model in the first view (part number, title, material, mass, scale, sheet n of m, author, date, revision) and can be overridden.
- **FR-DRW-004** (P5, S) Users can edit and save their own sheet formats (field placement, logo image).

### 11.2 Views

- **FR-DRW-010** (P5, M) **Model view** of a part/assembly/configuration from a named orientation (front, top, right, iso, ..., or current 3D view), scale, display style (visible lines, hidden lines dashed, hidden removed, shaded, shaded with edges), tangent edges (visible, thin, hidden).
- **FR-DRW-011** (P5, M) **Standard 3 views** and **projected views** aligned to their parent (move together along the projection axis).
- **FR-DRW-012** (P5, M) **Section view** from a cutting line (straight; P6 offset/aligned/half): hatched cut faces (ANSI31/ISO hatch by material, reuse hatching code), section labels A–A, arrows; option to exclude fasteners/components from the cut.
- **FR-DRW-013** (P5, M) **Detail view**: circle (or sketch profile) on a parent view, scale, label.
- **FR-DRW-014** (P5, M) **Auxiliary view** normal to a selected edge.
- **FR-DRW-015** (P6, S) Broken-out section, break view, crop view, alternate position view.
- **FR-DRW-016** (P5, M) Views are computed by HLR in the kernel worker (`HLRBRep_Algo` exact for P5 quality, `HLRBRep_PolyAlgo` for fast preview) and update when the model changes (associative), with a "drawing out of date" marker until updated.
- **FR-DRW-017** (P5, M) View properties: label, scale (sheet or custom), alignment lock, display style, show cosmetic threads, show sketch / reference geometry.

### 11.3 Dimensions and annotations

- **FR-DRW-020** (P5, M) **Model items**: import the driving dimensions of features into the views where they read best, without duplicates.
- **FR-DRW-021** (P5, M) Drawing dimensions (driven): linear, aligned, angular, radius, diameter, chamfer, ordinate, baseline, chain, arc length; tolerances (symmetric, deviation, limit, fit codes ISO 286 e.g. H7/g6), precision, prefix/suffix, inspection frame.
- **FR-DRW-022** (P5, M) **Hole callout** using the hole feature data (e.g. "4× M6-6H ↧12, ⌴Ø11 ↧6.4").
- **FR-DRW-023** (P5, M) Annotations: notes (with property links), balloons (linked to BOM item numbers, auto-balloon), centre marks and centrelines (auto on circles/cylinders), surface finish (ISO 1302/21920), datum features and GD&T feature control frames (ISO 1101 / ASME Y14.5 symbols), cosmetic threads.
- **FR-DRW-024** (P5, M) Tables: BOM (from FR-ASM-024), revision table, general table; P6: hole table.
- **FR-DRW-025** (P5, M) Annotation styles per standard: font (bundled open font with GD&T glyphs), text heights 2.5/3.5/5 mm, arrows, line weights per ISO 128.
- **FR-DRW-026** (P5, S) Dimensions reattach after model changes using persistent references; dangling ones are shown in a warning colour.

### 11.4 Output

- **FR-DRW-030** (P5, M) Export PDF (vector, sheet size, all or current sheet, fonts embedded), DXF (R12 or 2000, mm, layers per line type), SVG, PNG at 300 dpi.
- **FR-DRW-031** (P5, M) Print via the browser's print dialog at 1:1 sheet size.

---

## 12. Functional requirements: files, storage, interoperability

### 12.1 Native format

- **FR-IO-001** (P0, M) Native files use one ZIP container format with a separate extension per document kind (decided by Andrey 2026-11-06, D-5): **`.mcadprt`** part, **`.mcadasm`** assembly, **`.mcaddrw`** drawing. "MöbiusCAD file" below means any of the three. The container holds:
  - `manifest.json`: format id, schema version, app version, document kind, created/modified dates, units, root document id.
  - `document.json`: the document model (section 15).
  - `thumbnail.png`: 256×256 view for file pickers and recent files.
  - `cache/<featureId>.brep` (optional): evaluated shapes for fast open; ignored if the app version or a hash does not match.
  - `bodies/<id>.brep`: imported bodies (exact B-rep, required, FR-FT-130).
  - `embedded/<docId>.mcadprt|.mcadasm`: embedded component documents (assemblies) or the referenced model (drawings), optional.
  - `meta/hole-tables.json`, `meta/materials.json`: user tables used by this document.
- **FR-IO-002** (P0, M) Opening a MöbiusCAD file rebuilds from `document.json` alone when caches are missing or stale; the result shall be identical within tolerance (NFR-ACC-002).
- **FR-IO-003** (P0, M) Schema versioning: every file states its schema version; newer apps open older files through ordered migrations; an older app opening a newer file refuses with a clear message (no partial read).
- **FR-IO-004** (P0, M) The JSON is human-readable (pretty-printed, stable key order) so files diff well in git.
- **FR-IO-005** (P0, M) A MöbiusCAD file is opened by drag-and-drop, the Open dialog, `?url=` and the File Handling API (installed PWA, Chromium) like other formats today. The extension must match the manifest's document kind; a mismatch opens by the manifest and warns.

### 12.2 References between documents

- **FR-IO-010** (P4, M) Linked components and drawing models are referenced by path relative to the referencing file plus a content hash and the document's id.
- **FR-IO-011** (P4, M) When a linked document cannot be found, the user is asked to locate it (or the folder); a component whose document is missing shows its last cached mesh (if any) and is marked.
- **FR-IO-012** (P4, M) **Pack**: save an assembly or drawing with everything it references embedded into one `.mcadasm`/`.mcaddrw`, or into a ZIP of separate files (pack-and-go).
- **FR-IO-013** (P4, M) **Save as** of a referenced part asks whether to update references in open assemblies.

### 12.3 Storage

- **FR-STO-001** (P0, M) **Save** writes the file back to where it came from when the browser allows (FSA file handle, Chromium); otherwise **Save** downloads `name.mcadprt` (or `.mcadasm`, `.mcaddrw`) and also keeps a copy in the browser workspace.
- **FR-STO-002** (P0, M) **Browser workspace** (OPFS, IndexedDB fallback): all documents created or opened in modelling are kept there with their names, so the user can reopen them from **Recent** without the file. Storage use is shown with an option to delete items; quota errors are reported clearly.
- **FR-STO-003** (P0, M) **Autosave**: every committed command is journaled to the workspace within 2 s (debounced); after a crash or closed tab, the next start offers to recover unsaved changes per document.
- **FR-STO-004** (P4, S) **Project folder** (FSA directory handle, Chromium): open a folder, browse its parts/assemblies/drawings in a side list, links resolved inside it.
- **FR-STO-005** (P2, S) Outside a vault, each document keeps automatic snapshots at every save in the browser workspace (last 20), restorable or openable as a copy. Inside a vault, versions (FR-PDM-010..017) replace this.
- **FR-STO-030** (P2, S) Service worker for full offline start (cache app shell and WASM per version).

### 12.4 Exchange formats

| Format | Import | Export | Phase / notes |
| --- | --- | --- | --- |
| STEP AP203/AP214/AP242 | yes (viewer, imported body, component) | part, body, assembly with structure, names, colours | P1 part export (M); P4 assembly structure (M); P5 AP242 tessellated + validation properties (C) |
| IGES 5.3 | yes | bodies/surfaces | P3 export (S) |
| BREP (OCCT) | yes | bodies | P1 (S) |
| Parasolid X_T, SLDPRT/SLDASM | yes (dumb geometry) | — | existing |
| STL, OBJ, 3MF, glTF | yes as meshes (view/measure, not modelling) | yes | existing; 3MF with units and colours P3 (M) |
| DXF | into sketch (P2), cut profiles (existing) | sketch, flat pattern (P6), drawing (P5) | |
| SVG | — | sketch (P2), drawing (P5) | |
| PDF | — | drawing (P5), inspection report (existing) | |
| PNG | sketch picture (P5) | view (existing), drawing (P5) | |

- **FR-IO-020** (P1, M) STEP export of a part writes one product with the part name, solid bodies with colours (face colours where set), units mm, and the part's custom properties as STEP product properties where AP214/AP242 permit.
- **FR-IO-021** (P1, M) Exported STEP files reopen in MöbiusCAD and in at least FreeCAD with identical volume (±1e-6 relative) and face count (test fixture round trip).
- **FR-IO-022** (P1, M) STL/3MF/OBJ/glTF export of modelled parts uses the existing exporters, with a tessellation quality choice (chord tolerance and angle).
- **FR-IO-023** (P4, M) STEP export of assemblies writes the product structure (components as instances of one product definition each), with names and colours.

### 12.5 Product data management: vault, versions, revisions

Reference: SolidWorks PDM Professional (formerly Enterprise PDM, "EPDM") and PDM Standard. They keep CAD files in a **vault**: users check files out (lock) and in (new **version**), files move through a **workflow** of lifecycle states, a **revision** label is assigned on release, data cards hold metadata, and the vault knows which assemblies and drawings use which parts (where-used), so references never break. MöbiusCAD provides the same concepts without a server (C-1): the vault lives in a folder the user chooses, or in browser storage, and every operation runs in the browser. A server vault for teams with real access control is out of scope here (P7, separate FRS).

**Terms used in this section**

| Term | Meaning in MöbiusCAD |
| --- | --- |
| Vault | A folder (FSA directory handle) or a browser workspace (OPFS) holding working files plus a hidden `.mcadvault/` store with every version, metadata and the audit log. |
| Version | An immutable snapshot of one file, created at each check-in. Numbered 1, 2, 3 … per file. Saving without check-in only updates the working copy. |
| Revision | A human label (A, B, C … or 01, 02 …) given to a version when it is released through the workflow. Several versions can exist between two revisions. |
| State | The lifecycle state of a file (Work in progress, In review, Released, Change pending, Obsolete). |
| Transition | A move from one state to another, with rules (who, required fields, actions). |
| Data card | The form of metadata fields of a file (part number, description, material, project ...), stored in the document properties and indexed by the vault. |
| Change order (ECO) | A record that groups the files changed for one reason, with request, approval and closing. |

#### 12.5.1 Vault

- **FR-PDM-001** (P2, M) **Create vault** in a folder (Chromium, FSA) or in the browser workspace (all browsers). A vault has a name, a revision scheme, a numbering scheme, a workflow (default one shipped) and a list of user names.
- **FR-PDM-002** (P2, M) **Open vault**: the left panel gets a **Vault** tab showing the folder tree and files with columns: name, kind, state, revision, latest version, local version, checked out by, part number, description, modified date. Columns are configurable; the list is sortable and filterable.
- **FR-PDM-003** (P2, M) **Add to vault**: drag files or folders in, or **Save to vault** from an open document. Adding an assembly or drawing offers to add every referenced file, keeping relative paths.
- **FR-PDM-004** (P2, M) Foreign files (STEP, PDF, DXF, images, spreadsheets) can be vaulted too: versioned and given states and data cards, without CAD-specific functions.
- **FR-PDM-005** (P2, M) The store keeps each version's bytes content-addressed (`.mcadvault/objects/<sha256>`), so identical content is stored once; metadata in `.mcadvault/index.json` (rebuilt from the per-file records if lost) and per-file records `.mcadvault/files/<fileId>.json`.
- **FR-PDM-006** (P2, M) **Integrity check**: verifies hashes, missing objects, broken references, orphan objects; reports and repairs what can be repaired (re-index, drop orphans after confirmation).
- **FR-PDM-007** (P2, M) **Export vault** to a ZIP (all versions and metadata, or latest only) and **import** a vault ZIP, for backup and moving between computers.
- **FR-PDM-008** (P2, S) **Storage report**: size by file and version, with **Purge old versions** (keep released revisions, keep the last *n* versions) after confirmation.

#### 12.5.2 Check-out, check-in and versions

- **FR-PDM-010** (P2, M) A vaulted file is read-only until **checked out**. Check-out records the user name, time and computer label, and shows a lock badge. Opening a file not checked out shows a "Read-only, check out to edit" bar with a Check out button.
- **FR-PDM-011** (P2, M) **Check in** creates a new version from the working copy with a required comment (configurable as optional), options **keep checked out** and **check in referenced files too** (list with checkboxes, pre-ticked for changed files). Unchanged files are skipped.
- **FR-PDM-012** (P2, M) **Undo check-out** discards local changes after confirmation and releases the lock.
- **FR-PDM-013** (P2, M) **History** dialog per file: every version with number, date, user, comment, size, state at check-in, revision label if any, and transitions and other events in between. Actions: open version read-only, get version (make it the local copy), compare (FR-PDM-050), roll back.
- **FR-PDM-014** (P2, M) **Roll back** to an older version creates a new version with that content (history is never rewritten); destroying versions is an admin action logged in the audit trail.
- **FR-PDM-015** (P2, M) **Get latest** refreshes local copies of the selected files (and their references) to the latest versions; files with local changes are not overwritten without confirmation.
- **FR-PDM-016** (P2, M) Status badges everywhere a file appears (vault list, document tab, title bar, assembly tree): checked out by me / by someone else / local copy outdated / local copy modified / not in vault.
- **FR-PDM-017** (P2, M) Versions store the derived caches (`cache/*.brep`, thumbnail) so an old version opens fast; caches may be dropped by purge and are rebuilt on demand.

#### 12.5.3 References, where-used, copy and rename

- **FR-PDM-020** (P4, M) The vault indexes references between files at each check-in: assembly → components, drawing → models, part → inserted/derived parts and external references. Each reference records the target file id and **the version it was checked in against**.
- **FR-PDM-021** (P4, M) **Contains** and **Where used** views for a file, for the latest version or a chosen version, as an expandable tree with quantities.
- **FR-PDM-022** (P4, M) When opening a version of an assembly, the user chooses how components resolve: **as checked in** (the exact versions referenced, "as built"), **latest**, or **latest released revision**.
- **FR-PDM-023** (P4, M) **Rename** and **move** inside the vault update every referencing file (new versions are checked in for them, with an automatic comment); files referenced by released revisions keep their old references in those versions.
- **FR-PDM-024** (P4, M) **Copy tree**: copy an assembly or drawing with chosen referenced files to a new folder, with renaming rules (prefix, suffix, find/replace, new part numbers from the numbering scheme) and references redirected to the copies; the copies start as new files at version 1.
- **FR-PDM-025** (P4, M) **Delete** moves files to the vault recycle bin (restorable); a file that is referenced by any version of another file cannot be deleted, and the dialog lists the users of it.
- **FR-PDM-026** (P4, M) Outside a vault, **Pack** (FR-IO-012) still works; a pack made from a vault records the vault versions it was made from.

#### 12.5.4 Revisions and lifecycle

- **FR-PDM-030** (P4, M) **Revision scheme** per vault: letters A, B, … Z, AA (skipping I, O, Q, S, X, Z by option, as ASME Y14.35 recommends), numbers 01, 02 …, or a custom pattern; optional pre-release revisions (`-`, `0.1`, `0.2` or `X1`, `X2`) before the first release; RU option: ESKD change numbers (Изм. 1, 2 …) and production letters (О, О1, А, Б) (D-11).
- **FR-PDM-031** (P4, M) **Default workflow** shipped with every vault:

```
 ┌──────────────────┐ Submit  ┌───────────┐ Approve  ┌──────────┐
 │ Work in progress ├────────▶│ In review ├─────────▶│ Released │
 └──────────────────┘◀────────┴───────────┘ Reject   └────┬─────┘
          ▲                                   Change      │
          │        ┌────────────────┐ ◀───────────────────┘
          └────────┤ Change pending │                 Obsolete ──▶ ┌──────────┐
          (next    └────────────────┘                              │ Obsolete │
          revision)                                                └──────────┘
```

- **FR-PDM-032** (P4, M) Rules of the default workflow: only *Work in progress* and *Change pending* files can be checked out; **Approve** assigns the next revision label to the latest version and makes it read-only; **Change** on a released file moves it to *Change pending* (the released revision stays available and is what "latest released" resolves to); **Obsolete** marks a file not for new use (warning when inserted into an assembly).
- **FR-PDM-033** (P4, M) A transition can require: a comment, filled data card fields (e.g. part number, material, description), referenced files to be in a given state (an assembly cannot be released while a component is in work, option), the drawing to be up to date with its model (FR-DRW-016), and a role (Designer, Checker, Approver).
- **FR-PDM-034** (P4, M) Releasing writes the revision, state, approver name and date into the document properties, so title blocks (FR-DRW-003), revision tables (FR-DRW-024) and BOMs show them; STEP export writes the revision as the product definition formation id.
- **FR-PDM-035** (P5, S) **Workflow editor**: states (name, colour, read-only flag), transitions (name, from, to, conditions, roles, actions), revision increment on a transition, multiple workflows chosen by folder or file kind; saved in the vault, exportable as JSON.
- **FR-PDM-036** (P5, S) **Transition actions**: on release, generate and store PDF of drawings and STEP of parts/assemblies beside the revision (named by a pattern, e.g. `BR-001_revB.pdf`), set a watermark "Not released" on PDFs of unreleased versions, run the integrity check.
- **FR-PDM-037** (P4, M) Users and roles: in a personal vault, the single local user has every role. In a shared vault (FR-PDM-070) user names and roles come from the vault's user list; the app asks who is working at first use per browser. This is **identification, not security**: anyone with write access to the folder can change files; the UI says so in the vault settings.

#### 12.5.5 Data cards, numbering and search

- **FR-PDM-040** (P4, M) **Data card** per file kind: fields (text, number, date, list, checkbox, user), mapped to document custom properties both ways, with required flags and default values; shown in the right panel for the selected vault file and editable when checked out.
- **FR-PDM-041** (P4, M) **Numbering schemes**: patterns such as `MC-{YYYY}-{0000}` or `{PROJECT}-{0000}`, issued once per new file or on demand, never reused (counter kept in the vault).
- **FR-PDM-042** (P4, M) **Search**: by name, any data card field, state, revision, checked-out user, date range, file kind, and "contains material = Aluminium 6061"; saved searches; results open, check out or show where-used.
- **FR-PDM-043** (P4, S) Full-text search in notes and drawing text.

#### 12.5.6 Compare, BOMs and change orders

- **FR-PDM-050** (P4, M) **Compare two versions** of a part or assembly: data card differences; feature tree differences (added, removed, changed parameters with old → new values); geometry difference in the view (added volume in one colour, removed in another, via kernel booleans); volume and mass change.
- **FR-PDM-051** (P5, M) **Compare two versions of a drawing**: overlay of the two PDFs/views with differences highlighted.
- **FR-PDM-052** (P4, M) **BOM per version/revision**: the BOM of an assembly as checked in (exact component versions) or as of a revision; **BOM compare** between two revisions (added, removed, quantity changed, revision changed); CSV export.
- **FR-PDM-053** (P5, S) **Change requests and change orders (ECR/ECO)**: a change request (title, reason, affected files, attachments, requester) is reviewed; an approved request becomes a change order whose affected files move to *Change pending*; closing the order releases them together with new revisions and links the order number into their revision tables.
- **FR-PDM-054** (P5, S) **Release package**: the set of files released together (one transition on a selection, or an ECO) is recorded as a baseline, and can be exported as a ZIP with PDFs and STEP files for a supplier.

#### 12.5.7 Audit, notifications and sharing

- **FR-PDM-060** (P2, M) **Audit trail**: every vault action (add, check-out, check-in, undo check-out, transition, rename, move, delete, restore, destroy, purge, settings change) is appended to `.mcadvault/log/` with user, time, file, version and details; viewable and filterable per file or vault; exportable as CSV.
- **FR-PDM-061** (P5, S) **Notifications**: in a shared vault, the app shows a list of events since the user's last visit (files checked in, released, assigned for review); a transition can address a user or role.
- **FR-PDM-070** (P5, S) **Shared vault** on a folder several people can reach (network drive, or a synced folder such as Nextcloud, Dropbox, OneDrive, Google Drive): check-out writes a lock record; check-in refuses when the file's latest version moved on since the local copy was taken, offering to save the work as a new file or to discard; stale locks (older than a set time, or by a user who confirms) can be broken by an admin with a log entry.
- **FR-PDM-071** (P5, S) Because synced folders deliver changes with delay, every vault write is append-only (new object files, new log files, new per-file records with a sequence number) so concurrent writers never overwrite each other's data; the index is recomputed from these records; conflicting lock records are resolved by the earliest timestamp and reported to both users.
- **FR-PDM-072** (P7, C) **Git backend**: a vault folder may also be a git repository; check-in can create a commit (JSON documents diff well, FR-IO-004). Pushing is done by the user's own git tools.
- **FR-PDM-073** (P7, C) **Server vault** with authenticated users, permissions per folder and state, replication and web access: separate FRS and an explicit decision on C-1.

#### 12.5.8 PDM user interface

- **FR-PDM-080** (P2, M) Vault commands appear in a **Vault** tab of the command bar (Check out, Check in, Undo check-out, Get latest, History, Change state ▾, Where used, Contains, Copy tree, Search) and in context menus of files, document tabs and assembly components.
- **FR-PDM-081** (P2, M) The title bar and document tab show `name · Rev B · Released · v12` (state colour from the workflow); a modified file that is not checked out cannot be saved over the vault copy (Save as only).
- **FR-PDM-082** (P2, M) Check-in and transition dialogs list the files involved with their state, version and warnings (e.g. "Bracket.mcaddrw is out of date with its model") before anything is written.
- **FR-PDM-083** (P2, M) All PDM strings are translated (EN/RU); state names and revision labels are stored as defined in the vault and shown as typed (user data, not translated).

---

## 13. Functional requirements: user interface

The modelling UI combines SolidWorks' interaction model with MöbiusCAD's existing interface (section 1.3). Each requirement below names the habit it keeps ("SW habit") and where it lives in MöbiusCAD.

### 13.1 Layout

```
┌───────────────────────────────────────────────────────────────────────────────────┐
│ Header (existing): logo · File ▾ · document tabs · Undo Redo · EN/RU · theme · ?  │
├───────────────────────────────────────────────────────────────────────────────────┤
│ Command bar: [Features] [Sketch] [Evaluate] [Assembly] [Drawing] [View]  ← tabs   │
│  big icon + label buttons for the active tab; context tabs appear when needed     │
├──────────────┬──────────────────────────────────────────────────┬─────────────────┤
│ Left panel   │  Heads-up view bar (top centre, floating)        │ Right panel     │
│ tabs:        │                                                  │ (existing pages │
│  Tree        │                                                  │  Properties,    │
│  Feature     │              graphics area                       │  Section, Mass, │
│  Parameters  │                                       ┌───────┐  │  Explode,       │
│  Display     │                                       │ ✓  ✕  │  │  Export,        │
│              │  sketch status / DOF                  └───────┘  │  Measure)       │
│              │                               NavCube (existing) │                 │
├──────────────┴──────────────────────────────────────────────────┴─────────────────┤
│ Status bar: hints for the active command · rebuild state · kernel state · units   │
└───────────────────────────────────────────────────────────────────────────────────┘
```

- **FR-UI-001** (P0, M) The modelling layout reuses the existing header, panels, right-panel pages, NavCube, status bar, toasts and dialogs from `ui.ts`. Viewer-only users see no change until they create or edit a model.
- **FR-UI-002** (P1, M) **Left panel** (SW habit: FeatureManager on the left) with tabs: **Tree** (feature or assembly tree), **Feature** (the feature panel while a command runs), **Parameters** (P2), **Vault** (P2, FR-PDM-002), **Display** (P4 display states). Collapsible with Ctrl+[ like today; width resizable and remembered.
- **FR-UI-003** (P1, M) While a feature or sketch command runs, the left panel switches to the **Feature** tab (SW habit: PropertyManager replaces the tree) and a **mini tree** (fly-out, semi-transparent) is shown at the top left of the graphics area so planes and features can still be picked from the tree.
- **FR-UI-004** (P1, M) The **right panel** keeps MöbiusCAD's pages (properties, section, explode, mass, export, measurement list); its Properties page shows the selected entity's data (face type, area, radius, owning feature).
- **FR-UI-005** (P1, M) Breakpoints from the UI standards: ≥1366 px full layout on one command row; 1280–1365 labels fold to icons (existing `fitToolbar` logic); 768–1279 left and right panels are overlays; <768 view-only (FR-UI-090).

### 13.2 Command bar

- **FR-UI-010** (P1, M) A tabbed command bar below the header (SW habit: CommandManager) with tabs **Features**, **Sketch**, **Evaluate** (measure, mass properties, section, interference P4, analyses), **View** (display modes, projection, standard views, hide/show), and in later phases **Vault** (P2, FR-PDM-080), **Assembly** (P4), **Drawing** tabs in drawing documents (P5), **Sheet metal** (P6).
- **FR-UI-011** (P1, M) Buttons show icon + label (labels fold to icons with tooltips under 1366 px), grouped by function with separators; split buttons hold variants (Rectangle ▾ corner/centre/3-point).
- **FR-UI-012** (P1, M) Disabled commands explain why in the tooltip ("Select a closed sketch or a plane first").
- **FR-UI-013** (P1, M) Context tabs: entering a sketch selects the Sketch tab; finishing returns to Features.
- **FR-UI-014** (P1, S) Command search (Ctrl+K, MöbiusCAD's own): type a command name in EN or RU and run it.
- **FR-UI-015** (P1, M) Icons are MöbiusCAD's own SVG icon set in the existing style (stroke icons, currentColor, both themes), never copied bitmaps.

### 13.3 Graphics area interaction

- **FR-UI-020** (P0, M) Mouse: existing orbit (left drag in view mode), pan, zoom to cursor; in modelling the SolidWorks mapping is available as a preference and default for new users of modelling: **middle drag rotates, Ctrl+middle pans, wheel zooms to cursor, Shift+middle zooms, Alt+middle rolls**, left button selects and drags handles. Preference "Mouse: MöbiusCAD (left-drag orbit) / Middle-drag orbit (as in most mechanical CAD)" in Display ▾; the UI does not name other products.
- **FR-UI-021** (P1, M) **Confirmation corner** (SW habit): ✓ and ✕ buttons in the top-right of the graphics area while a command or sketch is active, mirroring the panel's OK/Cancel; in a sketch it shows "exit sketch" and "discard".
- **FR-UI-022** (P1, M) **Heads-up view bar** (SW habit), floating top centre: zoom to fit, zoom to area, previous view, section view toggle, view orientation ▾ (standard views + normal to), display style ▾, hide/show items ▾ (planes, axes, origins, sketches, sketch relations, dimensions), appearance, perspective toggle. It reuses existing view commands; in the viewer-only mode the same functions stay in the header as today.
- **FR-UI-023** (P1, M) **Shortcut bar** (SW habit: S key): pressing S shows a small floating toolbar at the cursor with the commands relevant to the current mode (sketch: line, rectangle, circle, arc, trim, dimension, relation; part: sketch, extrude, revolve, fillet, chamfer, hole, plane; assembly: insert, mate, move). Customisable in Preferences (P2).
- **FR-UI-024** (P2, S) **Mouse gestures** (SW habit): right-drag in a direction runs one of 4 or 8 commands per mode, with a radial guide; configurable; off for users who choose the MöbiusCAD mouse mapping.
- **FR-UI-025** (P1, M) **Context menu** (right-click) on geometry: a row of icon actions for the selection (Sketch, Extrude, Fillet, Hide, Measure, Select other, Zoom to selection, Normal to) plus a text menu (feature actions from FR-HIS-004, Properties).
- **FR-UI-026** (P1, M) **Context toolbar** on selection (SW habit): a small icon bar near the cursor after selecting a face/edge, fading with distance; shows Edit sketch, Edit feature, Sketch on face, Normal to, Hide, Appearance.
- **FR-UI-027** (P1, M) **Drag handles** (SW habit: Instant3D) on the selected feature's faces: arrows for extrude depth, rings for revolve angle, radius handles for fillets; dragging shows a ruler with snap ticks and the live value; snapping to vertices and faces uses the Snapper.
- **FR-UI-028** (P1, M) **Dimension editing on the model**: double-click a feature to show its dimensions; double-click a dimension to open the value box with a rebuild button and spin control; Enter rebuilds.
- **FR-UI-029** (P1, M) Hover highlight (preselection) in a theme colour; selection in another; colours meet 3:1 contrast against the model and background in both themes.
- **FR-UI-030** (P1, M) **Normal to** (Ctrl+8, and N when no sketch tool is active) on a face or plane; pressing it twice flips to the other side.
- **FR-UI-031** (P1, M) Standard views on keys **Ctrl+1 Front, Ctrl+2 Back, Ctrl+3 Left, Ctrl+4 Right, Ctrl+5 Top, Ctrl+6 Bottom, Ctrl+7 Isometric**, Spacebar opens a view-orientation picker (SW habits); the existing digits 1–5 for display modes and the NavCube stay.
- **FR-UI-032** (P1, M) Selection highlight lists entity type and owning feature in the status bar ("Face of Extrude2, plane, 1 240 mm²").

### 13.4 Feature panel

- **FR-UI-040** (P1, M) Layout top to bottom: title with icon; OK ✓, Cancel ✕, Preview 👁 (toggle), Help ?; a short message box (yellow hint / red error); then group boxes ("Direction 1", "Direction 2", "Thin feature", "Selected contours", "Feature scope") that collapse; optional groups have a checkbox in their header (SW habit).
- **FR-UI-041** (P1, M) Selection boxes are focused in turn (the active one has a coloured border); picking in the view fills the focused box; Tab/Shift+Tab moves between inputs; boxes show the count and list of picked items.
- **FR-UI-042** (P1, M) Inputs with units show the document unit; spin buttons step by a preference step (1 mm, 1°); mouse wheel over a spin input changes the value only when focused.
- **FR-UI-043** (P1, M) The panel remembers the last used options per feature type (end condition, merge, tangent propagation).
- **FR-UI-044** (P1, M) Keyboard: Enter = OK, Esc = Cancel, Ctrl+Enter = OK and repeat the command (P2), all inputs reachable by keyboard with visible focus rings; screen readers announce group names, labels and errors (aria-describedby).
- **FR-UI-045** (P1, M) Errors and warnings use the same wording as the tree's What's wrong list, translated.

### 13.5 Sketch UI

- **FR-UI-050** (P1, M) Sketch status in the status bar and a badge in the graphics area: "Under defined (3 DOF) / Fully defined / Over defined"; colours per FR-SLV-002 with a legend in Help.
- **FR-UI-051** (P1, M) Cursor feedback: the tool icon next to the cursor, inference glyphs (coincident, horizontal, tangent ...), the live length/angle/radius beside the cursor, dotted inference lines.
- **FR-UI-052** (P1, M) Typing a number while drawing an entity opens the value box for its next size (length, then angle), so lines can be drawn fully by keyboard.
- **FR-UI-053** (P1, M) Dimension value boxes appear at the dimension (SW habit: Modify box) with ✓, ✕, rebuild and spin; Esc keeps the previous value.
- **FR-UI-054** (P1, M) Sketch keyboard: L line, R rectangle, C circle, A arc (tangent arc while drawing), P point, G polygon, T trim, E extend, F sketch fillet, O offset, W slot, D dimension, K add relation, Q construction toggle (letters as built in 1.85.0, plus K), Esc ends the current tool then exits selection, Ctrl+Enter exits the sketch; letters are rebindable (P2) and do not collide with viewer letters while the sketch is active (viewer measure letters move under the Evaluate tab in modelling).
- **FR-UI-055** (P1, S) Grid and inference toggles in the heads-up bar while sketching.

### 13.6 Tree UI

- **FR-UI-060** (P1, M) Tree rows: expand arrow, icon, name, state badge; keyboard navigation (arrows, Home/End, F2 rename, Del, Enter edit); drag to reorder (P2) with insertion line and refusal tooltip; rollback bar as a thick draggable line.
- **FR-UI-061** (P1, M) Hovering a tree row highlights the feature in the view; hovering geometry highlights its tree row.
- **FR-UI-062** (P1, M) Errors bubble up: a parent folder/feature shows the worst child state.
- **FR-UI-063** (P1, S) Tree display options: show feature names / descriptions, flat vs nested sketches, dynamic reference visualisation (arrows to parents on hover, P2).

### 13.7 Assembly and drawing UI (P4/P5)

- **FR-UI-070** (P4, M) Mate panel: two selection boxes (Entities to mate), quick-mate toolbar at the cursor after the second pick, mate type groups (Standard / Advanced / Mechanical), alignment buttons, value input with flip, list of mates added in this session; the panel stays open for the next mate until ✕ (SW habit).
- **FR-UI-071** (P4, M) Component context bar: Open part, Edit in place, Hide, Isolate, Change transparency, Fix/Float, Replace, Mates of this component.
- **FR-UI-072** (P5, M) Drawing UI: sheet tabs at the bottom, view palette (drag a model's standard views onto the sheet), annotation tab with dimension/annotation tools, property panel per view/annotation, snapping to view geometry and inference lines between views.

### 13.8 Preferences

- **FR-UI-080** (P1, M) Preferences dialog (existing modal) gains a **Modelling** page: mouse mapping, default units/template, sketch colours legend, automatic relations on/off, auto rotate to sketch plane on/off, spin step sizes, preview quality, rebuild verification on/off, autosave interval.
- **FR-UI-081** (P2, S) Keyboard shortcut editor with conflict detection; import/export as JSON; a "Classic CAD" preset (the habits marked "SW habit" in this section) and the default MöbiusCAD preset.

### 13.9 Small screens and touch

- **FR-UI-090** (P1, M) Phones: modelling documents open in view mode (measure, section, tree browsing, parameters read-only) with a note that editing needs a larger screen.
- **FR-UI-091** (P2, S) Tablets: edit parameters and dimensions, suppress features, change configuration, export; touch gestures: one-finger orbit, two-finger pan/zoom, long-press = context menu.
- **FR-UI-092** (P5, C) Tablet sketching with pen (pen = draw, finger = navigate).

### 13.10 Feedback, help and onboarding

- **FR-HLP-001** (P1, M) The Help dialog (F1) gets Modelling, Sketcher, Features, Assemblies (P4) and Drawings (P5) sections in EN and RU, plus a shortcuts table.
- **FR-HLP-002** (P1, M) First-use tips (`hints.ts`) for: first sketch, first dimension, fully defined sketch, first feature edit, rollback bar, S-key shortcut bar; each shown once.
- **FR-HLP-003** (P1, S) A **Tutorial** document "Bracket in 10 steps" opened from the empty state, with a step list in the right panel that checks progress (sketch exists, extrude exists, ...).
- **FR-HLP-004** (P1, M) Long operations (>300 ms) show a busy state on the button or a progress line; >2 s show a cancel button; toasts follow the existing timings (4 s, errors sticky).
- **FR-HLP-005** (P1, M) Empty states: an empty part shows "Start a sketch on a plane" with buttons for the three planes; an empty assembly "Insert a component".

### 13.11 Measurement and evaluation integration

- **FR-MEA-001** (P1, M) All existing measure tools (smart measure, distances, radius, angle, pitch, coordinates, bounding box) work on modelled parts and assemblies under the Evaluate tab and with the existing shortcuts when no sketch is active.
- **FR-MEA-002** (P1, S) A measured value can be dragged or copied into a numeric input of a feature or dimension box.
- **FR-MEA-003** (P1, M) Measurements on a model reference persistent names, so they survive rebuilds and update their values; a measurement whose entity disappeared is flagged.
- **FR-MEA-004** (P1, M) The section tool (up to 3 planes, caps, hatching, drag arrows) works during feature editing and in the sketcher (section at sketch plane).
- **FR-MEA-005** (P5, S) Analyses: draft analysis (colour by draft angle against a pull direction), zebra stripes, curvature map, thickness analysis (ray-based), undercut detection.

### 13.12 Internationalisation

- **FR-I18N-001** (P0, M) Every new UI string is an English key with a Russian translation in `i18n.ru.ts`; the smoke test's "no English left in the Russian UI" check covers the modelling UI.
- **FR-I18N-002** (P1, M) Stored names (feature types, default names like `Extrude1`, standard plane names, error codes) are language-neutral in the file and translated when shown, so files open identically in both languages.
- **FR-I18N-003** (P1, M) Number input accepts both `.` and `,` as decimal separator in RU; display follows the language (`12,5 мм` in RU) while exports (STEP, DXF, CSV) stay in English/C locale.
- **FR-I18N-004** (P5, M) Drawing standards are independent of UI language (an RU user can make an ISO drawing in English text and vice versa); title block field labels follow the sheet format's language.

### 13.13 Everyday interaction parity (audit 2026-11-08)

An audit of SolidWorks' basic, everyday behaviours against this FRS and MöbiusCAD 1.85.0 (Appendix F) found habits that were missing here or described too loosely to build or test. The requirements below close those gaps; each has an acceptance test in section 16.2 (AT-UX-*). Sketch inference and snapping to model geometry (FR-SK-042, FR-SK-052) and middle-drag rotation in sketch mode (FR-UI-020) are being reworked in 1.89.0 and are not repeated here.

**Mouse and view**

- **FR-UI-100** (P1, M) **Rotation centre** (SW habit): a middle click without a drag on a vertex, edge or face sets the pivot for the following rotations: a vertex rotates about that point, an edge about the edge's line, a face about the picked point. A small marker shows the pivot; a middle click on empty space returns to rotating about the view centre. In the MöbiusCAD left-drag mapping the same pick is made with Alt+left click.
- **FR-UI-101** (P1, M) Mouse details: double middle click = zoom to fit; Shift+middle drag zooms (up = in); Ctrl+middle drag pans; wheel zooms about the cursor. Preferences: reverse wheel direction, zoom to cursor on/off, rotation speed. The same mapping works in the sketcher, the assembly and drawings (drawings: pan and zoom only).
- **FR-UI-102** (P1, M) Keyboard view navigation when focus is in the graphics area (or on the page with nothing focused): arrows rotate the view 15° (preference) about the screen axes, Shift+arrows 90°, Alt+←/→ roll 15°, Ctrl+arrows pan 10 % of the view; **Z** zooms out and **Shift+Z** zooms in by 20 % about the view centre. When the tree has focus the arrows keep moving in the tree and the rollback bar (FR-UI-060).
- **FR-UI-103** (P1, M) **Zoom to selection** (heads-up bar, context menu) frames the selected entities; **Zoom to area** draws a box and frames it; **Previous view** (heads-up bar, Alt+Z; Ctrl+Shift+Z stays redo) steps back through at least the last 10 camera positions of the document. Camera moves from these commands, standard views and Normal to are animated in at most 300 ms, and instant when `prefers-reduced-motion` is set.
- **FR-UI-104** (P1, M) **Orientation picker** (Space, completes FR-UI-031): a floating panel at the cursor with the seven standard views, Normal to, named views and a small selector cube whose faces, edges and corners can be clicked; Space again, Esc or a pick closes it. **Named views** (P2, S): "Save view" stores the current camera under a name in the document (view data, not on the undo stack, FR-UND-004).

**Selection**

- **FR-SEL-007** (P1, M) A left click without a drag on empty space clears the selection; Ctrl+click toggles an entity; Shift+click adds. With a command running, empty-space clicks do not clear its selection boxes (only Clear selections or Del does).
- **FR-SEL-008** (P1, M) Box selection (FR-SEL-002) works in parts and assemblies, not only in sketches: left to right takes entities fully inside, right to left those crossed; the selection filter (FR-SEL-003) applies; Ctrl adds the boxed entities. The box starts from a left drag on empty space; a left drag on geometry keeps orbiting in the MöbiusCAD mapping. P2 (S): lasso selection.
- **FR-SEL-009** (P1, S) **Selection breadcrumbs**: after a pick, a small bar at the top left of the graphics area shows the chain from the entity up (face → feature → sketch → body → part, and component → sub-assembly in assemblies); hovering a crumb highlights it, clicking selects it, right-click opens its menu. **Shift+D** moves the breadcrumbs and the confirmation corner (FR-UI-021) to the cursor (D stays the distance tool, Appendix A).
- **FR-SEL-010** (P2, S) **Magnifying glass** (G): a round inset at the cursor shows the area magnified (wheel changes the factor) and picks made inside it select at that zoom; Esc or G closes it.
- **FR-SEL-011** (P1, M) **Colour-coded selection boxes**: each selection box of a feature panel has its own colour (from tokens, 3:1 against model and background) and its picks are drawn in that colour in the view with a small callout naming the box ("Edges", "From", "Mate 1"), so the user sees which pick went where.
- **FR-SEL-012** (P1, M) Selection rules around commands: valid pre-selected entities fill the first matching box when a command starts (FR-SEL-006); after OK or Cancel the model selection is empty; the hover cursor shows a glyph for the entity type under it (face, edge, vertex, plane, sketch entity) as well as the highlight.

**Visibility**

- **FR-UI-105** (P3, M) **Hide/show under the cursor** in multibody parts and assemblies: **Tab** hides the body or component under the cursor; **Shift+Tab** shows a hidden one under the cursor; holding **Ctrl+Shift+Tab** draws all hidden bodies/components see-through so one can be clicked to show it. The keys act only while the pointer is over the graphics area and no input has focus (focus moves with Tab elsewhere); the 3D sketch keeps Tab for its plane (FR-SK-080). Hide/show this way is undoable (FR-UND-004).

**Feature panel and commands**

- **FR-UI-106** (P1, M) **Keep visible pushpin** in the panel header: when pinned, OK applies the feature and opens the same command again with the same options and empty selection boxes (same as Ctrl+Enter, FR-UI-044, which this brings forward from P2 to P1).
- **FR-UI-107** (P1, M) **Right-click while a command runs**: the context menu starts with OK, Cancel, Clear selections (of the focused box) and, over a picked item, Remove from selection; command-specific helpers follow (for fillet and chamfer: the edge helpers of 1.36.0). A right-drag still pans; the menu opens only on a release without movement.
- **FR-UI-108** (P1, M) **Undo inside a command**: Ctrl+Z / Ctrl+Y while a panel is open undo and redo the panel's own changes (a pick, a value, an option) without leaving it; the document stack is not touched until OK.
- **FR-UI-109** (P1, M) **Selection box flow** (completes FR-UI-041): when a panel opens, the first empty required box is focused; when a box has all it needs (e.g. one face for "From"), focus moves to the next required box by itself; a box keeps focus while it takes many items (edges for a fillet).
- **FR-UI-110** (P1, M) **Value callouts** (SW habit) for every feature's main values (depth, angle, radius, distance, count, thickness), attached to the model next to the drag handle: clicking one opens its value box, changes go both ways with the panel, and the flip arrow in the view reverses the direction like the panel button.
- **FR-UI-111** (P1, M) **Repeat last command**: Enter with no command running and focus in the graphics area repeats the last feature command (pre-selection rules apply); the status bar shows "Enter: repeat Fillet". In a sketch, Enter with the select tool active repeats the last sketch tool and **Ctrl+Enter** or the confirmation corner exits the sketch (FR-SK-003). (1.85.0 exits the sketch on a plain Enter; this changes it.)
- **FR-UI-112** (P1, M) Tooltips on every command button show the label, the shortcut key and a one-line description; a disabled button says why (FR-UI-012).
- **FR-UI-113** (P2, C) Right-click on empty graphics area lists the last 5 commands ("Recent commands") above the usual items.

**Dimensions on the model and in sketches**

- **FR-UI-114** (P1, M) **Modify box** (completes FR-UI-053 and FR-UI-028): the box shows the dimension's name as its title (editable, FR-SK-065), the value with units, ✓, ✕, **Rebuild** (applies and keeps the box open), **Reverse direction** for linear dimensions, an increment field with spin buttons, and the mouse wheel over the box steps the value by the increment (Shift ×10, Alt ×0.1) with a live rebuild/solve; typing `=` starts an expression with variable and dimension name completion (FR-PAR-002). Enter = ✓, Esc = ✕ keeping the old value.
- **FR-UI-115** (P1, M) **Feature dimensions on the model** (completes FR-HIS-010): a single click on a feature in the tree, or on one of its faces with Instant3D on, shows its driving dimensions (its sketch's and the feature's own) on the model in blue; a double click on a shown dimension opens the Modify box; a change rebuilds as one undo step. Double-clicking a feature row shows its dimensions (SW habit) and Edit feature stays in the context bar, the menu and Enter on the row. (1.85.0 opens Edit feature on a double click and shows no feature dimensions on the model.)
- **FR-SK-067** (P1, M) **Instant 2D**: in a sketch, a selected driving dimension shows a round handle at its moving end; dragging it changes the value with a ruler and snap ticks, as model handles do (FR-UI-027), and is one undo step.
- **FR-SK-068** (P1, M) Dimension placement feedback: while placing, the preview follows the cursor and shows the type it will be (horizontal, vertical, aligned, the angle quadrant, radius/diameter); a right-click locks the current orientation so the text can be moved freely; Esc cancels placement only. Clicking a placed dimension's arrow dots flips its arrows inside/outside.

**Sketch interaction**

- **FR-SK-043** (P1, M) **Drag to merge**: dragging an end point onto another point, the origin or a curve adds the coincident relation (or merges the points, FR-SK-051) with the coincident glyph shown while hovering the target; holding Ctrl while releasing suppresses it (FR-SK-052).
- **FR-SK-044** (P1, M) **Copy by drag**: Ctrl+drag of selected sketch entities copies them (relations between the copies kept, relations to the rest dropped);
- **FR-SK-045** (P1, M) **Sketch context menu** (right-click without movement): End chain (while drawing), Select chain, Construction on/off, the relations valid for the selection (FR-SK-054), Fully define…, Delete, Zoom to selection, Exit sketch, Discard. A right-click with the line tool ends the chain like a double click.
- **FR-SK-046** (P1, S) **Quick snaps**: a menu (heads-up bar while sketching and the sketch context menu) picks one snap type for the next point only (end point, midpoint, centre, quadrant, intersection, tangent, perpendicular, parallel, nearest, horizontal/vertical); Preferences turn each inference type on or off permanently.
- **FR-SK-047** (P1, M) The status bar shows the cursor position in sketch coordinates (x, y in document units) while sketching, next to the sketch status (FR-UI-050).

**Tree and history**

- **FR-HIS-012** (P1, M) Rollback commands in the tree menu (completes FR-HIS-004): Roll back to here, Roll to previous, Roll to end; a document saved rolled back reopens rolled back with a notice "The part is rolled back: N features are not shown" and a Roll to end button.
- **FR-HIS-013** (P1, S) Tree housekeeping: **Shift+C** collapses all rows; hovering a sketch, plane, axis or body row shows an eye button to hide/show it; a hidden item's icon is outlined.
- **FR-HIS-014** (P2, S) **Copy and paste features**: Ctrl+C on a sketch or a feature in the tree and Ctrl+V with a face or plane selected makes a copy placed on it; references that cannot follow are listed for repair (FR-TN-004). Ctrl+drag of a tree row onto a face does the same.

**Undo and status**

- **FR-UND-005** (P1, M) The Undo and Redo buttons have a ▾ list of the last 20 steps by name ("Extrude1 depth 20 → 25", FR-UND-001); picking a step undoes or redoes back to it. The button tooltips name the step they will undo. (1.85.0 shows a generic "Undo (Ctrl+Z)".)
- **FR-UI-116** (P1, M) **Units in the status bar**: clicking the unit label opens the unit systems (mm-g-s, cm-g-s, m-kg-s, in-lb-s, custom…) and decimals; choosing one changes the document's display units as an undoable document change; values are stored in mm and radians as before.

**Menus and toolbars (review 2026-11-08, Andrey: "reorganize all menus/buttons")**

- **FR-UI-117** (P1, M) **One command bar for everything** (completes FR-UI-010..013): every 3D document has one tabbed command bar, a full-width row under the header; no tool gets its own row of buttons. The tabs follow what is open: a model file shows **Evaluate**; a part shows **Features**, **Sketch**, **Surfaces**, **Weldments**, **Evaluate** (and **Sheet Metal** once it lands); an assembly shows **Assembly** and **Evaluate**. The bar remembers the last tab per document type. Features groups related commands behind split buttons (Sweep ▾ Loft, Cut-Sweep ▾ Cut-Loft, Pattern ▾, Plane ▾ Axis/Point/Coordinate system, Curves ▾ Helix/3D sketch/XYZ/Composite/Projected/Split line, Bodies ▾, Direct editing ▾); Surfaces and Weldments list their commands as buttons. Entering a sketch selects Sketch; leaving it selects Features.
- **FR-UI-118** (P1, M) **Header = document and application**: the header holds the menu, Open, New ▾, the document name, the view controls (display mode, projection, standard views, Display ▾), language, theme, help and the panel toggles. Measuring tools live in the Evaluate tab; the right panel's pages (Properties, Section, Explode, Mass, Export) are tabs at the top of the right panel; Filter, Undo ▾, Redo, Save ▾ and STEP sit at the right end of the tab row, like SolidWorks' menu bar. Every keyboard shortcut works whichever tab is shown.
- **FR-UI-119** (P1, M) **Rule for new modules**: a new module (sheet metal, motion, drawings, PCB) adds a tab or a group in an existing tab, never a floating bar of its own, and its buttons use the shared `mc-b` icon + label style with its own SVG icons (FR-UI-015). A tab whose buttons do not fit folds labels into icons with tooltips before it scrolls.
- **FR-UI-120** (P1, M) **Document tabs** (completes FR-DOC-003): open parts, assemblies and drawings show as tabs along the bottom of the window above the status bar, each with its type icon, name, modified dot and ✕; a click switches to it, keeping its own undo, selection and camera; Ctrl+Tab cycles; closing a modified document asks to save. Opening a part from an assembly opens a new tab instead of replacing the assembly.

---

## 14. Non-functional requirements

### 14.1 Performance

Reference machine: 4-core laptop CPU (2020 or newer), 8 GB RAM, integrated GPU, Chrome stable.

| ID | Requirement | Target | Phase |
| --- | --- | --- | --- |
| NFR-PERF-001 | Viewer start and STEP open times are not worse than 1.17.0 | ≤ +5 % on the smoke-test fixtures | P0 |
| NFR-PERF-002 | Entering modelling mode the first time (code + kernel ready) | ≤ 3 s on a warm cache, ≤ 10 s cold on 50 Mbit/s | P0 |
| NFR-PERF-010 | Sketch solve after a change, 200 entities / 300 constraints | ≤ 8 ms median, ≤ 30 ms p95 | P1 |
| NFR-PERF-011 | Sketch drag frame rate, 200 entities | ≥ 30 fps | P1 |
| NFR-PERF-020 | Extrude/revolve preview update on a 50-feature part | ≤ 200 ms (simple), ≤ 1 s (with booleans on complex bodies) | P1 |
| NFR-PERF-021 | Fillet preview, 20 edges on a 50-feature part | ≤ 1.5 s | P1 |
| NFR-PERF-022 | Full rebuild of a 100-feature typical machined part | ≤ 5 s | P2 |
| NFR-PERF-023 | Edit of the last feature in a 100-feature part | ≤ 1 s (shape cache) | P1 |
| NFR-PERF-024 | Open of a saved 100-feature `.mcadprt` with valid caches | ≤ 2 s to first display, editable ≤ 5 s | P1 |
| NFR-PERF-030 | Assembly of 200 components (50 distinct parts) opens | ≤ 10 s, 30 fps orbit | P4 |
| NFR-PERF-031 | Mate solve after a change, 200 mates | ≤ 100 ms | P4 |
| NFR-PERF-040 | Drawing view update (HLR exact), part of 2 000 faces | ≤ 5 s per view, fast preview ≤ 1 s | P5 |
| NFR-PERF-060 | Check-in of an assembly with 50 changed files (100 MB) | ≤ 10 s on a local SSD folder | P4 |
| NFR-PERF-061 | Vault search over 10 000 files and 50 000 versions | ≤ 1 s | P4 |
| NFR-PERF-062 | Where-used of a part in a 10 000-file vault | ≤ 1 s | P4 |
| NFR-PERF-050 | Kernel worker heap for a 100-feature part | ≤ 1.5 GB, worker recycle per FR-ARC-011 | P1 |
| NFR-PERF-051 | Main thread memory (JS heap) for a 100-feature part | ≤ 500 MB | P1 |

### 14.2 Reliability and data safety

- **NFR-REL-001** (P0, M) No user data loss on tab close, crash or kernel failure beyond the last 2 s of edits (autosave journal, FR-STO-003).
- **NFR-REL-002** (P0, M) A document that fails to rebuild still opens and stays editable (features error, data intact).
- **NFR-REL-003** (P0, M) Saving is atomic: a failed write never leaves a truncated file (write to a temp handle / OPFS then swap where possible; for downloads the previous file is untouched).
- **NFR-REL-005** (P2, M) Vault writes are append-only and crash-safe: an interrupted check-in leaves the previous version intact and is either completed or rolled back at the next vault open; no vault operation ever deletes the only copy of a version except an explicit, confirmed, logged destroy/purge.
- **NFR-REL-004** (P1, M) Kernel exceptions (`Standard_Failure`, `StdFail_NotDone`) are caught per feature and converted to feature errors; no uncaught exception stops the rebuild loop.

### 14.3 Accuracy

- **NFR-ACC-001** (P1, M) Modelling tolerance 1e-7 mm (OCCT `Precision::Confusion`); geometry comparisons in naming use scale-relative tolerances.
- **NFR-ACC-002** (P1, M) Rebuilding the same document twice, or on another supported browser, gives volumes equal to 1e-9 relative and the same face/edge counts.
- **NFR-ACC-003** (P1, M) Mass properties from the kernel (`BRepGProp`) are reported exact to 1e-6 relative for analytic solids (checked against closed-form values in tests).
- **NFR-ACC-004** (P1, M) Displayed values round per document decimals; stored values are full double precision.

### 14.4 Usability and accessibility

- **NFR-USE-001** (P1, M) WCAG 2.1 AA for all panels and dialogs: 0 axe-core violations in light and dark (existing smoke-test gate); 4.5:1 text contrast, 3:1 for UI glyphs and sketch status colours against the background.
- **NFR-USE-002** (P1, M) Every command reachable by keyboard; focus order logical; visible focus rings.
- **NFR-USE-003** (P1, S) A SolidWorks user can make the AT-P1 bracket without reading Help in ≤ 10 minutes (hallway test with 3 users before P1 release).
- **NFR-USE-004** (P1, M) Every error message says what failed and what to do next, in EN and RU.

### 14.5 Compatibility

- **NFR-CMP-001** (P0, M) Chrome, Edge, Firefox (current and previous), Safari 17+; differences only in storage (FSA availability).
- **NFR-CMP-002** (P1, M) Files saved in one browser open identically in the others.
- **NFR-CMP-003** (P1, M) STEP output passes import in FreeCAD and in at least one commercial CAD available to the team (manual check per release that changes the writer).

### 14.6 Security and privacy

- **NFR-SEC-001** (P0, M) No network requests with model data; the only network use is loading the app and WASM from the same origin (C-1). Checked by the smoke test (request log after a modelling session).
- **NFR-SEC-002** (P0, M) Opening a MöbiusCAD file executes no code from it: expressions are parsed by the app's own expression parser (no `eval`/`Function`), ZIP entries are size-limited (zip-bomb guard: total ≤ 2 GB, ratio ≤ 200:1) and paths sanitised.
- **NFR-SEC-003** (P6, M) A scripting console (if built) runs scripts in a worker with only the documented API, and only scripts the user typed or opened explicitly.

### 14.7 Maintainability and quality

- **NFR-MNT-001** (P0, M) TypeScript strict, `npm run typecheck` clean; no new runtime dependencies without a licence check and a credits entry (`credits-plugin.mjs`, `THIRD-PARTY-LICENSES.txt`).
- **NFR-MNT-002** (P0, M) Reuse existing modules (section 3) instead of parallel implementations; viewer and modeller share Viewer, Snapper, measure, Section, exporters.
- **NFR-QA-001** (P0, M) A unit test runner (`node --test` or Vitest) for the expression parser, document model, migrations, solver adapter and naming; run in CI beside the smoke test.
- **NFR-QA-002** (P1, M) Every feature type and every measurement/geometry change adds checks to `tests/smoke.mjs` (CLAUDE.md rule) using scripted documents built through the command API (`window.__sv` debug handle).
- **NFR-QA-003** (P1, M) A golden-model suite: documents in `tests/fixtures/model/` rebuilt in CI, comparing volume, area, face count and bounding box with stored expectations.

### 14.8 Licensing

- **NFR-LIC-001** (P0, M) OCCT, opencascade.js, occt-import-js stay LGPL-2.1, shipped unmodified as separate WASM files the user can replace; the About tab lists them.
- **NFR-LIC-002** (P0, M) The solver library's licence is verified (D-2) before it is bundled; if it is not compatible with an MIT static web app shipped as a separate replaceable WASM, the own TypeScript solver is used.
- **NFR-LIC-003** (P2, M) Standard data (thread, hole, fastener tables) are taken from public standards' numeric values, entered by the project, not copied from vendor libraries.

---

## 15. Data model

### 15.1 Principles

- Plain JSON, ids are short random strings (`f_7Kq2`), unique within the document, never reused.
- Numbers in internal units (mm, rad). Each numeric parameter is `{ "v": 20, "expr": "D1*2" }` where `expr` is optional and `v` is the last evaluated value (lets files open even if expressions fail).
- References to topology are persistent references (FR-TN-001).
- Derived data (meshes, shape caches) never appears in `document.json`.

### 15.2 Part document (schema sketch)

```jsonc
{
  "schema": 1,
  "kind": "part",
  "id": "d_a91F",
  "units": { "length": "mm", "angle": "deg", "decimals": 2 },
  "props": { "title": "Bracket", "partNumber": "BR-001", "revision": "A", "custom": { "Supplier": "ACME" } },
  "material": { "name": "Aluminium 6061", "density": 2.7 },
  "params": [ { "id": "p_1", "name": "wall", "expr": "4mm", "v": 4 } ],
  "configs": [ { "id": "c_def", "name": "Default", "overrides": {} } ],
  "activeConfig": "c_def",
  "features": [
    { "id": "f_org", "type": "origin" },
    { "id": "f_xy", "type": "plane.std", "std": "XY" },
    { "id": "s_1", "type": "sketch", "name": "Sketch1",
      "plane": { "ref": { "feature": "f_xy", "role": "plane" } },
      "entities": [
        { "id": "e1", "t": "line", "p": ["pt1", "pt2"] },
        { "id": "pt1", "t": "point", "xy": [0, 0] },
        { "id": "pt2", "t": "point", "xy": [100, 0] },
        { "id": "e5", "t": "circle", "c": "pt9", "r": { "v": 5 } }
      ],
      "relations": [ { "id": "r1", "t": "horizontal", "e": ["e1"] }, { "id": "r2", "t": "coincident", "e": ["pt1", "origin"] } ],
      "dims": [ { "id": "d1", "name": "D1", "t": "distance", "e": ["pt1", "pt2"], "val": { "v": 100 }, "driving": true, "pos": [50, -12] } ]
    },
    { "id": "f_ex1", "type": "extrude", "name": "Extrude1", "op": "boss",
      "profile": { "sketch": "s_1", "regions": "all" },
      "dir1": { "end": "blind", "depth": { "v": 20 }, "flip": false },
      "dir2": null, "draft": null, "thin": null, "merge": true },
    { "id": "f_fil1", "type": "fillet", "name": "Fillet1",
      "radius": { "v": 5 }, "tangentProp": true,
      "edges": [
        { "feature": "f_ex1", "role": "lateralEdge", "src": ["e1", "e2"], "sig": { "type": "line", "mid": [0, 0, 10], "dir": [0, 0, 1], "len": 20 } }
      ] }
  ],
  "rollback": null,
  "suppressed": [],
  "appearance": { "f_ex1": { "color": [0.6, 0.65, 0.7] } }
}
```

### 15.3 Assembly document (schema sketch)

```jsonc
{
  "schema": 1, "kind": "assembly", "id": "d_k2P0",
  "components": [
    { "id": "c_1", "name": "Base<1>", "doc": { "path": "Base.mcadprt", "id": "d_a91F", "hash": "sha256:…" }, "config": "Default",
      "fixed": true, "xf": [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1] },
    { "id": "c_2", "name": "Pin<1>", "doc": { "embedded": "embedded/d_p1n.mcadprt" }, "fixed": false, "xf": [/* column-major */] }
  ],
  "mates": [
    { "id": "m_1", "t": "concentric", "a": { "comp": "c_1", "ref": { "feature": "f_hole1", "role": "wall", "index": 0 } },
      "b": { "comp": "c_2", "ref": { "feature": "f_ex1", "role": "lateral", "src": ["e_circ"] } }, "align": "aligned" },
    { "id": "m_2", "t": "distance", "a": {/*…*/}, "b": {/*…*/}, "val": { "v": 2 }, "flip": false }
  ],
  "patterns": [], "explodes": [ { "id": "x_1", "name": "Exploded1", "steps": [] } ],
  "displayStates": []
}
```

Transforms are column-major 4×4 in mm (same convention as three.js and the verified SolidWorks import, but in mm instead of metres).

### 15.4 Drawing document (schema sketch)

```jsonc
{
  "schema": 1, "kind": "drawing", "standard": "ISO", "projection": "first",
  "model": { "path": "Bracket.mcadprt", "id": "d_a91F" },
  "sheets": [ { "id": "sh1", "name": "Sheet1", "size": "A3", "orient": "landscape", "scale": [1, 2], "format": "iso7200-a3",
    "views": [ { "id": "v1", "t": "model", "orient": "front", "pos": [120, 150], "style": "hlr-hidden-dashed", "scale": null },
               { "id": "v2", "t": "projected", "parent": "v1", "dir": "right", "pos": [260, 150] },
               { "id": "v3", "t": "section", "parent": "v1", "line": [[0, -30], [0, 30]], "label": "A" } ],
    "annotations": [ { "id": "a1", "t": "dim", "kind": "linear", "refs": [/* persistent refs + view id */], "pos": [140, 90], "tol": null } ] } ]
}
```

### 15.5 Vault records (schema sketch)

```jsonc
// .mcadvault/vault.json
{ "schema": 1, "name": "Workshop", "revisionScheme": { "kind": "letters", "skip": ["I","O","Q","S","X","Z"], "pre": "numbers" },
  "numbering": [ { "id": "n1", "pattern": "MC-{YYYY}-{0000}", "next": 17 } ],
  "workflows": [ { "id": "wf_default", "states": ["wip", "review", "released", "change", "obsolete"], "transitions": [ /* … */ ] } ],
  "users": [ { "name": "Andrey", "roles": ["designer", "checker", "approver", "admin"] } ] }

// .mcadvault/files/<fileId>.json  (one record per event, append-only: <fileId>/<seq>.json)
{ "fileId": "v_8Hf2", "path": "parts/Bracket.mcadprt", "kind": "part",
  "versions": [
    { "n": 11, "object": "sha256:…", "user": "Andrey", "at": "2026-11-06T21:30:00Z", "comment": "Hole Ø10 → Ø20",
      "refs": [ { "fileId": "v_P1n0", "version": 4 } ], "props": { "partNumber": "MC-2026-0007", "material": "Aluminium 6061" } },
    { "n": 12, "object": "sha256:…", "user": "Andrey", "at": "2026-11-07T09:02:00Z", "comment": "Fillets R5", "refs": [], "props": {} }
  ],
  "state": "released", "revisions": [ { "label": "A", "version": 9, "at": "…", "by": "Andrey" }, { "label": "B", "version": 12, "at": "…", "by": "Andrey" } ],
  "lock": null }
```

### 15.6 Migration

- **FR-IO-030** (P0, M) `migrations/<n>.ts` transforms schema *n* to *n+1*; unit tests open stored fixtures of every schema version.

---

## 16. Verification and acceptance

### 16.1 Test levels

| Level | Tool | What |
| --- | --- | --- |
| Unit | node test runner (NFR-QA-001) | expression parser, units, document model and commands, undo, migrations, solver adapter, region detection, naming resolution on synthetic histories |
| Kernel | headless Chromium page running the worker | each feature evaluator on reference inputs, error codes |
| Smoke / E2E | `tests/smoke.mjs` on the packaged build | scripted modelling sessions, UI checks, axe-core, layout, RU translation, network check |
| Golden models | `tests/fixtures/model/*.mcadprt|asm|drw` | rebuild results vs expectations |
| Manual | per release | STEP round trip in FreeCAD, hallway usability test (P1), drawing print check (P5) |

### 16.2 Phase acceptance tests

**P0 Foundations**

- **AT-P0-1** Create a Part, add a standard plane offset, undo, redo, save as `.mcadprt`, reload the page, reopen from Recent: identical document (deep-equal JSON).
- **AT-P0-2** Kill the kernel worker during a rebuild (debug command): the app recovers, rebuilds, shows a notice, no data lost.
- **AT-P0-3** Opening a viewer STEP fixture is not slower than 1.17.0 (NFR-PERF-001) and no modelling code is loaded (network log).
- **AT-P0-4** Spike report in `docs/` lists available OCCT classes and the solver decision with benchmark numbers.

**P1 MVP: the bracket**

All values exact to 1e-6 relative unless stated.

- **AT-P1-1** Sketch on XY: centre rectangle 100 × 60 at the origin, fully defined with two dimensions; status shows "Fully defined".
- **AT-P1-2** Extrude blind 20 mm → volume 120 000 mm³, 6 faces.
- **AT-P1-3** Sketch on the top face: circle Ø10 at the centre (its centre dimensioned to two edges); Cut through all → volume 120 000 − 500π = 118 429.204 mm³.
- **AT-P1-4** Fillet R5 on the 4 vertical edges → volume **118 000.000 mm³** (each fillet removes (25 − 6.25π)·20 mm³; the sum with the hole is exactly 2 000 mm³).
- **AT-P1-5** Edit the rectangle length 100 → 120: fillets stay on the 4 vertical edges (topological naming) → volume 142 000.000 mm³.
- **AT-P1-6** Edit the hole Ø10 → Ø20 → volume 144 000 − 2 000π − 429.204 = 137 287.611 mm³; the fillet feature has no warnings.
- **AT-P1-7** Chamfer 1 × 45° on the Ø20 hole's top edge → removes 2π·(10 + 1/3)·0.5 = 32.463 mm³, volume 137 255.148 mm³. Suppress the hole: the chamfer shows "parent suppressed", the part shows 144 000 − 429.204 = 143 570.796 mm³, no crash. Unsuppress: back to 137 255.148 mm³. Drag the rollback bar above the fillet and back: same values.
- **AT-P1-8** Revolve: a 10 × 20 rectangle at radius 30–40 on XZ revolved 360° about Z → volume π(40² − 30²)·20 = 43 982.297 mm³; export STEP, reopen in MöbiusCAD (viewer) → same volume and 4 faces.
- Plus: all new UI passes axe-core in both themes, the RU UI has no English, Help sections exist.

**P2**

- **AT-P2-1** ISO M6 tapped hole, depth 12, through a 20 mm plate: tap drill Ø5.0, cosmetic thread M6×1 stored; hole callout text produced.
- **AT-P2-2** Circular pattern of the hole, 6 instances on PCD 75: 6 holes, volume matches.
- **AT-P2-3** Global variable `wall = 4` drives a shell; changing it to 3 rebuilds and the volume follows the closed form.
- **AT-P2-4** Two configurations (long/short) with different dimension values and a suppressed feature; switching changes volume as expected; both saved.
- **AT-P2-5** DXF import of a gasket outline into a sketch → closed region → extrude; area equals the DXF polygon area.
- **AT-P2-6** Reordering a fillet above a cut it does not depend on works; reordering a feature above its parent is refused with the reason.

**P3**

- **AT-P3-1** Sweep a Ø2 circle along a helix (pitch 5, 10 turns, Ø20): spring volume within 1e-4 of π·1²·L (L = helix length).
- **AT-P3-2** Loft between a 40×40 square and a Ø30 circle 50 mm apart: valid solid, volume within 1e-6 of kernel `BRepGProp` (sanity), no self-intersection (BRepCheck OK).
- **AT-P3-3** Split a body by a plane into two, combine them back: volume preserved.
- **AT-P3-4** Imported STEP with a known gap: Check and heal reports it and closes it.

**P4**

- **AT-P4-1** Assembly: base plate fixed, a pin inserted, concentric + coincident mates → pin DOF = 1 (rotation), shown as under-defined.
- **AT-P4-2** Change the plate hole position in the part: the assembly updates and the pin follows.
- **AT-P4-3** Conflicting distance mate is refused and highlighted; nothing moves.
- **AT-P4-4** Interference detection finds a deliberate 1 mm overlap with the right volume.
- **AT-P4-5** BOM shows quantities across a sub-assembly and a circular component pattern; CSV export.
- **AT-P4-6** STEP export of the assembly reopens in the viewer with the same tree, names and placements.

**P5**

- **AT-P5-1** A3 drawing of the bracket: front/top/right/iso views, first angle; overall dimensions 120/60/20 imported as model items.
- **AT-P5-2** Section A–A through the hole: hatched area equals the cut area computed by `SectionProfile`.
- **AT-P5-3** Changing the part updates the drawing after Update; dimensions re-attach.
- **AT-P5-4** PDF export at A3 is vector, 1:1 when printed; DXF opens in a DXF viewer with correct scale.
- **AT-P5-5** Hinge mate allows rotation only, with a 0–90° limit.
- **AT-P5-6** Fastener library: insert an M6×20 ISO 4762 screw into a hole with automatic mates.

**UI/UX parity (section 13.13; P1 polish unless the requirement says otherwise)**

Each test is scripted in the smoke test where it can be (synthetic pointer and key events, camera and DOM checks).

- **AT-UX-1** (FR-UI-100) Middle click on a vertex of the bracket, then middle-drag: the vertex stays at the same screen position (±2 px) while the model turns; middle click on empty space, drag: the model turns about the view centre again.
- **AT-UX-2** (FR-UI-101, FR-UI-102) Double middle click frames the model (same camera as F within 1 %); → rotates the camera 15° about the screen's vertical axis, Shift+→ 90°; Z then Shift+Z returns to the starting distance within 1 %; with the tree focused, ↓ moves the tree selection and the camera does not move.
- **AT-UX-3** (FR-UI-103) Ctrl+1, Ctrl+5, Ctrl+7, then Previous view three times returns to the camera before Ctrl+1; Zoom to selection on one hole face frames it so its bounding box fills 60–90 % of the shorter view side; with reduced motion emulated, a standard view applies in one frame.
- **AT-UX-4** (FR-UI-104) Space opens the orientation picker at the cursor; clicking its Top face gives the same camera as Ctrl+5; Esc closes it without moving the camera.
- **AT-UX-5** (FR-SEL-007, FR-SEL-008) In a part, a right-to-left box over the bracket's corner selects the crossed faces and edges allowed by the filter; a click on empty space clears them; with Fillet open, an empty-space click keeps the Edges box filled.
- **AT-UX-6** (FR-SEL-011, FR-UI-109) Open Extrude with "Up to surface": the profile box is focused first, after picking the sketch the target box is focused by itself; the target face is drawn in the target box's colour and its callout reads the box name.
- **AT-UX-7** (FR-UI-106, FR-UI-108) Fillet with the pushpin on: pick 2 edges, Ctrl+Z → 1 edge, OK → the fillet exists and the Fillet panel is open again with the same radius and an empty Edges box; the document's undo list has one Fillet step.
- **AT-UX-8** (FR-UI-107) Right-click without movement during Chamfer shows OK, Cancel, Clear selections first; Clear selections empties the focused box; a right-drag pans and opens no menu.
- **AT-UX-9** (FR-UI-111) After a Fillet is made, Enter with nothing focused opens Fillet again; in a sketch, after drawing a circle and pressing Esc, Enter starts the circle tool and Ctrl+Enter exits the sketch.
- **AT-UX-10** (FR-UI-114, FR-UI-115) Click Extrude1 in the tree: its depth dimension shows on the model; double-click it, wheel up twice with increment 5 → value +10 and the volume updates before Enter; Esc restores the old value and volume; Enter instead makes one undo step.
- **AT-UX-11** (FR-SK-067, FR-SK-068) In a sketch, drag the handle of a 40 mm length dimension by +10 mm on screen scale: the value becomes 50 (snap ticks) and one Ctrl+Z restores 40; while placing a dimension between two points, right-click locks it horizontal and moving the cursor up keeps it horizontal.
- **AT-UX-12** (FR-SK-043, FR-SK-044, FR-SK-045) Drag a free line end onto another line's end: a coincident relation is added and DOF drops by 2; Ctrl+drag a selected circle: a second circle with the same radius exists, not related to the first; right-click while drawing a line chain ends the chain and keeps the line tool.
- **AT-UX-13** (FR-UND-005) After three edits the Undo ▾ list shows them by name, newest first; picking the third undoes all three; the Undo tooltip names the step it will undo.
- **AT-UX-14** (FR-HIS-012) Save a part rolled back above its last two features, reopen it: it opens rolled back with the notice; Roll to end in the notice shows all features.
- **AT-UX-15** (FR-UI-105, P3) In a two-body part, Tab over body 2 hides it; Shift+Tab over the same spot shows it; both steps are undoable.
- **AT-UX-16** (FR-UI-116, FR-SK-047) Choose in-lb-s in the status bar: a 25.4 mm dimension shows 1.000 in, the file still stores 25.4; Ctrl+Z returns to mm. While sketching, the status bar shows the cursor x, y in the document unit.
- **AT-UX-17** (FR-UI-117, FR-UI-118) Open a STEP file: the command bar shows only Evaluate with the 12 measuring tools on one row at 1366 px; the header has no measuring tools. New part: the tabs are Features, Sketch, Surfaces, Weldments and Evaluate; Sketch on Top selects the Sketch tab and Exit sketch returns to Features; R (radius) still starts the radius tool while Features is shown. New assembly: the part's tabs and quick buttons are gone; Assembly and Evaluate remain.
- **AT-UX-18** (FR-UI-120) Open a part, then an assembly, then a drawing: three tabs at the bottom; clicking the part's tab shows the part with its undo history and camera as left; closing the modified assembly asks to save.

**PDM**

- **AT-PDM-1** (P2) Create a vault in a folder, add the bracket, check out, change the hole, check in with a comment: version 2 exists, version 1 opens read-only with the old volume, the audit log has both entries.
- **AT-PDM-2** (P2) Kill the tab in the middle of a check-in (debug hook): reopening the vault shows version 1 intact and the check-in either completed or rolled back; the integrity check reports no errors.
- **AT-PDM-3** (P4) Release the bracket (revision A), change it (Change pending), check in twice, release again: revision B points to the latest version; "latest released" in an assembly resolves to B; the title block shows Rev B.
- **AT-PDM-4** (P4) Rename the pin part inside the vault: the assembly and drawing that use it get new versions with updated references and still open without missing files.
- **AT-PDM-5** (P4) Where-used of the pin lists the assembly and its drawing; deleting the pin is refused with that list.
- **AT-PDM-6** (P4) Compare bracket versions 1 and 2: the tree diff shows `Hole Ø10 → Ø20`, the geometry diff shows removed volume 2 000π − 500π = 4 712.389 mm³; BOM compare between assembly revisions A and B lists the changed component revision.
- **AT-PDM-7** (P5) ECO with two affected files: closing it releases both with new revisions and the ECO number appears in their revision tables.
- **AT-PDM-8** (P5) Two browser profiles on one shared folder: user 1 checks out the bracket; user 2 sees the lock and cannot check out; user 1 checks in; user 2 gets latest and sees the new version.

### 16.3 Solver acceptance set (P0 spike and P1)

1. Fully defined rectangle (4 lines, 2 dims, H/V, coincident at origin): DOF 0.
2. Slot with tangent arcs and equal radii: DOF reported correctly while adding each constraint.
3. Over-defined triangle (three lengths + one angle): conflict reported, sets offered.
4. 200-entity gear-like profile (circular pattern of arcs): solve time per NFR-PERF-010.
5. Dragging a point of an under-defined four-bar linkage: smooth motion, no flips.
6. Large change (dimension ×10): continuation keeps topology (no arc flips).
7. Redundant but consistent constraints (parallel + two perpendiculars): accepted as redundant.

---

## 17. Risks

| ID | Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- | --- |
| R-1 | Topological naming breaks fillets/holes after edits (the classic hard problem; FreeCAD needed years) | High | High | History-based naming from OCCT Generated/Modified + sketch ids + geometric signatures (FR-TN); AT-P1-5/6 as gates; missing references repairable; keep scope of references narrow in P1 |
| R-2 | WASM memory growth and crashes in long sessions | High | High | Explicit `delete()`, heap monitoring, background worker recycle and rebuild (FR-ARC-011), shape caches saved |
| R-3 | opencascade.js build lacks needed classes or is too old/buggy (beta build) | Medium | High | P0 spike; custom opencascade.js build with only needed modules (smaller too); fallback to occt 7.8 build via emsdk |
| R-4 | Sketch solver quality (flips, slow convergence, wrong DOF) | Medium | High | Proven PlaneGCS where licence allows, continuation steps, test set 16.3 |
| R-5 | Kernel operations slow in WASM (booleans/fillets 3–5× slower than native) | Medium | Medium | Shape cache per feature, preview at coarse tolerance, cancel/restart, client-side instant extrude preview |
| R-6 | Scope creep towards full SolidWorks parity | High | Medium | Phases with exit criteria; P5+ features are S/C; this FRS is the scope reference |
| R-7 | Storage limits/quota in browsers, Safari OPFS eviction | Medium | Medium | Save to real files encouraged, quota warnings, recovery journal small, export reminders |
| R-8 | Licence conflict of the solver (PlaneGCS port listed under MulanPSL-2.0 on npm, FreeCAD solver is LGPL) | Medium | Medium | D-2 licence review before bundling; own solver fallback |
| R-9 | UI complexity hurts the simple viewer users | Medium | Medium | Lazy-loaded modelling mode; viewer layout unchanged until a model is created; smoke test on viewer layout |
| R-10 | Accessibility regressions in complex panels | Medium | Low | axe-core gates in light/dark for every new panel; keyboard tests |
| R-11 | Drawing HLR quality/speed for complex parts | Medium | Medium | PolyAlgo preview, exact HLR in background, per-view caching |
| R-13 | Shared vault on a synced folder corrupts data or loses locks (sync delay, conflict copies) | Medium | High | Append-only records, content-addressed objects, sequence numbers, conflict detection on check-in (FR-PDM-071), integrity check, clear documentation of supported folders |
| R-14 | Users mistake vault roles for security | Medium | Medium | Settings and Help state that a folder vault identifies users but does not protect files (FR-PDM-037); real permissions only with a server vault (P7) |
| R-12 | Trademark/look-alike concerns from adopting SolidWorks habits | Low | Medium | Own icons, names, artwork, help text; only generic interaction patterns adopted (section 1.3) |

---

## 18. Open decisions

| ID | Decision | Options | Recommendation |
| --- | --- | --- | --- |
| D-1 | Product scope name: keep "MöbiusCAD" for viewer + modeller in one app | one app with modes / separate app | One app with modes (shared code and URL) |
| D-2 | Sketch solver | PlaneGCS WASM (`@salusoft89/planegcs`, licence to verify) / own TypeScript solver | Spike both in P0; prefer PlaneGCS if the licence allows a separate replaceable WASM, else own |
| D-3 | Topological naming strategy depth | history + signatures (proposed) / full OCAF TNaming | History + signatures in P1, revisit OCAF in P3 if failures |
| D-4 | Default mouse mapping in modelling | keep MöbiusCAD left-drag orbit / SolidWorks middle-drag | Ask on first modelling start, remember the choice |
| D-5 | Native extensions | **Decided 2026-11-06:** separate `.mcadprt`, `.mcadasm`, `.mcaddrw`, same ZIP+JSON container | Kind visible in folders, Open/Insert dialogs filter by kind, own icon per kind |
| D-6 | Standard plane names | XY/XZ/YZ / Top/Front/Right / both | Show "Front (XZ)" style with both |
| D-7 | Phase order after P2 | assemblies before advanced parts / as listed | As listed (P3 parts, P4 assemblies), revisit after P2 user feedback |
| D-8 | Drawing standard default | ISO first angle / by language (RU → ESKD/GOST) | ISO for both, GOST format offered |
| D-9 | Unit test runner | `node --test` / Vitest | `node --test` (no new dependency) |
| D-10 | Team PDM backend | shared synced folder (P5) / git repository / own server (P7) | Shared folder first (no server, fits C-1); server only if teams need permissions |
| D-11 | Default revision scheme | letters A, B, C (ASME/ISO practice) / numbers 01, 02 / ESKD change numbers and letters for RU | Letters with skips; ESKD scheme offered as a vault template |
| D-12 | Version storage | full copy per version, content-addressed (proposed) / deltas | Full copies (simple, robust; files are compressed ZIPs) with purge |

---

## 19. Appendices

### Appendix A. Keyboard shortcuts (modelling defaults)

| Key | Action | Note |
| --- | --- | --- |
| S | Shortcut bar at the cursor | SW habit |
| Ctrl+Z / Ctrl+Y | Undo / redo | |
| Ctrl+B / Ctrl+Q | Rebuild / force rebuild all | SW habit |
| Ctrl+S / Ctrl+Shift+S | Save / Save as | |
| Ctrl+N / Ctrl+O | New / Open | |
| Ctrl+1 … Ctrl+7 | Front, Back, Left, Right, Top, Bottom, Isometric | SW habit |
| Ctrl+8 | Normal to selection | SW habit |
| Space | View orientation picker | SW habit |
| F | Zoom to fit | existing |
| Shift+arrows / arrows | Rotate view 90° / by 15° (FR-UI-102) | SW habit |
| Alt+←/→, Ctrl+arrows | Roll 15°, pan | SW habit |
| Z / Shift+Z | Zoom out / in | SW habit |
| Alt+Z | Previous view (Ctrl+Shift+Z stays redo) | MöbiusCAD |
| Middle click, double middle click | Rotation centre, zoom to fit (FR-UI-100/101) | SW habit |
| Tab / Shift+Tab / Ctrl+Shift+Tab | Hide / show under the cursor, show hidden see-through (FR-UI-105) | SW habit |
| G | Magnifying glass (FR-SEL-010) | SW habit |
| Shift+D | Breadcrumbs and confirmation corner to the cursor (FR-SEL-009; D is the distance tool) | MöbiusCAD |
| Shift+C | Collapse the tree | SW habit |
| Ctrl+C / Ctrl+V | Copy / paste a feature or sketch (FR-HIS-014) | SW habit |
| Enter / Esc | OK / Cancel command, end chain; Enter with no command repeats the last one (FR-UI-111) | SW habit |
| Ctrl+Enter | Exit sketch | |
| L, R, C, A, P, G, T, E, F, O, W, D, K, Q | Line, rectangle, circle, arc, point, polygon, trim, extend, fillet, offset, slot, dimension, relation, construction (in a sketch) | |
| E | Extrude (part, no sketch active) | MöbiusCAD |
| Alt+click | Select other | |
| F2 | Rename in tree | |
| F5 | Selection filter | SW habit |
| Ctrl+K | Command search | MöbiusCAD |
| F1, ? | Help | existing |
| Viewer letters (D, M, R, C, L, A, N, B, I, H, U) | Measure and visibility tools | existing; active when no sketch tool is |

### Appendix B. Sketch relation matrix

| Selection | Offered relations |
| --- | --- |
| one line | horizontal, vertical, fixed |
| two lines | parallel, perpendicular, collinear, equal, (P2) symmetric with a third centreline |
| line + arc/circle | tangent |
| two arcs/circles | concentric, coradial, equal, tangent |
| point + line | coincident, midpoint |
| point + arc/circle | coincident, concentric (centre point) |
| two points | coincident, horizontal, vertical, merge, (P2) along X/Y |
| point + model edge (other plane) | (P2) pierce |
| any + projected model entity | on edge |

### Appendix C. Error codes (excerpt)

| Code | EN message | Typical cause |
| --- | --- | --- |
| E-SK-OPEN | The sketch has open contours; this feature needs closed regions. | Gap between line ends |
| E-SK-SELFX | The sketch profile crosses itself. | Overlapping lines |
| E-SLV-CONFLICT | This dimension conflicts with existing relations. | Over-defined |
| E-FT-ZERO | The feature produced no change in the body. | Cut outside the part |
| E-FT-DISJOINT | The boss is not connected to the body. | Gap between profile and part (P3: allowed as a new body) |
| E-FT-FILLET | The fillet radius is too large for edge {edge}. | Radius > adjacent face size |
| E-FT-SHELL | Shell failed: thickness {t} is too large for face {face}. | Thin walls |
| E-TN-LOST | Reference lost: {entity} of {feature}. | Topology changed |
| E-TN-AMBIG | Reference is ambiguous: {n} candidates. | Symmetric geometry |
| E-KRN-CRASH | The geometry kernel restarted; the model was rebuilt. | WASM trap / memory |
| E-IO-NEWER | This file was made by a newer MöbiusCAD (schema {n}). | Old app |
| E-MATE-OVER | This mate conflicts with existing mates. | Over-defined assembly |

All messages have Russian translations in `i18n.ru.ts`.

### Appendix D. OCCT mapping (reference for implementers)

| Function | OCCT classes |
| --- | --- |
| Faces from sketch regions | `BRepBuilderAPI_MakeEdge/Wire/Face`, `GC_MakeArcOfCircle`, `Geom_BSplineCurve`, `ShapeAnalysis_FreeBounds` |
| Extrude / revolve | `BRepPrimAPI_MakePrism`, `BRepPrimAPI_MakeRevol`, `BRepFeat_MakePrism`, `BRepFeat_MakeRevol` |
| Booleans | `BRepAlgoAPI_Fuse/Cut/Common/Section/Splitter`, `BOPAlgo_Builder` |
| Fillet / chamfer | `BRepFilletAPI_MakeFillet`, `BRepFilletAPI_MakeChamfer` |
| Shell / draft / offset | `BRepOffsetAPI_MakeThickSolid`, `BRepOffsetAPI_DraftAngle`, `BRepOffsetAPI_MakeOffsetShape` |
| Sweep / loft | `BRepOffsetAPI_MakePipeShell`, `BRepOffsetAPI_ThruSections` |
| Helix | `Geom2d_Line` on `Geom_CylindricalSurface` + `BRepBuilderAPI_MakeEdge`, or `HelixBRep` if present |
| Patterns / transforms | `BRepBuilderAPI_Transform`, `gp_Trsf`, compound + fuse |
| Naming history | `BRepBuilderAPI_MakeShape::Generated/Modified/IsDeleted`, `BRepTools_History`, `TopExp::MapShapes` |
| Checks / healing | `BRepCheck_Analyzer`, `ShapeFix_Shape`, `ShapeUpgrade_UnifySameDomain` |
| Mass properties | `BRepGProp::VolumeProperties/SurfaceProperties`, `GProp_PrincipalProps` |
| Distance / interference | `BRepExtrema_DistShapeShape`, `BRepAlgoAPI_Common` |
| Tessellation | `BRepMesh_IncrementalMesh`, `BRep_Tool::Triangulation` |
| Drawings | `HLRBRep_Algo`, `HLRBRep_HLRToShape`, `HLRBRep_PolyAlgo` |
| STEP | `STEPCAFControl_Writer/Reader`, `XCAFDoc_ShapeTool/ColorTool` (as in `occ.ts`) |
| Defeaturing | `BRepAlgoAPI_Defeaturing` |

### Appendix E. Sources consulted for the SolidWorks reference

- SolidWorks Help, Types of Mates (standard, advanced, mechanical): <https://help.solidworks.com/2021/english/SolidWorks/sldworks/r_Types_of_Mates_SWassy.htm>
- GoEngineer, Introduction to SolidWorks Mates: <https://www.goengineer.com/blog/introduction-to-solidworks-mates>
- SolidWorks 2026 what's new summaries (Hawk Ridge Systems, Javelin, SolidProfessor): <https://hawkridgesys.com/whats-new-in-solidworks-2026>, <https://www.javelin-tech.com/3d/assembly-modeling-whats-new-in-solidworks-2026/>, <https://solidprofessor.com/?p=9936793>
- PlaneGCS for the web: <https://github.com/Salusoft89/planegcs>, <https://npmjs.com/package/@salusoft89/planegcs>
- Remaining SolidWorks functionality is from general product knowledge of SolidWorks 2020–2026 and should be checked against the official help where a detail matters.

### Appendix F. SolidWorks everyday UI/UX parity audit (2026-11-08, MöbiusCAD 1.85.0)

Each row is a basic SolidWorks habit, where this FRS covers it, and what 1.85.0 does (checked in `src/main.ts`, `src/model/controller.ts`, `src/sketch/editor.ts`, `src/viewer/Viewer.ts`). **New** = was missing from the FRS, added in 13.13. **Weaker** = in the FRS, implemented partly or differently. **Done** = matches. Items the modelling thread is reworking in 1.87.0 are marked so.

| Habit | FRS | 1.85.0 | Class |
| --- | --- | --- | --- |
| Middle-drag rotate, Ctrl+middle pan, Shift+middle zoom | FR-UI-020 | Left drag orbits, middle and right drag pan; no preference | Weaker (sketch mode fixed in 1.89.0) |
| Snapping to model geometry and automatic relations while sketching | FR-SK-042, FR-SK-052 | Sketch points, origin, curves, H/V only | Weaker (model vertices, midpoints and centres snap and stay attached in 1.89.0) |
| Middle click sets the rotation centre | FR-UI-100 | No | New |
| Double middle click fits; wheel direction preference | FR-UI-101 | No (F fits; zoom to cursor on) | New |
| Arrow keys rotate/pan/roll, Z / Shift+Z zoom | FR-UI-102 (was only in Appendix A) | No | New |
| Zoom to selection, zoom to area, previous view | FR-UI-103 (FR-UI-022 named them) | No (tree double-click fits a node in the viewer only) | New |
| Space orientation picker, named views | FR-UI-031, FR-UI-104 | Ctrl+1…8 work; Space does nothing | Weaker / New (named views) |
| Animated view changes | FR-UI-103 | Done (`animateTo`), no reduced-motion rule | New (detail) |
| Normal to, twice flips | FR-UI-030 | Done (N and Ctrl+8) | Done |
| Click empty space clears; Ctrl+click toggles | FR-SEL-002, FR-SEL-007 | Esc clears; sketch box select only | Weaker |
| Box selection in the part | FR-SEL-002, FR-SEL-008 | Sketch only | Weaker |
| Select other | FR-SEL-004 | Alt+click cycles faces behind | Done |
| Selection filter F5 | FR-SEL-003 | Done (faces, edges, vertices) | Done |
| Breadcrumbs, D to the cursor | FR-SEL-009 | No | New |
| Magnifying glass G | FR-SEL-010 | No | New |
| Colour-coded selection boxes | FR-SEL-011 | One pick colour | New |
| Tab / Shift+Tab hide and show under the cursor | FR-UI-105 | No (H hides the selection in the viewer) | New |
| Confirmation corner | FR-UI-021 | ✓/✕ in the view | Done |
| Shortcut bar on S | FR-UI-023 | Done (part and sketch) | Done |
| Context toolbar on selection | FR-UI-026 | Done | Done |
| Right-click menu on geometry | FR-UI-025 | Browser menu suppressed; only fillet/chamfer edge helpers | Weaker |
| Right-click during a command: OK / Cancel / Clear selections | FR-UI-107 | No | New |
| Mouse gestures | FR-UI-024 (P2, S) | No | Weaker (not started) |
| Heads-up view bar | FR-UI-022 | View buttons sit in the header | Weaker |
| Fly-out mini tree while a panel is open | FR-UI-003 | No | Weaker |
| Pushpin / OK and repeat | FR-UI-044, FR-UI-106 | No | New |
| Undo inside an open panel | FR-UI-108 | No | New |
| Selection box focus moves on by itself | FR-UI-109 | Partly per feature (`focus` fields) | New (rule) |
| Panel remembers last options | FR-UI-043 | No (hole favourites only) | Weaker |
| Value callouts on the model | FR-UI-110 | Fillet/chamfer callouts, extrude arrow | New (rule for all) |
| Enter repeats the last command | FR-UI-111 | Enter exits a sketch / OKs a panel only | New |
| Modify box with rebuild, spin, wheel | FR-UI-053, FR-UI-114 | 1.140.0: Modify box with name, ✓ ✕ ⟲, spin arrows, ↑/↓ and wheel (Shift ×10, Alt ×0.1), live solve in sketches; no editable title, increment field or reverse direction yet | Partly |
| Feature dimensions on the model, double-click to edit | FR-HIS-010, FR-UI-028, FR-UI-115 | 1.140.0: double-click a face shows its feature's sketch dimensions and extrude depth on the model; a click opens the Modify box, one undo step; not yet from a tree click, and no angles or other feature values | Partly |
| Instant2D dimension drag; placement lock on right-click | FR-SK-067, FR-SK-068 | No | New |
| Typing a number while drawing | FR-UI-052 | No | Weaker |
| Sketch keys (L R C A P T O D K Q) | FR-UI-054 | L R C A D T O Q, plus G polygon, F fillet, E extend, W slot; no K | Weaker (keys differ) |
| Drag an end point onto another to merge | FR-SK-043 | Drag moves; no relation added | New |
| Ctrl+drag copies sketch entities | FR-SK-044 | No | New |
| Sketch right-click menu (End chain, Select chain…) | FR-SK-045 | No | New |
| Quick snaps | FR-SK-046 | No | New |
| Cursor x, y in the status bar while sketching | FR-SK-047 | Status shows DOF and the tool hint | New |
| Hover a tree row highlights the feature; hover geometry highlights the row | FR-UI-061 | Selecting a row highlights its faces (FR-HIS-003); no hover link | Weaker |
| Rollback bar drag and arrows | FR-HIS-005 | Done | Done |
| Roll to previous / Roll to end; reopens rolled back | FR-HIS-012 | Bar works; menu items partly | New (detail) |
| Shift+C collapse, eye buttons in the tree | FR-HIS-013 | Folders collapse; sketch Show/Hide in the menu | New |
| Copy and paste features | FR-HIS-014 | No | New |
| Tree reorder by drag, Alt+↑/↓ | FR-HIS-006 | Done | Done |
| Rename F2, Del deletes | FR-UI-060 | Done | Done |
| Undo/redo with names and a ▾ list | FR-UND-001, FR-UND-005 | Generic "Undo (Ctrl+Z)" tooltip, no list | Weaker / New |
| Rebuild Ctrl+B, force Ctrl+Q | FR-HIS-020 | Done | Done |
| Command search Ctrl+K | FR-UI-014 (S) | Done (1.121.0) | Done |
| Units in the status bar | FR-UI-116 | No | New |
| Tooltips with the shortcut key | FR-UI-112 | Some buttons | New (rule) |

### Appendix G. Implementation status audit (2026-11-08, MöbiusCAD 1.87.0)

Every requirement of phases P1–P5 was compared with the code: the feature schema in `src/model/types.ts`, the kernel in `src/kernel/model.ts`, the controllers and the UI. The table lists the ones that are **not built** or only **partly built**. A requirement not listed is built, or is a P6/P7 item. The UI/UX items of section 13.13 are tracked in Appendix F and not repeated here. Requirements done since the audit are struck out in later versions of this table rather than removed, so the history stays readable.

**Documents, history, workspace (sections 7, 13)**

| ID | Requirement | 1.87.0 | Class |
| --- | --- | --- | --- |
| FR-DOC-003 | Several documents open at once in tabs | 1.129.0: document tabs; parked documents keep their undo history; one kernel is live (the shown document is rebuilt on activation); camera and selection are not kept yet | Partly |
| FR-HIS-022 | **What's wrong** list of all errors and warnings, each linking to its feature | Errors show as tree badges and tooltips and in the feature panel; there is no list | Partly |
| FR-UI-002 / FR-UI-003 | Left panel tabs, and a fly-out mini tree while a panel is open | The feature panel replaces the tree; no mini tree | Partly |
| FR-UI-014 | Command search (Ctrl+K) | Done in 1.121.0 | Done |
| FR-UI-022 | Heads-up view bar in the graphics area | The view buttons sit in the header; 1.87.0 adds the Space picker | Partly |
| FR-UI-024 | Mouse gestures (P2, S) | No | Not built |
| FR-UI-043 | Panels remember the last options per feature type | Only hole favourites | Not built |
| FR-UI-061 | Hovering a tree row highlights the feature, and the other way round | Selecting a row highlights its faces; no hover link | Partly |
| FR-UI-080 | Preferences dialog with a Modelling page | Settings live in the Display menu; no Modelling page | Not built |
| FR-UI-091 | Tablets: touch gestures for parameters and view (P2, S) | No touch gestures | Not built |
| FR-HLP-003 | Tutorial document "Bracket in 10 steps" (S) | No | Not built |
| FR-MEA-002 | Drag a measured value into a numeric input (S) | No | Not built |
| FR-CFG-003 | Configuration table as CSV (P5, C) | Done in 1.139.0 (Configurations panel: Export table / Import table…) | Done |

**Sketcher (section 8)**

| ID | Requirement | 1.87.0 | Class |
| --- | --- | --- | --- |
| FR-SK-006 | Section view at the sketch plane (S) | Done in 1.139.0 (sketch bar Section toggle) | Done |
| FR-SK-020 | Text: bundled fonts, height, emboss/engrave (S) | Built in 1.137.0 (sans/serif/mono, bold, italic, angle); along a curve in 1.142.0 | Done |
| FR-SK-042 / FR-SK-052 | Inference from model geometry; automatic relations while drawing | Being reworked in 1.87.0 by the modelling thread | Partly |
| FR-SK-073 | **Check sketch for feature** before starting it | Done in 1.121.0 (sketch panel Check) | Done |
| FR-UI-052 | Typing a number while drawing opens the size box | No | Not built |

**Part features (section 9)**

| ID | Requirement | 1.87.0 | Class |
| --- | --- | --- | --- |
| FR-FT-012 | Extrude end condition **Up to body** | The other P2 end conditions are built (`EndKind`); Up to body is missing | Partly |
| FR-FT-033 | Setback fillets (P3, S) | Yes | Built in 1.134.0: setback vertices with a distance each; fillets cut square to the edges, corner filled with a G1 patch |
| FR-FT-041 | Vertex chamfer (three distances) and offset-face chamfer | Two distances is built; vertex and offset-face are missing | Partly |
| FR-FT-050 | Hole types counterdrilled, clearance (close/normal/loose) and slot; end conditions up to face and up to next | Simple, counterbore, countersink, tapped and heat-set insert; blind or through all | Partly |
| FR-FT-060 | Shell with multi-thickness faces (P3) | One thickness | Partly |
| FR-FT-061 | Parting-line draft (P5) | Neutral-plane draft only | Partly |
| FR-FT-062 | Rib draft | Rib without draft | Partly |
| FR-FT-070 / FR-FT-071 / FR-FT-072 | Patterns and mirror of **faces and bodies** (P3) | Features only | Partly |
| FR-FT-073 | **Sketch-driven** pattern (P3) and table-driven pattern (P5) | No (sketch patterns exist inside the sketcher only) | Not built |
| FR-FT-074 | Geometry pattern option: copy the result, or re-evaluate per instance | Done in 1.141.0 (Geometry pattern box on feature patterns and mirror) | Done |
| FR-FT-080 | Sweep start/end tangency (P5) | Done: start tangency in 1.108.0, end tangency in 1.143.0 | Done |
| FR-FT-082 | Loft start/end constraints, connectors, guide curves | Built: ruled, close, centreline, start/end normal, guide curves (1.119.0) and connectors (1.131.0) | Built |
| FR-BODY-007 | Intersect (S) and Indent (P5) | No | Not built |
| FR-FT-102 | Feature recognition on imported bodies (P5, C) | No | Not built |
| FR-FT-131 | Check and heal as a feature with a before/after report (S) | Built in 1.126.0 (Check-Heal feature; Insert body also heals) | Built |

**Assemblies (section 10)**

| ID | Requirement | 1.87.0 | Class |
| --- | --- | --- | --- |
| FR-ASM-030 | In-context design: edit a part inside the assembly, references to other components | Edit in context (1.135.0): the assembly shown around the part, sketches on other components' flat faces, External References list with lock / lock all | Built (planes; converted edges not yet) |

**Planned, not started:** P6 sheet metal (FR-FT-120), weldments (FR-FT-121), motion (FR-FT-122) and the scripting console; P7 server vault and git backend (FR-PDM-072, FR-PDM-073).

**Specification changes made with this audit:** FR-UI-054 and Appendix A now list the sketch letters as built (P point, G polygon, E extend, F fillet, W slot), plus K for Add relation; FR-UI-030 names the N key; section 5 gets a status line.
