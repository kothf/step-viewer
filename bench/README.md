# Kernel benchmarks

Node scripts that run the kernel (the full OpenCASCADE build from `node_modules`) on real part files, without a
browser. They are not part of the test suite.

```bash
node bench/run.mjs bench/parts.bench.ts   <folder with .mcadprt> [name filter]   # the worker's "model" request, stage by stage
node bench/run.mjs bench/drawing.bench.ts <folder> [filter]                      # build, facts, four exact views, a preview, a section
node bench/run.mjs bench/prof.bench.ts    <file.mcadprt> [rows]                  # time per Modeller method / OCCT call: open, edit, no change
node bench/run.mjs bench/hlr.bench.ts     <file.mcadprt> front|top|right|iso|section
node bench/run.mjs bench/names.bench.ts   <folder> out.json                      # face names, volume, area, box: diff two builds
PROF=1 node bench/run.mjs ...                                                    # also writes a V8 CPU profile under node_modules/.cache/bench/prof
```

Timings in node are close to Chrome's (same V8, same WASM). Runs differ by 10 to 20 %: compare several.

## What the numbers said (1.558.0, the 37 parts of the model steam engine, 4-core cloud container)

- A rebuild is the features (Booleans: about 50 ms per hole cut into a 30-face body) plus a fixed tail per request:
  mesh, mesh analysis, exact face/edge values, mass and box. The tail was paid in full after every change:
  2.1 s for a nameplate with 441 faces, 0.67 s for a flywheel. With `src/kernel/memo.ts` it is 0.5 s and 0.1 s.
- `BRepBndLib::AddOptimal` is the slow part of the box (0.5 s on a flywheel: tori and spheres are boxed by a
  numeric search). It is kept per face now, so it is paid once.
- `new BRepClass3d_SolidClassifier_3(shape, p, tol)` prepares the solid each time (6 ms); a kept classifier
  answers the next point in well under 1 ms (`stateAt`).
- Exact hidden-line removal (`HLRBRep_Algo::Hide`) is fast (10 to 100 ms a view) except with free-form edges seen
  along a direction in which they overlap themselves or other edges: a rod with a cross hole takes 2 to 7 s in the
  three standard views and 20 ms in an isometric one. Simplifying the curves (`ShapeCustom::BSplineRestriction`)
  gave 5 times at best and turned circles into splines; tilting the view by 1e-3 rad is fast but draws doubled lines.
  Such parts get the quick preview first instead.
- A section's plane 1 µm off a round part's axis makes every cone and torus outline a free-form curve: the cut
  and the projection of a stepped shaft with fillets took 3.4 to 5.3 s, on the plane 0.15 to 0.55 s.
- The fast path (`projectFast`: polygonal HLR + exact lines and arcs) is not a drop-in for small parts: hidden
  lines come out in many short pieces and the first view pays for a fine mesh (1.7 s on the cylinder part).

## Not done, in order of expected gain

- A persistent cache of built parts (BREP + names + analysed mesh by a hash of the part document and the
  worker's code) would make re-opening assemblies and drawings skip the rebuild altogether.
- The OpenCASCADE build uses JavaScript exception handling (678 `invoke_*` trampolines); a rebuild with WASM
  exceptions and `-O3` should speed every kernel call up by a fifth or more and shrink the 50 MB file, at the
  price of maintaining our own build of opencascade.js.
- Hole cuts: each hole's cylinder is intersected with every body face whose box it overlaps (a big round body's
  faces overlap everything).
