# Thermal solver validation

FRS-thermal NFR-TH-020 (analytic answers) and NFR-TH-021 (an open-source FEA solver). First measured in 1.694.0;
the CalculiX comparison was run again in 1.695.0 after the fixes it led to (see "1.695.0" below).

## Analytic answers (NFR-TH-020, AT-TH0-1)

`tests/unit/thermal.test.ts` and `tests/unit/thermal-analytic.test.ts`. Each case runs the passes a study runs
(p = 2, 3, 4 on one grid) and is read after the last one.

| Case | Closed form | Required | Largest difference |
|---|---|---|---|
| Slab, fixed temperature + heat power | linear | 0.5 % | < 1e-6 K |
| Slab, volume heat, both ends held | parabola | 0.5 % | < 1e-6 K |
| Slab, flux in, convection out | linear | 0.5 % | < 1e-6 K |
| Tube wall, heat through it | logarithm | 1 % | < 2 % at p = 4 (curved faces faceted) |
| Pin fin 4 × 4 × 100 mm, aluminium, convection on sides and tip | cosh | 2 % | 0.012 % of the rise |
| Annular fin r 10 to 40 mm, 2 mm thick, convection on both faces | Bessel I₀, I₁, K₀, K₁ | 2 % | 0.012 % of the rise |
| Solid cylinder R 10 mm, internal heat, convection on the side | parabola in r | 1 % | 0.011 % of the rise |
| Heat balance of each | heat made = heat leaving | 0.5 % | < 1e-6 relative |

## Against CalculiX (NFR-TH-021, AT-TH3-9)

`node bench/run.mjs bench/thval.bench.ts <work folder> [case]` (offline: CalculiX `ccx` 2.21 and the gmsh 4.15 Python
module; nothing of it is shipped). Each case is built from boxes in Gmsh with shared faces where bodies touch (perfect
contact), meshed with second-order tetrahedra and solved by CalculiX; the same bodies, faces and heat are then solved
by MöbiusCAD as a study does (`runThermal`, default settings: about 150 cells, passes p = 2, 3, 4), and both are read
at every corner node of CalculiX's mesh. Differences are given as a share of the largest rise above ambient.

