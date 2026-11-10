# Part modelling: handover (2026-11-10)

State of the part modelling work. Current thread: "Polish cut-extrude contour preview" (from 13:18Z, branch `claude/project-thread-9th1cp`); before it "Add draft per extrude direction", "Polish modelling to match SolidWorks" and "Continue part modelling from FRS". The requirements are in `docs/FRS-modelling.md`; the code map is in `CLAUDE.md`.

## Where things stand

- `main` is at 1.470.0 (1.472.0 FeatureWorks-style dimensions on recognised sketches in review); aerocat.tech serves 1.469.0. Every row of the FRS gap table (section 13.13 and the feature tables) is Done except two that are partial on purpose:
  - **FR-UI-100** rotation centre: a middle click on an edge pivots about the clicked point, not about the edge's line (the orbit is Z-up).
  - **FR-FT-102** feature recognition on imported bodies. Done: Recognize Holes (1.116.0), Recognize Fillets with chamfers on round edges and two-distance chamfers (1.390.0, 1.398.0), Recognize Extrudes with nested rounds, cuts open to the side, through notches at the outline (1.402.0 to 1.411.0), the base of a prism as sketch + Extrude (1.414.0) and the base of a body of revolution as sketch + Revolve (1.415.0). Left: bodies of revolution with a skew axis (no plane through the axis without a model edge), lofted or swept bases, variable fillets. All are rare in real imports.
- Last slices: PR #336 (1.421.0 Selected Contours, FR-FT-010), #344 (1.428.0 contour hover, Planar Surface contours), #354 (1.451.0 Extrude/Cut/Revolve from the sketch being edited, FR-SK-004), #371 (1.456.0 extrude Direction 2 with any end condition, FR-FT-011), #377 (1.460.0 draft angle for each extrude direction, FR-FT-014).

## Extrude Direction 2 (1.456.0)

`ExtrudeFeature.end2` (`Dir2End`, absent = blind by `depth2`) + `upTo2`/`upToOffset2`/`reverseOffset2`/`upToVertex2`/`upToBody2`. `types.ts`: `hasDir2` (a stale `depth2` under a non-blind end counts only when `end2` is set, so old files keep one direction), `dir2Apart` (blind both ways stays one prism, so face names are unchanged), `dir2Blind`, `clearDir2`, `dir2Feature` (Direction 2 as a one-way extrude with `flip` turned). Kernel `sweep` → `extrudeTools` per direction; Direction 2's names are remapped (`:end` → `:start`, `:start` → `:mid`, `:new:` → `:new2:`) and `unifyAlike` joins the side halves. Controller: focus `upto2`/`upbody2`, `extrudeTarget` returns `upto2|vertex2|body2`, the `depth2` drag arrow, `boxFlow`/`boxPicks` entries. Draft is hidden while the directions are built apart. Tests `tests/unit/extrudeDir2.test.ts`, smoke block "model 1.456" in shard 2.

## Feature recognition code

`src/kernel/model.ts`: `recognizeHoles`, `recognizeBlends` (`blendRound`), `recognizeExtrudes(doc, base = true)` → `extrudeRound` (candidates `Cand`, `rank` = sketch face area), `extrudeFeatures`, `flatFaceAt`, `baseExtrude`, `baseRevolve`, `loopEnts` (3D curves → sketch entities). Every result is accepted only when it rebuilds to the same volume. Tests: `tests/unit/recognize.test.ts` (12 tests; the ones for the Delete Face way pass `false` as the second argument), smoke block "Recognize Extrudes" in shard 1.

## Working habits that held up

- One slice = code + `src/help.ts` (EN and RU) + `src/i18n.ru.ts` + `CHANGELOG.md` with compare links + the `CLAUDE.md` code-map line + the FRS row + a unit test + a smoke check.
- Version: no reserved numbers. Right before merging, merge `main` in and set the version to `main` + 1. `main` moves about every 10 minutes and PR CI takes 10 to 15, so a renumber is normal. After CI was green on a head, a merge of `main` that only changed version, CHANGELOG and version labels was merged at once without a second CI wait.
- After a squash merge the branch is brought level with `git merge -s ours origin/main`; `git diff origin/main --stat` must be empty (a force push is refused in cloud threads).
- Unit tests: `npm ci`, then `node scripts/unit.mjs <name fragment>` (for example `extrudeDir2`), not a path.
- Squash merges always get an explicit title and message (GitHub's default adds a co-author line).
- Release: dispatch `release.yml` on `main` when no Release run started in the last 20 minutes and none covers the version; then check the aerocat.tech pin.
- `check_suite.completed` events can carry an older head: confirm with the PR's check runs before merging.
- `git stash` fails with an intent-to-add file: `git add -A` first.
- Smoke tests can drive touch with a `hasTouch` context and CDP `Input.dispatchTouchEvent` (block "touch 1.394").

## Ideas for a SolidWorks-fidelity pass

- **Done in 1.460.0: draft per direction (FR-FT-014).** `ExtrudeFeature.draft2 { angle, outward }`: the key being present (even at 0° = off) means each direction tapers on its own from the sketch plane; older files have no key and keep one draft over the whole two-way prism. `types.ts` `draftApart` makes `dir2Apart` true for blind both ways, `dir2Feature` takes `draft2` (blind only); Direction 2 side faces are `fid:side2:<ent>` when `draft2` is set. The panel writes `draft2` when Direction 2 or a draft is turned on. Tests: `tests/unit/extrudeDir2.test.ts`, smoke check "model 1.460" inside the "model 1.456" block (shard 2). Gotcha for smoke checks: while a feature is being edited the rebuild is rolled back to it, so volumes leave later features out.
- **Done in 1.463.0:** Selected Contours of a cut are filled in the cut preview's yellow (`CONTOUR_CUT`), a boss's in orange (`CONTOUR_BOSS`), each with a darker outline.
- **Done in 1.465.0: Recognize Features** (`Modeller.recognizeFeatures`, command `recall`): blends, holes and extrudes found on the stripped body, then holes and blends put back after the extrudes by place; a FeatureWorks-like tree (base, cuts, Hole, Fillet) with no Delete Face when the base is found. Tests `tests/unit/recognizeAll.test.ts`, smoke "model 1.465" in the Recognize block (shard 1).
- **Done in 1.467.0: recognised sketches fully defined**: `src/sketch/define.ts` `fullyDefineSketch` (pure, was the editor's `fullyDefine`; `refPts`/`nextDimName` moved there too), controller `defineRecognised` in `recognizeFeatures`/`recognizeExtrudes`. Tests `tests/unit/defineRecognised.test.ts`, smoke "model 1.467" after "model 1.465".
- **Done in 1.472.0:** `fullyDefineSketch(sk, { sizes: true })` (used by `defineRecognised` only) adds the lengths of H/V lines, longest first, before the origin distances; unit test in `defineRecognised.test.ts`, smoke "model 1.472" after "model 1.467".
- **Next slice idea:** the `baseRevolve` refusal below.
- A base made by `baseRevolve` after Recognize Holes is refused, because the Delete Face patches no longer carry the import's face names.
