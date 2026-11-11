# Drawings thread: handover

Written for whoever continues drawing work (FRS section 11, `FR-DRW-…`). The CLAUDE.md "Drawings" line is the code map. It gives every release from 1.64.0 to 1.374.0 with its functions and fields. This file covers how the work runs, what is left, and the traps.

## Scope

- Yours:
  - `src/drawing/*` and `src/kernel/drawing.ts`.
  - The drawing smoke blocks in `tests/smoke.mjs`.
  - `tests/unit/drawing.test.ts`.
- Don't edit `src/model/*`, `src/sketch/*`, `src/kernel/model.ts` or `src/asm/controller.ts`. Other threads own them.
- Shared files are append-only. Add your lines and don't rewrite others':
  - `package.json`
  - `CHANGELOG.md`
  - the CLAUDE.md Drawings line
  - `src/i18n.ru.ts`
  - `src/help.ts`, where Drawings is the long `<li>` in both the EN and RU halves
- Every new UI string needs an entry in `i18n.ru.ts`. The smoke test fails on English left in the Russian UI.

## How a slice runs

1. Branch: develop on the thread branch.
   - After each merge, restart it from main:
     `git fetch -q origin main <branch> && git checkout -q -B <branch> origin/main && git merge -q -s ours origin/<branch> -m "Merge previous branch state" && git push -q -u origin <branch>`
   - The auto-mode classifier refuses force-push and `git reset --hard`, so restart this way.
2. Code and tests:
   - Pure helpers go in `annot.ts`/`compose.ts`.
   - Unit tests build real parts with `Modeller.evaluate`. `block()` and `rect()` at the top of `drawing.test.ts` help with that.
   - Add a smoke block (part via `#file-input` + `.mcadprt` zip, New ▾ → New drawing, read `window.__sv.drw.prims()`).
   - Put it in its own `if (inShard(k))` on the shard that was shortest in the last CI.
   - To run one block alone, mark it `inShard(5)`, run `npm run package && SMOKE_SHARD=5/100 npm test`, then switch it back.
3. Checks:
   - `npm run -s typecheck`
   - `node scripts/unit.mjs drawing` (62 tests at 1.341.0), then `node scripts/unit.mjs` (everything)
4. Release files:
   - `npm version X.Y.Z --no-git-tag-version`.
   - Add a CHANGELOG section and update the compare links (`[Unreleased]` → vX, `[X]` compare from the previous version).
   - `npm run release-notes -- X.Y.Z` must print it.
   - Add a note at the end of the CLAUDE.md Drawings line and a sentence in Help (EN + RU).
5. Open a draft PR:
   - The body starts with `<!-- claude-projects-attribution -->` and `_Requested by **Andrey** · project thread_`.
   - Add no Claude attribution anywhere: no Co-Authored-By, no "Generated with" (CLAUDE.md: Andrey is the sole author).
   - Subscribe to the PR.
