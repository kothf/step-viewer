# Structural analysis: validation against CalculiX

FRS-structural NFR-SIM-022. Three real parts of the model steam engine (project files, `.mcadprt`) are solved by
the app's meshless solver and by CalculiX 2.21 on a second-order tetrahedral mesh of the same geometry, with the
same supports, loads and material. The margins are those of NFR-SIM-020: displacements within 3 %, peak stress
away from singularities within 5 %, reactions within 0.1 % of the applied load.

CalculiX and Gmsh are used offline for this comparison only. Nothing of them is shipped with the app.

## Set-up

All three parts are steel (E = 210 000 MPa, ν = 0.3), held on one face (fixed) and loaded by a force spread evenly
over picked faces.

| Part | Held | Loaded | Force, N |
| --- | --- | --- | --- |
| Fork link (2-06.1) | end of the stem | pin holes of the fork (both walls) | 0, 0, −40 |
| Connecting rod (2-03, two bodies) | big end bore | small end bore (both walls) | −400, 60, 0 |
| Bracket (1-01.4) | underside of the foot | bore of the forked lug (both walls) | 0, 80, −200 |

The app: six passes (degrees 2, 3, 4 everywhere, then raised to 6 where the estimated error is highest), about
150 cells. CalculiX: the part written as STEP by the app's kernel, meshed by Gmsh with ten-node tetrahedra
(`C3D10`), the force put on as the consistent nodal loads of a uniform traction.

## Results

| Part | CalculiX mesh | App: unknowns | Largest displacement, mm (CalculiX / app) | Difference | Displacement field, RMS | Peak von Mises, MPa (CalculiX / app) | Difference | Stress field, RMS | Reactions |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Fork link | 71 014 nodes, 46 028 elements | 22 365 | 0.024887 / 0.024698 | −0.76 % | 0.61 % | 59.13 / 59.23 | +0.18 % | 2.3 % | 1e-7 % |
| Connecting rod | 86 045 nodes, 53 618 elements | 17 052 | 0.14972 / 0.14761 | −1.41 % | 1.48 % | 49.93 / 49.33 | −1.21 % | 3.1 % | 1e-7 % |
| Bracket | 75 187 nodes, 46 668 elements | 20 475 | 0.0046832 / 0.0046013 | −1.75 % | 2.05 % | 14.11 / 14.32 | +1.50 % | 3.1 % | 4e-5 % |

All three are inside the margins.

How the numbers are taken:

- The displacement is compared at CalculiX's corner nodes; the RMS column is the root mean square of the
  difference over the root mean square of the reference.
- The stress is compared at CalculiX's integration points. Points nearer than a tenth of the part's size to the
  support, and points near sharp inside corners (where the exact stress is unbounded and both solvers only grow
  with refinement), are left out. The peak is the highest value among the points that are left, in each solver.
- Reactions: the support's total force against the applied force.

Remarks:

- On the connecting rod the two peaks sit at different points of the loaded bore's rim. At CalculiX's own peak
  point (an integration point 0.1 mm under the loaded surface, where its nodal loads enter) the app reads
  34.8 MPa. The stress field as a whole differs by 3.1 % RMS.
- The app's largest displacement is 1 to 2 % low on all three parts: the method converges from the stiff side, and
  the strain energy was still rising by 0.2 to 0.3 % in the last pass.
- With three passes only, the bracket is 5.3 % low in displacement; the app says so itself (energy change 4.2 %,
  above the 2 % it stops at).

## What the comparison found

Defects, fixed in 1.648.0:

1. The connecting rod is two bodies that stand 0.00002 mm apart in the file. They were not joined, and the study
   refused the part. Bodies up to 0.001 mm apart are now bonded.
2. A bore that a slot cuts in two is one named face with two walls. The view lit both walls and the panel said
   "1 face", but the solver loaded only the first wall. Every wall of a picked face is now used.
3. On the bracket the solver overshot from degree 5 on (strain energy 6 % too high in pass 4) and failed in
   pass 5. A few merged cut cells need a far larger interior penalty than the formula gives once the degree is
   high. The penalty of every cut element is now measured (the largest ratio of its boundary flux energy to its
   strain energy) and raised where the formula falls short.

The test set that followed (an engine stage assembly, `tests/human/set-shaft.mjs`) found a fourth:

4. A component much thinner than the cells (a 6.5 mm base plate among parts 430 mm across) has no cell a quarter
   full, so the scraps of cells at its rim were joined to nothing. One of them, holding next to no material, made
   the stiffness matrix indefinite. Such a component's own fullest cells are now what the scraps join.

## Running it again

```bash
apt install calculix-ccx gmsh && pip install gmsh
node bench/run.mjs bench/simfaces.bench.ts <part.mcadprt>          # the faces, to choose supports and loads
node bench/run.mjs bench/simval.bench.ts <folder of parts> <work folder> [con-rod|bracket|fork-link]
```

`SIMVAL_PASSES` (6), `SIMVAL_CELLS` (150), `SIMVAL_REUSE=1` (keep CalculiX's results in the work folder). The
same three set-ups are run through the UI by `tests/human/set-engine.mjs`.
