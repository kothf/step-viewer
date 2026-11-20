# Structural analysis: SA0 spike report

Phase SA0 of [FRS-structural.md](FRS-structural.md) (AT-SA0-1). Code: `src/sim/`, `src/kernel/simgeo.ts`; tests: `tests/unit/sim.test.ts`, `tests/unit/sim-part.test.ts`. Numbers are from the cloud container (4 cores, node 22), one thread; the reference desktop (i7-4770) runs a similar single-thread speed.

## Decision (D-S1)

**Cells + polynomials, as recommended.** The method works on the exact geometry without a mesh, converges from below as the degree rises, and meets the SA0 accuracy and speed targets on the bracket. The tetrahedral p-mesh alternative (FR-SARC-015) is not needed and was not built.

## What the spike built

| Piece | File | Notes |
|---|---|---|
| Basis | `basis.ts` | Complete polynomial of degree p ≤ 4 per cell, products of Legendre polynomials in the cell's scaled coordinates. Hierarchical: the degree-1 functions come first. |
| Cells | `grid.ts` | Uniform cubes over the body's box (centred). Cells the body misses are dropped. A cell with under 25 % material lends its quadrature to the fullest neighbour, whose polynomial spans both (aggregation), so no polynomial lives on a sliver. |
| Body | `body.ts`, `kernel/simgeo.ts` | The body is the kernel's fine tessellation of its exact faces (double precision, each triangle knows its face). Lines along an axis are cut exactly at the triangles (bucketed by the other two coordinates). The inside test is parity along x. A box knows whether its boundary turns sharply (an edge or corner) and which axis is nearest the boundary's normal. |
| Quadrature | `quad.ts` | Cut cells: an octree to depth 3, then Gauss lines along the axis nearest the boundary normal, cut exactly at the boundary. The transverse rule is split where the boundary meets the leaf's faces (that is where the length inside has kinks). Leaves holding an edge are split up to 3 levels more. The fine points are then replaced by (2p + 1)³ Gauss points whose weights reproduce every tensor Legendre moment of degree ≤ 2p (moment fitting, closed form). The stiffness is then identical to the fine rule's at a fraction of the cost. Faces between cells get the same treatment in 2D. Supports and loads are integrated on the face triangles, cut along the grid planes so each piece lies in one cell (Duffy rule). |
| Elasticity | `static.ts` | Symmetric interior penalty between elements (γ = 3 (λ + 2μ)(p + 1)² / h). Nitsche for fixed and sliding (normal only) supports. Force (total, spread by area) and pressure loads. Results: displacement and stress anywhere, von Mises. |
| Solvers | `sparse.ts`, `pcg.ts` | Element-block sparse matrix. Up to 6 000 unknowns: reverse Cuthill–McKee + envelope Cholesky. Above that: CG with a two-level p-multigrid (forward block Gauss–Seidel over elements, exact solve of the degree-1 part, backward sweep). The coarse matrix is just the leading sub-blocks, since the basis is hierarchical. |
| Passes | `static.ts` `grid` | A later pass reuses the cells and their fine points and only refits them for the new degree. The geometry is not queried again. |

## Accuracy

| Benchmark | Set-up | Result | Target |
|---|---|---|---|
| Patch test, bar in tension, ν = 0 | grid fits the bar, p = 1 | exact to 1e-6 | exact |
| same, grid not fitting (cut cells, plain inside test without line cuts) | h 13 mm | 0.01 % off (cut-cell volume 7e-4 off) | — |
| AT-SA0-2 cantilever 200 × 20 × 20, 1 000 N | h 10, p 2 / h 20, p 3 / h 20, p 4 / h 40, p 4 | 2.5 % / 2.1 % / 1.2 % / 1.8 % below Timoshenko | 3 % |
| Round bar Ø20 × 200 cantilever (cut cells) | h 10, p 2 / h 7, p 3 | 2.6 % / 0.7 % below Timoshenko | — |
| Lamé quarter cylinder a 10, b 20, 100 MPa, plane strain | h 5, p 3 | hoop stress at the bore 0.6 % high, radial displacement 0.4 % low | 3 % (AT-SA1-5) |
| AT-SA0-3 bracket (100 × 60 × 20, Ø10 hole) volume | tessellation 0.002 mm / 0.05 rad | 1.2e-6 of `massOf` | 1e-4 |
| Round bar as a mesh of 96 facets (coarse), h 10 | depth 2 / 3 | 7e-5 / 5e-6 of the mesh volume | — |

The 3D clamped cantilever is a little stiffer than beam theory (the clamp holds the end section's Poisson contraction), so the converged 3D answers sit about 0.7 % under Timoshenko. A cell can be larger than the part's section (h 40 on a 20 mm bar): a p = 4 polynomial still bends correctly.

Degree p = 1 locks in bending (16 % of the deflection at h 10). **The passes start at p = 2.**

## Speed (AT-SA0-4)

Bracket, fixed end face, 1 000 N on the other, h 10 mm, one thread:

| Pass | Unknowns | Cells + quadrature | Assembly | Solve | Tip deflection |
|---|---|---|---|---|---|
| p 2 | 3 600 | 5.5 s (first, geometry) | 0.3 s | 0.5 s direct | 0.0389 mm |
| p 3 | 7 200 | 0.8 s (refit) | 0.4 s | 1.4 s PCG, 80 its | 0.0398 mm |
| p 4 | 12 600 | 1.6 s (refit) | 2.0 s | 5.1 s PCG, 102 its | 0.0402 mm |

All three passes take about 18 s. That is under the 60 s spike target and under the SA1 target of 30 s. The strain energy rises 19.48 → 19.94 → 20.11 N·mm. Without the p-multigrid, the p = 4 direct factorisation alone took 18.5 s.

Where the time goes, and what SA1 does about it:

- **First quadrature (5.5 s).** Mostly the box hints (triangle–box overlap tests) and line cuts. SA1 runs them on worker batches (FR-SARC-020). Box hints can also reuse their parent's triangle list.
- **PCG at p = 4.** The iteration count grows with p (52, 80, 102). A three-level cycle (p → 2 → 1) and running the sweeps in workers come next. WASM (FR-SARC-023) is held back until the TypeScript profile is flat.
- **Assembly at p = 4.** This is the face terms. They can be done per element pair in workers.

## Open points for SA1

- **Exact surface.** Lines are cut at the tessellation. A 0.002 mm chord keeps the volume within 1e-6, but the kinks between facets limit how fast cut cells converge. In SA1, hits within the chord tolerance are snapped to the exact surface in the kernel worker (`IntCurvesFace_ShapeIntersector` on the line), or moved by a curved-triangle (Phong) correction from the vertex normals.
- **Thin walls (FR-SARC-014).** Not tried in the spike. The h 40 cantilever suggests that p ≥ 3 cells larger than the wall thickness bend correctly. SA1 checks this on LE10 and a sheet metal part, and splits cells across the thickness only if needed.
- **Error estimate and adaptive passes.** The spike raises p uniformly. SA1 adds the per-cell residual/energy estimate, raises p or splits only where needed, and stops at the targets (D-S5).
- **Reactions and hinge/moment/gravity loads**, then the worker and the UI (SA1 plan in the FRS).
