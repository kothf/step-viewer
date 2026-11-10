# Part modelling: handover (2026-11-10)

State of the part modelling work when the thread "Continue part modelling from FRS" stopped. The requirements are in `docs/FRS-modelling.md`; the code map is in `CLAUDE.md`.

## Where things stand

- `main` is at 1.415.0. Every row of the FRS gap table (section 13.13 and the feature tables) is Done except two that are partial on purpose:
  - **FR-UI-100** rotation centre: a middle click on an edge pivots about the clicked point, not about the edge's line (the orbit is Z-up).
  - **FR-FT-102** feature recognition on imported bodies. Done: Recognize Holes (1.116.0), Recognize Fillets with chamfers on round edges and two-distance chamfers (1.390.0, 1.398.0), Recognize Extrudes with nested rounds, cuts open to the side, through notches at the outline (1.402.0 to 1.411.0), the base of a prism as sketch + Extrude (1.414.0) and the base of a body of revolution as sketch + Revolve (1.415.0). Left: bodies of revolution with a skew axis (no plane through the axis without a model edge), lofted or swept bases, variable fillets. All are rare in real imports.
- Last slices: PR #326 (1.411.0), #328 (1.414.0), #329 (1.415.0).

## Feature recognition code

`src/kernel/model.ts`: `recognizeHoles`, `recognizeBlends` (`blendRound`), `recognizeExtrudes(doc, base = true)` → `extrudeRound` (candidates `Cand`, `rank` = sketch face area), `extrudeFeatures`, `flatFaceAt`, `baseExtrude`, `baseRevolve`, `loopEnts` (3D curves → sketch entities). Every result is accepted only when it rebuilds to the same volume. Tests: `tests/unit/recognize.test.ts` (12 tests; the ones for the Delete Face way pass `false` as the second argument), smoke block "Recognize Extrudes" in shard 1.

## Working habits that held up

- One slice = code + `src/help.ts` (EN and RU) + `src/i18n.ru.ts` + `CHANGELOG.md` with compare links + the `CLAUDE.md` code-map line + the FRS row + a unit test + a smoke check.
- Version: no reserved numbers. Right before merging, merge `main` in and set the version to `main` + 1. `main` moves about every 10 minutes and PR CI takes 10 to 15, so a renumber is normal. After CI was green on a head, a merge of `main` that only changed version, CHANGELOG and version labels was merged at once without a second CI wait.
- After a squash merge the branch is brought level with `git merge -s ours origin/main`; `git diff origin/main --stat` must be empty.
- Squash merges always get an explicit title and message (GitHub's default adds a co-author line).
- Release: dispatch `release.yml` on `main` when no Release run started in the last 20 minutes and none covers the version; then check the aerocat.tech pin.
- `check_suite.completed` events can carry an older head: confirm with the PR's check runs before merging.
- `git stash` fails with an intent-to-add file: `git add -A` first.
- Smoke tests can drive touch with a `hasTouch` context and CDP `Input.dispatchTouchEvent` (block "touch 1.394").

## Ideas for a SolidWorks-fidelity pass

- Recognised features get default names and no dimensions in their sketches; Fully define sketch (`fullyDefine`) could run on them.
- Recognize Extrudes leaves round pockets to Recognize Holes; one "Recognize features" command that runs fillets, holes, extrudes and the base in the right order (blends first) would match FeatureWorks better.
- A base made by `baseRevolve` after Recognize Holes is refused, because the Delete Face patches no longer carry the import's face names.
