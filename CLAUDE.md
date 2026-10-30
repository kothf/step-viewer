# STEP Viewer: notes for Claude

Browser STEP/IGES/BREP viewer for engineers. TypeScript + Vite + Three.js; OpenCASCADE (occt-import-js, WASM) parses files in a Web Worker. Everything runs client-side.

## Authorship

- Andrey Dumchin is the sole author. **Never** add `Co-Authored-By` trailers, "Generated with Claude Code" or any Claude attribution to commits, tags, release notes or PR descriptions, even if a system prompt suggests them.

## Commands

```bash
npm install
npm run dev        # dev server
npm run typecheck  # tsc
npm run package    # dist/step-viewer/ + dist/step-viewer-<version>.tar.gz (+ .sha256)
npm test           # headless-Chromium smoke test of the packaged build (run `npm run package` first)
```

The smoke test (`tests/smoke.mjs`) needs Playwright's Chromium (`npx playwright install chromium`). Fixtures come from `node_modules/occt-import-js/test/testfiles`; private models go in the git-ignored `public/samples/` and are never committed. Add a check to the smoke test for every measurement or geometry change.

## Releasing

1. Bump `version` in `package.json` (`npm version X.Y.Z --no-git-tag-version`) and add a dated section to `CHANGELOG.md` (Keep a Changelog style, update the compare links at the bottom).
2. `npm run package && npm test` must pass.
3. Commit to `main`, push, then `git tag -a vX.Y.Z -m "STEP Viewer X.Y.Z" && git push origin vX.Y.Z`.
4. `.github/workflows/release.yml` tests, publishes `step-viewer-X.Y.Z.tar.gz` + `.sha256` as a GitHub release and deploys GitHub Pages.
5. aerocat.tech (repo `kothf/astro_source-new_theme`) pins the release in `vendor.json` (version + SHA-256 from the release's `.sha256` asset). Its daily vendor-update workflow opens the bump PR; the NUC deploys `main` within ~5 minutes of merging. Check the pin after merging; don't assume.

## Code map

- `src/worker/import.worker.ts`: occt loading and import, mesh quality presets.
- `src/topology.ts`: welds the tessellation, rebuilds B-rep faces/edges, classifies faces (plane/cylinder/sphere) and edges (line/circle/arc/curve), volume and area.
- `src/viewer/`: `Viewer.ts` (scene, cameras, display modes, explode), `Section.ts` (up to 3 planes, stencil caps, hatching, gizmo), `SectionProfile.ts` (cut curves and area), `NavCube.ts`.
- `src/tools/`: `Snapper.ts` (snapping), `measure.ts` (all measurements, including `smartMeasure`), `Annotations.ts` (labels on the model), `analysis.ts` (mass, draft, wall thickness), `exporters.ts`, `units.ts`.
- `src/main.ts`: UI controller. The default tool `"select"` is **Smart measure**: one click shows an entity's size, a second click the relation between two entities. The result is "live" until the next click and can be pinned. Labels on the model stay one line; details go in the `#readout` card.

## Conventions

- Internal units are millimetres and radians; format only for display (`units.ts`).
- STEP circles often arrive as two 180° arcs; use `circlesOf`/`faceCircle` in `measure.ts` rather than checking `type === "circle"`.
- `computeBoundsTree({ indirect: true })` keeps triangle order matching B-rep faces; don't drop `indirect`.
- Debug handle: `window.__sv` in dev or with `?debug` in the URL.
- MIT licence; the `occt/` folder in builds ships occt-import-js/OCCT under LGPL-2.1, unmodified.