6. Order: the coordinator hands out version numbers and merge order. Wait for your turn (the thread before you says when it merged, or main reaches the version before yours).
7. Merge (Andrey's batch rule, 2026-11-09):
   1. Merge main into the branch.
   2. Conflicts are usually only `package.json`, `package-lock.json`, `CHANGELOG.md` and `CLAUDE.md`:
      - package files: `git checkout --theirs` both, then `npm version` yours again.
      - CHANGELOG: put your section above main's newest and fix the links.
      - CLAUDE.md: keep yours for the line starting `- Drawings`, theirs for the rest.
   3. Run typecheck and unit tests locally.
   4. If the merge had no code conflicts, mark the PR ready and squash-merge right away. If it had code conflicts, push and wait for CI first.
   5. Squash-merge with `merge_pull_request`, passing `commit_title`, `commit_message` (no attribution: GitHub's default adds `Co-authored-by: Claude`) and `expectedHeadSha`.
8. After the merge:
   - Tell the next thread in the queue.
   - If the next PR is ready right behind you, don't release; hand the release to it.
   - Otherwise wait for CI on main's latest commit and run `release.yml` on `main` (`actions_run_trigger`).
   - Then check `https://aerocat.tech/tools/mobiuscad/VERSION`.

## State on 2026-11-10 (thread "Continue drawings polish further")

- Released through 1.473.0 (#391: `FAST_EDGES` 1500, `std3Layout` 85 % margin only when enlarging). 1.476.0 (this thread's first PR): two drawing workers and the empty fast view fallback below.
- Big assemblies (drawings exam round two): `projectAuto` in `src/kernel/drawing.ts` picks `projectFast` from `FAST_EDGES` edges up. `projectFast` = `projectPoly` at diag/1000 and 0.1 rad, then `exactify` (chords chained by `chains`, straight runs → lines snapped to `viewCurves` model lines, runs on end-on circles → exact arcs, the rest polylines), `mergeLines`, `underLines`, `unhide`. `?fasthlr` forces it (smoke block in shard 3). Known look: a shaft end seen at a slant can come out dotted (the mesh HLR flickers along it); a "speck makes the hidden curve visible" rule was tried and made hidden lines visible, so it was dropped.
- Exam round three (1.474.0): the older engine copy (desktop Projects/drawings-exam/parts/engine.mcadasm) got Standard 3 views at 1:2 in ~2 min, but every view came back with vis = hid = 0 from `projectFast` (only centre lines on the sheet). Cause not found (the file is only on the desktop; the newer project-files copy works). 1.476.0 guards it: no visible lines → `BRepTools.Clean` + a diag/300, 0.5 rad mesh (what previews use, which worked on that file) → else exact `project`. `projectPoly` now collects getter exceptions in `Projection.fail` and `projectFast` logs them with `console.warn`, so the exam can report the real reason. If the exact fallback is then too slow, the doc's earlier idea stands: switch by time, not by edge count.
- Parallel views (1.476.0): `DrawingKernel` runs exact requests through `exact`/`pump`, one at a time on the main worker and one on a helper `Lane` (same model, `lite` load). Previews and `config`/`diff`/`load` stay on the main worker. Smoke check "drawing 1.476" (shard 6, the body-materials drawing block, `?drwhelper=1`).
- Exam retest of #394 on the older engine: works; only Front needed the exact fallback (15.8 s), Top/Right fast. The helper starts only for models under `FAST_EDGES` (memory: an engine2 tab crashed after Standard 3 views on 1.474.0).
- Fixed in 1.478.0 by recycling the worker (see CLAUDE.md); was: (exam, 1.474.0, engine2.mcadasm) Alternate position on Front (component c_hco8zi9c9, du 20, dv 49) failed with "OpenCASCADE error 24", no phantom, and the tab later fell back to the 3D assembly (likely out of memory). Next: reproduce with the project-files engine (`alt` request in a unit test: Assembler + the worker's alt steps), see whether the moved compound or `projectAuto` throws; the exam script is desktop drawings-exam/link/talt.js.
- Progress (1.478.0, exam round three ask): status line shows projections in flight and the restart; the restart reloads lite. Still open: the phantom of a moved flywheel took ~150 s on engine2 in the exam, mostly queueing behind Standard 3 views plus the restart; a warm standby worker would cut the restart but holds a second engine copy (that crashed a tab before), so it was not done.
- Memory (1.478.0, 1.480.0): measured in node on the project-files engine (`oc.HEAP8.length`; divide by 1048576, `>> 20` overflows past 2 GB). Each fast view grew the heap ~100 MB. 1.480.0: `polyEdges` and `viewCurves` delete every wrapper (~35 MB), and `projectPoly` reuses one `HLRBRep_PolyHLRToShape` per oc (`polyReader`): deleting one never gave its memory back (~25 MB per view), `Update` on a kept one reuses it. Left: ~40 MB per view, almost all from `HCompound_1` (hidden sharp edges; the other five getters do not grow), inside OCCT, so `recycle()` stays. `HLRBRep_PolyAlgo.Hide`/`Show` (a way round the reader) are unbound in opencascade.js (`HLRAlgo_BiPoint::PointsT`). Hidden lines are needed by default (orthographic views are HLV). One fast view takes ~2.3 s on the engine, so the exam's ~150 s Standard 3 views are mostly elsewhere (exact HLR of the helper lane, queueing, restarts); profile that next.
- Speed (1.481.0): node profile of the engine sheet load: Assembler.evaluate 10 s, `topology` 45 s (204 whole-compound `BRepClass3d_SolidClassifier_3` calls for hole ends), previews ~1 s each, fast views 2-8 s each. `topology` now classifies per solid (1.1 s). Next big cost is the 10 s `Assembler.evaluate` (done twice: main worker load and each recycle) and the first fast view's 8 s (meshing at diag/1000).
- Snapshot (1.482.0): a full load returns `snap` (`ModelSnap`: the shape as BREP text via `shapeBrep`, plus names, materials and the placed component ids/materials; ~1 MB / 0.2 s for the engine); `recycle()` and the helper's load send it with `lite`, and the worker's `readSnap` reads it (`readShape` + `childShapes` for `placedShapes`) instead of evaluating (12 s → 0.3 s). Topology from the snapshot equals the original to 1e-6, exact HLR visible lines are the same, fast HLR differs by a line or two (remeshing). Left: the first fast view's 8 s meshing. 1.483.0: the snapshot is binary BREP (`shapeBin`/`readBin`: engine 0.2 s write, 0.3 s read) and the first fast view of the whole shape sends it again with its mesh (11 MB; a restart then skips the 5.7 s mesh, BRepMesh only checks it, ~0.8 s). Left: the first fast view still meshes once (5.7 s at diag/1000, 0.1 rad); poly HLR ~2 s per view.
- Sheet redraws (1.487.0): a browser profile of the engine sheet (headless Chromium, 60 s) showed only ~20 s of kernel work; the rest was 66 redraws of a 2.3 MB SVG, because every render re-asked each pending view and added one more `renderSheet` for when it landed. Now asked once and redrawn once per landing (`renderSheetSoon`): 40 s. Left on that sheet: drawing worker init 3-5 s + load 12-13 s (Assembler.evaluate), first fast view ~9 s (5.7 s mesh), previews ~2-3 s each, later views ~3-5 s each; the palette then projects 4 more directions (fast views, ~3 s each) after the sheet is ready.
- Sections (1.491.0, exam round four): a plain section through the engine's crank axis never finished. Cause: `BRepAlgoAPI_Cut` is pathologically slow when the cutting plane holds a revolved face's axis (the piston alone: 156 s exact, 79 s fuzzy, 0.1 s with the plane 1 µm off). `section` now moves the plane (and a staircase's legs) `SECTION_NUDGE` 1e-3 mm towards the viewer and `cutSolids` cuts each solid on its own (bbox: wholly behind = kept, wholly in front = dropped; for polygon/stair cutters only the cutter bbox test); `sectionEdges` moves cut edge points back by the nudge. Engine: 12 s (cut ~4 s, projection ~7 s). Unit tests' area tolerances allow the 1 µm sliver. Left: sections get no fast preview (`previewFor` skips them); a quick one would be the poly HLR of the cut shape.
- Load from the open assembly (1.501.0): a drawing of the assembly open in 3D gets the placed shapes from the assembly's kernel worker (`asmSnap`, warm `Assembler.evaluate` ~3 ms + binary BREP ~50 ms) instead of the drawing worker evaluating every part (engine: 11.2 s cold); the drawing worker then only reads it (~60 ms) and computes topology (~1.2 s). Only when the drawing's `flat` equals the assembly's `expanded.doc` (asking the kernel worker for another doc would rebuild it and lose the 3D cache). Left on the engine sheet: drawing worker init 3-5 s, the first fast view, previews.
- Cancelling (1.491.0): `DrawingKernel.drop(keep)` (wanted keys from the workspace's `dropGone` on every store change) rejects queued jobs with `DROPPED`, stops a helper running a dropped job and recycles the main worker when its running job is dropped. `lastShown` keeps each view's last exact projection while one with a new style/config is coming (drawn as a preview, same direction only).
- Standard 3 views: `std3Layout(dx, dy, dz, area, tb, third)` in `views.ts` tries scales from the largest, placing the L-shaped group centred, at the frame edges, left of or above the title block; null falls back to the old `fitScale`.

- Section previews (1.494.0): the old blank frame while a section's exact lines ran is gone. Measured in node on the project-files engine (centre, Front and Right sections): cut 2.0 / 2.8 s, preview (poly HLR of the cut) 0.4 / 0.5 s, exact finish 5.8 / 2.9 s. The preview's cut is stashed in the worker and reused by the exact request, so only the preview's ~0.4 s is added. When the exact job goes to the helper lane (small models), the helper cuts again.

- Box cache (1.495.0), node on the engine: `AddOptimal` box 0.9 s, `shapeInfo` 1.2 s, called by every `projectAuto` and preview; now once per shape. Left on a sheet: the first fast view's diag/1000 mesh (5.3 s, BRepMesh, single-threaded wasm), and previews after that mesh are slower (0.7 s → 1.9 s: the poly HLR works on the finer mesh, which BRepMesh keeps).

## Ideas for next slices (none started)

- **Centre marks on views at an angle**: end-on tests use `|ax·n| ≈ 1` (1e-6). Isometric views get no marks at all, which matches SolidWorks, so leave them unless asked.
- **Performance**: done in 1.476.0 with two drawing workers. More than two would cost one more model copy each; measure before adding.
- Check the FRS (`docs/FRS-modelling.md`, FR-DRW-001..031) and Appendix G for drawing items marked partial.

## Gotchas

- `centreMarks` (annot.ts) draws in this order:
  1. end-on circles grouped by 3D centre and radius;
  2. straight slots (`straightSlots`), then arc slots (`arcSlots`, deduped by `slotKeys`);
  3. hole rows (`holeLines`), then bolt circles (`boltCircles`) on the remaining holes, then plain crosses;
  4. side-on axes from `topo.cyls` plus `topo.revs` (cones, tori, revolved faces).

  Keep that order: rows before bolts, because no three bolt-circle holes lie on a line.
- The 2 mm overshoot of centre lines is in sheet mm (`ext = 2 / pl.s`), so in model mm it depends on the view scale. Smoke checks must not assume 1:1.
- STEP splits circles into two 180° arcs. Group by centre and radius, never trust `t === "circle"` alone.
- `topology` names edges by the sorted names of the faces they join (`MEdge.k`). Component-only views filter by the `<comp>@` prefix in `topoOnly`, which also covers `revs`.
- Sheet labels follow the UI language in every export (what you see is what you get), unlike reports.
- PDF uses DejaVu Sans, so Cyrillic works. Text widths come from `textWidth.ts`.
- Previews (`drw-preview`) are screen-only. Picking, annotations and exports always wait for exact projections.
- The workspace keeps topology per view in `factsOf(viewId)`. Configurations, component-only views and section cut edges (`withCut`) each change it, so always go through `factsOf` / `ctx().forView`.
- Smoke runtime: each drawing block opens its own browser context, which costs ~10 s. Prefer extending an existing block when the model fits.
- Fast mesh angle (1.497.0), node on the engine Front view: the diag/1000 mesh at 0.1 rad took 5.9 s and the poly HLR 2.2 s; at 0.3 rad 1.8 s and 1.0 s (0.5 rad: 1.2 s / 0.8 s). Visible lines sampled every 0.5 mm agree within 0.6 mm (1.2 chord errors) for all but ~0.1 % of their length both ways; the few differences are mesh-dependent visibility of near-coincident lines, present at 0.1 too. The chord bounds the sag, so the angle only refined small round features. Left on a sheet: `Assembler.evaluate` on load, the drawing worker's init.
- Preview retry (1.497.0): main CI on 1.495.0 failed the section-preview smoke check with `errs: ["The drawing kernel stopped" ×2]`: placing the section dropped the other side's running exact job, `drop` → `recycle()` rejected the pending previews, and previews are asked only once. `preview()` now asks again once on the restarted worker (`again`) unless the exact projection landed first.
