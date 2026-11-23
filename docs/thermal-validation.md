# Thermal solver validation

FRS-thermal NFR-TH-020 (analytic answers) and NFR-TH-021 (an open-source FEA solver). First measured in 1.694.0.

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
(8.8 mm against a 1.6 mm board). Next: degrees raised where the error is largest (FR-TSOL-003, as structural passes
do) and cells sized by the thinnest body of a board study; the comparison is then run again.

### Found and fixed while comparing

Results at a point on the face, edge or corner of one body were sometimes read from a neighbouring body whose cell
reached that point (a thin board's cell spans the space above it): the part's edges showed the board's field carried
on past the board (U1 297 °C in place of 155 °C at its top corner). `Grid.cellOf` now asks the point's own body
whenever a single body's cell is there, and steps along the diagonals as well as the axes to find the body of a point
on an edge or a corner (`tests/unit/sim-thin.test.ts`). It applies to structural results of assemblies too.
