# MöbiusCAD (step-viewer): notes for Claude

Browser STEP/IGES/BREP viewer for engineers, plus a 2D Gerber/Excellon PCB view. TypeScript + Vite + Three.js; OpenCASCADE (occt-import-js, WASM) parses files in a Web Worker. Everything runs client-side.

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

1. Bump `version` in `package.json` (`npm version X.Y.Z --no-git-tag-version`) and add a dated section to `CHANGELOG.md` (Keep a Changelog style, update the compare links at the bottom). `npm run release-notes -- X.Y.Z` must print it.
2. `npm run package && npm test` must pass locally.
3. Get it onto `main` (merge the PR, or commit and push). CI runs on every commit on `main`.
4. Release with **Actions → Release → Run workflow** on `main`; Claude starts it without asking as soon as the bump is on `main` (from the cloud: the GitHub `actions_run_trigger` tool, workflow `release.yml`, ref `main`). It releases `package.json`'s version (or the one typed in), reuses that commit's CI result (testing itself only if CI has no finished run), and tags `main` itself once that passes, so no tag push is needed. Pushing a `vX.Y.Z` tag by hand still works the same way. Don't create releases in GitHub's Releases page: the workflow makes them.
5. `.github/workflows/release.yml` publishes `step-viewer-X.Y.Z.tar.gz` + `.sha256` as a GitHub release, deploys GitHub Pages and, with the `SITE_DISPATCH_TOKEN` secret set, starts aerocat.tech's vendor update at once.
6. aerocat.tech (repo `kothf/astro_source-new_theme`) pins the release in `vendor.json` (version + SHA-256 from the release's `.sha256` asset). Its vendor-update workflow (dispatched by the release, otherwise daily) opens the bump PR; the NUC deploys `main` within ~5 minutes of merging. Check the pin after merging; don't assume.

## Code map

- `src/worker/import.worker.ts`: occt loading and import, mesh quality presets.
- `src/topology.ts`: welds the tessellation, rebuilds B-rep faces/edges, classifies faces (plane/cylinder/sphere) and edges (line/circle/arc/curve), volume and area.
- `src/viewer/`: `Viewer.ts` (scene, cameras, display modes, explode), `Section.ts` (up to 3 planes, stencil caps, hatching, gizmo), `SectionProfile.ts` (cut curves and area), `NavCube.ts`.
- `src/tools/`: `Snapper.ts` (snapping), `measure.ts` (all measurements, including `smartMeasure`), `Annotations.ts` (labels on the model), `analysis.ts` (materials, mass properties), `exporters.ts`, `units.ts`, `csys.ts` (active user coordinate system: positions, directions and axis deltas are re-expressed only when formatted; stored values stay world mm).
- `src/gerber/`: PCB view (Canvas 2D, no Three.js). `gerber.ts` (RS-274X/X2 parser, apertures and macros), `excellon.ts`, `load.ts` (zip, sniffing, layer classification, default colours), `build.ts` (path batches for drawing/SVG, packed features for picking), `geom.ts` (hit tests, clearance, grid), `GerberView.ts` (view, snapping, tools, measurements, export), `panel.ts` (side panels). Fixtures in `tests/fixtures/pcb/`; `#app.gerber` switches the UI (`.gerber-only` / `.step-only`).
- `src/ui.ts`: shared UI pieces (toasts, modal focus trap and confirm dialog, collapsible panels and phone sheets, tabs, busy buttons, empty states). UI/UX rules (contrast, focus, breakpoints 1280/768) are checked by axe-core and layout checks in the smoke test.
- `src/i18n.ts` + `src/i18n.ru.ts`: EN/RU. English text is the key; `t("…", { n })` in code, and static or code-built markup whose whole text is a key is translated in the DOM by a MutationObserver (`translate="no"` keeps file/part names). Add every new UI string to `i18n.ru.ts`; the smoke test fails on English left in the Russian UI. Views with interpolated text re-render via `onLangChange`. Stored data (measurement titles, layer labels) stays English and is translated when shown (`tx`, `layerLabel`); PDF/CSV/JSON exports stay English (`withLang("en", …)`).
- `src/help.ts` (Help dialog content, both languages; the About tab lists credits from the build's `credits.json`, written by `scripts/credits-plugin.mjs` from the bundled packages, with licence texts in `THIRD-PARTY-LICENSES.txt`; non-bundled code such as occt goes in its `extra` option in `vite.config.ts`), `src/hints.ts` (first-use tips, shown once each).
- `src/main.ts`: UI controller. The default tool `"select"` is **Smart measure**: one click shows an entity's size, a second click the relation between two entities. The result is "live" until the next click and can be pinned. Labels on the model stay one line; details go in the `#readout` card.

## Conventions

- Internal units are millimetres and radians; format only for display (`units.ts`).
- STEP circles often arrive as two 180° arcs; use `circlesOf`/`faceCircle` in `measure.ts` rather than checking `type === "circle"`.
- `computeBoundsTree({ indirect: true })` keeps triangle order matching B-rep faces; don't drop `indirect`.
- Debug handle: `window.__sv` in dev or with `?debug` in the URL.
- MIT licence; the `occt/` folder in builds ships occt-import-js/OCCT under LGPL-2.1, unmodified.
