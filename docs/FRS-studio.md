# Möbius Studio: Functional Requirements Specification (ECAD ↔ MCAD)

| | |
| --- | --- |
| Document | FRS-STUDIO, Functional Requirements Specification for one engineering studio built from Tube Amp CAD (electronics) and MöbiusCAD (mechanics) |
| Version | 0.1 (first draft for review) |
| Date | 2026-11-10 |
| Owner | Andrey Dumchin |
| Product baseline | MöbiusCAD 1.459.0 (`kothf/step-viewer`), Tube Amp CAD 3.187.1 (`kothf/tube-amp-cad`) |
| Status | Draft. Open decisions are listed in section 21. |

---

## Contents

1. [Introduction](#1-introduction)
2. [Baseline: what the two apps already have](#2-baseline-what-the-two-apps-already-have)
3. [Reference products](#3-reference-products)
4. [Product overview](#4-product-overview)
5. [Phases and release plan](#5-phases-and-release-plan)
6. [Architecture](#6-architecture)
7. [The Board Model](#7-the-board-model)
8. [Link protocol](#8-link-protocol)
9. [Studio shell and project](#9-studio-shell-and-project)
10. [Electronics to mechanics](#10-electronics-to-mechanics)
11. [Mechanics to electronics](#11-mechanics-to-electronics)
12. [Enclosures and chassis](#12-enclosures-and-chassis)
13. [Cross-domain checks](#13-cross-domain-checks)
14. [Outputs: BOM, drawings, manufacturing, release](#14-outputs-bom-drawings-manufacturing-release)
15. [Interoperability](#15-interoperability)
16. [User interface](#16-user-interface)
17. [Non-functional requirements](#17-non-functional-requirements)
18. [Data model](#18-data-model)
19. [Verification and acceptance](#19-verification-and-acceptance)
20. [Risks](#20-risks)
21. [Open decisions](#21-open-decisions)
22. [Appendices](#22-appendices)

---

## 1. Introduction

### 1.1 Purpose

This document specifies what has to be built so that an engineer can design a piece of electronics and its mechanics in one browser studio: the circuit, its simulation, the printed circuit board, the parts that live off the board, and the box or chassis around it. The electrical and the mechanical side must keep each other up to date ("talk to each other"), so a change on one side shows up on the other without exporting and importing files.

It is the reference for design, implementation, testing and acceptance of the studio work in both repositories. It does not prescribe code structure beyond the architecture constraints in section 6.

### 1.2 Decisions this FRS starts from

Taken with Andrey on 2026-11-10:

- **Connect, don't merge or rewrite.** Tube Amp CAD (plain JavaScript, classic scripts, no build step, ~39k lines) and MöbiusCAD (TypeScript + Vite, Three.js, OpenCASCADE in WASM) stay separate codebases with their own tests and releases. They are joined by a shared data model and a message protocol. A rewrite of either (or of both in C++) is rejected: the heavy computation already runs as compiled code (OCCT, `sim-solver.wasm`, `parasolid.wasm`) and a rewrite would stall both products for years.
- **MöbiusCAD is the host.** The studio is MöbiusCAD's application shell. Tube Amp CAD runs inside it as a document kind, unchanged in how it is built, and still ships on its own.
- **The link is the product.** The distinguishing value is a reliable two-way link between board and enclosure, with simulation data (voltages, currents, dissipation) feeding mechanical checks. Becoming a general-purpose ECAD tool is not a goal of this FRS (section 1.3).

### 1.3 Scope

In scope:

- A studio shell in which schematic/simulation, board layout, parts, assemblies and drawings are documents of one project (section 9).
- A neutral **Board Model** (section 7): the board's mechanical description (outline, cut-outs, thickness, holes, component bodies, connectors, keep-outs, height zones) that both sides read and write.
- A **link protocol** (section 8) between the two apps: live updates, change proposals, selection and identity.
- Board → mechanics: the board as a live assembly component with exact geometry (section 10).
- Mechanics → board: outline, holes, cut-outs, keep-outs and panel-part positions driven from the mechanical model (section 11).
- Enclosure and chassis generation from the board, including chassis-built valve amplifiers where most parts are not on a PCB (section 12).
- Checks that need both domains: interference, heights, high-voltage clearance to a metal enclosure, heat, grounding, access to connectors (section 13).
- One BOM, drawings, a whole-product STEP and a release package for the project (section 14).
- Exchange with other tools: IDX (EDMD), IDF 3.0, KiCad boards, Gerber-derived boards (section 15).

Out of scope (may get their own documents later):

- General-purpose schematic capture beyond what Tube Amp CAD covers today (digital logic families, hierarchical multi-board systems, high-speed constraints, more than two copper layers). The studio must not block them, but does not specify them.
- Cable and harness design beyond lead lengths (FR-ENC-030 is a *could*).
- FEA/thermal simulation with a solver; section 13 uses rules and estimates only.
- Server-side collaboration. The studio stays client-side (MöbiusCAD FRS P7 governs any server work).

### 1.4 Definitions and abbreviations

| Term | Meaning |
| --- | --- |
| ECAD | Electronic CAD: schematic, simulation, board layout. Here: Tube Amp CAD. |
| MCAD | Mechanical CAD: parts, assemblies, drawings. Here: MöbiusCAD. |
| TAC | Tube Amp CAD (repository `kothf/tube-amp-cad`). |
| MCD | MöbiusCAD (repository `kothf/step-viewer`). |
| Studio | The combined product (working name "Möbius Studio", decision D-1). |
| Board Model (BM) | The neutral mechanical description of a board, section 7. |
| Board-mounted part | A part whose footprint is on the PCB. |
| Panel part | A board-mounted or chassis part that must line up with a hole in the enclosure (jack, pot shaft, switch, LED, connector, fuse holder). |
| Chassis part | A part mounted on the enclosure, wired to the board or point to point (mains transformer, output transformer, choke, chassis tube socket, TO-3 on a heatsink, IEC inlet). |
| Proposal | A set of changes one side offers the other, accepted or rejected as a whole or per item (section 8.4). |
| Owner | The side allowed to change a BM item without a proposal (section 4.3). |
| EDMD / IDX | ProSTEP iViP ECAD/MCAD collaboration schema and its XML exchange format. |
| IDF | Intermediate Data Format 3.0 (`.emn` board, `.emp` library). |
| HV | High voltage: nets above the board's `rules.hvVolts` (60 V default) in the simulation. |
| Creepage / clearance | Distance over a surface / through air between conductors, or between a conductor and the enclosure. |

Other terms as in `docs/FRS-modelling.md` section 1.4.

### 1.5 Requirement notation

- **ID**: `FR-<area>-<nnn>` functional, `NFR-<area>-<nnn>` non-functional. Areas: ARC (architecture), BM (board model), LNK (link protocol), SHL (shell), PRJ (project and files), E2M (electronics → mechanics), M2E (mechanics → electronics), ENC (enclosure and chassis), XCK (cross-domain checks), OUT (outputs), IO (interoperability), UI, PERF, REL, SEC, I18N, A11Y, TST.
- **Priority**: **M** must, **S** should, **C** could.
- **Phase**: S0 to S5, section 5.
- **Repo tag**: `[TAC]`, `[MCD]` or `[both]` names where the work lands. A requirement without a tag lands in MöbiusCAD.

"Shall" is binding, "should" a recommendation, "may" an option. Lengths are millimetres and angles radians in data; display follows each app's unit settings.

### 1.6 Related documents

- `docs/FRS-modelling.md` (MöbiusCAD modelling, phases P0–P7), `CLAUDE.md` (code map).
- Tube Amp CAD: `README.md` (Board Design section), `docs/ARCHITECTURE.md` (the `BOARD_*` messages, `board-core.js`, `board-3d.js`).
- aerocat.tech `vendor.json` (both apps are deployed there, see 2.3).

---

## 2. Baseline: what the two apps already have

### 2.1 Tube Amp CAD (3.187.1)

| Area | What exists | Relevance |
| --- | --- | --- |
| Schematic + simulation | MNA/Newton solver in JS and WASM, worker pool, DC/transient/AC/noise, ratings checks | DC voltages, currents and dissipation per part and net feed section 13 |
| Board document | `BoardCore.newBoard`: `units: "mm"`, `outline: { w, h, r }` (a rectangle with one corner radius), `stackup { layers: 2, thickness, copper }`, `rules` (incl. `maxHeight` "room under the lid"), `parts` keyed by schematic id `{ ref, fp, x, y, rot, side }`, `tracks`, `vias`, `holes { x, y, d, plated, pad, net }`, `texts`, `zones`, `keepouts { name, pts, layers, … }` | Source of most BM data. The outline is the main gap: no polygon, arcs or inner cut-outs |
| Coordinates | Board coordinates in mm, **y down**, origin at the outline's top left; construction geometry and dimensions use a user frame with **y up** from the bottom-left corner | BM uses the y-up frame (FR-BM-003) |
| Footprints and bodies | Footprint library with real lead spacing; `body { kind, l, d, w, h, lead }` per footprint, from part numbers (`mpn.js`) or set by hand (`bp.body`) | Gives component envelopes and heights |
| 3D | `board-3d.js` builds closed planar polyhedra for the board and every body and writes STEP AP214 with colours; `board-3d-view.js` shows them | A one-way, file-based path to MCAD exists already |
| Constraints | `board-construct.js` (construction geometry, tied holes), `board-dims.js` (driving dimensions between holes, parts, keep-outs, edges) | Lets MCAD-driven positions be held as constraints (FR-M2E-020) |
| Messages | CAD ↔ Board window over `BroadcastChannel("tube_cad_v2")` and frames: `BOARD_HELLO`, `BOARD_NETLIST`, `BOARD_SAVE`, `BOARD_SELECT`, `CAD_SELECT`; tool tabs as `iframe.tab-frame` | The pattern the studio link follows (section 8) |
| Files and storage | Circuit file is JSON (`.json`, "Tube Amp CAD circuit") holding the board as `board`; autosave in `localStorage`; recent files; **vaults** (3.187.0: revisions in folders on this computer) | Two vaults exist; FR-PRJ-030 joins them |
| Fabrication | Gerber RS-274X + X2, Excellon, ZIP, PDF prints, KiCad project export | MöbiusCAD reads these Gerbers already |
| Chassis parts | Transformers, chokes, pots, speakers, chassis sockets and TO-3 can get wire pads; `rules.socketHole` (hole for a valve socket) exists | The chassis-built workflow W3 (4.2) starts here |

### 2.2 MöbiusCAD (1.459.0)

| Area | What exists | Relevance |
| --- | --- | --- |
| Parts | Full parametric modeller (sketches, features, sheet metal, weldments, surfaces), persistent face names | Enclosures, chassis, brackets |
| Assemblies | Components, mates, sub-assemblies, interference/clearance (`Assembler.interference`, `clearance`), BOM, patterns, explodes, motion, fastener library (`src/asm/fasteners.ts`), vendor parts, in-context design (`src/model/context.ts`) | The board becomes a component (section 10) |
| Sheet metal | Base/edge/miter flanges, hems, cuts, forming tools, corner reliefs, flat pattern with DXF, bend tables | Valve amp chassis are bent sheet metal |
| Drawings | Associative drawings, sections, details, BOM tables, balloons, hole tables, GD&T, DXF/PDF/SVG | Panel drawings, assembly drawings |
| PCB view | `src/gerber/`: Gerber/Excellon parser, layer classification, 2D view, measuring, `Board3D.ts` (board solid with textured skins), `Kernel.boardStep` (STEP of a board body from outline loops and holes) | Exact board solid from loops already exists; Gerber → BM is a small step (FR-IO-030) |
| Documents | Document tabs (`src/docTabs.ts`), File menu, recent files in IndexedDB, Pack and Go, autosave journal | The studio shell builds on these |
| PDM | Local vault (`src/pdm/`): check-in/out, versions, revisions, workflow, where-used, release outputs | The project vault (FR-PRJ-030) |
| Offline | Service worker `sw.js` precaches the build | TAC files must be precached too (FR-ARC-012) |
| UI rules | Command bar tabs (FR-UI-119 of the modelling FRS: a new module adds a tab, never its own bar), EN/RU, axe-core checks | Studio UI follows them |

### 2.3 Deployment today

- aerocat.tech serves MöbiusCAD at `/tools/mobiuscad/` and Tube Amp CAD at `/tools/tube-curve-tracer/`, each pinned by version and SHA-256 in `vendor.json`.
- GitHub Pages serves them at `kothf.github.io/step-viewer/` and `kothf.github.io/tube-amp-cad/`.

In both places the two apps share one origin, so frames, `BroadcastChannel`, IndexedDB and OPFS are shared between them. The studio relies on this (FR-ARC-010) but must not depend on the other app's deployment path (FR-ARC-011).

### 2.4 Gaps the studio must close

1. TAC's board outline is a rounded rectangle only; enclosures need polygons, arcs, notches and inner cut-outs (FR-BM-010, `[TAC]`).
2. There is no neutral board description; STEP and Gerber are one-way, lose identity (which body is R3) and cannot carry changes back.
3. No stable identity across the two apps: TAC keys parts by schematic id, MCD names faces; nothing maps one to the other.
4. Two document systems, two vaults, two recent lists, two autosaves.
5. Simulation results (voltages, dissipation) never reach the mechanical side.
6. Chassis parts have no place in the mechanical model.

---

## 3. Reference products

These tools set users' expectations for ECAD/MCAD work. Names are trademarks of their owners, used only to describe functionality; the studio does not use their names, icons or wording.

| Product | How it links ECAD and MCAD | What the studio takes from it |
| --- | --- | --- |
| Autodesk Fusion (Electronics, formerly Eagle) | One application; the PCB is a 3D component in the design, the board outline can be driven from a sketch; push/pull between 2D and 3D | Board as a live component; outline from a mechanical sketch |
| Altium Designer + MCAD CoDesigner | Plug-ins on both sides exchange changes through a server; changes are proposed, reviewed and accepted per item | Proposal/accept model (section 8.4) without a server |
| SolidWorks PCB / CircuitWorks | IDF/IDX import and export, component libraries mapped to models, round trips | IDX/IDF interop (section 15), library mapping (FR-E2M-030) |
| KiCad + FreeCAD (KiCad StepUp) | Board and parts as STEP into FreeCAD, outline and keep-outs pushed back as sketches | Outline back from a mechanical sketch, part models by footprint |
| ProSTEP iViP EDMD / IDX | Neutral schema: items with identity, baseline + incremental change messages, accept/reject | The BM's item identity and change sets are modelled on EDMD so an IDX bridge is direct |

Lesson from all of them: the link fails when identity is lost (a part re-imported as a new body) or when one side silently overwrites the other. Sections 7.3 and 8.4 address both.

---

## 4. Product overview

### 4.1 Users

- Builders and designers of valve and audio amplifiers (TAC's current users), who need a chassis drilled and bent to fit the parts.
- Small-shop electronics engineers who design a board and its box.
- Mechanical engineers who receive a board and design around it.

### 4.2 Workflows

**W1. Board first.** Draw and simulate the circuit, lay out the board, then make the box: Studio offers "Enclosure from board" (FR-ENC-001), which places the board, sizes a box with clearances, adds standoffs at the mounting holes and cuts holes for the panel parts. Moving a jack on the board moves its hole in the box.

**W2. Box first.** Start from an existing enclosure (a STEP from a vendor, or a MöbiusCAD part). Sketch or pick the board outline and mounting holes inside it; the board document receives them as its outline and fixed holes; height zones under the lid limit part heights in the board's rule check.

**W3. Chassis-built valve amplifier.** Tubes, transformers, chokes, pots and jacks sit on a bent aluminium chassis; small parts are on a board or tag strip. The studio places chassis parts in the chassis assembly (with their real bodies), makes the sheet-metal chassis with socket, transformer and panel holes, keeps the schematic as the parts list, and reports lead lengths and HV clearances.

**W4. Change loop.** Either side changes something shared (outline, a hole, a connector's position, an enclosure wall). The other side sees a proposal with what changed and accepts or rejects it; accepted changes rebuild that side; rejected ones are marked as conflicts until resolved.

### 4.3 Ownership

Every BM item has an owner. The owner changes it directly; the other side can only propose a change (FR-LNK-030).

| Item | Default owner | Notes |
| --- | --- | --- |
| Parts, nets, copper, footprints, part placement on the board | ECAD | MCAD may propose positions of panel parts (FR-M2E-020) |
| Board outline, cut-outs, thickness | ECAD in W1, MCAD in W2 | Ownership can be handed over per item (FR-LNK-033) |
| Mounting holes | ECAD in W1, MCAD in W2 | Same |
| Keep-outs and height zones | MCAD when they come from the enclosure, ECAD otherwise | Each zone carries its source |
| Board placement in the product (its 3D transform) | MCAD | ECAD never moves the board in space |
| Enclosure, chassis, brackets, fasteners | MCAD | |
| Chassis part positions | MCAD | Their electrical identity (ref, type, nets) stays ECAD's |
| Component 3D bodies | ECAD envelope; MCAD may substitute a model (FR-E2M-030) | The envelope stays the reference for checks unless a model is chosen |

---

## 5. Phases and release plan

Each phase ships through the normal release flows of both repositories. A phase is done when its **M** requirements pass their acceptance tests (section 19). Both apps keep working on their own at every step.

| Phase | Name | Content | Exit |
| --- | --- | --- | --- |
| **S0** | Foundations | Board Model v1 schema and validator (shared package), TAC exporter/importer of BM, polygon outline and cut-outs in TAC, link protocol v1 (hello, versions, snapshot), TAC hosted as a document tab in MöbiusCAD, TAC vendored into the MöbiusCAD build | AT-S0-1..4 |
| **S1** | Board → mechanics | Board component in assemblies with exact geometry, part envelopes, persistent names for mates, live update on board change, cross-probing between schematic, board and 3D | AT-S1-1..4 |
| **S2** | Mechanics → board | Outline/holes/cut-outs from MCAD sketches and faces, keep-outs and height zones from the enclosure, panel-part positions, proposals with accept/reject in both apps, ownership hand-over | AT-S2-1..4 |
| **S3** | Enclosures and chassis | Enclosure from board, panel cut-outs from part data, standoffs and fasteners, sheet-metal chassis for valve amps, chassis parts placed in MCAD | AT-S3-1..4 |
| **S4** | Cross-domain checks and outputs | Height, interference, HV clearance to conductive walls, heat, grounding, connector access; unified BOM; studio project file and one vault; product STEP; drawings; release package | AT-S4-1..5 |
| **S5** | Interoperability | IDX import/export, IDF 3.0, KiCad board import, board from Gerber, vendor STEP models by part number | AT-S5-1..4 |

S0–S2 are the minimum product ("the link works both ways"). Indicative effort for one developer with AI assistance: S0 3–4 weeks, S1 3 weeks, S2 4 weeks, S3 5–6 weeks, S4 4–5 weeks, S5 4 weeks. Planning numbers only.

---

## 6. Architecture

### 6.1 Overview

```
 MöbiusCAD page (studio shell)                               Tube Amp CAD (framed document)
 ┌───────────────────────────────────────────────┐          ┌───────────────────────────────┐
 │ Document tabs, File menu, project, vault      │          │ cad-app.js  schematic + sim   │
 │ ModelController / AsmController / Drawings    │          │ board-app.js board layout     │
 │ StudioLink (src/studio/)                      │ postMsg  │ studio-link.js  (new)         │
 │  - BoardModel store per board (source copy)   │◀────────▶│  - BM export/import           │
 │  - proposals, identity map, selection         │  (port)  │  - proposals UI               │
 │ Kernel workers: board solid, enclosure, STEP  │          │ sim workers (unchanged)       │
 └───────────────────────────────────────────────┘          └───────────────────────────────┘
              ▲  shared package: board-model (schema, validator, transforms, diff)  ▲
              └──────────────── used by both, plain ES module + .d.ts ──────────────┘
```

### 6.2 Hosting

- **FR-ARC-001** (S0, M) The studio shell shall be MöbiusCAD's page. A TAC circuit opens as a document tab whose content is TAC's own page in an `iframe`, loaded from the TAC files shipped with the build (FR-ARC-011).
- **FR-ARC-002** (S0, M) `[TAC]` TAC shall keep working stand-alone (its own `index.html`, `circuit_sandbox.html`, `board.html`) with no studio present. Studio behaviour turns on only when its page is framed by a studio and the handshake succeeds (FR-LNK-001).
- **FR-ARC-003** (S0, M) `[TAC]` In a studio frame TAC shall hide what the shell provides (its own file menu entries for open/recent/vault, app header branding) through one switch, `studioMode`, and keep everything else. Its Board window opens as a second studio tab, not a browser window.
- **FR-ARC-004** (S0, S) The shell should keep a parked TAC tab alive (not reload it) while it is hidden, like parked part and assembly tabs, up to a memory limit (NFR-PERF-004); beyond it the tab is unloaded and reloaded from its saved state.

### 6.3 Packaging and deployment

- **FR-ARC-010** (S0, M) The studio shall rely on TAC and MCD being served from the same origin. Cross-origin hosting is not supported.
- **FR-ARC-011** (S0, M) MöbiusCAD's build shall include a pinned TAC release (version + SHA-256, same scheme as aerocat.tech's `vendor.json`) under `tac/`, installed by a script at build time, never copied into the repository by hand. The pin is updated by a PR, like the site's vendor updates.
- **FR-ARC-012** (S0, M) The service worker (`scripts/sw-plugin.mjs`) shall precache the TAC files, so the studio works offline including the schematic and simulation.
- **FR-ARC-013** (S0, S) `[TAC]` TAC's release shall publish a machine-readable `studio.json` (link protocol versions supported, BM versions read and written, entry pages), which the MCD build reads to refuse an incompatible pin.
- **FR-ARC-014** (S0, M) Both apps keep separate versions, changelogs and release workflows. A studio release is a MöbiusCAD release that names the TAC version it ships.

### 6.4 Shared code

- **FR-ARC-020** (S0, M) The Board Model schema, validator, unit/frame transforms and diff shall live in one shared module, `board-model`, written as a plain ES module with a `.d.ts` (TAC loads plain scripts; MCD imports TypeScript). One source, consumed by both builds; neither repository forks it.
- **FR-ARC-021** (S0, S) The shared module should live in MöbiusCAD (`src/studio/board-model/`) and be copied into TAC's release by its packaging script from a pinned MCD release, or live in its own small repository; decision D-3.
- **FR-ARC-022** (S0, M) The shared module shall have no DOM dependency and run in Node, so both repositories unit-test it (`npm run test:unit` in MCD, `node --test` in TAC).

### 6.5 Computation

- **FR-ARC-030** (S1, M) Exact board geometry (board solid, cut-outs, holes, envelopes) shall be built by MöbiusCAD's kernel workers from the BM, not taken from TAC's polyhedra. TAC's `board-3d.js` remains its own preview and STEP path when used stand-alone.
- **FR-ARC-031** (S4, M) Cross-domain checks (section 13) run in MöbiusCAD, which receives the simulation numbers it needs through the BM's `electrical` block (FR-BM-060). TAC never needs geometry from MCAD beyond the BM.

---

## 7. The Board Model

### 7.1 Principles

- **FR-BM-001** (S0, M) The BM is the only data the two sides exchange about a board. It is derived from TAC's board document and from MCAD's model; it is never the user's working document on either side.
- **FR-BM-002** (S0, M) The BM shall be JSON with `kind: "board-model"`, an integer `version` (starting at 1) and a validator that reports every problem with a path and an English message key (translated by each app).
- **FR-BM-003** (S0, M) Units are millimetres and radians. The board frame has **x right, y up, origin at the bottom-left corner of the outline's bounding box, z up out of the top (component) side; the board's bottom face is at z = 0**. Transforms between this frame and TAC's y-down frame are part of the shared module and unit-tested both ways.
- **FR-BM-004** (S0, M) Every item has a stable `id` that survives edits, renumbering and reordering on both sides (7.3).
- **FR-BM-005** (S0, M) The BM carries a `rev` counter and a content hash; a side can tell whether its copy is current without comparing the whole document.

### 7.2 Content

- **FR-BM-010** (S0, M) **Outline**: one outer loop and any number of inner cut-out loops, each a closed list of line and arc segments (arc = end point + centre + direction, or bulge). `[TAC]` TAC's board shall support such outlines (today `outline { w, h, r }` only): the existing rounded rectangle stays as a shortcut that produces a loop, the rule check, pours, edge clearance, Gerber edge cuts, 3D and KiCad export use the loops.
- **FR-BM-011** (S0, M) **Stack-up**: thickness (default 1.6), copper weight, layer count, solder-mask and silkscreen colours (for the 3D look).
- **FR-BM-012** (S0, M) **Holes**: mounting holes, non-plated holes, slots (two centres + width), each with diameter, plating, net (when plated), `fastener` hint (e.g. "M3") and `role` (`mount` | `tooling` | `other`). Component holes are not listed (they are inside the component).
- **FR-BM-013** (S0, M) **Components**: one entry per physical part (a dual triode's two sections share one socket entry): `id`, `ref` (designator), `type`, `value`, `mpn` (when known), `footprint`, `side` (top/bottom), placement (x, y, rotation), `body` envelope (FR-BM-014), `pins` (positions in the part frame, with pin names and nets), `mount` (`board` | `chassis` | `panel`), `heat` and `electrical` data (FR-BM-060), and an optional `model` reference (FR-E2M-030).
- **FR-BM-014** (S0, M) **Body envelope**: an extruded outline (polygon + height above the board), a cylinder (diameter, height, axis vertical or horizontal), or a list of such primitives, plus `lead` data for through-hole parts below the board (length beyond the bottom face). It is built from TAC's `body { kind, l, d, w, h, lead }`, standing resistors included. Envelopes are conservative: the real part fits inside.
- **FR-BM-015** (S0, M) **Panel features** on panel parts: the axis that must pierce a wall (point + direction in the part frame), the hole the wall needs (round, D-shaped with flat distance, rectangular with corner radius, or a named cut-out from a library), the nut/washer stack thickness and the panel thickness range the part accepts (e.g. a pot bushing takes 0–6 mm).
- **FR-BM-016** (S0, M) **Keep-outs** (from TAC `keepouts`): polygon, sides, what they forbid (parts, tracks, vias, pours), and `source` (`ecad` | `mcad`).
- **FR-BM-017** (S2, M) **Height zones**: polygon, side, maximum height above (or below) the board, `source`. A zone from the enclosure carries the face it came from. TAC's single `rules.maxHeight` is the fallback zone covering the whole board.
- **FR-BM-018** (S0, S) **Copper and silkscreen as images**: optional raster or path data for the 3D look (top/bottom copper, mask, silk). MöbiusCAD's `Board3D.ts` already composites such layers from Gerbers; the BM may carry them as a Gerber ZIP produced by TAC's `BoardFab`.
- **FR-BM-019** (S1, S) **Connectors to off-board items**: each wire pad or connector lists the off-board part it goes to (by component id) and the net, so lead lengths can be measured (FR-ENC-030).

### 7.3 Identity

- **FR-BM-020** (S0, M) Component ids are TAC's part keys (the schematic part ids, joined by "+" for shared packages), which already survive renumbering. Holes, keep-outs, zones and outline loops get UUID-like ids assigned by their creator and kept by both sides.
- **FR-BM-021** (S0, M) `[TAC]` TAC shall store BM ids on its own board items (`holes`, `keepouts`, outline loops) so a round trip keeps them.
- **FR-BM-022** (S1, M) MöbiusCAD face names of the board component shall be derived from BM ids (`board:top`, `board:bottom`, `board:edge:<loop id>:<segment k>`, `hole:<id>:wall`, `comp:<id>:body`, `comp:<id>:axis` …), so mates, drawings and features that reference them survive any board change that keeps the ids (the face-name contract of `CLAUDE.md`).
- **FR-BM-023** (S0, M) Deleting an item and creating a new one is never treated as a move. A side that rebuilds an item keeps its id.

### 7.4 Electrical and thermal data

- **FR-BM-060** (S0, M) `[TAC]` Each component carries what the mechanical checks need from the simulation, when a result exists: per pin the net name and DC voltage, the highest voltage difference to ground and to its neighbours, the part's dissipation (W) and whether it is over its rating. Nets carry their class (Signal/Power/HV) and DC voltage. The block has the simulation's timestamp; a stale result is marked.
- **FR-BM-061** (S0, S) Components should carry mass when known (transformers and chokes from their library data, otherwise a density estimate from the envelope), for mass properties of the product.
- **FR-BM-062** (S4, S) Components may carry a maximum surface temperature estimate (from dissipation and the body area), for heat checks.

### 7.5 Versioning

- **FR-BM-070** (S0, M) A reader shall accept every older BM version and refuse newer ones with a message that says which app to update. Migrations live in the shared module.
- **FR-BM-071** (S0, M) Unknown fields shall be kept on a round trip (forward compatibility within a version).

---

## 8. Link protocol

### 8.1 Transport and handshake

- **FR-LNK-001** (S0, M) The shell creates a `MessageChannel` per framed TAC document and hands one port to the frame with `postMessage({ type: "STUDIO_HELLO", protocols: [1], bm: [1], doc })`; TAC answers `STUDIO_WELCOME` with the protocol and BM versions it picked. No answer within 5 s (or no common version) leaves TAC stand-alone in the tab and the shell shows why.
- **FR-LNK-002** (S0, M) Messages are plain objects with `type`, a sequence number and, for requests, an id the reply carries. Every message type is listed in Appendix B with its direction and payload.
- **FR-LNK-003** (S0, M) Messages from any other source (another origin, another frame, TAC's own `tube_cad_v2` broadcast channel) shall be ignored by the studio link. TAC's CAD ↔ Board channel keeps working as it does.
- **FR-LNK-004** (S0, M) Neither side echoes what it received (TAC's `BOARD_SAVE` rule), so nothing loops.

### 8.2 Snapshots and updates

- **FR-LNK-010** (S0, M) On connect and whenever the user asks, TAC sends `BM_SNAPSHOT` with the full BM. After that it sends `BM_UPDATE` with a diff (added/changed/removed items by id) after each board or schematic change that alters the BM, at most once per 250 ms while editing and at once on commit.
- **FR-LNK-011** (S0, M) Each update names the `rev` it applies to. A receiver whose copy is not at that rev asks for a snapshot (`BM_RESYNC`).
- **FR-LNK-012** (S1, M) Simulation results arriving after a change send an update of the `electrical` block only.
- **FR-LNK-013** (S1, M) When TAC is not open (its tab closed or the project opened without it), MöbiusCAD works from the last BM saved in the project (FR-PRJ-010) and marks the board "not live".

### 8.3 Selection

- **FR-LNK-020** (S1, M) Selecting a component, hole or keep-out on any side sends `STUDIO_SELECT { ids }`; the other side selects and, when the user has turned "follow selection" on, zooms to it. Selection is never echoed. This extends TAC's `BOARD_SELECT` / `CAD_SELECT` (the schematic, the board window and the 3D assembly all take part).
- **FR-LNK-021** (S1, S) Hover may be shared (`STUDIO_HOVER`) for a pre-highlight, throttled to one per animation frame.

### 8.4 Proposals

- **FR-LNK-030** (S2, M) A change to an item the sender does not own is sent as `BM_PROPOSE { id, items: [{ id, before, after, reason }] }`. The owner shows it (FR-UI-030), and answers `BM_DECIDE { id, accepted: [ids], rejected: [{ id, why }] }`. Accepted items come back in the owner's next `BM_UPDATE`.
- **FR-LNK-031** (S2, M) A proposal never changes the owner's document before it is accepted. While open, the proposing side shows the item as pending (FR-UI-031).
- **FR-LNK-032** (S2, M) A rejected item stays a **conflict** on the proposing side until the user re-proposes, takes the owner's value, or hands ownership over. Conflicts are listed (FR-UI-032) and block a release (FR-OUT-040).
- **FR-LNK-033** (S2, M) Ownership of an outline, hole, keep-out or zone can be handed over in either direction by a proposal of kind `own`. A hand-over is recorded in the BM item (`owner`, `since`).
- **FR-LNK-034** (S2, S) A user setting "accept proposals automatically" (per project, off by default) accepts proposals whose items are all geometry the owner has not changed since the last sync.

---

## 9. Studio shell and project

### 9.1 Shell

- **FR-SHL-001** (S0, M) The File menu's New ▾ gains **Circuit** (opens an empty TAC document in a tab) and **Project** (9.2). Open accepts TAC circuit files (`.json` with `app` = TAC's, sniffed, not by extension alone).
- **FR-SHL-002** (S0, M) TAC documents use the shell's document tabs (`src/docTabs.ts`): label, dirty mark, park/resume, Save all. The shell asks TAC for its state with `DOC_STATE` and to save with `DOC_SAVE` (TAC returns the file bytes; the shell writes them where the tab's file lives).
- **FR-SHL-003** (S0, M) The command bar shows a **Circuit** tab while a TAC tab is live, with the commands TAC exposes (`STUDIO_COMMANDS`: id, label key, icon, enabled), routed to TAC by `STUDIO_RUN`. TAC's own toolbar stays inside its frame; FR-UI-119 of the modelling FRS applies to new studio commands.
- **FR-SHL-004** (S1, M) An assembly that contains a board shows a **Board** group in its command bar: Open circuit, Open board layout, Sync now, Proposals, Board settings.
- **FR-SHL-005** (S0, S) The header language and theme switches drive TAC's (`STUDIO_PREFS { lang, theme, units }`), so the studio never shows two languages or themes.

### 9.2 Project

- **FR-PRJ-001** (S0, M) A **studio project** is a folder (or a ZIP for download, `.mstudio`) holding a `project.json` manifest and its documents: circuits (TAC files, board inside, as today), parts, assemblies, drawings, and the last BM of each board (`boards/<board id>.bm.json`).
- **FR-PRJ-002** (S0, M) The manifest lists documents with ids and relative paths, and the **links**: which assembly component is which circuit's board, and which chassis part components belong to which circuit parts.
- **FR-PRJ-003** (S0, M) Opening a project opens its manifest in a Project panel (tree by kind) and the documents the user last had open. A document can still be opened alone; it then works without its links and says so.
- **FR-PRJ-010** (S0, M) Saving a circuit inside a project also writes its current BM next to it, so the mechanical side can work without TAC loaded (FR-LNK-013).
- **FR-PRJ-020** (S0, M) Autosave and recovery cover TAC documents through the shell's autosave journal; TAC's own `localStorage` autosave stays for stand-alone use and is not used in studio mode.
- **FR-PRJ-030** (S4, M) The MöbiusCAD vault stores TAC circuits as ordinary vault files (check-in/out, versions, revisions, where-used: an assembly that uses a board "contains" its circuit). TAC's own vault (3.187.0) stays for stand-alone use; studio mode routes TAC's vault commands to the shell's.
- **FR-PRJ-031** (S4, S) A vault release of an assembly should offer to release the circuits it contains at the same time, with matching revision labels.
- **FR-PRJ-040** (S0, M) Pack and Go and recent documents include circuits and project manifests.

---

## 10. Electronics to mechanics

### 10.1 The board component

- **FR-E2M-001** (S1, M) **Insert board**: an assembly can insert a board from an open circuit, a project circuit, or a saved BM file. The component is a new assembly part kind, `board`, whose source is the BM (by board id and rev) rather than a part document.
- **FR-E2M-002** (S1, M) The kernel builds the board as exact B-rep: outline loops extruded to the thickness (reusing `Kernel.boardStep`'s loop → face code), holes and slots cut, and one body per component envelope placed on its side; leads below the board as thin cylinders when the BM has them. Faces are named per FR-BM-022.
- **FR-E2M-003** (S1, M) The board's top and bottom faces show the copper/mask/silk look when the BM carries layer data (FR-BM-018), reusing `src/gerber/Board3D.ts`'s compositing; otherwise a plain mask colour.
- **FR-E2M-004** (S1, M) The board component behaves like any component: mates to its faces, holes and edges; hide, colour, transparency; interference and clearance; exploded views; BOM row; drawings (projection, sections, balloons).
- **FR-E2M-005** (S1, M) Component bodies are sub-entities of the board component: they can be selected, hidden, measured and balloon-ed by designator, but not moved in the assembly (placement belongs to ECAD; moving one makes a proposal, FR-M2E-020).

### 10.2 Live update

- **FR-E2M-010** (S1, M) A `BM_UPDATE` rebuilds only what changed: a moved part moves its body; a changed outline rebuilds the board solid; mates referencing kept face names stay solved; mates referencing removed ids are marked broken with the item named.
- **FR-E2M-011** (S1, M) An update arriving while the user is in a command waits until the command ends.
- **FR-E2M-012** (S1, S) The assembly shows a "board changed" notice with what moved (by designator) and a one-click compare (before/after ghost) for the last update.
- **FR-E2M-013** (S1, M) Undo in the assembly never undoes a board change; undo in TAC sends the reverse update like any other change.

### 10.3 Component models

- **FR-E2M-030** (S3, S) A component can show a detailed 3D model instead of its envelope: from a model library keyed by footprint or MPN, from a STEP the user drops on it, or from a MöbiusCAD part. The mapping is stored per project (and optionally in a user library in IndexedDB). The model is aligned by its footprint origin and pin 1, with a manual offset/rotation editor.
- **FR-E2M-031** (S3, M) Checks use the model when one is set and the envelope otherwise; the user can switch a check to envelopes only.
- **FR-E2M-032** (S3, C) Parametric models (MöbiusCAD part with configurations) may be generated from footprint and body data for common packages (radial cans, axial parts, TO-220, film boxes, noval sockets), so the library starts non-empty without third-party files.

---

## 11. Mechanics to electronics

### 11.1 Outline and holes

- **FR-M2E-001** (S2, M) **Board from sketch**: in a part or in-context in an assembly, a closed sketch profile (lines, arcs, circles) can be published as a board outline: outer loop + inner cut-outs; circles inside become holes or cut-outs as the user chooses. The board receives it as a proposal (or a direct change when MCAD owns the outline).
- **FR-M2E-002** (S2, M) **Board from face**: a flat face of an enclosure part (e.g. the floor between ribs, offset inwards by a clearance) can drive the outline. The link is associative: when the face changes, a new proposal is made.
- **FR-M2E-003** (S2, M) **Holes from the enclosure**: standoffs, bosses and holes in the enclosure that a board covers can be published as mounting holes (position, diameter from the fastener: M3 → 3.2 clearance by default, editable). A moved boss proposes the hole's new position.
- **FR-M2E-004** (S2, M) `[TAC]` TAC shall honour MCAD-owned outline and holes: they are locked in the board window (drawn with a lock mark, not draggable), the rule check uses them, and a part placed over them is reported as usual.

### 11.2 Keep-outs and heights

- **FR-M2E-010** (S2, M) The enclosure's inner surfaces above and below the board yield **height zones** (FR-BM-017): the shell computes, over the board area, the free height to the nearest enclosure face on each side and publishes zones as polygons with a maximum height (simplified to a few levels, editable tolerance). Ribs, bosses and screw heads become keep-outs.
- **FR-M2E-011** (S2, M) `[TAC]` TAC's rule check shall report each part taller than the zone it stands in (extending today's `maxHeight` check), with the zone and the overrun in mm, and draw zones in the board window.
- **FR-M2E-012** (S2, S) A user can draw a keep-out or height zone in MCAD on the board's face (sketch on `board:top`) and publish it.

### 11.3 Panel parts

- **FR-M2E-020** (S2, M) A panel part's position can be driven by the enclosure: the user mates the part's panel axis (FR-BM-015) to a hole or sketch point on a wall. The resulting board position is proposed to TAC as a placement change; TAC accepts it and, when accepted, holds it with a driving dimension or a lock (`board-dims.js`, `board-construct.js`), so later board edits do not move it.
- **FR-M2E-021** (S2, M) Conversely, moving a panel part on the board moves its panel hole when MCAD's hole is linked to the part (FR-ENC-010).
- **FR-M2E-022** (S2, S) Several panel parts on one wall can be aligned by MCAD (common height, equal spacing) and proposed together as one proposal.

---

## 12. Enclosures and chassis

### 12.1 Enclosure from board

- **FR-ENC-001** (S3, M) **Enclosure from board** creates an assembly with the board and a new enclosure part: a box (two-shell: base + lid, or a U-shape + cover) sized from the board outline plus a side clearance and the tallest part plus a lid clearance, with wall thickness, inner fillet radius and split line chosen in a panel; or a **sheet-metal** box (MöbiusCAD sheet metal: base flange, edge flanges, reliefs), which then has a flat pattern.
- **FR-ENC-002** (S3, M) Standoffs or bosses at each mounting hole, with height from the lowest part leads below the board plus a clearance, and fasteners from the fastener library (screws, nuts, washers; standoffs to be added to the library: hex M3 female-female and male-female in common lengths).
- **FR-ENC-003** (S3, M) The enclosure is an ordinary parametric part: every size is an editable feature or equation, and regeneration from the board keeps user features added later (they come after the generated ones in the tree).

### 12.2 Panel cut-outs

- **FR-ENC-010** (S3, M) **Cut-outs from parts**: for each panel part whose axis meets a wall, a hole feature is added on that wall with the part's panel hole (round, D, rectangle, library shape), linked to the component id. When the part moves, the hole moves; when the part is removed, the hole is marked orphaned (not silently deleted).
- **FR-ENC-011** (S3, M) A panel part whose axis meets no wall, or meets a wall outside the part's panel thickness range, is reported (FR-XCK-020).
- **FR-ENC-012** (S3, S) A library of panel cut-outs (IEC C14 inlet, XLR, Speakon, binding posts, 6.35 mm jacks, RCA, toggle switches, fuse holders, LED bezels, panel meters), each a sketch with sizes from its maker's drawing (source recorded, as the material library does).
- **FR-ENC-013** (S3, S) Ventilation: a vent pattern (holes or slots) placed over the parts with the most dissipation, sized from FR-XCK-031.

### 12.3 Chassis-built amplifiers

- **FR-ENC-020** (S3, M) Parts with `mount: "chassis"` (transformers, chokes, chassis tube sockets, TO-3 on heatsinks, IEC inlets, chassis pots/jacks) appear in a **Chassis parts** list in the assembly. Placing one puts its 3D body (library model or envelope) into the assembly; the component is linked to the circuit part id (FR-PRJ-002) and shows its designator.
- **FR-ENC-021** (S3, M) A chassis part brings its mounting cut-out: tube sockets (socket hole diameter from TAC's socket data, `rules.socketHole` as the default, plus its screw holes), transformers (EI frame bolt pattern from the EI size, or a lamination window for through-chassis types), chokes, TO-3 (two screw holes + two pin holes + insulator outline), IEC inlet, fuse holder.
- **FR-ENC-022** (S3, M) **Chassis from parts**: a sheet-metal chassis (top plate + bent sides, optional bottom cover) sized to enclose the placed chassis parts and the board(s) with a clearance; its holes are the parts' cut-outs (FR-ENC-021) linked by id. The flat pattern then drives drilling/punching (DXF).
- **FR-ENC-023** (S3, S) Tube parts get a top clearance check against the lid/cage and a recommended spacing between tubes and transformers (heat and hum), reported, not enforced.
- **FR-ENC-030** (S3, C) **Lead lengths**: for each net between chassis parts and board pads (FR-BM-019), the straight-line and routed (along the chassis floor, Manhattan) length; listed in a wiring table for the build and the BOM (wire by gauge from the net's current, FR-BM-060).

### 12.4 Grounding

- **FR-ENC-040** (S3, S) The chassis earth point (protective earth from the IEC inlet) and the signal ground point (TAC's star point `XG1` when `rules.ground` is `star`) are marked in the chassis and their screws added; a board hole with net GND and a metal standoff is reported as a chassis connection (FR-XCK-040).

---

## 13. Cross-domain checks

All checks run in MöbiusCAD on the assembly, list results in one **Studio checks** panel (severity, item, value, limit, a "show" button), and send results to TAC (`STUDIO_CHECKS`) so the board window's rule-check list shows the board-related ones too.

### 13.1 Geometry

- **FR-XCK-001** (S4, M) **Interference**: board, component bodies and leads against the enclosure, fasteners and other components (`Assembler.interference`), naming parts by designator.
- **FR-XCK-002** (S4, M) **Height**: each component against its height zone (FR-BM-017), with the overrun.
- **FR-XCK-003** (S4, M) **Assembly clearance**: board edge to walls, and parts to walls, against a minimum (default 1 mm), using `Assembler.clearance`.
- **FR-XCK-004** (S4, S) **Insertion**: the board can be lowered into the base along the base's open direction without hitting anything (sweep of the board's envelope), so the box can actually be assembled.

### 13.2 Access

- **FR-XCK-020** (S4, M) **Panel alignment**: each panel part's axis passes through its hole within a tolerance (default 0.2 mm) and the wall thickness is within the part's range; otherwise the deviation is reported.
- **FR-XCK-021** (S4, S) **Plug access**: for connectors, a mating-plug envelope (from the cut-out library) does not collide with anything outside the enclosure.

### 13.3 Electrical safety

- **FR-XCK-030** (S4, M) **HV clearance to conductive parts**: for every pad, lead and exposed conductor on an HV net (FR-BM-060), the distance through air to any conductive enclosure part, fastener or standoff is at least the clearance for the net's voltage (from TAC's IPC table, `rules.ipc`; for mains-connected circuits the user may choose IEC 62368-1 values, decision D-6). Enclosure parts are conductive when their material is a metal (MöbiusCAD material library category).
- **FR-XCK-031** (S4, S) **Heat**: the total dissipation inside a closed enclosure is compared with what its surface and vents can shed for a chosen temperature rise (a natural-convection estimate with the coefficients shown), and parts above a dissipation threshold (TAC's `rules.hotWatts`) are checked for distance to plastic walls and to the lid. Results are estimates and say so.
- **FR-XCK-032** (S4, S) **Creepage** across the board from HV pads to mounting holes with metal fasteners (over the board surface, around slots), compared with the clearance rule.

### 13.4 Grounding and mass

- **FR-XCK-040** (S4, S) Every board hole with a metal standoff joins the chassis; the check lists which nets that ties to the chassis (expected: GND or none), and warns when an HV or signal net would be tied.
- **FR-XCK-041** (S4, M) Mass properties of the product include board, components (mass from FR-BM-061) and chassis parts (transformers dominate a valve amp's mass and centre of gravity).

---

## 14. Outputs: BOM, drawings, manufacturing, release

### 14.1 Bill of materials

- **FR-OUT-001** (S4, M) One **product BOM** combines TAC's electrical BOM (`BomLib.build`: designators, values, part numbers, sockets) and MöbiusCAD's mechanical BOM (enclosure parts, fasteners, standoffs, hardware) with a Domain column; export CSV and XLSX; the electrical rows keep TAC's grouping and part-number data.
- **FR-OUT-002** (S4, S) Panel hardware that comes with a part (pot nuts, jack washers) is listed once with the part, not as separate fasteners.

### 14.2 Drawings

- **FR-OUT-010** (S4, M) MöbiusCAD drawings of an assembly with a board can balloon components by designator and show the board outline, mounting holes and cut-outs with dimensions (the board is a component like any other).
- **FR-OUT-011** (S4, S) A **board mechanical drawing**: outline with dimensions, hole table, thickness, component heights by zone; generated as a MöbiusCAD drawing from the board component.
- **FR-OUT-012** (S4, S) A **panel drawing** per enclosure wall: holes with their sizes and the parts they are for (a note per hole with designator and part), for drilling by hand or for a front-panel maker.

### 14.3 Manufacturing pack and release

- **FR-OUT-020** (S4, M) **Product STEP**: the assembly with the board (exact geometry, component bodies or models, names = designators) as AP214 with structure.
- **FR-OUT-021** (S4, M) **Manufacturing pack**: one ZIP with the board's Gerber/Excellon/BOM/placement files (from TAC's `BoardFab`), the enclosure's STEP and sheet-metal flat patterns (DXF), drawings (PDF), the product BOM and the wiring table.
- **FR-OUT-040** (S4, M) Releasing a project (vault release or "Make manufacturing pack") is refused while proposals are open or conflicts exist (FR-LNK-032), and warns about errors in Studio checks (overridable with a reason, recorded).

---

## 15. Interoperability

- **FR-IO-001** (S5, S) **IDX (EDMD) export and import** of the BM: baseline and incremental messages, item identity mapped to BM ids, so the studio can exchange with other ECAD/MCAD tools that speak IDX.
- **FR-IO-010** (S5, S) **IDF 3.0** export (`.emn` + `.emp`) and import of outline, holes, keep-outs and component placements/heights.
- **FR-IO-020** (S5, S) **KiCad board import** (`.kicad_pcb`): outline (Edge.Cuts), holes, footprints with 3D model names and heights, into a BM with no circuit behind it (a "foreign board"), so boards from KiCad can go through sections 10–14. A foreign board is owned by MCAD for outline/holes and is read-only for components.
- **FR-IO-030** (S5, M) **Board from Gerber**: MöbiusCAD's PCB view can turn a loaded Gerber/Excellon set into a foreign-board BM (outline loops from the edge-cuts layer, holes from the drill files, no components), for enclosures around boards from elsewhere.
- **FR-IO-040** (S5, S) **Board from STEP**: an imported STEP of a board can be marked as a board (pick the board body and its top face) to get height zones and checks against its component bodies.

---

## 16. User interface

- **FR-UI-001** (S0, M) The studio follows MöbiusCAD's UI rules (tokens, light/dark, EN/RU, focus, breakpoints, axe-core). TAC's frame keeps its own UI; the shell makes them agree on language and theme (FR-SHL-005).
- **FR-UI-010** (S1, M) **Cross-probing** across schematic, board layout and 3D (FR-LNK-020), with a "follow selection" toggle in each.
- **FR-UI-011** (S1, S) A **link status** indicator in the status bar: live / not live / out of date / version mismatch, with a menu to resync or open the circuit.
- **FR-UI-030** (S2, M) **Proposal review** (in both apps): a dialog listing items with before/after values and a small preview (2D on the board side, ghost overlay in 3D), accept/reject per item or all, a reason field on reject.
- **FR-UI-031** (S2, M) Pending items are drawn with a dashed outline and a "pending" badge on the proposing side.
- **FR-UI-032** (S2, M) A **Conflicts** list (Studio panel) with actions: re-propose, take theirs, hand over ownership.
- **FR-UI-040** (S3, M) Enclosure from board, chassis from parts and cut-outs use MöbiusCAD's PropertyManager panels (✓/✕, selection boxes, value callouts) like any feature.
- **FR-UI-050** (S0, M) Every new string is in both languages (`i18n.ru.ts` in MCD, `i18n-ru.js` in TAC); the smoke tests' English-left-in-Russian checks cover the studio panels.
- **FR-UI-060** (S1, S) A first-use tutorial "Board to box" (MöbiusCAD's tutorial framework, FR-HLP-003) walks W1 on a two-stage 12AX7 preamp.

---

## 17. Non-functional requirements

### 17.1 Performance

- **NFR-PERF-001** (S1, M) A board with 200 components and 20 holes builds as an assembly component in under 3 s on the reference laptop (the modelling FRS's), and a one-part move updates in under 300 ms (body moved, no board rebuild).
- **NFR-PERF-002** (S0, M) A `BM_UPDATE` for one moved part is under 4 kB; a full BM of 200 parts without layer images under 300 kB.
- **NFR-PERF-003** (S4, S) Studio checks on that board in a two-part enclosure finish in under 10 s, running in workers, never blocking the UI.
- **NFR-PERF-004** (S0, S) A parked TAC tab costs under 150 MB; with more than two parked TAC tabs the oldest is unloaded (its state saved).

### 17.2 Reliability and compatibility

- **NFR-REL-001** (S0, M) A crash or reload of the TAC frame never loses MCAD state, and vice versa; the link reconnects and resyncs by snapshot.
- **NFR-REL-002** (S0, M) Every circuit and BM written by a studio opens in stand-alone TAC of the same or later version (the BM's extra fields are kept, FR-BM-071).
- **NFR-REL-003** (S0, M) Studio versions refuse a TAC pin whose `studio.json` does not list a compatible protocol (FR-ARC-013), at build time, not at run time.

### 17.3 Privacy and security

- **NFR-SEC-001** (S0, M) Everything stays client-side, as today. No board, circuit or model data leaves the machine unless the user uses a feature that says so (TAC's AI and DigiKey features keep their own rules).
- **NFR-SEC-002** (S0, M) The link accepts messages only on its own `MessageChannel` port from a same-origin frame it created (FR-LNK-003).

### 17.4 Testing

- **NFR-TST-001** (S0, M) The shared `board-model` module is unit-tested in both repositories (round trips TAC board → BM → TAC board, frame transforms, diffs, migrations).
- **NFR-TST-002** (S0, M) MöbiusCAD's smoke test gains a studio block (its own shard, per `CLAUDE.md`) that opens a TAC example circuit in a tab, inserts its board into an assembly, moves a part in TAC and checks the 3D body moved.
- **NFR-TST-003** (S0, M) `[TAC]` TAC's e2e test runs its studio-mode handshake against a stub shell, so TAC releases cannot break the link unnoticed.

---

## 18. Data model

### 18.1 Board Model (schema sketch)

```ts
interface BoardModel {
  kind: "board-model";
  version: 1;
  id: string;                     // board id, stable for the circuit's life
  rev: number;                    // increments on every change
  hash: string;                   // content hash without rev/hash
  source: { app: "tac" | "kicad" | "gerber" | "step" | "mcad"; doc?: string; version?: string };
  units: "mm";
  frame: "bm-v1";                 // x right, y up, origin bottom-left of the outline box, z up, bottom face z = 0
  stackup: { thickness: number; layers: number; copperUm: number; mask?: string; silk?: string };
  outline: { outer: Loop; inner: Loop[]; owner: Side; since?: string };
  holes: Hole[];
  components: Component[];
  keepouts: Zone[];
  heights: HeightZone[];
  nets?: Record<string, { cls: "Signal" | "Power" | "HV"; v?: number }>;
  layers?: { gerberZip?: string /* base64 */ };
  electrical?: { at: string; stale: boolean };
  extra?: Record<string, unknown>; // kept on round trips
}
type Side = "ecad" | "mcad";
interface Loop { id: string; segs: Seg[] }   // closed; segment k runs from the previous end to `to`
type Seg = { k: "line"; to: [number, number] } | { k: "arc"; to: [number, number]; c: [number, number]; ccw: boolean };
interface Hole { id: string; x: number; y: number; d: number; slot?: { x2: number; y2: number }; plated: boolean; net?: string; fastener?: string; role: "mount" | "tooling" | "other"; owner: Side }
interface Component {
  id: string;                     // TAC part key ("12" or "12+13")
  ref: string; type: string; value?: string; mpn?: string; footprint: string;
  mount: "board" | "chassis" | "panel";
  side: "top" | "bottom";
  at?: { x: number; y: number; rot: number };   // absent for chassis parts not on the board
  body: Body[];                   // envelope primitives in the part frame
  lead?: { below: number; d: number };
  pins: { name: string; x: number; y: number; net?: string; v?: number }[];
  panel?: { p: [number, number, number]; dir: [number, number, number]; hole: PanelHole; stack: number; range: [number, number] };
  power?: { w: number; over?: boolean };
  vmax?: number;                  // largest DC voltage of any pin to ground
  mass?: number;                  // kg
  model?: { kind: "step" | "part" | "lib"; ref: string; tf?: number[] };
  owner: Side;
}
type Body =
  | { k: "prism"; pts: [number, number][]; z0: number; h: number }
  | { k: "cyl"; c: [number, number, number]; axis: [number, number, number]; d: number; h: number };
type PanelHole =
  | { k: "round"; d: number } | { k: "d"; d: number; flat: number }
  | { k: "rect"; w: number; h: number; r: number } | { k: "lib"; name: string };
interface Zone { id: string; pts: [number, number][]; side: "top" | "bottom" | "both"; forbid: ("parts" | "tracks" | "vias" | "pour")[]; source: Side; owner: Side }
interface HeightZone { id: string; pts: [number, number][]; side: "top" | "bottom"; max: number; source: Side; face?: string; owner: Side }
```

### 18.2 Mapping from TAC's board document

| TAC (`BoardCore`) | BM | Notes |
| --- | --- | --- |
| `outline { w, h, r }` | `outline.outer` as 4 lines + 4 arcs | y flipped: `y_bm = h − y_tac` |
| new `outline.loops` (FR-BM-010) | `outline.outer` / `inner` | |
| `stackup.thickness`, `layers`, `copper` | `stackup` | |
| `parts[key] { ref, fp, x, y, rot, side }` | `components[]` with `id = key` | rotation sign flips with the y axis |
| footprint `f.body`, `bp.body`, `bp.mpn` | `body[]`, `lead`, `mpn` | standing resistors → vertical cylinder + lead loop envelope |
| `holes { x, y, d, plated, pad, net }` | `holes[]` with new `id` | |
| `keepouts` | `keepouts[]` | |
| `rules.maxHeight` | one `HeightZone` over the outline | only when no MCAD zone exists |
| netlist `pins` with `net`, `i`; `volts` | `pins[].net`, `pins[].v`, `nets` | from the last simulation result |
| tracks, vias, zones, texts | not in the BM | optional `layers.gerberZip` for the look |

### 18.3 Project manifest (schema sketch)

```ts
interface StudioProject {
  kind: "studio-project"; version: 1; id: string; name: string;
  docs: { id: string; kind: "circuit" | "part" | "assembly" | "drawing"; path: string }[];
  boards: { id: string; circuit: string; bm: string }[];          // bm = path of the last saved Board Model
  links: { asm: string; comp: string; board?: string; part?: string /* circuit part id for chassis parts */ }[];
  settings: { autoAccept: boolean; clearance: number; hvStandard: "ipc2221" | "iec62368" };
}
```

---

## 19. Verification and acceptance

Reference project: a two-stage 12AX7 preamplifier with a 6.35 mm input jack, a volume pot and an output jack on the board, a separate power supply off-board, in an aluminium enclosure (W1); and the "Single-ended 2A3, Hammond 1627SEA" example circuit built on a chassis (W3).

| ID | Phase | Test |
| --- | --- | --- |
| AT-S0-1 | S0 | A TAC example opens as a studio tab; save, close, reopen keeps it unchanged; stand-alone TAC opens the same file |
| AT-S0-2 | S0 | Round trip TAC board → BM → TAC board is lossless for outline, holes, parts, keep-outs (unit test in both repos) |
| AT-S0-3 | S0 | TAC board with an L-shaped outline, a notch and an inner cut-out passes its own rule check, exports Gerber edge cuts and 3D correctly |
| AT-S0-4 | S0 | Studio offline (service worker, network off) opens a circuit, simulates and saves |
| AT-S1-1 | S1 | Insert the preamp board into an assembly; designators on bodies; mate the board's bottom face and two holes to standoffs |
| AT-S1-2 | S1 | Move the input jack 10 mm in TAC; its 3D body moves within 1 s; mates stay solved |
| AT-S1-3 | S1 | Select R3 in the schematic: the board window and the 3D assembly select it, and the other way round |
| AT-S1-4 | S1 | Close TAC; reopen the project; the assembly shows the board from the saved BM, marked not live |
| AT-S2-1 | S2 | In W2, sketch an outline in the enclosure part and publish it; TAC shows a proposal; accept; the board takes the outline, locked |
| AT-S2-2 | S2 | Lower the enclosure lid by 5 mm; TAC's rule check reports the electrolytic that no longer fits, by zone |
| AT-S2-3 | S2 | Mate the pot's axis to a front-panel hole; TAC receives the placement proposal; accept; a later board edit does not move the pot |
| AT-S2-4 | S2 | Reject a proposal; it appears in Conflicts; release is refused until it is resolved |
| AT-S3-1 | S3 | Enclosure from board makes base, lid, standoffs, screws and three panel holes; moving the output jack moves its hole |
| AT-S3-2 | S3 | Chassis from parts for the 2A3 amplifier: socket holes, transformer cut-outs, IEC inlet; flat pattern exports as DXF |
| AT-S3-3 | S3 | A panel part whose axis misses the wall is reported |
| AT-S3-4 | S3 | User features added to the generated enclosure survive regeneration after a board change |
| AT-S4-1 | S4 | An HV pad 1 mm from an aluminium wall is reported with the voltage and the required clearance |
| AT-S4-2 | S4 | Product BOM lists resistors (with part numbers) and M3 screws/standoffs in one table; CSV export |
| AT-S4-3 | S4 | Manufacturing pack contains Gerbers, drill, enclosure STEP, flat-pattern DXF, drawings and BOM |
| AT-S4-4 | S4 | Vault: check in the project; the assembly's where-used lists the circuit; release refused while a conflict exists |
| AT-S4-5 | S4 | Product mass and CoG include the transformers' masses |
| AT-S5-1 | S5 | Export IDX baseline, re-import into a new project: outline, holes, placements identical |
| AT-S5-2 | S5 | Import a KiCad board; enclosure from board works on it |
| AT-S5-3 | S5 | Board from a Gerber set (one of `tests/fixtures/pcb/`) gives the right outline and holes |
| AT-S5-4 | S5 | IDF export opens in the IDF reader of the smoke test with the expected heights |

---

## 20. Risks

| ID | Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- | --- |
| R-1 | Two release trains drift; a TAC release breaks the link | Medium | High | `studio.json` versions (FR-ARC-013), TAC's studio e2e against a stub (NFR-TST-003), pinned TAC in MCD builds |
| R-2 | Polygon outlines ripple through TAC (rule check, pours, edge clearance, autorouter, KiCad export) | High | Medium | S0 work item of its own; the rounded rectangle remains a shortcut; tests per consumer |
| R-3 | Identity loss (re-created items treated as new) breaks mates and drawings | Medium | High | Ids on every TAC item (FR-BM-021), face names from ids (FR-BM-022), tests that move/rename/renumber |
| R-4 | Memory: OCCT + a TAC frame with its simulation workers in one tab set | Medium | Medium | Parked-tab limits (NFR-PERF-004), TAC's worker pool sized down in studio mode |
| R-5 | Users expect general ECAD (digital parts, 4+ layers) | High | Medium | State the scope (1.3); KiCad import (FR-IO-020) covers boards made elsewhere |
| R-6 | Proposal flow feels heavy for a single user doing both sides | Medium | Medium | Auto-accept setting (FR-LNK-034); ownership defaults per workflow |
| R-7 | Safety rules (mains clearance) misread as certification | Low | High | Checks say "rule check, not certification" and name the standard and table used |
| R-8 | Height zones from complex enclosures are slow or noisy | Medium | Low | Level simplification with tolerance; user-drawn zones as fallback |

---

## 21. Open decisions

| ID | Question | Options | Recommendation |
| --- | --- | --- | --- |
| D-1 | Product name | "Möbius Studio"; keep "MöbiusCAD" with a Circuit module; other | "Möbius Studio" for the combined app, keep both apps' names for the parts |
| D-2 | Where the studio lives on aerocat.tech | MöbiusCAD path gains the studio; a new `/tools/studio/` | MöbiusCAD's path (one build), TAC's path keeps stand-alone TAC |
| D-3 | Home of the shared `board-model` module | In MöbiusCAD, copied into TAC releases; own repo; in TAC | In MöbiusCAD (`src/studio/board-model/`), plain ES module + `.d.ts` |
| D-4 | Project file | Folder + `project.json` and `.mstudio` ZIP; only vault projects | Both, as in 9.2 |
| D-5 | TAC's own vault in studio mode | Routed to MöbiusCAD's vault; both kept | Routed (FR-PRJ-030) |
| D-6 | Clearance standard for mains equipment | IPC-2221 only; add IEC 62368-1 tables | Add IEC 62368-1 as an option; default IPC-2221 as TAC today |
| D-7 | Component model library | Envelopes only; generated parametric models (FR-E2M-032); user STEP library | Envelopes first, generated models for common packages in S3, user STEP library in S5 |
| D-8 | Board window in studio | Second tab; split view next to the 3D | Second tab in S0; split view later |

---

## 22. Appendices

### Appendix A. Ownership quick reference

See 4.3. Rule of thumb: ECAD owns what is electrical and where parts sit on the board; MCAD owns where the board sits in space and everything around it; outline, holes and zones belong to whoever started the design and can be handed over.

### Appendix B. Message catalogue (protocol v1)

| Message | Direction | Payload |
| --- | --- | --- |
| `STUDIO_HELLO` | shell → TAC | `protocols`, `bm` versions, `doc` (tab id), port |
| `STUDIO_WELCOME` | TAC → shell | chosen `protocol`, `bm`, TAC version, `commands` |
| `STUDIO_PREFS` | shell → TAC | `lang`, `theme`, `units` |
| `DOC_STATE` / `DOC_STATE_R` | shell ↔ TAC | request / `{ name, dirty }` |
| `DOC_SAVE` / `DOC_SAVE_R` | shell ↔ TAC | request / `{ bytes, name }` |
| `DOC_LOAD` | shell → TAC | `{ bytes, name }` |
| `STUDIO_COMMANDS` | TAC → shell | `[{ id, label, icon, enabled }]` |
| `STUDIO_RUN` | shell → TAC | `{ id }` |
| `BM_SNAPSHOT` | TAC → shell | full BM |
| `BM_UPDATE` | TAC → shell | `{ base, rev, added, changed, removed }` |
| `BM_RESYNC` | shell → TAC | `{ have }` |
| `BM_PROPOSE` | either | `{ id, items: [{ id, before, after, reason }] }` |
| `BM_DECIDE` | either | `{ id, accepted, rejected: [{ id, why }] }` |
| `STUDIO_SELECT` | either | `{ ids }` |
| `STUDIO_HOVER` | either | `{ id \| null }` |
| `STUDIO_CHECKS` | shell → TAC | `[{ id, sev, item, msg, value, limit }]` |
| `STUDIO_OPEN` | TAC → shell | `{ what: "board" \| "asm", id }` (open the board window or the assembly that uses this board) |

### Appendix C. Work items by repository (S0)

`[TAC]`: polygon outlines and cut-outs through every consumer; ids on holes, keep-outs, loops; BM export/import using the shared module; `studioMode` switch and handshake; Board window as a studio tab; `studio.json` in the release; studio e2e against a stub shell.

`[MCD]`: `src/studio/` (link, BM store, shared module); TAC vendoring + service-worker precache; Circuit document kind in tabs, File menu and Pack and Go; Circuit command bar tab; smoke-test shard for the studio.
