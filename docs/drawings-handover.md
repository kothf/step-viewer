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
- Standard 3 views: `std3Layout(dx, dy, dz, area, tb, third)` in `views.ts` tries scales from the largest, placing the L-shaped group centred, at the frame edges, left of or above the title block; null falls back to the old `fitScale`.

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