| Case | What | Hottest body, CalculiX | MöbiusCAD | Largest difference anywhere |
|---|---|---|---|---|
| heatsink | Aluminium heatsink (60 × 40 mm base, six 25 mm fins) on a 15 W copper heater, open faces at 10 W/(m²·K) | 109.47 °C | 109.41 °C (−0.08 %) | **0.14 %** |
| board | Board 100 × 80 × 1.6 mm, 0.8 W/(m·K), five parts making 6 W, open faces at 10 W/(m²·K) | U1 157.59 °C | 152.79 °C (−3.6 %) | 9.4 % (at a part's corner) |
| chassis | The board on four brass standoffs over an aluminium plate held at 40 °C underneath, three parts making 5 W, 6 W/(m²·K) | A 224.35 °C | 197.95 °C (−13.2 %) | 15.3 % |

Per body (hottest temperature, difference of its rise):

| Case | Body | CalculiX °C | MöbiusCAD °C | Difference |
|---|---|---|---|---|
| board | U1 (2 W, 20 W/(m·K)) | 157.59 | 152.79 | −3.6 % |
| board | Q1 (1.5 W, 50 W/(m·K)) | 133.46 | 126.06 | −6.8 % |
| board | R1 (0.5 W) | 90.87 | 90.13 | −1.1 % |
| board | U2 (1.2 W, 1 W/(m·K)) | 96.11 | 96.06 | −0.1 % |
| board | L1 (0.8 W) | 89.20 | 88.30 | −1.4 % |
| chassis | A (2.5 W) | 224.35 | 197.95 | −13.2 % |
| chassis | B (1.5 W) | 141.17 | 127.91 | −11.4 % |
| chassis | C (1 W) | 127.22 | 124.80 | −2.4 % |

The heat balance closes in every case (heat leaving = heat made to 1e-4 W).

CalculiX's own answer has settled: on the board, a mesh 0.6 times the size (131,641 elements) moves U1 from 157.59 to
158.69 °C (0.8 % of the rise) and Q1 from 133.46 to 134.53 °C.

### What limits the boards

The heatsink meets the 3 % target easily. The boards do not with the default settings: the parts come out cooler than
CalculiX, and the difference shrinks as the degree or the number of cells grows, so it is resolution, not the model:

| Case, body | Default (p 4) | Degree 6 everywhere | 8 times the cells, p 4 |
|---|---|---|---|
| board, U1 | −3.6 % | −1.8 % | −2.5 % |
| board, Q1 | −6.8 % | −3.8 % | −2.4 % |
| chassis, A | −13.2 % | −3.8 % (with 400 cells) | −3.4 % |
| chassis, B | −11.4 % | −4.7 % (with 400 cells) | −4.7 % |

Heat from a part that conducts far better than the board leaves through the rim of its footprint and spreads in a
1.6 mm board; the temperature has a kink along that rim, which raising the degree on cells several millimetres across
resolves only slowly. The chassis case is worse by default because its cells are sized by the whole assembly
(8.8 mm against a 1.6 mm board). Both were addressed in 1.695.0, with a third cause found on the way (see below).

### Found and fixed while comparing

Results at a point on the face, edge or corner of one body were sometimes read from a neighbouring body whose cell
reached that point (a thin board's cell spans the space above it): the part's edges showed the board's field carried
on past the board (U1 297 °C in place of 155 °C at its top corner). `Grid.cellOf` now asks the point's own body
whenever a single body's cell is there, and steps along the diagonals as well as the axes to find the body of a point
on an edge or a corner (`tests/unit/sim-thin.test.ts`). It applies to structural results of assemblies too.

## 1.695.0: weighted joints, local passes, cells by the thinnest body

Three changes followed from the comparison above:

1. **Weighted joints.** Where two bodies meet, each side's heat flux is now weighed by the other side's normal
   conductivity (`thermal.ts` `joinWeights`, the weighted interior-penalty form), and so is the penalty. With plain
   averages the poorly conducting board took half the say in the flux leaving a copper or silicon part, which made
   the parts too cool; this was the largest single cause.
2. **Local passes (FR-TSOL-003).** After three passes over every cell, passes 4 to 6 raise the degree only in the
   cells holding most of the remaining change, up to degree 6, as structural studies do. A study still runs three
   passes by default; the passes setting goes up to 6.
3. **Cells by the thinnest body.** An assembly with a body thinner than a third of the default cell (a 1.6 mm
   board) gets cells three times that body's thickness, up to 400 cells (`run.ts` `thermalCellSize`). A transient
   study keeps the old size.

Hottest body, difference of its rise against CalculiX (same CalculiX answers as above):

| Case, body | 1.694.0 default | 1.695.0 default (3 passes) | 1.695.0, 6 passes |
|---|---|---|---|
| heatsink, heater | −0.08 % | −0.08 % | −0.04 % |
| board, U1 | −3.6 % | −1.95 % | −0.76 % |
| board, Q1 | −6.8 % | −3.2 % | −1.55 % |
| board, R1 | −1.1 % | −0.9 % | −0.4 % |
| chassis, A | −13.2 % | −4.0 % | −2.4 % |
| chassis, B | −11.4 % | −3.8 % | −2.5 % |
| chassis, C | −2.4 % | −0.7 % | −0.6 % |

| Case | Cells | Unknowns (3 / 6 passes) | Largest difference anywhere (3 / 6 passes) | RMS (3 / 6) | Time in node (3 / 6 passes) |
|---|---|---|---|---|---|
| heatsink | 298 | 10,430 / 13,741 | 0.14 % / 0.10 % | 0.04 % / 0.03 % | 19 s / 76 s |
| board | 668 | 23,380 / 26,544 | 7.5 % / 5.4 % | 0.77 % / 0.39 % | 31 s / 112 s |
| chassis | 753 | 26,355 / 28,119 | 8.6 % / 6.5 % | 0.65 % / 0.41 % | 45 s / 162 s |

With six passes every hottest body is within the 3 % target; with the default three, within about 4 %. The largest difference anywhere stays at a
part's bottom corner, where it meets the board along a re-entrant edge; the RMS over all nodes is under 1 %. The
heat balance closes in every run.

## 1.715.0: finer around pads

A part's heat enters a board through its pads, a few square millimetres each. With the board's cells three times its
thickness (4.8 mm on a 1.6 mm board) and degree 2 to 4 everywhere, the temperature peak over a pad was smeared out
and the hottest parts came out cool. The bench case `pads` checks this: a board 80 × 60 × 1.6 mm (0.8 W/(m·K)) with
copper pads 0.05 mm thick under three parts, 3 W put on the pads (U1 eight pads 1.4 W, Q1 a tab 1.2 W, R1 two pads
0.4 W) and 1 W in the bodies, open faces at 10 W/(m²·K); CalculiX 55,589 nodes, 28,483 tetrahedra.

Now, when heat comes in through patches (Heat from package: the footprint, the package's own regions or the heatsink
faces), the cells under those patches start `PAD_FINE` 2 degrees ahead and their neighbours 1 (`run.ts`
`thermalBoost`, the structural local refinement's `boostOf`), and the board's cells are sized by its thickness up to
1500 cells instead of 400 (`thermalCellSize(..., pads)`).

Hottest body, difference of its rise against CalculiX, 3 passes:

| Body | before (401 cells) | finer degree only | 1.715.0 (1580 cells + finer degree) |
|---|---|---|---|
| board | −4.87 % | −2.60 % | +0.35 % |
| U1 | −3.82 % | −2.21 % | −0.02 % |
| Q1 | −4.87 % | −2.60 % | +0.35 % |
| R1 | −5.81 % | −1.20 % | +0.32 % |

The largest difference anywhere is 4.5 % at Q1's tab corner, the RMS over all nodes 0.16 %, the heat balance closes;
60,130 unknowns in the last pass, 88 s in node. Studies without heat on patches keep their cells.
