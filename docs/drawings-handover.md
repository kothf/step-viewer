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

## Ideas for next slices (none started)

- **Centre marks on views at an angle**: end-on tests use `|ax·n| ≈ 1` (1e-6). Isometric views get no marks at all, which matches SolidWorks, so leave them unless asked.
- **Performance**: big assemblies spend most time in `HLRBRep_Algo`. Previews (`projectPoly`) already cover the wait; projecting views in parallel across the kernel pool (`src/kernel/pool.ts`) is the next step.
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
