# MöbiusCAD Structural Analysis: Functional Requirements Specification

| | |
| --- | --- |
| Document | FRS-MCAD-SIM, Functional Requirements Specification for structural analysis in MöbiusCAD |
| Version | 0.1 (draft) |
| Date | 2026-11-20 |
| Owner | Andrey Dumchin |
| Product baseline | MöbiusCAD 1.605.0 (parametric parts, assemblies, drawings, weldments, sheet metal, motion studies, vault) |
| Status | Draft. Open decisions are listed in section 14. Nothing here is built yet. |

---

## Contents

1. [Introduction](#1-introduction)
2. [Reference approach: meshless analysis on CAD geometry](#2-reference-approach-meshless-analysis-on-cad-geometry)
3. [Baseline: what MöbiusCAD already has](#3-baseline-what-möbiuscad-already-has)
4. [Product overview](#4-product-overview)
5. [Phases and release plan](#5-phases-and-release-plan)
6. [Architecture requirements](#6-architecture-requirements)
7. [Functional requirements: studies](#7-functional-requirements-studies)
8. [Functional requirements: materials, supports and loads](#8-functional-requirements-materials-supports-and-loads)
9. [Functional requirements: solving](#9-functional-requirements-solving)
10. [Functional requirements: results and reports](#10-functional-requirements-results-and-reports)
11. [Functional requirements: assemblies and connections](#11-functional-requirements-assemblies-and-connections)
12. [Functional requirements: user interface](#12-functional-requirements-user-interface)
13. [Non-functional requirements](#13-non-functional-requirements)
14. [Open decisions](#14-open-decisions)
15. [Data model](#15-data-model)
16. [Verification and acceptance](#16-verification-and-acceptance)
17. [Risks](#17-risks)
18. [Appendices](#18-appendices)

---

## 1. Introduction

### 1.1 Purpose

This document specifies what MöbiusCAD must do to analyse the strength and stiffness of parts and assemblies, in the browser, directly on the exact CAD geometry the modeller makes. It is the reference for design, implementation, testing and acceptance of every simulation phase. `docs/FRS-modelling.md` left simulation out of its scope "for its own document"; this is that document.

### 1.2 Scope

In scope, in this order (Andrey, 2026-11-20: "start with parts and then move on to assemblies", "static analysis first", "then modal"):

1. Linear static analysis of parts (single body and multibody).
2. Modal analysis (natural frequencies and mode shapes) of parts.
3. Linear static analysis of assemblies, with connections between components (bonded, sliding, bolts, welds, connectors).
4. Modal analysis of assemblies.
5. Later phases: linear buckling, steady-state thermal, thermal stress, separating and frictional contact, fatigue estimate, design variants.
6. Optional last phase: material and geometric non-linearity, dynamic response.

Out of scope: meshing as a user-visible step, export of meshes or input decks to other solvers, fluid flow (CFD), electromagnetics, crash and explicit dynamics, composite lay-ups, topology optimisation (may get its own document later), any cloud or server solving (C-1).

### 1.3 Product principle

The analysis follows the approach of meshless, CAD-native structural tools (section 2): the engineer picks faces, sets loads and supports, presses Solve and sees results in seconds to minutes, without meshing, defeaturing or repairing the geometry, and repeats the loop after every design change. Accuracy is reached by **adaptive passes** that the solver runs by itself, not by the user tuning a mesh.

MöbiusCAD's analysis is an **original implementation**: its own method choice (section 6), names, icons, wording and file data. No other product's code, help text, icons or file formats are reproduced.

Results are engineering estimates for design decisions. Reports state the assumptions (linear elastic material, small displacements, the connection types used) and that they do not replace a validated analysis where a standard or a customer requires one (FR-RES-060).

### 1.4 Definitions and abbreviations

| Term | Meaning |
| --- | --- |
| Study | One analysis set-up on one part or assembly: its kind (static, modal, …), included bodies, materials, supports, loads, connections, solution settings and results. A document may hold several studies. |
| Support | A boundary condition that holds the model: fixed, sliding, hinge, elastic, enforced displacement. |
| Load | Something that acts on the model: force, pressure, moment, gravity, bearing load, remote load, bolt preload, centrifugal load. |
| Connection | How two bodies or components are joined in the analysis: bonded, sliding, bolt, weld, rigid or elastic connector. |
| Pass | One solution of the whole model at a given approximation; the next pass refines the approximation where the error is largest. |
| Cell | A box of space in which a body's displacement is approximated by a polynomial field (section 6.2). Cells are internal and never shown as a mesh. |
| DOF | Degrees of freedom (unknown coefficients) of the approximation. |
| Von Mises stress | Equivalent stress σ_v = √(½[(σ1−σ2)² + (σ2−σ3)² + (σ3−σ1)²]), compared with the yield strength. |
| Safety factor | Yield (or tensile, by choice) strength divided by von Mises stress at a point. |
| Mode | A natural vibration shape of the structure with its frequency. |
| Free-free | A modal study without supports: the first six modes are rigid-body modes at about 0 Hz. |
| Singularity | A point where the exact linear-elastic stress is infinite (re-entrant sharp corner, point load, edge of a fixed face). Its value grows with every pass and must be flagged, not reported as the maximum. |

### 1.5 Requirement notation

As in `FRS-modelling.md` section 1.5:

- **ID**: `FR-<area>-<nnn>` for functional, `NFR-<area>-<nnn>` for non-functional. Areas: STU (studies), SMAT (analysis materials), SUP (supports), LOAD (loads), SOL (solving), RES (results), REP (reports), CON (connections), SUI (simulation UI), SARC (architecture).
- **Priority**: **M** must (the phase is not done without it), **S** should, **C** could.
- **Phase**: SA0 to SA6, see section 5. Phase names are prefixed SA so they do not collide with the modelling phases P0–P7.

Internal units stay millimetres and radians (`units.ts`). The solver works in the consistent set **N, mm, s, MPa, t/mm³** (E in MPa, density in tonnes per mm³, frequencies in Hz). Values are shown in the document units (stress in MPa or psi, force in N or lbf).

### 1.6 Related documents

- `docs/FRS-modelling.md` (modelling FRS, the style and numbering this document follows), `CLAUDE.md` (code map).
- Material library (1.372.0): `src/tools/materials.ts`.
- Mass properties (1.344.0): `src/tools/inertia.ts`, `src/tools/massPanel.ts`.
- Exact kernel and its speed work: `src/kernel/occ.ts`, `src/kernel/memo.ts`, `src/kernel/pool.ts`.
- NAFEMS linear elastic benchmarks LE1 and LE10 and free-vibration benchmarks FV (public benchmark values used in section 16).

---

## 2. Reference approach: meshless analysis on CAD geometry

### 2.1 What engineers value in the reference tools

Meshless structural tools that work on CAD geometry are valued for these traits; each is a requirement here:

| Trait | Why it matters | Where required |
| --- | --- | --- |
| No meshing step | A conventional FEA spends most of the engineer's time on meshing, defeaturing and mesh fixing. | FR-SOL-001, NFR-SIM-010 |
| Works on the full geometry | Small fillets, holes, text, threads stay; nothing is simplified by hand. | FR-SOL-003 |
| Tolerant of imprecise assemblies | Parts that touch with small gaps or overlaps (as real CAD assemblies do) are still connected. | FR-CON-003 |
| Fast first answer, then adaptive refinement | A rough answer in seconds guides design; later passes converge. | FR-SOL-010..015 |
| Same set-up survives design changes | Loads and supports stay on their faces after the part is edited; re-solving is one click. | FR-STU-020 |
| Large assemblies on a desktop | Hundreds of parts without a cluster. | NFR-SIM-003 (later phases) |
| Connections found automatically | Bonded contacts, bolts and welds are proposed, not drawn by hand. | FR-CON-001..030 |
| Convergence shown | The engineer sees how energy and peak stress change pass by pass. | FR-RES-040 |

### 2.2 Typical workflow to match

1. Open the part or assembly; choose New study ▸ Static (or Modal).
2. Check materials (taken from the part) and the bodies included.
3. Assemblies: review the connections found automatically; change types where needed (bonded → sliding, bolt preload).
4. Add supports and loads by picking faces, edges or points.
5. Solve: the first pass shows results in seconds; further passes refine while the engineer looks.
6. Read displacement, von Mises stress, safety factor and reactions; probe points; animate the deformed shape or the modes.
7. Edit the design in the modeller and solve again; compare with the previous result.
8. Export a report.

### 2.3 How the reference tools are believed to work, and what we can use

The leading meshless tool approximates each part's displacement with polynomial functions defined on the part's geometry itself (the published "method of external approximations"), raises the order and adds functions where the error is large, and joins parts through their contact areas with a tolerance. The details of that method are not published in a form that can be implemented. MöbiusCAD therefore uses openly published methods with the same user-facing properties (section 6.2): an immersed, adaptive, high-order approximation over cells that the geometry cuts (the finite cell idea), with weak coupling between cells and between parts. To the user both look the same: no mesh, exact geometry, passes that converge.

---

## 3. Baseline: what MöbiusCAD already has

Reusing these is a requirement (NFR-SIM-030), not a suggestion.

| Area | Existing module | Reuse in analysis |
| --- | --- | --- |
| Exact B-rep | `src/kernel/occ.ts`, `src/kernel/model.ts` (`Modeller`), `src/kernel/assembly.ts` (`Assembler`) | The analysed geometry is the modeller's exact body (parts) or the placed shapes (assemblies). No re-import. |
| Point classification | `src/kernel/memo.ts` `stateAt(shape, p, tol)` (one classifier per shape), `optimalBox`, `massOf` | Inside/outside tests for volume quadrature in cut cells; tight boxes for the cell grid; exact volume as a check of the quadrature (NFR-SIM-021). |
| Parallel kernel workers | `src/kernel/pool.ts` `KernelPool`, `src/kernel/spare.ts` | Geometry queries for cell batches run on helper workers in parallel. |
| Persistent face names | `FaceRef`/`EdgeRef` + `Modeller.resolveFace`/`refindFace` (1.586.0) | Supports, loads and probes are stored by face name and follow the design through edits (FR-STU-020). |
| Tessellation and picking | `src/topology.ts`, `Snapper.ts`, three-mesh-bvh (`indirect: true`) | Picking faces/edges/points for loads; display mesh on which results are drawn; BVH for fast inside tests. |
| Materials | `src/tools/materials.ts`: 170 materials with E, ν, yield, tensile, density, k, cp, α; `PartDoc.material`, per-body `PartDoc.bodies[key].material`, asm `setPartMaterial` | Elastic properties and allowables come from the part or body material; missing values block the solve with a clear message (FR-SMAT-002). |
| Mass properties | `src/tools/inertia.ts` (`combine`, `principal`), `massProperties` | Gravity and acceleration loads, inertia relief, modal mass checks (total mass of the model = Σ effective modal masses of all modes). |
| Result colouring | `src/viewer/Analysis.ts` `SurfaceAnalysis` (swaps material and vertex colours, `restore()`), `surfaceAnalysis.ts` legend classes | Contour plots on the model and their legend. |
| Wall thickness | `surfaceAnalysis.ts` `thickness` (rays with `boundsTree`) | Thin-wall detection to size cells across the thickness (FR-SOL-013). Sheet metal thickness `SheetState` T is used directly. |
| Sections | `src/viewer/Section.ts` (up to 3 planes, caps) | Results on section caps (FR-RES-030). |
| Animation | `src/motion/` (frames, GIF/WebM/PNG recording) | Animating deformed shapes and modes, recording them (FR-RES-020). |
| Coordinate systems | `src/tools/csys.ts`, `CsysFeature` | Directions of loads and supports, results in a chosen frame. |
| Disk cache | `src/buildCache.ts` (IndexedDB, keyed by build id + content) | Cached cell geometry and results per study state (FR-SOL-030). |
| Assemblies | mates (`src/asm/solver.ts`), fasteners (`src/asm/fasteners.ts`), interference/clearance (`Assembler.interference`/`clearance`) | Contact detection and bolt proposals (section 11). |
| Weldments | `src/weldments/` bead features (`<id>:b<k>:leg1|leg2|face`) | Weld connections from beads (FR-CON-022). |
| Reports | `exporters.ts` (jsPDF with DejaVu Sans, Cyrillic), `withLang` | PDF report (FR-REP-001). |
| UI kit | `src/ui.ts`, `commandBar.ts` tabs, `.pm` panels with ✓/✕, `i18n.ru.ts` | Simulation tab and panels; every string in EN and RU. |

Gaps to fill: no elasticity solver, no study data, no cell approximation, no result fields, no connection model.

---

## 4. Product overview

### 4.1 User classes

| User | Needs | Typical study |
| --- | --- | --- |
| Design engineer | Check a part or bracket before ordering it; compare two designs | Static, 1–3 loads, a few minutes |
| Maker | Will this printed part break? | Static, plastic material, gravity + one force |
| Machine builder | Frame or weldment stiffness, first natural frequency above the drive frequency | Static and modal of a weldment or assembly |
| Student | Learn how loads flow, see the mode shapes | Static and modal on simple parts |

### 4.2 Operating environment

As the modeller (`FRS-modelling.md` 4.2): current desktop browsers, WebAssembly, no SharedArrayBuffer (no COOP/COEP headers on aerocat.tech and GitHub Pages), workers for heavy work, reference machine i7-4770 with 15 GB RAM (the author's desktop). Phones show results of a solved study but do not set studies up.

### 4.3 Constraints

- **C-1** Everything runs in the browser. No model, load or result leaves the computer; no cloud solving.
- **C-2** Free tooling only (Andrey, 2026-11-11: no paid services). Libraries must be free and licensed MIT, BSD, Apache-2.0, or LGPL as a separate replaceable module. GPL/AGPL code is not shipped; it may be used offline for validation only (CalculiX, NFR-SIM-022).
- **C-3** Simulation code and workers load on demand, only when a study is opened or created; opening a model or a part must not get slower (NFR-SIM-001).
- **C-4** One static deployment, released by the existing Release workflow.
- **C-5** One author for commits and releases (Andrey Dumchin).

### 4.4 Assumptions

- **A-1** The opencascade.js build shipped today offers what geometry queries need: `BRepClass3d_SolidClassifier`, `BRepExtrema_DistShapeShape`, `BRepAdaptor_Surface`, `GeomAPI_ProjectPointOnSurf`, `BRepGProp`, `BRepMesh_IncrementalMesh`. It has no volume mesher; the method does not need one (section 6.2).
- **A-2** A worker has about 2–4 GB of WASM/JS heap; the solver must stay within the budget of NFR-SIM-005.
- **A-3** Linear elasticity, small strains and isotropic materials cover SA1–SA4.

---

## 5. Phases and release plan

Each phase ships as one or more releases through the normal flow. A phase is complete when all its **M** requirements pass their acceptance tests (section 16). Order: parts before assemblies, static before modal (section 1.2). Reading of that order: static parts, modal parts, then static and modal assemblies (D-S7).

| Phase | Name | Content | Exit criteria |
| --- | --- | --- | --- |
| **SA0** | Spike | Method decision (cells + polynomials, section 6.2), quadrature on exact geometry, solver core in TypeScript, optional WASM hot loops; accuracy on the benchmark set; speed on the reference desktop; spike report in `docs/` | AT-SA0-1..4 |
| **SA1** | Part linear static (MVP) | Static study on a single-body part: material from the part, fixed / sliding / hinge supports, force, pressure, moment, gravity; adaptive passes with convergence chart; displacement, von Mises, safety factor, deformed shape, probes, reactions; studies stored in the part; re-solve after edits; PDF report | AT-SA1-1..8 |
| **SA2** | Part modal | Modal study: first N modes or modes in a range, free-free or supported, mode list with frequencies and effective masses, animated mode shapes; multibody parts (bonded bodies) for static and modal; more loads and supports (elastic support, enforced displacement, bearing, remote load, centrifugal); local refinement; results on sections | AT-SA2-1..6 |
| **SA3** | Assembly linear static | Static study on an assembly: automatic connections with gap/overlap tolerance (bonded, sliding), bolts from the fastener library and hole pairs with preload, welds from weld beads, rigid and elastic connectors; include/exclude components, rigid components; results per component; reaction and connection forces | AT-SA3-1..7 |
| **SA4** | Assembly modal | Modal study on assemblies with the SA3 connections (linear types); added masses; comparing two assembly designs | AT-SA4-1..3 |
| **SA5** | Further analyses | Linear buckling, steady-state thermal and thermal stress (now planned in `docs/FRS-thermal.md`), separating and frictional contact (non-linear), fatigue estimate from S-N data, design variants table | per analysis |
| **SA6** | Non-linear and dynamics (optional) | Bilinear plasticity, large displacements, transient and frequency response | separate decision |

Indicative effort for one developer with AI assistance: SA0 1–2 weeks, SA1 3–4 weeks, SA2 2 weeks, SA3 3–4 weeks, SA4 1 week. Planning numbers, not commitments; SA0 may change them.

---

## 6. Architecture requirements

### 6.1 Overview

```
 main thread                       kernel workers (existing)          simulation worker (new)
 ───────────                       ─────────────────────────          ───────────────────────
 Simulation tab, study tree   ──▶  exact body / placed shapes   ──▶   cell grid, quadrature,
 panels, picks (face names)        stateAt, face sampling,            assembly of matrices,
 result display (Analysis.ts) ◀──  thickness, contact pairs     ◀──   solve, error estimate,
                                                                       result fields per cell
```

- **FR-SARC-001** (SA0, M) A new `src/sim/` module holds the study model, the approximation, the solver and the result evaluation as pure TypeScript where possible, so unit tests run in node (`npm run test:unit`).
- **FR-SARC-002** (SA0, M) Solving runs in its own worker (`sim.worker.ts`), started on demand, never on the main thread. Geometry queries run on the kernel workers (`ModelKernel` for parts, the assembly worker for assemblies, `KernelPool` helpers for batches). The solver never holds OCCT objects.
- **FR-SARC-003** (SA0, M) Data between workers moves as transferable `ArrayBuffer`s (no SharedArrayBuffer, section 4.2).
- **FR-SARC-004** (SA0, M) A solve can be cancelled at any time; cancelling keeps the last finished pass's results.

### 6.2 Approximation method (decided in SA0, D-S1)

The recommended method, to be confirmed by the SA0 spike:

- **FR-SARC-010** (SA0, M) **Cells, not a mesh.** Each body is covered by an octree of axis-aligned cells built from its tight box (`optimalBox`). Cells wholly outside the body are dropped; cells cut by the boundary are kept. The geometry is never meshed into elements and never simplified.
- **FR-SARC-011** (SA0, M) **Polynomial fields per cell.** In each cell the displacement is a complete polynomial of degree p = 1..4 in local scaled coordinates (Legendre basis for conditioning), 3 components. Neighbouring cells are joined weakly (symmetric interior penalty), so cells of different sizes and degrees meet without a conforming mesh or hanging-node rules.
- **FR-SARC-012** (SA0, M) **Integration on the exact geometry.** Volume integrals in cut cells use adaptive sub-cell quadrature; each quadrature point is classified against the body (the BVH of the fine tessellation first, `stateAt` on the exact B-rep where a point is within tolerance of the boundary). Moment fitting on the boundary (divergence theorem over the face triangles, corrected to the exact surface) is an allowed faster alternative if SA0 shows equal accuracy. The quadrature volume of a body must match the exact volume `massOf` within 1e-4 relative.
- **FR-SARC-013** (SA0, M) **Boundary conditions weakly.** Supports, enforced displacements and connections are applied by Nitsche's method (penalty as a fallback) on the picked faces; pressures and surface forces are integrated over the picked faces' triangles with points projected onto the exact surface.
- **FR-SARC-014** (SA0, M) **Thin walls.** Where the local wall thickness (rays, or the sheet metal T) is less than the cell size, cells are split across the thickness only (anisotropic refinement) and get p ≥ 2, so plates and sheet metal bend correctly without shell elements.
- **FR-SARC-015** (SA0, S) The spike also measures the alternative of a body-fitted tetrahedral mesh made internally by an LGPL mesher compiled to WASM (Netgen) with p-elements, hidden from the user. It is chosen only if the cell method fails the accuracy or speed targets.

### 6.3 Numerical core

- **FR-SARC-020** (SA0, M) Matrices are stored in block (3×3) compressed sparse row form in `Float64Array`s. Cell matrices are computed in parallel by worker batches and merged in the solver worker.
- **FR-SARC-021** (SA1, M) Linear static: preconditioned conjugate gradients with a p-multigrid preconditioner (the p = 1 problem solved by a sparse Cholesky factorisation, block-Jacobi smoothing for higher degrees). Direct sparse Cholesky for small models (below a DOF limit set in SA0).
- **FR-SARC-022** (SA2, M) Modal: LOBPCG (or shift-invert Lanczos on the same factorisation) for the lowest N eigenpairs of K φ = ω² M φ; consistent mass matrix from the same quadrature.
- **FR-SARC-023** (SA0, S) Hot loops (cell integration, matrix-vector products, factorisation) may move to a WASM module built with free tools (Rust + wasm-pack or C via Emscripten), MIT licensed, when SA0 shows at least a 2× gain. TypeScript stays the reference implementation for tests.
- **FR-SARC-024** (SA5, C) WebGPU compute for matrix-free products where the browser offers it, with the CPU path kept.
- **FR-SARC-025** (SA3, S) Assemblies: per-component matrices are built in parallel; the global system couples them through connection terms only, so a component that did not change keeps its matrices (FR-SOL-031).

### 6.4 Code organisation

- **FR-SARC-030** (SA1, M) `src/sim/types.ts` (study schema), `study.ts` (store, undo through the document store), `cells.ts` (octree, cut cells), `basis.ts`, `quad.ts`, `assemble.ts`, `solve.ts` (PCG, Cholesky, LOBPCG), `estimate.ts` (error estimate and refinement), `results.ts` (stress recovery, sampling at display vertices, probes), `sim.worker.ts`, `ui.ts` (tab, tree, panels), `report.ts`. Kernel-side queries go in `src/kernel/simgeo.ts`.
- **FR-SARC-031** (SA1, M) Every new UI string is added to `i18n.ru.ts`; smoke blocks go in their own `inShard(k)` section.

---

## 7. Functional requirements: studies

### 7.1 Creating and keeping studies

- **FR-STU-001** (SA1, M) A part document holds zero or more studies (`PartDoc.studies`); SA3 adds `AsmDoc.studies`. A study is saved with the document, undone and redone with it, and travels with it into the vault.
- **FR-STU-002** (SA1, M) New study ▸ **Static** (SA1), **Modal** (SA2); later kinds appear in their phases. A new study gets a name ("Static 1") and copies nothing from other studies unless created by **Duplicate study**.
- **FR-STU-003** (SA1, M) Rename, duplicate, delete a study; the active study is remembered per document.
- **FR-STU-004** (SA1, M) A study analyses the shown, non-suppressed bodies of the active configuration at the end of the history (rollback ignored). The study states which configuration it uses; changing the configuration marks results out of date.
- **FR-STU-005** (SA2, M) Multibody parts: every solid body is included by default; bodies may be excluded. Touching bodies are bonded by default (the connection engine of section 11, inside one part).
- **FR-STU-006** (SA1, M) Surface (sheet) bodies are left out with a note in SA1–SA4 (no shell formulation).

### 7.2 Associativity

- **FR-STU-020** (SA1, M) Supports, loads, probes and connections refer to faces, edges and vertices by their persistent names (`FaceRef`/`EdgeRef`/`VertexRef`), as features and mates do. After an edit they are resolved again (including the re-find of 1.586.0); a reference that cannot be resolved is marked **missing** in the study tree, the study does not solve until it is fixed or removed, and the panel offers to pick it again.
- **FR-STU-021** (SA1, M) Any change to the geometry, material, configuration or study set-up marks the results **out of date** (shown greyed with a banner and a Solve again button). Out-of-date results stay viewable.
- **FR-STU-022** (SA1, S) **Solve on change** option per study: after each rebuild the study re-solves in the background with the first pass only, then continues.
- **FR-STU-023** (SA2, S) **Compare**: two studies, or the current result and the last one before an edit, side by side or as a table of peak values (max displacement, max von Mises, min safety factor, first frequencies).

---

## 8. Functional requirements: materials, supports and loads

### 8.1 Materials

- **FR-SMAT-001** (SA1, M) Each body's analysis material is its body material, else the part material (`PartDoc.material`, `bodies[key].material`), with E, ν, density, yield and tensile strength from `materials.ts`.
- **FR-SMAT-002** (SA1, M) A body with no material, or with no E or ν, blocks the solve with "Set a material with Young's modulus and Poisson's ratio for <body>" and a button to the material picker.
- **FR-SMAT-003** (SA1, S) A study may override the material of a body (study-only, not written into the part). Custom materials from My materials are allowed.
- **FR-SMAT-004** (SA1, M) Values from library rows marked as typical (not standard minimums) are labelled so in the study and in the report, as the material dialog does today.
- **FR-SMAT-005** (SA5, C) Orthotropic and temperature-dependent properties.

### 8.2 Supports

| ID | Phase | Pri | Support | Picks | Behaviour |
| --- | --- | --- | --- | --- | --- |
| FR-SUP-001 | SA1 | M | **Fixed** | faces, edges, vertices | All translations zero. |
| FR-SUP-002 | SA1 | M | **Sliding** | flat or curved faces | Zero displacement along the face normal, free in the tangent plane. |
| FR-SUP-003 | SA1 | M | **Hinge** | cylindrical faces | Radial and axial displacement zero, free rotation about the axis (optionally axial free). |
| FR-SUP-004 | SA1 | S | **Fixed in directions** | faces, edges, vertices | Any of X/Y/Z (in a chosen coordinate system) fixed. |
| FR-SUP-005 | SA2 | M | **Elastic support** | faces | Normal and tangential stiffness per area (N/mm³). |
| FR-SUP-006 | SA2 | M | **Enforced displacement** | faces, edges, vertices | Given displacement per direction. |
| FR-SUP-007 | SA2 | S | **Inertia relief** | (study option) | Unsupported static model held by its own inertia; replaces supports. |
| FR-SUP-008 | SA3 | S | **Symmetry** | flat faces | Sliding on a symmetry plane, with a note in the report. |

- **FR-SUP-010** (SA1, M) Before solving, the model is checked for rigid-body motion: each connected group of bodies must be held in all six directions (static). A free group stops the solve with a message naming it and suggesting a support (or inertia relief, SA2).
- **FR-SUP-011** (SA1, M) Supports are drawn on the model with their own glyphs (fixed: hatched triangles; sliding: rollers; hinge: a pin), sized to the view.

### 8.3 Loads

| ID | Phase | Pri | Load | Picks | Values |
| --- | --- | --- | --- | --- | --- |
| FR-LOAD-001 | SA1 | M | **Force** | faces, edges, vertices | Total force, direction by normal, edge, face, axis or X/Y/Z components in a coordinate system; spread uniformly over the picks (total, not per item, with a "per item" option). |
| FR-LOAD-002 | SA1 | M | **Pressure** | faces | Uniform pressure normal to each face (MPa, bar, psi); sign convention shown by arrows. |
| FR-LOAD-003 | SA1 | M | **Gravity** | (model) | Acceleration vector, default 9 806.65 mm/s² along −Z or "down" of the view's up direction. |
| FR-LOAD-004 | SA1 | M | **Moment** | faces | Moment vector about the faces' centroid, as a linear traction distribution. |
| FR-LOAD-005 | SA2 | M | **Bearing load** | cylindrical faces | Force in the plane square to the axis, distributed sinusoidally over the loaded half. |
| FR-LOAD-006 | SA2 | M | **Remote load** | faces + a point | Force and moment at a point (picked or typed), passed to the faces rigidly or as a distributed coupling. |
| FR-LOAD-007 | SA2 | S | **Centrifugal** | axis | Angular velocity (rpm) and acceleration. |
| FR-LOAD-008 | SA2 | S | **Hydrostatic pressure** | faces | Pressure rising with depth from a fluid level and density. |
| FR-LOAD-009 | SA2 | S | **Torque** | cylindrical faces | Moment about the axis as tangential traction. |
| FR-LOAD-010 | SA3 | M | **Bolt preload** | bolt connection | Axial force or torque with a nut factor. |
| FR-LOAD-011 | SA5 | M | **Temperature** | bodies / from thermal study | Uniform or solved temperature field for thermal stress. |

- **FR-LOAD-020** (SA1, M) Loads are drawn as arrows on the picked items (spread arrows for pressures and distributed forces), scaled to the view, with a value callout.
- **FR-LOAD-021** (SA1, M) Values accept expressions and units like feature inputs (`expr.ts`), and may use global variables (`PartDoc.vars`), so a load can be driven by an equation.
- **FR-LOAD-022** (SA2, S) Load cases: several sets of loads in one static study solved together (one factorisation, several right-hand sides), with results per case and an envelope (max over cases).
- **FR-LOAD-023** (SA2, C) Partial face loads: a load on a region of a face bounded by a split line (the modeller's Split Line feature makes the region).

---

## 9. Functional requirements: solving

### 9.1 What the user sees

- **FR-SOL-001** (SA1, M) There is no mesh setting, no element type and no mesh display. The only settings are those in FR-SOL-010 and FR-SOL-012.
- **FR-SOL-002** (SA1, M) Solve runs in the background; the model stays usable (rotate, probe old results). Progress shows the pass, its share and the elapsed time in the study tree and the status bar, with Cancel.
- **FR-SOL-003** (SA1, M) Small geometry features (fillets, small holes, engraved text, cosmetic threads ignored as geometry) need no removal; the approximation resolves them where they matter for stress.

### 9.2 Adaptive passes

- **FR-SOL-010** (SA1, M) Solution settings: **Passes** (default 3, range 1–8), **Adaptation** Global / Global + local, and **Convergence** target in % (default 2 % on strain energy and 5 % on peak von Mises away from singularities). Solving stops at the target or the pass limit, whichever comes first.
- **FR-SOL-011** (SA1, M) Pass 1: cells sized from the body box, the smallest feature size and the wall thickness, degree p = 1 (p = 2 in thin regions). Each further pass refines where the error estimate is largest: raises p in cells where the solution is smooth, splits cells near concentrations, re-entrant edges, small features and load or support boundaries.
- **FR-SOL-012** (SA2, M) **Local refinement**: the user picks faces or bodies and a level (1–3); cells touching them start finer and keep a lower error target.
- **FR-SOL-013** (SA1, M) Thin-wall handling of FR-SARC-014 is automatic; a study option **Thin walls** (on by default) can turn it off for speed on solid parts.
- **FR-SOL-014** (SA1, M) Error estimate per cell: residual of equilibrium in the cell, jumps of traction across cell faces and on loaded or free faces, weighted to energy norm. Its global value is shown per pass (FR-RES-040).
- **FR-SOL-015** (SA1, M) **Singularity detection**: a point whose stress keeps growing with refinement (by more than 8 % in each of the last two passes and 25 % over both) while the energy has converged is marked as a likely singularity (sharp re-entrant edge, point load, edge of a fixed face). The peak-stress convergence check ignores it, and the results mark it (FR-RES-012).

### 9.3 Errors and limits

- **FR-SOL-020** (SA1, M) Before solving, the expected DOF and memory are estimated. Over the budget (NFR-SIM-005), the user is told and offered fewer passes, global adaptation only, or excluding bodies.
- **FR-SOL-021** (SA1, M) Error messages say what to do, in EN and RU, with codes (Appendix B): no material, free body, missing reference, load on nothing, out of memory, solver did not converge, worker stopped.
- **FR-SOL-022** (SA1, M) A crashed or out-of-memory worker is replaced; the study keeps its last good pass.

### 9.4 Reuse and caching

- **FR-SOL-030** (SA1, M) Cell geometry (cut cells, quadrature points and weights) is cached per body by its geometry signature, results per study state, in memory and in the disk cache (`buildCache.ts`, key = build id + body BREP + study JSON). Reopening a document shows the last results without solving again.
- **FR-SOL-031** (SA1, S) When only loads change, the factorisation or preconditioner is reused; when only some bodies or components change, the others keep their cells and matrices.
- **FR-SOL-032** (SA1, S) A new pass starts from the previous pass's solution projected onto the refined cells (warm start).

---

## 10. Functional requirements: results and reports

### 10.1 Static results

- **FR-RES-001** (SA1, M) Plots: **Displacement** (magnitude and X/Y/Z), **von Mises stress**, **Safety factor** (yield by default, tensile as an option; capped display, e.g. ≥ 10 shown as one colour), **Principal stresses** σ1/σ3 with directions (SA2: vectors), **Stress components** σxx…τzx in a chosen coordinate system (SA2), **Strain energy density** (SA2).
- **FR-RES-002** (SA1, M) Contours are drawn on the model's display mesh: results are evaluated at the display vertices from the cell fields, so they lie on the exact surface the user knows. Smooth or banded colours, legend with min/max and units, adjustable range (auto, typed, clip above/below).
- **FR-RES-003** (SA1, M) **Deformed shape**: scale Auto (max displacement shown as 5 % of the model size), True (1:1) or typed; undeformed outline shown faintly.
- **FR-RES-004** (SA1, M) **Maximum and minimum markers** with values, and a **hot spots** list (the N highest local maxima of von Mises, singularities flagged).
- **FR-RES-005** (SA1, M) **Probes**: click a point on the model to show the value there; probes are kept in the study, listed in a table with coordinates, exported as CSV, and followed after re-solving (stored by face name + position).
- **FR-RES-006** (SA1, M) **Reaction forces and moments** per support and in total, and the load balance check (Σ reactions + Σ loads = 0 within 0.1 % of the largest load).
- **FR-RES-007** (SA2, S) **Iso-clipping**: show only the regions above or below a value (e.g. safety factor < 2).
- **FR-RES-008** (SA3, M) **Connection forces**: per bolt (axial, shear, bending moment), per weld (force per length), per bonded contact (total force and moment).
- **FR-RES-012** (SA1, M) A peak at a detected singularity is drawn with a warning mark and the text "Stress singularity: value depends on refinement", and the hot-spot list shows the next real peak.

### 10.2 Modal results (SA2)

- **FR-RES-020** (SA2, M) Mode table: number, frequency (Hz), effective mass per direction (% of the total), cumulative effective mass. Free-free modes near 0 Hz are labelled as rigid-body modes.
- **FR-RES-021** (SA2, M) Mode shape plot (normalised displacement), animated (sine, adjustable speed and amplitude), recorded as GIF/WebM through the motion recorder.
- **FR-RES-022** (SA2, M) Settings: number of modes (default 6, up to 50) or a frequency range; free-free allowed (no rigid-body check).
- **FR-RES-023** (SA2, S) Warn when a mode's frequency is within 10 % of a typed excitation frequency (e.g. a motor speed in rpm).

### 10.3 Other views of results

- **FR-RES-030** (SA2, M) **Section results**: the existing section planes (`Section.ts`) show contours on the caps.
- **FR-RES-031** (SA2, S) **Plot along a path**: values along an edge or a line between two points, as a chart and CSV.
- **FR-RES-032** (SA1, M) Results in parts follow display states: hidden bodies are hidden in results; transparent bodies show contours too.
- **FR-RES-040** (SA1, M) **Convergence chart**: strain energy and peak von Mises (singularities excluded) per pass, with DOF and time per pass.

### 10.4 Reports

- **FR-REP-001** (SA1, M) **Report** (PDF, and HTML for viewing): document name and configuration, date, MöbiusCAD version, study kind and settings, bodies and materials with their source and basis (minimum/typical), supports and loads with values and images, connections (SA3), convergence chart, results images (displacement, von Mises, safety factor; modes for modal), min/max table, probes, reactions, assumptions and the statement of FR-RES-060.
- **FR-REP-002** (SA1, M) Report images are rendered offscreen from standard views plus the current view; text follows the UI language (like drawings), numbers in document units.
- **FR-REP-003** (SA1, S) Export result values at probe points and the hot spots as CSV; export the deformed shape as STL.
- **FR-RES-060** (SA1, M) Every report and the results panel state: "Linear elastic analysis with small displacements. Results are estimates for design and depend on the loads, supports and connections chosen. They do not replace a validated analysis where one is required."

---

## 11. Functional requirements: assemblies and connections

### 11.1 Model

- **FR-CON-001** (SA3, M) An assembly study includes the shown, non-suppressed components, expanded (patterns, sub-assemblies) as the kernel builds them; components may be **excluded** or made **rigid** (6-DOF body with its mass, no strain).
- **FR-CON-002** (SA3, M) Each component's material comes from its part (and body materials); the study may override it per component.

### 11.2 Automatic connections

- **FR-CON-003** (SA3, M) **Find connections**: pairs of faces of different components (or bodies of one part) that touch, overlap or face each other within a **gap tolerance** (default 0.1 mm, or 1 % of the smaller part size if larger, user-settable) are found from the placed exact shapes (`BRepExtrema_DistShapeShape` on boxes that meet, then the BVH for the contact patch). Imprecise CAD (small gaps, small overlaps, slightly misaligned faces) still connects.
- **FR-CON-004** (SA3, M) Found connections are listed in a **Connections** table: components, faces, type, area, gap; filter by component and type; select highlights the patch in two colours; change type for one or many.
- **FR-CON-005** (SA3, M) Default type **Bonded** (no relative motion over the patch). Coupling is weak (Nitsche/penalty) across the gap, so the two parts' cells need not match.
- **FR-CON-006** (SA3, M) **Sliding**: no separation, no penetration, free tangential motion (linear, frictionless).
- **FR-CON-007** (SA5, M) **Separating** (contact that can open) and **frictional** contact: non-linear, iterated.
- **FR-CON-008** (SA3, S) Mates guide defaults: a concentric + coincident pair on a fastener hole proposes a bolt (FR-CON-020); a hinge mate proposes a hinge connection (sliding on the cylinder); other mates leave contacts bonded.

### 11.3 Bolts, welds and connectors

- **FR-CON-020** (SA3, M) **Bolts**: toolbox fasteners (`fasteners.ts`) inserted in holes are found as bolts (size, length, head and nut faces); a bolt can also be defined on a hole pair through two components with a size. A bolt is modelled as an elastic beam between head and nut contact rings, with optional preload (FR-LOAD-010); the fastener part itself is excluded from the solid analysis. Thread engagement can replace the nut for tapped holes.
- **FR-CON-021** (SA3, M) Bolt results: axial force, shear, bending moment, and the safety factor against the property class's proof stress (8.8, 10.9, 12.9; A2-70; a table in `fasteners.ts`).
- **FR-CON-022** (SA3, M) **Welds**: weldment bead features (fillet beads, both sides, intermittent) are taken as weld connections along their root edges with their leg size; welds can also be added on picked edges with a throat size. Results: force per length and throat stress.
- **FR-CON-023** (SA3, M) **Rigid connector** and **elastic connector** (spring with stiffness per direction) between picked faces/points, and **point mass** on faces (added mass for static gravity and modal).
- **FR-CON-024** (SA3, S) **Spot welds** at picked points with a diameter.
- **FR-CON-025** (SA3, S) **Adhesive layer**: bonded with a thin elastic layer (thickness, E).

### 11.4 Assembly results

- **FR-CON-030** (SA3, M) All result plots of section 10 work across components; a component can be shown alone; per-component min/max table.
- **FR-CON-031** (SA3, M) Exploded view and display states apply to results (contours on exploded components).

---

## 12. Functional requirements: user interface

- **FR-SUI-001** (SA1, M) A **Simulation** tab in the command bar (part and assembly tab sets): New study ▾, Supports ▾, Loads ▾, Connections ▾ (assemblies, multibody parts), Settings, Solve, Results ▾, Probe, Report. It follows the command bar rules (one place for each command).
- **FR-SUI-002** (SA1, M) A **Studies** side tab beside Features (parts) and Assembly (assemblies) holds the study tree: Study ▸ Model (bodies or components with materials), Connections, Supports, Loads, Solution, Results (plots, probes, modes). Rows have the tree's habits: rename (F2), right-click menu, suppress (an item that is suppressed is left out of the solve), delete, hover highlight on the model.
- **FR-SUI-003** (SA1, M) Each support, load and connection is edited in a property panel with ✓/✕ in the head (`.pm-head.pm-top`), the viewport corner ✓/✕, colour-coded selection boxes and live glyph previews, like feature panels.
- **FR-SUI-004** (SA1, M) A study can be opened while the Features tab is in use; switching to the Features tab hides result colours and shows the plain model; returning shows them again.
- **FR-SUI-005** (SA1, M) Result legend in the viewport (left edge), vertical, with the plot name, units, min/max and an edit button for the range; it does not cover the nav cube or the heads-up bar.
- **FR-SUI-006** (SA1, M) Keyboard: Solve = Ctrl+Enter in a study; probes by click while the Probe tool is on; Esc ends tools. Shortcut customisation (`shortcuts.ts`) covers the simulation commands.
- **FR-SUI-007** (SA1, M) EN and RU text for everything; axe-core and layout checks in the smoke test cover the tab, tree, panels, legend and report dialog in light and dark themes.
- **FR-SUI-008** (SA1, S) First-use tips (`hints.ts`) for New study, the first support and the first solve; Help gets a Simulation section in both languages.
- **FR-SUI-009** (SA1, S) Phones and folded panels: results and mode animations can be viewed; set-up commands are hidden with a note.

---

## 13. Non-functional requirements

### 13.1 Performance (reference desktop i7-4770, Chrome, converged = default settings)

- **NFR-SIM-001** (SA1, M) Opening a model or part is not slower; simulation code is loaded only when the Simulation tab or a study is opened.
- **NFR-SIM-002** (SA1, M) SA1 bracket (AT-SA1-1, about 30 faces): first pass results within **5 s**, converged within **30 s**. A part of about 300 faces: first pass within 20 s, converged within **2 min**.
- **NFR-SIM-003** (SA3, M) Assembly of 20 parts with 50 connections: connections found within 10 s, converged static within **5 min**. (Hundreds of parts: SA5 target.)
- **NFR-SIM-004** (SA2, M) Modal, 10 modes: at most 2× the static time on the same part.
- **NFR-SIM-005** (SA1, M) Memory: at most 1.5 GB per worker; the solve refuses or scales down beyond the estimate (FR-SOL-020).
- **NFR-SIM-006** (SA1, S) Re-solving after a load change only: within 30 % of the first solve's time.

### 13.2 Accuracy

- **NFR-SIM-020** (SA1, M) On the benchmark set (section 16.3), after convergence: displacements within **3 %**, peak stresses away from singularities within **5 %**, reactions within **0.1 %** of the applied loads.
- **NFR-SIM-021** (SA0, M) Quadrature volume within 1e-4 of the exact volume for every benchmark part and the Leuenberger engine parts.
- **NFR-SIM-022** (SA1, M) Validation against an open-source FEA solver (CalculiX, run offline on the desktop, not shipped) on three real parts from the project files; results within the NFR-SIM-020 margins. The comparison is kept in `docs/`.
- **NFR-SIM-023** (SA2, M) Modal frequencies within **2 %** of the benchmark values.

### 13.3 Other

- **NFR-SIM-030** (SA1, M) Reuse of the modules in section 3; no second kernel, no second material list.
- **NFR-SIM-031** (SA1, M) Unit tests for the basis, quadrature, assembly, solvers and the error estimate run in node; smoke checks for study set-up, solving a small case and the results UI run in the packaged build (`?nocache` where needed).
- **NFR-SIM-032** (SA1, M) Determinism: the same document and settings give the same results to 1e-9 relative (no random seeds, fixed reduction order).
- **NFR-SIM-033** (SA1, M) Licences: only free libraries under MIT/BSD/Apache-2.0 (LGPL only as a separate replaceable WASM); credits added to the About tab through `credits.json`.
- **NFR-SIM-034** (SA1, M) Privacy: no telemetry; nothing leaves the browser (C-1).

---

## 14. Open decisions

| ID | Decision | Options | Recommendation |
| --- | --- | --- | --- |
| D-S1 | Approximation method | Cells + high-order polynomials with weak coupling (finite cell idea, section 6.2) / hidden tetrahedral p-mesh from an LGPL mesher in WASM / own reconstruction of external approximations | Cells, decided by the SA0 spike against NFR-SIM-002/020 |
| D-S2 | Numerical core language | TypeScript only / TypeScript + Rust WASM / TypeScript + C (Emscripten) | TypeScript first, WASM for hot loops if ≥ 2× faster |
| D-S3 | Where studies live | In the part/assembly document (like motion studies) / separate `.mcadsim` file | In the document; results in the cache only |
| D-S4 | Results persistence | Cache only (re-solve when missing) / saved results file beside the document | Cache only in SA1; a "Save results" option later if asked |
| D-S5 | Default passes and targets | 3 passes, 2 % energy, 5 % stress / more passes | 3 passes; revisit after the benchmarks |
| D-S6 | Safety factor basis | Yield / tensile / user choice | Yield by default, tensile selectable |
| D-S7 | Phase order | Static part → modal part → static asm → modal asm (as in section 5) / static part → static asm → modal both | As in section 5 (Andrey's order: parts first, static first, then modal) |

---

## 15. Data model

### 15.1 Study (schema sketch)

```ts
interface Study {
  id: string;                    // "st1"
  name: string;                  // "Static 1"
  kind: "static" | "modal";     // SA5: "buckling" | "thermal" | "thermostress"
  config?: string;               // configuration analysed (absent = active)
  bodies?: { key: string; off?: boolean; rigid?: boolean; mat?: MatRef }[]; // part bodies or asm components
  supports: Support[];           // { id, type: "fixed"|"sliding"|"hinge"|"dirs"|"elastic"|"enforced"|"symmetry", refs: GeoRef[], ... }
  loads: Load[];                 // { id, type: "force"|"pressure"|"gravity"|"moment"|"bearing"|"remote"|..., refs, value: Num, dir?, csys?, case? }
  connections?: Connection[];    // SA3: { id, type: "bonded"|"sliding"|"bolt"|"weld"|"rigid"|"spring"|"mass", a, b, gap?, size?, preload? }
  refine?: { refs: GeoRef[]; level: 1 | 2 | 3 }[];
  settings: { passes: number; adapt: "global" | "local"; energyTol: number; stressTol: number; thin: boolean };
  modal?: { modes: number; fmin?: number; fmax?: number; excite?: number };
  probes?: { id: string; ref: GeoRef; p: [number, number, number] }[];
  plot?: { kind: string; scale?: number; range?: [number, number] }; // view state, not undone
  suppressed?: string[];         // ids of supports/loads/connections left out
}
```

`GeoRef` = the existing `FaceRef` / `EdgeRef` / `VertexRef`; in assemblies prefixed with the component id like mates. `Num` = the existing expression value (`{ v, expr? }`).

### 15.2 Results (cache only)

Per pass: cell list (octree keys, degrees), coefficients (`Float64Array`), error per cell, energy, peak values, reactions, timing. Display arrays (per display vertex: displacement 3, von Mises 1, principal 2) are recomputed from the coefficients when shown. Modal: frequencies, modal masses, coefficients per mode.

### 15.3 Migration

Documents without `studies` open as before. A document with studies opened and saved in an older MöbiusCAD should keep the `studies` field; SA1 checks whether `file.ts` carries unknown fields through and makes it do so if not.

---

## 16. Verification and acceptance

### 16.1 Test levels

- Unit tests (node): basis orthogonality, quadrature of polynomials on cut cells (exact to the degree), patch test (constant strain reproduced exactly), PCG/Cholesky/LOBPCG against small dense solves, error estimate monotonic under refinement.
- Benchmarks (node, `bench/`): section 16.3 cases with timings, run before each SA release.
- Smoke (packaged build, `inShard`): create a study, add support and load by real clicks, solve a small case, check the legend values and the report download.
- Human-style tests (`tests/human/`): a scenario per user-facing feature, screenshots in `gap-tests`.

### 16.2 Phase acceptance tests

**SA0 Spike**

- **AT-SA0-1** Spike report `docs/structural-spike.md`: method chosen (D-S1), DOF and time per pass for every benchmark, memory, accuracy table.
- **AT-SA0-2** Cantilever 200 × 20 × 20 mm, steel E 210 000 MPa, end force 1 000 N: tip deflection within 3 % of Timoshenko beam theory (FL³/3EI = 0.952 mm plus the shear term FL/κGA ≈ 0.007 mm).
- **AT-SA0-3** Quadrature volume within 1e-4 on all benchmark parts (NFR-SIM-021).
- **AT-SA0-4** The bracket of AT-SA1-1 converges within 60 s in the spike code (the SA1 target is 30 s).

**SA1 Part linear static**

- **AT-SA1-1** The modelling FRS bracket (100 × 60 × 20 mm block with a Ø10 hole, AT-P1-1..3), steel: fix one end face, 1 000 N on the other end down: Solve shows displacement and von Mises within NFR-SIM-002; reactions balance within 0.1 %.
- **AT-SA1-2** Plate with a hole (200 × 100 × 5 mm, Ø10 hole, tension 100 MPa on the ends, sliding supports for symmetry): peak σ near the hole within 5 % of the Heywood finite-width value.
- **AT-SA1-3** NAFEMS LE1 (elliptic membrane): σyy at point D = 92.7 MPa within 5 %.
- **AT-SA1-4** NAFEMS LE10 (thick plate under pressure): σyy at point D = −5.38 MPa within 5 %.
- **AT-SA1-5** Lamé thick cylinder (inner Ø100, outer Ø200, inner pressure 10 MPa): hoop stress at the bore 16.67 MPa within 3 %.
- **AT-SA1-6** Edit the bracket's hole diameter, rebuild: loads and supports stay on their faces, results are out of date, Solve again gives new results without any re-picking.
- **AT-SA1-7** A part with a sharp re-entrant corner: the corner is flagged as a singularity and the hot-spot list shows the next peak.
- **AT-SA1-8** Report PDF opens, in EN and in RU, with images, tables and the FR-RES-060 statement.

**SA2 Part modal**

- **AT-SA2-1** Cantilever 500 × 20 × 10 mm steel: first bending frequency within 2 % of (1.875²/2π)·√(EI/(ρAL⁴)).
- **AT-SA2-2** Free-free beam: six rigid-body modes near 0 Hz, first flexible mode within 2 % of 4.730² theory.
- **AT-SA2-3** NAFEMS FV benchmark (a free square plate or a cantilevered thin plate from the FV set): first five frequencies within 2 %.
- **AT-SA2-4** Sum of effective masses of 30 modes of a supported part ≥ 90 % in the main direction; total mass equals the mass properties' mass within 0.1 %.
- **AT-SA2-5** Two-body part (bonded) gives the same static and modal results as the same shape as one body, within 2 %.
- **AT-SA2-6** Mode animation records a GIF.

**SA3 Assembly linear static**

- **AT-SA3-1** Two plates overlapping 50 mm, modelled with a 0.05 mm gap, bonded: tension result equal to a one-piece plate within 3 %.
- **AT-SA3-2** The same plates joined by one M10 toolbox bolt with 20 kN preload: bolt axial force ≈ preload + share of the load; joint does not move apart.
- **AT-SA3-3** Weldment frame with fillet beads: welds found from the beads, weld force per length reported.
- **AT-SA3-4** Sliding contact of a block on a plane carries normal load only.
- **AT-SA3-5** Find connections on the Leuenberger engine assembly lists the expected pairs within NFR-SIM-003.
- **AT-SA3-6** A rigid component and an excluded component behave as specified.
- **AT-SA3-7** Assembly report lists connections and bolt/weld results.

**SA4 Assembly modal**

- **AT-SA4-1** Two bonded plates: frequencies match the one-piece plate within 2 %.
- **AT-SA4-2** A point mass on a cantilever: first frequency within 2 % of the beam + tip mass formula.
- **AT-SA4-3** Compare two assembly designs in the study comparison table.

### 16.3 Benchmark set

| Case | Quantity | Reference |
| --- | --- | --- |
| Cantilever (static) | tip deflection | Timoshenko beam |
| Plate with hole | peak stress | Heywood / Peterson Kt |
| NAFEMS LE1 | σyy at D | 92.7 MPa |
| NAFEMS LE10 | σyy at D | −5.38 MPa |
| Lamé cylinder | hoop stress at bore | p(b² + a²)/(b² − a²) |
| Cantilever (modal) | f1..f3 | Euler–Bernoulli |
| Free-free beam | f1 | 4.730² theory |
| NAFEMS FV plate | f1..f5 | NAFEMS FV values |
| Three project parts | displacement, peak stress | CalculiX offline (NFR-SIM-022) |

---

## 17. Risks

| ID | Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- | --- |
| R-S1 | Cut-cell quadrature too slow in WASM (millions of point classifications) | High | High | BVH of the fine tessellation first, exact classifier only near the boundary; cache cut cells per body; moment fitting alternative; parallel helpers |
| R-S2 | Ill-conditioning from tiny cut cells (a cell with a sliver of material) | High | Medium | Legendre basis, cell merging into a neighbour, small stabilisation stiffness on the empty part (finite cell α ≈ 1e-8 E) |
| R-S3 | Thin walls and sheet metal stiffen (locking) | Medium | High | p ≥ 2 across thickness, anisotropic cells, benchmark LE10 and a thin plate early in SA0 |
| R-S4 | DOF too large for the browser on big parts or assemblies | Medium | High | Estimate before solving, p-adaptivity before h, per-component reuse, memory budget, scaled-down offers |
| R-S5 | Users trust singular peaks or unrealistic supports | High | Medium | Singularity detection, hot-spot list, FR-RES-060 statement, Help on supports |
| R-S6 | Contact detection misses or over-connects parts in imprecise assemblies | Medium | Medium | Tolerance setting, connection table with highlight, type changes in bulk |
| R-S7 | Effort larger than planned (a solver is a big piece of work) | Medium | Medium | SA0 spike with go/no-go numbers; parts static first; later phases only after SA1 is used |
| R-S8 | Validation tool licences (CalculiX GPL) | Low | Low | Used offline on the desktop only, never shipped (C-2) |

---

## 18. Appendices

### Appendix A. Command map (Simulation tab)

| Group | Commands | Phase |
| --- | --- | --- |
| Study | New study ▾ (Static, Modal), Duplicate, Settings, Solve, Cancel | SA1, SA2 |
| Supports | Fixed, Sliding, Hinge, Fixed in directions, Elastic, Enforced displacement, Symmetry | SA1–SA3 |
| Loads | Force, Pressure, Gravity, Moment, Bearing, Remote, Torque, Centrifugal, Hydrostatic, Load cases | SA1–SA2 |
| Connections | Find connections, Bonded, Sliding, Bolt, Weld, Rigid, Spring, Point mass | SA3 |
| Results | Displacement, Von Mises, Safety factor, Principal, Components, Reactions, Modes, Probe, Hot spots, Iso-clip, Section, Compare | SA1–SA3 |
| Output | Report, CSV, Deformed STL, Record animation | SA1–SA2 |

### Appendix B. Error codes

| Code | Message |
| --- | --- |
| E-SIM-NOMAT | Set a material with Young's modulus and Poisson's ratio for {body}. |
| E-SIM-FREE | {bodies} can move freely. Add a support or a connection. |
| E-SIM-REF | {item} lost its face after the last change. Pick it again. |
| E-SIM-EMPTY | {item} has nothing picked. |
| E-SIM-MEM | The study needs about {gb} GB, more than this browser allows. Use fewer passes or exclude bodies. |
| E-SIM-DIVERGE | The solution did not converge. Check supports and connections. |
| E-SIM-STOPPED | The solver stopped. The last finished pass is shown. |
| E-SIM-SHEET | Surface bodies are not analysed and were left out. |

### Appendix C. Mapping to existing code (for implementers)

| Need | Existing piece |
| --- | --- |
| Exact body of a part | `ModelKernel` worker's last `Rebuild` body (`Modeller.evaluate`) |
| Placed shapes of an assembly | `Assembler` placed shapes (as used by `asmInterfere`, `asmSnap`) |
| Inside test | `memo.ts` `stateAt`; three-mesh-bvh on the fine tessellation |
| Tight box | `memo.ts` `optimalBox` |
| Exact volume / centre / inertia | `memo.ts` `massOf`, `inertia.ts` |
| Face points and normals | `BRepAdaptor_Surface`, `GeomAPI_ProjectPointOnSurf`, `BRepLProp_SLProps` (as in weld beads' `normalAt`) |
| Wall thickness | `surfaceAnalysis.ts` `thickness`, sheet metal `SheetState` T |
| Contact pairs | `Assembler.clearance` / `interference` pattern, `BRepExtrema_DistShapeShape` |
| Bolts | `fasteners.ts` `FASTENERS`, `fastenHole`, auto mates |
| Welds | weld bead faces `<id>:b<k>:leg1|leg2|face`, `cutList` beads |
| Colours on the model | `Analysis.ts` `SurfaceAnalysis` |
| Animation recording | `motion/manager.ts` recorders, `gif.ts` |
| Report PDF | `exporters.ts` jsPDF + DejaVu Sans |
