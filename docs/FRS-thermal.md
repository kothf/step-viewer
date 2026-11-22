# MöbiusCAD Thermal Analysis: Functional Requirements Specification

| | |
| --- | --- |
| Document | FRS-MCAD-THERM, Functional Requirements Specification for thermal analysis in MöbiusCAD |
| Version | 0.1 (draft) |
| Date | 2026-11-21 |
| Owner | Andrey Dumchin |
| Product baseline | MöbiusCAD 1.649.0 (parametric parts, assemblies, drawings, PCB view, structural analysis SA0–SA4 from 1.606.0 to 1.648.0) |
| Status | Draft. Open decisions are listed in section 14. Nothing here is built yet. |

---

## Contents

1. [Introduction](#1-introduction)
2. [Reference approach: meshless thermal analysis on CAD geometry](#2-reference-approach-meshless-thermal-analysis-on-cad-geometry)
3. [Baseline: what MöbiusCAD already has](#3-baseline-what-möbiuscad-already-has)
4. [Product overview and user journeys](#4-product-overview-and-user-journeys)
5. [Phases and release plan](#5-phases-and-release-plan)
6. [UX principles and screen layout](#6-ux-principles-and-screen-layout)
7. [Functional requirements: board thermal maps (STEP + thermal package)](#7-functional-requirements-board-thermal-maps-step--thermal-package)
8. [Functional requirements: thermal studies](#8-functional-requirements-thermal-studies)
9. [Functional requirements: materials, heat loads and boundary conditions](#9-functional-requirements-materials-heat-loads-and-boundary-conditions)
10. [Functional requirements: boards and electronics in a study](#10-functional-requirements-boards-and-electronics-in-a-study)
11. [Functional requirements: solving](#11-functional-requirements-solving)
12. [Functional requirements: results, checks, reports and export](#12-functional-requirements-results-checks-reports-and-export)
13. [Non-functional requirements](#13-non-functional-requirements)
14. [Open decisions](#14-open-decisions)
15. [Data model and file formats](#15-data-model-and-file-formats)
16. [Verification and acceptance](#16-verification-and-acceptance)
17. [Risks](#17-risks)
18. [Appendices](#18-appendices)

---

## 1. Introduction

### 1.1 Purpose

This document specifies what MöbiusCAD must do to show and compute temperatures in parts, assemblies and electronic boards, in the browser, on the exact CAD geometry and with the same no-mesh, adaptive-pass approach as the structural analysis (`docs/FRS-structural.md`). It is the reference for design, implementation, testing and acceptance of every thermal phase. `FRS-structural.md` listed steady-state thermal and thermal stress under SA5 "Further analyses"; this document replaces that line with a full plan.

### 1.2 Scope

In scope, in this order (section 5):

1. **Board thermal maps.** Opening a board's STEP file together with the thermal package that the board design app writes next to it (the "Board thermal map and thermal export" FRS of 2026-11-21, section 15.2 here), showing the temperatures on the 3D board and parts, and reading each part's heat, temperature, limit, margin and capacitor life. No solving is needed for this.
2. **Steady-state thermal studies of parts**: conduction in solids, heat power and heat flux loads, fixed temperatures, convection and radiation to ambient.
3. **Steady-state thermal studies of assemblies**, including a board opened from STEP: thermal contact between components, contact resistance and interface materials, heat sources taken straight from the thermal package, a board modelled as a layered copper/laminate plate, heatsinks.
4. **Transient thermal studies**: warm-up, cool-down, duty cycles and power profiles.
5. **Thermal stress**: a solved temperature field as a load in a structural study (FR-LOAD-011 of FRS-structural).

Out of scope: fluid flow (CFD) and air flow inside enclosures (convection is described by film coefficients, not by solving the air), radiation exchange between arbitrary surfaces with view factors beyond the cases in FR-TBC-007, phase change, Joule heating computed from currents in copper (powers come from the design app or the user), electrical simulation, any cloud or server solving.

### 1.3 Product principle

Same as the structural analysis: the engineer picks bodies or faces, says where the heat comes from and where it goes, presses Solve, and sees temperatures in seconds; accuracy comes from adaptive passes the solver runs by itself. For boards the principle is stronger still: **opening the files is the whole set-up**. A board's STEP and its thermal package open as one coloured model with a summary of what is too hot, and re-simulating it in MöbiusCAD is one command whose set-up is filled in from the package.

The analysis is an original implementation. Public text, Help and the UI describe it as "meshless, CAD-native analysis"; no other product's name, help text, icons or file formats are reproduced.

Results are engineering estimates. Every map shows its stated accuracy (for a package: the accuracy the package declares, ±15 °C by default; for a MöbiusCAD study: the error estimate of the last pass), and reports state the assumptions (FR-TRES-060).

### 1.4 Definitions and abbreviations

| Term | Meaning |
| --- | --- |
| Thermal package | The ZIP (or loose files) a board design app writes beside the board's STEP: a manifest `*-thermal.json`, a VTK mesh `*-thermal.vtu` with surface temperatures, a heat-source table `*-heat-sources.csv`, a picture `*-thermal.png` and a README (section 15.2). |
| Thermal map | Temperatures shown on the model: either read from a package (an imported map) or solved by MöbiusCAD (a study result). |
| Heat source | A body or face that produces heat, with a power in W. In a package: one row per part (designator, STEP body names, power and where it goes). |
| Heat path | Where a part's heat goes first: into the board, to air, to a heatsink, to the chassis (package column `heat_path`). |
| Film coefficient h | Heat transfer coefficient of convection, W/(m²·K): heat flux = h (T − T_ambient). |
| Contact resistance | Thermal resistance across an interface per area, K·m²/W (or a conductance per area, W/(m²·K)); a thermal interface material (TIM) is a layer with a conductivity and a thickness. |
| Ambient | The temperature of the surrounding air (and of radiation surroundings unless set otherwise). |
| Margin | Limit temperature minus estimated temperature; negative means over the limit. |
| Capacitor life | Estimated electrolytic capacitor life from the 10 °C rule: L = L₀ · 2^((T₀ − T)/10). |
| ΔT map | Difference between two thermal maps of the same board or two study results. |
| RA part | Right-angle mounted part (TO-220/TO-247 bent over onto copper or standing on a heatsink, right-angle connectors), as in the board FRS. |

### 1.5 Requirement notation

As in `FRS-structural.md` 1.5: `FR-<area>-<nnn>` / `NFR-<area>-<nnn>`, priority **M** / **S** / **C**, phase TH0 to TH5 (prefix TH so it does not collide with P0–P7 or SA0–SA6). Areas: TPKG (thermal package reading), TMAP (thermal map display), TSTU (studies), TMAT (thermal materials), TLOAD (heat loads), TBC (boundary conditions), TBRD (boards in a study), TCON (thermal connections), TSOL (solving), TRES (results), TREP (reports and export), TUI (user interface), TARC (architecture).

Internal units stay millimetres and radians. The thermal solver works in the consistent set **mm, s, W, J, K** (conductivity W/(mm·K), film coefficient W/(mm²·K), density kg/mm³, specific heat J/(kg·K)). Temperatures are shown in °C by default, °F or K by the units setting; conductivity in W/(m·K), film coefficients in W/(m²·K), power in W or mW.

### 1.6 Related documents

- `docs/FRS-structural.md` (structure, numbering, solver), `docs/structural-spike.md`, `docs/structural-validation.md`.
- "FRS: Board thermal map and thermal export" (claude.ai doc, 2026-11-21): the board design app's side, which writes the thermal package. Its manifest, mesh and CSV layouts are copied into section 15.2 so this repository holds the contract it reads.
- `docs/FRS-modelling.md`, `CLAUDE.md` (code map).
- Public verification sources: analytic conduction solutions (slab, fin with Bessel solution, cylinder with internal heat), JEDEC JESD51 natural-convection board conventions for the film coefficients' sanity range.

---

## 2. Reference approach: meshless thermal analysis on CAD geometry

### 2.1 What engineers value

| Trait | Why it matters | Where required |
| --- | --- | --- |
| No meshing step | Thermal models of boards and heatsinks are full of thin plates, fins and small parts; meshing them is most of the work in a conventional tool. | FR-TSOL-001 |
| Heat sources found from the design | Typing 40 part powers by hand is error-prone; the design app already knows them. | FR-TBRD-001 |
| Reasonable convection without CFD | Most users need "natural convection in a closed box at 40 °C", not an air model. | FR-TBC-004, FR-TBC-005 |
| Fast answer for comparisons | Moving a power resistor 10 mm away from a capacitor should show the difference in seconds. | NFR-TH-002 |
| Clear verdicts | "C12 runs at 71 °C, rated 105 °C, about 19,000 h" beats a colour plot. | FR-TMAP-020, FR-TRES-020 |
| Same set-up survives design changes | Loads stay on their bodies and faces after the design changes. | FR-TSTU-020 |

### 2.2 Method

Steady conduction −∇·(k ∇T) = q is the scalar counterpart of linear elasticity. The structural solver's octree cells, hierarchical Legendre basis, symmetric interior penalty coupling, Nitsche boundary terms, adaptive passes and error estimate (`src/sim/`) carry over with one unknown per function instead of three (section 3). Convection and contact conductance are Robin terms of the same form as the structural elastic support and adhesive joints. Radiation is linearised and iterated. Transient analysis adds the capacity matrix (from the same quadrature as the modal mass matrix) and steps in time.

---

## 3. Baseline: what MöbiusCAD already has

Reusing these is a requirement (NFR-TH-030).

| Area | Existing module | Reuse in thermal |
| --- | --- | --- |
| Cell grid and quadrature on the exact geometry | `src/sim/grid.ts` (`makeGrid`, domains, aggregation, `refit`), `quad.ts`, `body.ts` (`MeshBody`), `kernel/simgeo.ts` (`simGeometry`, `asmSimGeometry`) | The same cells, cut cells, thin-body handling (1.648.0) and per-domain maps. |
| Basis, sparse solvers | `basis.ts`, `sparse.ts` (`BlockMatrix`, `Envelope`), `pcg.ts` | Scalar blocks (1×1 instead of 3×3); direct Cholesky up to the limit, PCG above. |
| Static solver structure | `static.ts` `solveStatic`: SIPG faces, Nitsche supports, Robin springs (`Support.spring`), domain joins (`pair`, `links` with `kn`), `measurePenalty`, error estimate `eta`, local degrees, memory estimate | A `solveThermal` built the same way, as helpers outside the big function (lesson of 1.648.0: Chrome stops optimising a function that grows). |
| Passes, cases, cache | `run.ts` (`runStatic`, `markElements`, `envelope`, load cases), `buildCache.ts` (`cacheKey("sim", …)`) | Thermal passes, power cases (idle / full load), cached results. |
| Eigen/mass machinery | `eigen.ts`, `Mel` consistent mass | Capacity matrix ρ·cp for transient studies. |
| Study UI | `src/sim/ui.ts` `SimController`: Simulation tab `#sim-tools`, `#sim-tree`, `#sim-pm`, legend `#sim-legend`, probes, hot spots, paths, section caps, compare, report, iso-clipping, per-component tables, disk cache restore, auto solve | One controller with a `thermal` study kind; same tree, panels, legend, probes, report. |
| Materials | `src/tools/materials.ts`: conductivity k, specific heat cp, density, α for 170 materials; FR-4 row; per-body and per-component materials; study materials (`Study.mats`, `Study.comps[].material`) | Thermal properties; missing k (or cp for transient) blocks the solve with a button to the picker. |
| Assemblies | `src/asm/` components, mates, fasteners; `Study.links`, `findConnections` (`connect.ts`), `Study.comps` (off, rigid, material) | Thermal contacts found the same way; left-out components; materials per component. |
| STEP import and names | `src/worker/import.worker.ts`, `src/names.ts` `fixResultNames`, `stepMeta.ts` | Solid names (designators) for matching package rows to bodies. |
| ZIP reading | `src/model/zip.ts` `unzipLimited` (size-limited, `DecompressionStream`) | Opening a package ZIP; inflating the `.vtu`'s zlib blocks needs no new dependency (`DecompressionStream("deflate")`). |
| Recent documents | `src/recent.ts` (a group of files opened together is one entry) | A STEP and its package come back together from the recent list. |
| PCB view | `src/gerber/` (`load.ts` layer classification, `build.ts`, `GerberView.ts`, `Board3D.ts` composited copper/mask/silk maps per side, board thickness) | Copper coverage per area for the board's conductivity (FR-TBRD-020); the board's copper and silk texture blended under the thermal colours (FR-TMAP-012); a 2D thermal overlay in the PCB view (FR-TMAP-040). |
| Result display | sim overlay mesh (`userData.simPlot`), `plotmesh.ts` `refineMesh`, `hotspots.ts`, `probes.ts`, `path.ts`, `comps.ts`, `exports.ts`, `report.ts` | Colour plots, hot spots, probes, paths, per-part tables, PDF/HTML report. |
| Animation | `src/motion/gif.ts`, sim `recordGif` | Transient playback recording. |
| Units | `src/tools/units.ts` | °C / °F / K display. |

Gaps to fill: no package reader, no temperature field display for imported data, no scalar solver, no convection/radiation boundary terms, no board-as-plate material, no transient stepping.

---

## 4. Product overview and user journeys

### 4.1 User classes

| User | Needs | Typical use |
| --- | --- | --- |
| Electronics designer (amp builder) | Which parts run too hot on my board, how long will the electrolytics last, where should the power resistor go? | Opens STEP + thermal package; compares two layouts; re-simulates in a chassis |
| Mechanical designer | Heatsink size, enclosure wall temperature, a bracket next to a hot part | Steady thermal of a part or assembly |
| Maker | Will the printed enclosure soften near the regulator? | Assembly with a board and a plastic case |
| Student | See conduction and convection at work | Simple part studies |

### 4.2 Journeys the UI is designed around

Each journey has a click budget; the acceptance tests in section 16 check them.

- **J1 Open a board with its map (2 actions).** Drop the STEP and the thermal ZIP on the window together (or open the ZIP alone when it contains the STEP, or pick both in File ▸ Open). The board opens coloured by temperature with the legend, the summary card ("Hottest V3 182 °C · 2 parts over their limit · estimate ±15 °C") and the Thermal tab selected. Nothing to set.
- **J2 Find the problem parts (1 click).** The Parts list in the side panel is sorted by margin, worst first, red rows over the limit; clicking a row zooms to the part, outlines it and pins its card.
- **J3 Add a map to an open board (1 action).** With a STEP already open, drop the package on it, or File ▸ Add thermal map…. The map is checked against the model (FR-TPKG-020) and shown.
- **J4 Compare two layouts (2 actions).** Drop a second package for the same board; choose "Compare with…" to see the ΔT map and a table of parts whose temperature changed most.
- **J5 Re-simulate the board in MöbiusCAD (1 click + Solve).** "Simulate in MöbiusCAD" on the Thermal tab makes an assembly study with the board, the parts as components, materials guessed (FR-TBRD-010), every heat source from the package, ambient and enclosure from the package settings, and solves it. The user can then add the chassis, a heatsink or a fan and solve again.
- **J6 Part or heatsink study (about 5 clicks).** New study ▸ Thermal; pick the face where the device sits and type 15 W; Convection is already on (natural, ambient 25 °C); Solve.
- **J7 Thermal stress (2 clicks).** In a structural study, Loads ▸ Temperature ▸ From study "Thermal 1".

---

## 5. Phases and release plan

Each phase ships as one or more releases through the normal flow. A phase is complete when all its **M** requirements pass their acceptance tests (section 16). TH1 comes first because it gives board users value without any solver work (D-T1).

| Phase | Name | Content | Exit criteria |
| --- | --- | --- | --- |
| **TH1** | Board thermal maps | Read thermal packages (ZIP or loose files, version 1); pair with the STEP; match package parts to STEP solids; show the map on the 3D model with legend, range, hover card, hot-spot labels, top/bottom; Parts list with margins and capacitor life; Problems list; probes; ΔT compare of two packages; PNG and report; sample packages as fixtures | AT-TH1-1..9 |
| **TH0** | Solver spike (in parallel with TH1) | Scalar conduction on the existing cells; Robin convection; linearised radiation; analytic benchmarks; speed on the reference desktop; spike report `docs/thermal-spike.md` | AT-TH0-1..4 |
| **TH2** | Part steady-state thermal | Thermal study on parts (single and multibody): heat power, heat flux, fixed temperature, convection (auto natural, forced, typed h), radiation to ambient, insulated by default; passes with error estimate; temperature and heat flux results, probes, paths, sections, hot spots, heat balance; report; cache; auto solve | AT-TH2-1..8 |
| **TH3** | Assembly and board thermal | Thermal contacts (found automatically, perfect / resistance / TIM / gap), components left out, materials per component; board as a layered plate with copper from the stack-up or the Gerber set; heat sources and heat paths from the package; heatsink and chassis paths; "Simulate in MöbiusCAD"; per-component results, part temperatures and limits, capacitor life; export as a thermal package | AT-TH3-1..9 |
| **TH4** | Transient thermal | Initial temperature, end time, power profiles (step, table, duty cycle), time steps chosen by the solver; time slider, temperature-vs-time at probes, time to reach a temperature, animation and GIF | AT-TH4-1..5 |
| **TH5** | Thermal stress and extras | Temperature field as a structural load (thermal expansion), temperature-dependent conductivity, radiation between facing parts (valve bulbs onto the board), forced-air film coefficients from velocity along a plate, design comparison table | per item |

Indicative effort with AI assistance: TH1 1–2 weeks, TH0 3–5 days, TH2 1–2 weeks, TH3 2–3 weeks, TH4 1 week, TH5 per item. Planning numbers, not commitments.

---

## 6. UX principles and screen layout

### 6.1 Principles

- **UX-1 Opening is the set-up.** Every value a package or a model already holds is used without asking: names, powers, heat paths, ambient, enclosure, ranges, limits, capacitor ratings. Dialogs appear only for choices nothing can infer.
- **UX-2 Verdict first, plot second.** The first thing on screen after a map opens or a study solves is the summary card: hottest point, parts over their limit, lowest capacitor life, heat balance, accuracy. The colour plot supports it.
- **UX-3 Names the user knows.** Parts are called by designator (R14, V3, Q2) and value, not by solid index or face name. Temperatures in the user's unit, powers in W or mW with sensible rounding.
- **UX-4 Everything clickable leads somewhere.** A row in a table zooms to its part; a hot-spot label pins the part card; a problem selects its part and shows why; a card's "Heat path: board" highlights the pads it heats.
- **UX-5 One place per command.** Thermal commands live in the command bar (Thermal tab for a model file with a map, Simulation tab for studies); the side panel holds lists and properties; the viewport holds the legend, the summary card and labels. No tool appears in two places (standing rule of 2026-11-11).
- **UX-6 No idle banners over the model.** Suggestions ("This STEP looks like a board: add its thermal map") go to the status bar's hint area, never as a banner over the view (standing rule of 2026-11-09).
- **UX-7 Honest accuracy.** The legend always states the accuracy; a package map says "from <app>, estimate ±15 °C"; a study shows its error estimate; a map that does not fit the model says so in place, not in a log.
- **UX-8 Same habits as structural studies.** The thermal study uses the same tree, panels with ✓/✕, colour-coded selection boxes, legend, probes, hot spots, paths, compare and report; a user who knows one knows the other.
- **UX-9 Fast feedback.** Changing ambient, enclosure or a power re-solves automatically (Auto solve on by default for thermal studies, FR-TSOL-020) and the first pass appears within seconds; changing the colour range or palette costs nothing (shader uniforms).
- **UX-10 Accessible.** Palette perceptually even and readable in grey; every colour has a number on hover or probe; keyboard for all commands; EN and RU; axe-core clean in light and dark themes.

### 6.2 Screen layout

```
 ┌ header ─────────────────────────────────────────────────────────────────────────┐
 │ File ▾  Display ▾ …                                                    ⚙        │
 ├ command bar ── [Evaluate] [Thermal] ────────────────────────────────────────────┤
 │ Map ● | Range ▾ | Top/Bottom | Hot spots | Probe | Compare ▾ | Simulate | Export ▾│
 ├───────────────┬───────────────────────────────────────────────┬─────────────────┤
 │ Side panel    │  ┌ summary card ───────────────┐      navcube │                 │
 │ [Thermal]     │  │ Hottest V3 182 °C           │               │                 │
 │  Parts (40)   │  │ 2 over limit · C12 19,000 h │   legend ▮    │                 │
 │  ▸ V3  182 °C │  │ estimate ±15 °C (package)   │   182 °C      │                 │
 │  ▸ R14 131 °C │  └─────────────────────────────┘     ▮         │                 │
 │  Problems (3) │        3D board, coloured           ▮  40 °C   │                 │
 │  Settings     │        "R14 131 °C" labels                     │                 │
 ├───────────────┴───────────────────────────────────────────────┴─────────────────┤
 │ status: hint · units · selection                                                 │
 └──────────────────────────────────────────────────────────────────────────────────┘
```

- The **Thermal tab** appears in the command bar of a model file (STEP) when a thermal map is attached; a part or assembly with thermal studies uses the existing **Simulation** tab, whose New study ▾ gains Thermal and Transient thermal.
- The **Thermal side page** (model files) holds Parts, Problems and Settings; studies use the existing Study tab (`#tab-sim`).
- The **summary card** sits top left of the viewport, folds to one line (click to open), and never covers the nav cube, heads-up bar or legend.
- The **legend** is the structural legend (`#sim-legend`) with a temperature unit, Auto/Fixed range and the accuracy line.

---

## 7. Functional requirements: board thermal maps (STEP + thermal package)

### 7.1 Opening and pairing

- **FR-TPKG-001** (TH1, M) File ▸ Open, drag-and-drop on the window and the start card accept a thermal package as: a ZIP holding a `*-thermal.json` manifest; the loose files (manifest + `.vtu` + optional CSV/PNG/README) picked or dropped together; or a ZIP that also holds the STEP (`files.step`). A ZIP is told apart from a Gerber ZIP by the manifest's presence (`format` field), before any Gerber sniffing.
- **FR-TPKG-002** (TH1, M) Dropping or picking a STEP and a package together opens the STEP and attaches the map in one step (J1). The pair is one entry in the recent list (`recent.ts` groups) and one tab in the document tabs.
- **FR-TPKG-003** (TH1, M) A package opened alone without a STEP inside opens its own mesh as the model (the `.vtu` surfaces are a complete picture of the board) with a status hint "Open the board's STEP to measure it or simulate it"; dropping the STEP later attaches it (FR-TPKG-020 then checks the fit).
- **FR-TPKG-004** (TH1, M) With a STEP open, File ▸ Add thermal map… or dropping a package on the viewport attaches the map to that model (J3). A second package for the same model offers "Replace" or "Keep both and compare" (FR-TMAP-030).
- **FR-TPKG-005** (TH1, S) A STEP that looks like a board (a thin flat solid larger than every other, named board/PCB, or parts named by designators) gets a status-bar hint with an "Add thermal map…" link (UX-6), shown once per file. Built in 1.678.0: `src/thermal/study.ts` `looksLikeBoard` (a body named board/PCB, 3+ bodies named by designators, or the `findBoard` plate with a footprint larger than every other body's); `#st-thermal` in the status bar, files remembered in localStorage `mc:thermalHint`.
- **FR-TPKG-006** (TH1, S) In a vault, a STEP and a package with the same stem in the same folder open together; Pack and Go keeps them together. Built in 1.682.0: opening either from the vault opens both (the package is `<stem>-thermal.zip`, or a thermal `<stem>.zip` when the STEP is opened); Pack and Go adds the package the open model's map came from.
- **FR-TPKG-007** (TH1, M) Packages are read with the existing size limits (`unzipLimited`, NFR-SEC-002); a package that exceeds them, or whose manifest is not valid JSON, is refused with E-TH-PKG and nothing else changes.

### 7.2 Reading the package (version 1 contract, section 15.2)

- **FR-TPKG-010** (TH1, M) The manifest is read first. Accepted `format` values: `tubecad-thermal` (the board design app) and `mobiuscad-thermal` (MöbiusCAD's own export, FR-TREP-010). Version 1 is accepted; unknown keys and arrays are ignored; a higher version opens with a note "written by a newer app: some data may be missing" when its required fields are present, else E-TH-VERSION.
- **FR-TPKG-011** (TH1, M) The `.vtu` reader handles VTK XML UnstructuredGrid with one `<Piece>`, `ascii` and `binary` (base64) data arrays, UInt32 or UInt64 headers, little-endian, uncompressed and `vtkZLibDataCompressor` blocks (inflated with `DecompressionStream("deflate")`), cell types 5 (triangle) and 9 (quad, split a-b-c / a-c-d). Required arrays: `Points`, `Temperature_C`, `PartId`; optional: `Face`, `Power_W`, `HeatFlux_W_m2`, field data `Ambient_C`, `GridStep_mm`. Parsing runs in a worker (`thermal.worker.ts`) and transfers typed arrays.
- **FR-TPKG-012** (TH1, M) The CSV is read when present (comma, UTF-8, dot decimals, header row); when both CSV and manifest `parts` exist, the manifest wins and the CSV is only checked against it. Columns are found by header name, so added columns do not break the reader.
- **FR-TPKG-013** (TH1, M) Settings shown to the user come from the manifest (`settings.ambient_C`, `enclosure`, `orientation`, `operating_point`, `grid_mm`, `emissivity`), `accuracy_C`, `range_C`, `app`, `created`, `design`.
- **FR-TPKG-014** (TH1, S) A plain `.vtu` with a `Temperature_C` (or any one-component point array, chosen in a small list) opens as a map without a manifest, with parts unnamed, so maps from other tools that write VTK can be viewed on a STEP too. Built in 1.677.0: the reader takes Temperature_C, else the only one-component point array (or the one named like a temperature), and asks in a list when several fit; a name ending in K is read as kelvin; with no PartId the connected pieces are parts 1…n, largest first; polygon cells (type 7) are read as fans.
- **FR-TPKG-015** (TH3, S) A heat-source CSV alone (columns at least `step_bodies` or `designator`, and `p_total_W`) can be attached to a STEP to give a study its heat sources without a map (journey J5 for apps that only export powers). Built in 1.672.0: `readPackage` reads such a CSV (no manifest, no .vtu) as a package with `sourcesOnly`; rows without `part_id` are numbered.

### 7.3 Matching the map to the STEP

- **FR-TPKG-020** (TH1, M) Each package part is matched to STEP solids by the names in `step_bodies` (the STEP's `MANIFOLD_SOLID_BREP` names, read with the solid names enabled in the import, else by scanning the STEP text for the names in solid order). Parts not found by name are matched by `bbox_mm` (centres within 0.5 mm and sizes within 0.5 mm). The result is shown as "40 of 40 parts matched"; unmatched parts are listed in the Problems list with "not in this STEP".
- **FR-TPKG-021** (TH1, M) Fit check: the package and STEP must share coordinates (package frame = the STEP's). If matched parts' centres are off by more than 0.5 mm on average, the legend shows "The map does not fit this model (about 3.2 mm off)" with a **Fit by parts** button that moves the map by the least-squares translation of the matched centres. A rotation or mirror is not guessed.
- **FR-TPKG-022** (TH1, M) A STEP whose bodies changed since the package was written (parts missing, extra parts, boxes changed by more than 1 mm) shows the map with "The map is older than the model: n parts changed", and the changed parts drawn grey with a hatch.

### 7.4 Showing the map

- **FR-TMAP-001** (TH1, M) When a map is attached, the model is coloured by temperature: by default the package mesh is drawn in place of the STEP's shaded bodies (same geometry, same coordinates), and the STEP bodies stay in the scene, invisible to rendering but used for picking, measuring, snapping and sections, so every Evaluate tool keeps working on the exact model. The **Map** button of the Thermal tab toggles the map (T is the Note tool's key); the camera stays where it is.
- **FR-TMAP-002** (TH1, S) Option "Colour the model's faces" (Thermal settings): each STEP mesh vertex takes the temperature of the nearest package point of the same part (grid hash, 0.5 mm cells), so a STEP with finer or different tessellation, cut by a section plane, still shows the map.
- **FR-TMAP-003** (TH1, M) Palette: perceptually even, dark = ambient, light yellow = hottest (default), plus a "rainbow" and a grey palette in the legend menu. Colouring is a 1D palette texture with the range as shader uniforms (changing range or palette does not rebuild geometry).
- **FR-TMAP-004** (TH1, M) Range: Auto (ambient to hottest, or the package's `range_C`) or Fixed (typed min/max, kept per board), so two maps compare on one scale. Values outside a fixed range show in the end colours with ▲/▼ marks on the legend.
- **FR-TMAP-005** (TH1, M) Legend: plot name, unit, min/max, the source ("from Tube Amp CAD 3.24x, 2026-11-21" or the study name), ambient, operating point and the accuracy line ("estimate ±15 °C"). It reuses `#sim-legend`.
- **FR-TMAP-006** (TH1, M) Summary card (UX-2): hottest part and point, number of parts over their limit, lowest capacitor life, highest board temperature, accuracy; each line is a link (FR-TMAP-020). Folds to one line; state remembered.
- **FR-TMAP-007** (TH1, M) Hover card on a part: designator, value, power (W) and where it goes (board / air / heatsink / chassis with the W of each), temperature and its kind (body, case, junction, bulb), limit and margin, capacitor rated temperature and estimated life, operating point. Clicking pins it; Esc unpins. On the board itself: the board temperature at that point and the heat flux leaving it.
- **FR-TMAP-008** (TH1, M) Hot-spot labels: the hottest point of the board and every part over its limit get a one-line label in 3D ("R14 131 °C"), placed like the structural peak labels (`.sim-peak`), red when over the limit; a legend checkbox hides them.
- **FR-TMAP-009** (TH1, M) Top / Bottom: a button turns the view to the board's other face (the side whose `Face` cells are 1 or 2), since SMD power parts and pours heat the bottom too.
- **FR-TMAP-010** (TH1, S) Isotherm clip: show only surfaces hotter (or cooler) than a value (reuses the structural iso-clipping), with the rest ghosted.
- **FR-TMAP-011** (TH1, M) Probe: clicking with the Probe tool shows the temperature at that point of the map (nearest package point, interpolated over the triangle), kept in a probe list with CSV export (reuses `probes.ts`).
- **FR-TMAP-012** (TH1, C) When the board's Gerber set is opened too, the board faces can blend the Board3D copper/mask/silk composite under the thermal colours with a slider, so tracks and silkscreen stay readable; the Gerber outline is aligned to the STEP board by the outline's box (with a manual offset if needed). Built in 1.681.0: Board layers on the Thermal bar; copper, silkscreen and holes multiplied under the colours, the legend's Layers slider and Offset, mm; a quarter turn when the outline's sizes fit the board better that way.
- **FR-TMAP-013** (TH1, S) "Ambient + ΔT" view: colours and labels in temperature rise above ambient instead of absolute temperature.
- **FR-TMAP-014** (TH1, M) The package PNG is available as "Picture from the design app" in the Thermal side page (a thumbnail that opens full size).

### 7.5 Parts, problems and checks

- **FR-TMAP-020** (TH1, M) Parts list (Thermal side page): one row per package part: designator, value, power, temperature, limit, margin, life (electrolytics); sorted by margin (worst first), sortable by any column, filter box (designator or value). Rows over the limit are red, within 10 °C amber. Clicking a row zooms to the part (fits its box), outlines it and pins its card; double-click isolates it (others transparent, as asm Isolate).
- **FR-TMAP-021** (TH1, M) Problems list: parts over their limit, electrolytics with estimated life under a threshold (default 10,000 h, set in Thermal settings), board hotter than its laminate limit (default 105 °C for FR-4: Tg minus margin, editable), parts in the package not found in the STEP (FR-TPKG-020) and changed parts (FR-TPKG-022). Each problem selects its part or spot. The Thermal tab shows the count as a badge.
- **FR-TMAP-022** (TH1, M) Capacitor life is shown as the package gives it (`life_h`); when a part's row has a limit and a rated life (L₀ at T₀) but no life, MöbiusCAD computes it with the 10 °C rule and marks it "computed".
- **FR-TMAP-023** (TH1, S) Heat budget table: total power, split by heat path (board / air / heatsink / chassis), largest five sources.

### 7.6 Comparing maps

- **FR-TMAP-030** (TH1, S) Compare with…: a second package (or, from TH3, a study result) on the same STEP shows the ΔT map (B − A) with a diverging palette centred on 0, and a table of parts by temperature change. Parts present in one map only are listed separately.
- **FR-TMAP-031** (TH1, S) A/B switch: one key (**B**) flips between the two maps on one fixed range.

### 7.7 Other views

- **FR-TMAP-040** (TH1, C) PCB view: when the board's Gerber set and a package are both open, View ▾ Thermal overlay draws the package's board-face temperatures under the 2D layers at 50 % opacity, with the legend, for the face the view shows.
- **FR-TMAP-041** (TH1, M) Section planes cut the map: caps show the package's surface temperatures where they meet the cut outline only (a package has no interior values) with a note in the legend; a MöbiusCAD study paints the caps with interior values (FR-TRES-030).
- **FR-TMAP-042** (TH1, M) Save PNG in Thermal mode draws the legend, the summary line and the accuracy into the picture.

---

## 8. Functional requirements: thermal studies

### 8.1 Creating and keeping studies

- **FR-TSTU-001** (TH2, M) New study ▾ in the Simulation tab gains **Thermal** (steady state) and, in TH4, **Transient thermal**. Thermal studies are stored with the structural ones (`PartDoc.studies`, `AsmDoc.studies`), `kind: "thermal" | "transient"`, results in the cache only.
- **FR-TSTU-002** (TH2, M) A new thermal study starts with sensible defaults so that one heat load is enough to solve: ambient 25 °C, every face not otherwise set loses heat by **natural convection** (auto film coefficient) and radiation with ε from the material (0.9 when unknown), the model's own materials. The tree shows these defaults as rows ("Convection: natural, all free faces", "Ambient 25 °C") that can be edited or switched off; nothing is hidden.
- **FR-TSTU-003** (TH2, M) Duplicate, rename, delete and the study switcher behave as for structural studies; the study used last is remembered.
- **FR-TSTU-004** (TH3, M) An opened STEP gets thermal studies through an assembly: **Simulate in MöbiusCAD** (Thermal tab) or New study ▸ Thermal on a model file creates an assembly (one component per STEP solid, named by the solid name, the import kept exact), opens it in a new tab and makes the study there (J5). The assembly is unsaved until the user saves it; nothing about the STEP file changes.
- **FR-TSTU-005** (TH3, S) Power cases: one study holds several sets of heat loads (Idle, Full power, With signal), solved together with results per case and an envelope (max T over cases); a package's operating point becomes the first case's name. Built in 1.670.0: Study tab Power cases (steady studies; a transient study runs every source on its profile), envelope = highest temperature per point; the package's operating point is not taken over yet.

### 8.2 Associativity

- **FR-TSTU-020** (TH2, M) Loads and boundary conditions are stored by face, body or component reference and follow edits like structural ones (`FaceRef`/`refindFace`); one that lost its reference gets E-SIM-REF.
- **FR-TSTU-021** (TH2, M) Results are stale when the model, materials or study set-up changed (same `keyOf` rules); the cached result of an earlier identical state comes back without solving.

---

## 9. Functional requirements: materials, heat loads and boundary conditions

### 9.1 Materials

- **FR-TMAT-001** (TH2, M) Thermal conductivity k (and, for transient studies, density and specific heat cp) come from the body, part or component material, or the study's material override, as for structural studies. A body without k (or cp when needed) blocks the solve with "Set a material with thermal conductivity for <body>" and a button to the picker.
- **FR-TMAT-002** (TH2, M) Materials used by electronics get thermal values where a public source gives them: FR-4 (k 0.3, cp 1,100), copper (k 390), aluminium alloys, tin-lead and SAC solder, alumina, silicone thermal pads, thermal grease, glass (valve bulbs), ABS/PLA/PETG/PC enclosures, mica; library rows without a source stay without the value (the library rule). Each added value gets its reference like other rows.
- **FR-TMAT-003** (TH2, S) Orthotropic conductivity: a material or a study override may give in-plane and through-thickness k with the plane's normal (a board, a laminated stack, a graphite pad). Stored as `kx, ky, kz` in a body frame.
- **FR-TMAT-004** (TH5, C) Temperature-dependent k (table), solved by repeating the solve with k at the current temperature until it changes less than 0.5 %. Built in 1.665.0: a table per part or component in the thermal study (also used in transient studies).

### 9.2 Heat loads

| ID | Phase | Pri | Load | Picks | Values |
| --- | --- | --- | --- | --- | --- |
| FR-TLOAD-001 | TH2 | M | **Heat power** | bodies, components, faces | Total power in W (or mW), spread over the volume of the picked bodies or the area of the picked faces; "per item" option. Bodies are the default pick (a part dissipates in its body). |
| FR-TLOAD-002 | TH2 | M | **Heat flux** | faces | W/m² normal into the face. |
| FR-TLOAD-003 | TH2 | S | **Volume heat** | bodies | W/m³. Built in 1.671.0: the whole part, or in an assembly the components of the picked faces. |
| FR-TLOAD-004 | TH3 | M | **Heat from package** | (all package parts) | One power per package part on its matched bodies, split by its heat path (FR-TBRD-003); edited as one row with a table of parts, each part can be left out or given another power. |
| FR-TLOAD-005 | TH4 | M | **Power profile** | any heat load | Step, table of (time, power or factor), duty cycle (on time, period), expression of t; reuses the motion study profile parsers (`parsePoints`, `exprValue`). |

- **FR-TLOAD-010** (TH2, M) Values accept expressions, units and global variables (`values.ts` pattern; W, mW, kW, BTU/h for power; W/m², W/cm² for flux).
- **FR-TLOAD-011** (TH2, M) Heat loads are drawn on the model: a flame glyph with "15 W" on bodies and components, small inward arrows on faces with a flux.

### 9.3 Boundary conditions

| ID | Phase | Pri | Condition | Picks | Behaviour |
| --- | --- | --- | --- | --- | --- |
| FR-TBC-001 | TH2 | M | **Fixed temperature** | faces, bodies | Temperature held (°C), e.g. a cold plate, a chassis wall held at 45 °C. |
| FR-TBC-002 | TH2 | M | **Insulated** | faces | No heat crosses (removes the default convection from those faces). |
| FR-TBC-003 | TH2 | M | **Convection** | faces | Film coefficient h (W/(m²·K)) to a bulk temperature (ambient by default). |
| FR-TBC-004 | TH2 | M | **Natural convection (auto)** | faces (default: all free faces) | h per face from its orientation (vertical, facing up, facing down) and size by the standard laminar plate correlations, evaluated at the face's current temperature and iterated; enclosure factor (open frame 1.0, vented chassis 0.8, closed chassis 0.55, editable). |
| FR-TBC-005 | TH2 | S | **Forced air** | faces | Air speed (m/s) along the faces → h from the laminar/turbulent flat-plate correlation with the face's length in the flow direction; or a fan's speed typed as a number. Built in 1.667.0 (speed typed or from a fan's flow through an opening, flow direction ±X/±Y/±Z). |
| FR-TBC-006 | TH2 | M | **Radiation to surroundings** | faces (default: all free faces) | εσ(T⁴ − T_s⁴), ε from the material or typed, T_s = ambient by default; linearised and iterated. |
| FR-TBC-007 | TH5 | C | **Radiation between faces** | two face sets | Exchange by view factor computed by ray sampling (e.g. a valve bulb onto the board under it, a heater onto a wall). Built in 1.666.0. |
| FR-TBC-008 | TH3 | M | **Heatsink** | faces of a component or of a part | Either a modelled heatsink body (its fins get the default convection) or a thermal resistance to ambient Rth (K/W) on the picked faces; the package's heatsink path maps here (FR-TBRD-004). |
| FR-TBC-009 | TH3 | S | **Chassis wall** | faces | Fixed temperature or resistance to ambient for parts wired off the board (package `heat_path` = chassis). |

- **FR-TBC-010** (TH2, M) Ambient temperature is one study value shown at the top of the tree, used by every convection and radiation unless overridden; enclosure presets **Open frame (25 °C)**, **Vented chassis (35 °C)**, **Closed chassis (40 °C)** set ambient and the enclosure factor in one pick.
- **FR-TBC-011** (TH2, M) Gravity direction for natural convection: −Z of the model by default, or "down" of the current view, or a typed direction; a board's orientation preset (horizontal parts up, parts down, vertical) sets it for boards.
- **FR-TBC-012** (TH2, M) A study with no path for heat to leave (all faces insulated and no fixed temperature) stops with E-TH-NOSINK naming the bodies, before solving.
- **FR-TBC-013** (TH2, M) Boundary conditions are drawn with their own glyphs (fixed temperature: a thermometer; convection: wavy arrows; radiation: dashed rays; heatsink: fins) with a value callout.

### 9.4 Thermal connections (assemblies)

- **FR-TCON-001** (TH3, M) Components that touch or lie within the gap (default 0.1 mm) are joined automatically (`findConnections`), by default with **perfect contact** (temperature continuous).
- **FR-TCON-002** (TH3, M) A connection's type can be **Contact resistance** (K·m²/W or conductance W/(m²·K)), **Interface material** (k and thickness, e.g. a 0.5 mm silicone pad, grease, mica washer; library entries for common ones) or **Gap** (air layer of the found gap, conduction only, k_air at the mean temperature), or **None**. Types are set in the Connections table, as structural links. Built in 1.676.0: Air gap (`StudyLink.type` "air", `t` = the found gap or 0.1 mm; the solver takes air's k at each joint's mean temperature, solving again until the conductance settles; a transient run takes it at the starting temperature) and the pad library (`PAD_LIBRARY`, typical data sheet values).
- **FR-TCON-003** (TH3, S) Bolted joints: a pair joined by a bolt from the fastener library gets a contact conductance from the clamping by default (a typed value; no pressure-dependent model in TH3). Built in 1.673.0: Find connections and Solve mark the pairs a toolbox screw clamps (its head patch's and nut/thread patch's components) as Bolted joint, 5000 W/(m²·K) by default.
- **FR-TCON-004** (TH3, M) Heat crossing each connection is reported (W, mean temperature drop) in the Connections table.

---

## 10. Functional requirements: boards and electronics in a study

- **FR-TBRD-001** (TH3, M) **Simulate in MöbiusCAD** (J5): from a STEP with a package, MöbiusCAD makes the assembly (FR-TSTU-004), a thermal study with ambient, enclosure and orientation from the package settings, one **Heat from package** load, the board material (FR-TBRD-010), part materials guessed by name and package (FR-TBRD-011), default convection and radiation, and starts solving. The user sees the same summary card and Parts list as for the imported map, now with "MöbiusCAD study, error ±x °C", and can compare the two (FR-TMAP-030).
- **FR-TBRD-002** (TH3, M) Package parts with `p_total_W` under 10 mW are left out, as the package does; the load's table shows them greyed.
- **FR-TBRD-003** (TH3, M) Heat paths become boundary terms:
  - `board`: `p_board_W` enters the board through the part's contact patch with the board (faces of the part within the gap of the board found by `findConnections`, else its footprint box projected on the board), `p_air_W` is the part's own convection and radiation (its body gets the default convection);
  - `air`: the whole power heats the body; the body cools by convection and radiation and conducts into the board through its pins/contact;
  - `heatsink`: `p_sink_W` goes into the heatsink (modelled body or Rth, FR-TBC-008); `p_board_W` into the board as above;
  - `chassis`: `p_sink_W` leaves through FR-TBC-009; only lead heat stays on the board.
  The split is the package's starting point; in MöbiusCAD's own solve the heat goes where the conductances send it, unless "Keep the package's split" is ticked (then the shares are applied as fixed powers).
- **FR-TBRD-004** (TH3, M) RA parts: a part with mount `ra-on-heatsink` or `ra-on-copper` follows FR-TBRD-003 with its contact found in the geometry (the tab lying on a pad is a contact with the board; a tab on a heatsink is a contact with the heatsink body), so the bent-over and standing cases differ without extra input.
- **FR-TBRD-010** (TH3, M) **Board material**: the solid identified as the board (largest thin flat solid, or named board/PCB, or the package's PartId 0 region) gets an orthotropic "PCB (effective)" material: in-plane k = Σ (copper fraction × 390 × t_Cu) / t + k_FR4, through k from the layered stack in series, density and cp by volume. Inputs: layers, copper thickness per layer (oz or µm) and overall copper fraction (default 2 layers, 35 µm, 50 % / 30 % top/bottom), shown in a Board panel.
- **FR-TBRD-011** (TH3, S) Part materials guessed for the solids made by the board design app: resistor bodies = alumina, electrolytic cans = aluminium, valve bulbs = glass, plastic packages = epoxy moulding compound, metal tabs = copper; shown in the Model section with "guessed" so the user can change them.
- **FR-TBRD-020** (TH3, S) **Copper from the Gerber set**: when the board's Gerber set is attached (dropped on the board or found beside it), the copper coverage of each copper layer is rasterised (`build.ts` paths, the Board3D masks) and the board's in-plane conductivity varies over the board with the local coverage (sampled at quadrature points); thermal vias in the drill file add through conductivity locally. The Board panel shows a coverage map. Built in 1.675.0: the Gerber set is picked from the board row (Copper from Gerber…); each copper layer is drawn into a canvas and averaged per cell (`src/thermal/copperRaster.ts`, about 1 mm cells, at most 40 000), plated holes add barrel copper through the board per cell (`copper.ts` `viaShare`); the map is kept in the study (`StudyComp.board.map`), centred on the board body (sides swapped when they fit better) and each element takes the area mean of its cells (`thermal.ts` `KMap`, `kmapMean`). Dropping the set on the board and finding it beside the STEP are not built.
- **FR-TBRD-021** (TH3, M) Part temperatures in a MöbiusCAD study: each package part's reported temperature is the maximum of its body (`t_kind` body/case/bulb) or, for parts whose package temperature is a junction, its case temperature plus p × Rjc when Rjc is known (typed in the parts table; empty = case only, marked).
- **FR-TBRD-022** (TH3, M) Limits and capacitor life come from the package rows (`t_limit_C`, rated life) and can be edited in the load's parts table; the Parts list and Problems list work as in TH1 on the study results.
- **FR-TBRD-023** (TH3, S) Board checks after a solve as in FR-TMAP-021, plus "electrolytic within 10 °C of a part over 1 W" as a gradient warning.

---

## 11. Functional requirements: solving

- **FR-TSOL-001** (TH2, M) No meshing step and no simplification: the solver uses the cells, quadrature and thin-body handling of the structural solver (FRS-structural 6.2), one unknown per basis function.
- **FR-TSOL-002** (TH2, M) Weak form: symmetric interior penalty for conduction across cell faces, Nitsche for fixed temperatures, Robin terms for convection, linearised radiation and contact conductance, penalty measured per element as in `measurePenalty`. Orthotropic and spatially varying k enter at quadrature points.
- **FR-TSOL-003** (TH2, M) Passes start at degree 2 and raise degrees where the error is largest (energy norm of the flux difference between passes, `eta` per element) until the change in heat energy is below the tolerance (default 1 %), as structural passes; local refinement and the Accuracy group (passes, tolerance, refine on faces) are shared.
- **FR-TSOL-004** (TH2, M) Non-linear terms (auto natural convection, radiation, temperature-dependent k) are solved by Picard iteration inside each pass (at most 12 iterations, stop at 0.1 K change), reusing the factorisation where only the Robin terms change and the PCG otherwise.
- **FR-TSOL-005** (TH2, M) The heat balance is checked after every pass: heat in (loads) = heat out (convection + radiation + fixed temperatures + heatsinks) within 0.5 %; the result shows it (FR-TRES-004).
- **FR-TSOL-006** (TH4, M) Transient: implicit time stepping (BDF2 after one backward Euler step) with the consistent capacity matrix; the time step is chosen by the solver from the temperature change per step (at most 2 K or 2 % of the rise per step, between end time / 2,000 and end time / 20), at the degrees of a steady pre-pass; the user gives the end time and the output interval only.
- **FR-TSOL-007** (TH2, M) Solving runs in the simulation worker, cancellable, keeps the last finished pass, refuses beyond the memory estimate (E-SIM-MEMORY), and its results go to the disk cache (`cacheKey("sim", …)`).
- **FR-TSOL-020** (TH2, M) Auto solve is on by default for thermal studies (steady state only): after a change in loads, ambient, materials or the model, the study solves again after 700 ms and the first pass replaces the plot as soon as it lands (UX-9).
- **FR-TSOL-021** (TH3, S) Changing only powers or ambient reuses the matrix and factorisation (linear case) so the new result appears within 20 % of the first solve's time. Built in 1.674.0: fixed temperatures too; the solver's worker keeps each degree's build and factorisation under a key of everything else (`run.ts` `reuseKey`); a block re-solved in about 15 % of the first time.

---

## 12. Functional requirements: results, checks, reports and export

### 12.1 Results

- **FR-TRES-001** (TH2, M) Plots: temperature (default), temperature rise above ambient, heat flux magnitude, heat flux vectors (arrows on a sampled set of surface points), error estimate. Built in 1.669.0: Temperature rise (K above the study's ambient) in the plot list, Heat flow arrows checkbox under the colour scale (temperature, heat flux and error plots were built in 1.651.0).
- **FR-TRES-002** (TH2, M) The summary card (FR-TMAP-006) for studies: hottest point and body, coolest, heat balance, error estimate, and for boards the TH1 lines.
- **FR-TRES-003** (TH2, M) Probes, paths (temperature along a line, CSV), section caps with interior temperatures, iso-clipping, hot-spot list (local maxima; temperatures have no singular points, so no singularity marks; heat flux at sharp corners is marked as structural stress is), legend probe label — all as structural results.
- **FR-TRES-004** (TH2, M) Heat balance table: every load and every way out with its W; the imbalance in %.
- **FR-TRES-005** (TH3, M) Per-component table: max / mean temperature, heat produced, heat leaving by convection, radiation and conduction to each neighbour; clicking a row shows that component alone, as structural per-component results.
- **FR-TRES-006** (TH4, M) Transient results: a time slider on the legend (play/pause, speed), temperature-vs-time chart for each probe and for each component's maximum, "time to reach" a typed temperature per probe, final steady value when the run ended at steady state; GIF and CSV export.
- **FR-TRES-020** (TH3, M) Board results in a study use the TH1 Parts list, Problems list, hover cards, labels and capacitor life (FR-TMAP-006..022) with values from the solve.
- **FR-TRES-030** (TH2, M) Compare: a study with its previous result or another study, and from TH3 a study with an imported package map (ΔT map, table), reusing `compare.ts`.
- **FR-TRES-060** (TH2, M) Assumptions statement on results and in reports: steady (or transient) conduction, convection by film coefficients (natural correlations or typed), radiation to surroundings, contact types used, no air flow solved, accuracy from the error estimate and from the inputs (powers, h).

### 12.2 Reports and export

- **FR-TREP-001** (TH1, M) Report (PDF / HTML, as structural): model and source, settings, summary, pictures from the current view (top and bottom for boards), Parts and Problems tables, heat budget, assumptions and accuracy. For an imported map the report says the values come from the package and its app.
- **FR-TREP-010** (TH3, M) Export ▾ Thermal package writes the same layout as section 15.2 with `format: "mobiuscad-thermal"`, version 1: the study's surface temperatures on the display mesh as `.vtu` (ascii or compressed), the heat-source CSV (one row per heat load or package part), manifest, PNG and README; so the result opens in ParaView, PyVista and FreeCAD FEM and back in MöbiusCAD. Built in 1.668.0 (Study tab ▸ Thermal package; part temperatures by component, board = part 0).
- **FR-TREP-011** (TH2, S) CSV exports: probes, paths, Parts list, heat balance, transient charts.
- **FR-TREP-012** (TH5, M) Thermal stress: Loads ▸ Temperature ▸ From study in a structural study takes the last result of a thermal study on the same model (temperature at each quadrature point by sampling the kept solution, reference temperature typed, default 20 °C) and the material's α; stale when the thermal study changes. Built for parts in 1.663.0 and for assemblies (each component's own α, the expansion mismatch carried across joined faces) in 1.664.0.

---

## 13. Non-functional requirements

### 13.1 Performance (reference desktop i7-4770, Chrome)

- **NFR-TH-001** (TH1, M) Opening a package of 4 MB ascii (150 × 100 mm board, 40 parts) next to its STEP adds at most 2 s to opening the STEP; a compressed package of 1 MB at most 1 s. The map toggle (T) and range changes respond within 100 ms.
- **NFR-TH-002** (TH2, M) Part thermal study of about 30 faces: first pass within 3 s, converged within 15 s.
- **NFR-TH-003** (TH3, M) Board study (board + 40 parts, no chassis): first pass within 15 s, converged within 2 min; re-solve after a power change within 20 s (FR-TSOL-021).
- **NFR-TH-004** (TH4, M) Transient study of the board, 200 time steps: within 5 min.
- **NFR-TH-005** (TH1, M) Thermal code (package reader, solver) loads on demand; opening a model without a map is not slower.

### 13.2 Accuracy

- **NFR-TH-020** (TH2, M) Against analytic solutions after convergence: slab with fixed temperatures and internal heat within 0.5 %; fin with convection (Bessel solution) within 2 %; cylinder with internal heat and convection within 1 %; heat balance within 0.5 %.
- **NFR-TH-021** (TH3, M) Against an open-source FEA thermal solver (Elmer or CalculiX, run offline, not shipped) on three cases (a heatsink part, a board with five sources, a board in a chassis): temperatures within 3 % of the rise above ambient. The comparison is kept in `docs/thermal-validation.md`.
- **NFR-TH-022** (TH1, M) Displayed package values equal the file's values (no smoothing): a probe at a mesh point returns its `Temperature_C` exactly (to the display's decimals).
- **NFR-TH-023** (TH3, S) A MöbiusCAD board study set up from a package agrees with the package's own map within the package's stated accuracy on the example boards (a cross-check, not a pass/fail on the design app).

### 13.3 Other

- **NFR-TH-030** (TH0, M) Reuse of the modules in section 3; no second solver framework, no second legend, no second material list.
- **NFR-TH-031** (TH0, M) Unit tests in node for the package reader (all encodings), matching, the scalar solver and analytic benchmarks; smoke checks in the packaged build for opening a package, the Parts list and a small thermal study; hands-on scenarios in `tests/human/` for J1–J7.
- **NFR-TH-032** (TH0, M) Determinism to 1e-9 relative, as structural.
- **NFR-TH-033** (TH1, M) Free libraries only; no new runtime dependency for the reader (its own text scan of the XML, DecompressionStream, existing zip code).
- **NFR-TH-034** (TH1, M) Privacy: nothing leaves the browser.
- **NFR-TH-035** (TH1, M) EN and RU for every string; axe-core and layout checks cover the Thermal tab, side page, summary card and legend in light and dark themes.
- **NFR-TH-036** (TH1, M) A malformed package (bad XML, wrong array lengths, offsets past the end, NaN temperatures, zip bombs) never hangs or crashes the page: it is refused with a message naming what is wrong (E-TH-VTU).

---

## 14. Open decisions

| ID | Decision | Options | Recommendation |
| --- | --- | --- | --- |
| D-T1 | Phase order | Board maps (TH1) first, solver spike in parallel / solver first | TH1 first: the board user gets value with no solver risk |
| D-T2 | Where studies of a STEP live | Automatic assembly from the STEP (FR-TSTU-004) / studies on model files in a side file | Automatic assembly: reuses components, materials, connections, saving and the vault |
| D-T3 | Map display | Package mesh in place of the STEP bodies (STEP kept for picking) / colour the STEP's own faces | Package mesh by default, face colouring as an option (FR-TMAP-001/002) |
| D-T4 | Formats read | `tubecad-thermal` v1 and `mobiuscad-thermal` v1 / also JEDEC ECXML | The two; ECXML is commercial-tool territory and was dropped by the board FRS too |
| D-T5 | Convection model | Correlations for plates + typed h / a simple air network in enclosures | Correlations + enclosure factor in TH2; an enclosure air node (one well-mixed air temperature rising with total power) as a TH5 candidate |
| D-T6 | Board conductivity | Effective orthotropic from stack-up (TH3) + Gerber coverage (S) / every track as geometry | Effective, with Gerber coverage when available; tracks as geometry is far too heavy |
| D-T7 | Default ambient for a new part study | 25 °C / 40 °C | 25 °C for parts; boards take the package's value (40 °C closed chassis by the board FRS) |

---

## 15. Data model and file formats

### 15.1 Study additions (schema sketch)

```ts
interface ThermalStudy extends Study {
  kind: "thermal" | "transient";
  ambient: Num;                          // °C
  enclosure?: "open" | "vented" | "closed" | { factor: number };
  gravity?: [number, number, number];    // for natural convection, absent = -Z
  heat: HeatLoad[];                      // { id, type: "power"|"flux"|"volume"|"package", refs, value: Num, profile?: Profile, case? }
  bcs: ThermalBC[];                      // { id, type: "fixed"|"insulated"|"convection"|"natural"|"forced"|"radiation"|"heatsink"|"chassis", refs, ... }
  links?: StudyLink[];                   // thermal contact: type "perfect"|"resistance"|"tim"|"gap"|"none", r?, k?, t?
  board?: { comp: string; layers: number; copper: number[]; fill: number[]; gerber?: string }; // TH3
  package?: { name: string; sha: string; split: boolean; parts: PackagePart[] }; // the attached package's part table (edits kept)
  transient?: { end: Num; out: Num; t0: Num };  // TH4
}
```

Model files (STEP) with an attached map are not documents; the pairing is kept by the recent list and the document tab (`DocTab` keeps the package bytes like `modelSrc` keeps the model's). Thermal settings of a map (range, palette, labels, life threshold, laminate limit) are kept per STEP name in localStorage `mc:thermalMap:<stem>`.

### 15.2 Thermal package, version 1 (read contract)

Copied from the board FRS of 2026-11-21 so this repository holds the contract. All files share the STEP's frame: millimetres, x right, y up, z up from the board's bottom face.

```
<name>-thermal.zip
  <name>-thermal.vtu        temperatures on the 3D board and parts (VTK XML)
  <name>-heat-sources.csv   one row per heat source, names = STEP bodies
  <name>-thermal.png        3D view with legend
  <name>-thermal.json       manifest
  README-thermal.txt
  <name>.step               optional ("Include STEP")
```

**Manifest** (`format` `tubecad-thermal` or `mobiuscad-thermal`, `version` 1):

```json
{
  "format": "tubecad-thermal",
  "version": 1,
  "app": "Tube Amp CAD 3.24x.0",
  "created": "2026-11-21T20:00:00Z",
  "design": "EL84 push-pull",
  "units": { "length": "mm", "temperature": "C", "power": "W", "flux": "W/m2" },
  "frame": "same as the STEP export: x right, y up, z up from the board's bottom face",
  "files": { "mesh": "amp-thermal.vtu", "sources": "amp-heat-sources.csv", "picture": "amp-thermal.png", "step": "amp.step" },
  "settings": { "ambient_C": 40, "enclosure": "closed", "orientation": "horizontal-up", "operating_point": "dc", "grid_mm": 1, "emissivity": 0.9 },
  "accuracy_C": 15,
  "range_C": [40, 182],
  "parts": [
    { "part_id": 2, "designator": "R14", "step_bodies": ["R14"], "bbox_mm": [33, 26.75, 2.0, 57, 33.25, 8.5],
      "p_total_W": 3.1, "t_body_C": 131, "t_limit_C": 155, "heat_path": "board", "mount": "lying" }
  ]
}
```

`parts` repeats the CSV columns as JSON. `bbox_mm` = min x, y, z then max x, y, z. Rules: refuse another `format`; accept version 1; ignore unknown keys and arrays; a new required field means version 2.

**Mesh** (`.vtu`, VTK XML UnstructuredGrid, one Piece):

| Array | Where | Type | Unit | Meaning |
| --- | --- | --- | --- | --- |
| Points | per point | Float32 × 3 | mm | x, y, z in the STEP frame |
| Temperature_C | PointData | Float32 | °C | surface temperature (required) |
| PartId | CellData | Int32 | – | 0 = board, 1…n = `part_id` (required) |
| Face | CellData | Int8 | – | 0 part body, 1 board top, 2 board bottom, 3 board edge |
| Power_W | CellData | Float32 | W | the part's whole dissipation |
| HeatFlux_W_m2 | CellData | Float32 | W/m² | heat leaving the board face to air |
| Ambient_C | FieldData | Float32 | °C | ambient used |
| GridStep_mm | FieldData | Float32 | mm | board grid size |

Cell types 5 (triangle) and 9 (quad). Points are not shared between solids. Encoding `ascii`, or `binary` base64 with a UInt64 (or UInt32) header; with `compressor="vtkZLibDataCompressor"` the header is block count, block size, last block size, then each compressed block size, each block zlib-compressed.

**Heat-source CSV** (UTF-8, comma, dot decimals, one header row, sorted by power):

```
part_id,designator,step_bodies,part,heat_path,mount,x_mm,y_mm,z_mm,dx_mm,dy_mm,dz_mm,volume_mm3,p_total_W,p_board_W,p_air_W,p_sink_W,t_body_C,t_kind,t_limit_C,margin_C,life_h,source
1,V3,V3;V3-2;V3-3,EL84,air,socket,45.0,62.0,40.5,22.0,22.0,78.0,24300,18.2,0.6,17.6,0,182,bulb,250,68,,dc
2,R14,R14,470R 5W,board,lying,45.0,30.0,3.9,24.0,6.5,6.5,780,3.1,1.6,1.5,0,131,body,155,24,,dc
3,Q2,Q2,IRF820,heatsink,ra-on-heatsink,118.0,8.0,12.0,10.4,4.6,15.0,560,4.4,0.2,0,4.2,96,junction,150,54,,dc
4,C12,C12,47u 450V,air,standing,60.0,55.0,18.0,16.0,16.0,32.0,6400,0.05,0,0.05,0,71,case,105,34,19000,dc
```

`heat_path` ∈ board, air, heatsink, chassis; `mount` ∈ lying, standing, smd, ra-on-copper, ra-on-heatsink, socket, wired; `t_kind` ∈ body, case, junction, bulb; `source` ∈ dc, signal. p_board + p_air + p_sink = p_total.

MöbiusCAD's export (FR-TREP-010) writes the same layout with `format: "mobiuscad-thermal"`; `PartId` then numbers the study's heat loads or package parts, and the CSV's `t_body_C` is the study's maximum temperature of those bodies.

### 15.3 Migration

Documents without thermal studies open as before; older MöbiusCAD versions carry unknown study kinds through untouched (the structural FRS 15.3 rule) and show them as "Study of a newer kind".

---

## 16. Verification and acceptance

### 16.1 Test levels

- Unit tests (node, `npm run test:unit`): package reader (ascii, base64, zlib blocks, UInt32/UInt64 headers, quads, malformed inputs), CSV and manifest parsing, part matching and fit check, capacitor life, scalar solver against analytic cases, convection correlations, radiation iteration, heat balance, transient against the analytic slab cooling curve.
- Fixtures: the board design app ships three sample packages (its FRS's FR-22: examples 07, 14, 17 with STEP, validated with the VTK library); copies go to `tests/fixtures/thermal/` with their STEPs, plus a generated small package (`tests/fixtures/thermal/make.mjs`) covering every encoding.
- Smoke test (packaged build, own `inShard(k)` blocks in the shortest shards): open STEP + package together, legend and summary, Parts list sorting and zoom, Top/Bottom, a probe value, ΔT compare, a part thermal study solved, heat balance shown.
- Hands-on scenarios (`tests/human/`, real clicks): one per journey J1–J7 with screenshots and `report.md`.

### 16.2 Phase acceptance tests

| ID | Test |
| --- | --- |
| AT-TH1-1 | Dropping example 14's STEP and ZIP together opens one tab with the map shown, legend 40–182 °C, summary "Hottest V3", "estimate ±15 °C", Thermal tab selected (J1, 2 actions). |
| AT-TH1-2 | A ZIP holding the STEP opens both from one file. |
| AT-TH1-3 | All parts matched by name; with the STEP's names removed, matched by boxes; a package moved by 3 mm shows the fit warning and Fit by parts brings the error under 0.1 mm. |
| AT-TH1-4 | Probes at five mesh points return the file's `Temperature_C` exactly (NFR-TH-022). |
| AT-TH1-5 | Parts list sorted by margin; clicking R14 zooms to it and pins its card with 3.1 W, board 1.6 W / air 1.5 W, 131 °C, limit 155 °C, margin 24 °C. |
| AT-TH1-6 | Problems list counts match the package (parts over limit, caps under 10,000 h); changing the threshold updates it. |
| AT-TH1-7 | ascii and compressed versions of the same package give identical maps. |
| AT-TH1-8 | ΔT compare of two packages: a part 10 °C hotter in B shows +10 in the table and in the probe. |
| AT-TH1-9 | Malformed packages (truncated XML, offsets past the end, zip bomb) are refused with the message and the page stays usable. |
| AT-TH0-1 | Slab, fin and cylinder analytic cases within NFR-TH-020. |
| AT-TH0-2 | Heat balance within 0.5 % on every benchmark. |
| AT-TH0-3 | Radiation-only cooling of a plate converges within 12 Picard iterations to within 0.5 % of the analytic equilibrium. |
| AT-TH0-4 | Speed of the 30-face part within NFR-TH-002. |
| AT-TH2-1 | J6 in at most 5 clicks after New study: heatsink part, 15 W on the base face, natural convection default, solve, summary shows the base temperature. |
| AT-TH2-2 | Changing ambient from 25 to 40 °C raises every temperature by 15 °C ± 0.5 (linear case, auto solve shows it without pressing Solve). |
| AT-TH2-3 | Insulated everywhere → E-TH-NOSINK before solving. |
| AT-TH2-4 | Doubling the fin count lowers the base temperature; a fin study agrees with the Bessel fin solution within 2 %. |
| AT-TH2-5 | Fixed-temperature faces report the heat through them; the balance closes within 0.5 %. |
| AT-TH2-6 | Section cap through the heatsink shows interior temperatures continuous with the surface. |
| AT-TH2-7 | Editing the part (fin height) keeps loads on their faces; the cached result of the earlier height comes back when undone. |
| AT-TH2-8 | Report PDF in EN and RU has the summary, pictures, heat balance and assumptions. |
| AT-TH3-1 | Simulate in MöbiusCAD on example 14 makes the assembly, the study with every package source, and solves; no part over its limit that the package does not also list, unless the user changed the set-up (NFR-TH-023 within ±15 °C). |
| AT-TH3-2 | The same TO-220 as ra-on-copper vs ra-on-heatsink: board rise under the part at least 3× larger on copper. |
| AT-TH3-3 | A 5 W resistor lying vs standing: the lying one gives a hotter board under it, the standing one a hotter body. |
| AT-TH3-4 | A 0.5 mm silicone pad (k 3) between a part and a heatsink raises the part by p·t/(k·A) ± 3 %. |
| AT-TH3-5 | Board in-plane conductivity from 2 × 35 µm, 50 % fill: point source on a board agrees with the analytic thin-plate fin solution within 3 %. |
| AT-TH3-6 | Gerber coverage: a large pour under a hot part lowers its temperature compared with a bare board. |
| AT-TH3-7 | Export Thermal package from the study, open it back: the map equals the study's (probes within display decimals); ParaView-compatible (parsed by `vtk` in a validation script, not in CI). |
| AT-TH3-8 | Per-component heat table sums to the total power within 0.5 %. |
| AT-TH3-9 | Validation against Elmer/CalculiX within NFR-TH-021 (offline, report in docs). |
| AT-TH4-1 | A block heated by a step of power approaches the steady result; the curve matches the lumped analytic curve within 2 % for a small Biot number. |
| AT-TH4-2 | A 50 % duty cycle settles to a periodic band around the steady result at half power. |
| AT-TH4-3 | Time slider, probe chart and "time to reach 80 °C" agree with the probe's CSV. |
| AT-TH4-4 | GIF records the warm-up. |
| AT-TH4-5 | Transient board study within NFR-TH-004. |

### 16.3 Benchmark set

Analytic: slab (fixed temperatures, internal heat), cylinder with internal heat and convection, straight fin with convective tip (Bessel/hyperbolic solution), plate with a point source (modified Bessel K0 for a thin plate with convection on both faces), lumped cooling of a small block (exponential), radiation equilibrium of a plate. Real: an extruded heatsink, example boards 07/14/17, a board in an aluminium chassis.

---

## 17. Risks

| Risk | Effect | Mitigation |
| --- | --- | --- |
| STEP solid names not available from the import | Package parts not matched by name | Scan the STEP text for `MANIFOLD_SOLID_BREP` names in order; box matching fallback (FR-TPKG-020) |
| One STEP product with many solids imports as one mesh | Per-part picking and per-part components impossible | Split by solid in the import (the kernel already walks solids); test with the example STEPs first in TH1 |
| Natural convection correlations off inside real enclosures | Absolute temperatures off by 10–20 °C | Enclosure factor, accuracy line, comparisons emphasised (differences between layouts are more reliable) |
| Thin board (1.6 mm) and tiny SMD bodies in one model | Many cut cells, slow passes | Thin-body aggregation (1.648.0), orthotropic board as one domain, small parts as rigid-temperature lumps when below a size (TH3 option: "small parts as lumps") |
| Package format changes in the design app | Reader breaks | Versioned manifest, ignore-unknown rule, fixtures from the design app's own tests |
| Radiation between parts matters (valves onto the board) | Board under a valve too cool in MöbiusCAD's own solve | TH5 face-to-face radiation; until then the package's map (which models it) is shown alongside, and the compare view makes the gap visible |
| Large ascii packages | Slow open, memory | Worker parsing, typed arrays, compressed option preferred in the hint |

---

## 18. Appendices

### Appendix A. Command map

| Place | Commands | Phase |
| --- | --- | --- |
| Thermal tab (model file with a map) | Map on/off (T), Range ▾ (Auto, Fixed, palette, ΔT above ambient), Top/Bottom, Hot spots, Isotherm, Probe, Compare ▾ (with another package, A/B (B)), Simulate in MöbiusCAD, Export ▾ (PNG, report, Parts CSV) | TH1, TH3 |
| File menu | Open (accepts packages), Add thermal map… | TH1 |
| Simulation tab, Study | New study ▾ (… Thermal, Transient thermal), Solve, Cancel, Settings | TH2, TH4 |
| Simulation tab, Heat | Heat power, Heat flux, Volume heat, Heat from package, Power profile | TH2–TH4 |
| Simulation tab, Boundaries | Fixed temperature, Insulated, Convection, Natural convection, Forced air, Radiation, Heatsink, Chassis wall, Ambient & enclosure | TH2–TH3 |
| Simulation tab, Connections | Find connections, Perfect, Contact resistance, Interface material, Gap | TH3 |
| Simulation tab, Results | Temperature, Rise, Heat flux, Flux vectors, Error, Probe, Path, Hot spots, Section, Compare, Parts, Heat balance, Time slider | TH2–TH4 |
| Simulation tab, Output | Report, Thermal package, CSV, GIF | TH2–TH4 |

### Appendix B. Error and notice codes

| Code | Message |
| --- | --- |
| E-TH-PKG | This is not a thermal package (no manifest), or it could not be read: {reason}. |
| E-TH-VERSION | This thermal package needs a newer MöbiusCAD (format {format} version {v}). |
| E-TH-VTU | The thermal mesh could not be read: {reason}. |
| E-TH-FIT | The map does not fit this model (about {d} mm off). |
| E-TH-NOMATCH | {n} parts of the map are not in this STEP. |
| E-TH-NOK | Set a material with thermal conductivity for {body}. |
| E-TH-NOCP | Set a material with density and specific heat for {body} (needed for transient studies). |
| E-TH-NOSINK | Heat cannot leave {bodies}: add convection, a fixed temperature or a heatsink. |
| E-TH-NOHEAT | The study has no heat load. |
| E-TH-BOARD | No board found in this model: pick the board body in the Board panel. |

The structural codes E-SIM-REF, E-SIM-EMPTY, E-SIM-MEMORY and E-SIM-STOPPED apply as they are.

### Appendix C. Mapping to existing code (for implementers)

| Need | Existing piece |
| --- | --- |
| ZIP, size limits | `src/model/zip.ts` `unzipLimited` |
| zlib blocks of the `.vtu` | `DecompressionStream("deflate")` (as `zip.ts` uses `deflate-raw`) |
| Opening and sniffing files | `main.ts` `openFiles` / `openBuffer`, `gerber/load.ts` sniffing (check the manifest first) |
| Solid names | `names.ts` `fixResultNames`, `stepMeta.ts`, import worker |
| Overlay plot, legend, probes, labels | `src/sim/ui.ts` (`showPlot`, `#sim-legend`, `probes.ts`, `.sim-peak`), `plotmesh.ts` |
| Isolate, zoom to part | asm `isolate`, `Viewer.fit(animate, box)` |
| Thermal solver | new `src/sim/thermal.ts` beside `static.ts`, sharing `grid.ts`, `quad.ts`, `basis.ts`, `sparse.ts`, `pcg.ts`, `run.ts` passes; helpers outside the main function |
| Assembly from a STEP | `AsmController` insert path (`readSource`, `importBody`) per solid; `kernel/simgeo.ts` `asmSimGeometry` |
| Contacts | `connect.ts` `findConnections`, `Study.links` |
| Board copper coverage | `gerber/build.ts`, `Board3D.ts` masks |
| Profiles over time | `motion/evaluate.ts` `pointsAt`, `parsePoints`, `exprValue` |
| Report, GIF, compare | `sim/report.ts`, `motion/gif.ts`, `sim/compare.ts` |
| Materials | `tools/materials.ts` (k, cp, density; add references for new values) |
