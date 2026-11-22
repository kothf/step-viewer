# What MöbiusCAD needs from the board design app

This is the export a board design app (Tube Amp CAD) writes so that MöbiusCAD can show the board's thermal map, put the board's copper under it and make a board study from it. The full read contract is section 15.2 of `docs/FRS-thermal.md`; this page is the short list for the app's side. It is valid from MöbiusCAD 1.683.0.

## One file to hand around

Write one ZIP, `<name>-thermal.zip`:

```
<name>-thermal.zip
  <name>-thermal.json        manifest                            required
  <name>-thermal.vtu         surface temperatures (VTK XML)      required
  <name>-heat-sources.csv    one row per heat source             recommended
  <name>-thermal.png         3D view with legend                 optional
  README-thermal.txt         plain text for people               optional
  <name>.step                the board's STEP                    recommended
  gerber/                    the board's Gerber and drill files  recommended (new)
```

With the STEP and the `gerber/` folder inside, opening the ZIP alone does everything:

1. The STEP opens.
2. The map goes on its bodies.
3. The copper and silkscreen show under the temperatures.
4. **Simulate** makes a board study whose board conducts heat along its real copper.

## Required

- **Manifest** `<name>-thermal.json`:
  - `"format": "tubecad-thermal"` and `"version": 1`.
  - `files.mesh` naming the `.vtu`.
  - `parts`: one entry per part, with `part_id`, `designator`, `step_bodies`, `bbox_mm` and `p_total_W`.
  - Unknown keys are ignored, so you can add your own.
- **Mesh** `<name>-thermal.vtu`:
  - Uses the STEP's frame: mm, x right, y up, z up from the board's bottom face.
  - `Temperature_C` per point.
  - `PartId` per cell: 0 for the board, 1…n for `part_id`.
  - `Face` per cell: 0 for a part, 1 for the board top, 2 for the board bottom, 3 for the board edge.
  - Triangles or quads. ascii, base64 binary or zlib all work.
- **Body names in the STEP**: each part's solids are named as in its `step_bodies` (the `MANIFOLD_SOLID_BREP` names). This is how parts are matched to bodies. When names are missing, MöbiusCAD falls back to `bbox_mm`, which is less reliable.

## Recommended

- **`<name>.step` inside the ZIP**, named in `files.step`. Without it, the user has to open the STEP first and then add the map.
- **`gerber/` folder** holding the files the board was made from:
  - Every copper layer.
  - The board outline.
  - The drill files, plated and non-plated.
  - Silkscreen and solder mask too, if you like; they only change how the map looks.
  - Name the folder in `files.gerber` if it is not called `gerber`.
  - Layers are recognised in this order:
    1. The Gerber X2 `%TF.FileFunction` attribute (best: `Copper,L1,Top`, `Copper,L2,Inr`, `Copper,L4,Bot`, `Profile`, `Legend,Top`, `Soldermask,Top`).
    2. The usual suffixes: `.gtl`/`.gbl` copper, `.gto`/`.gbo` silkscreen, `.gts`/`.gbs` mask, `.gko`/`.gm1` outline.
    3. KiCad-style names such as `-F_Cu`, `-B_Cu`, `-Edge_Cuts`.
  - Drill files that say `PTH`/`NPTH` in their name (or carry X2 `Plated`/`NonPlated`) let the plated holes add heat paths through the board.
  - Put the Gerber in the same x, y frame as the STEP if you can. MöbiusCAD centres the outline on the board anyway, and the user can nudge it, but the same frame needs no nudging.
- **Heat-source CSV** with the columns in section 15.2. It carries:
  - `p_board_W` / `p_air_W` / `p_sink_W`: the split of each part's heat. A board study uses it to put each part's board share into the board under its footprint.
  - `t_limit_C`, `t_kind` and `life_h`: the limits and capacitor life shown in the Parts and Problems lists.
- **`settings`** in the manifest:
  - `ambient_C`, `enclosure` (`open` / `vented` / `closed`) and `orientation` (`horizontal-up`, `horizontal-down`, `vertical`). A board study takes its ambient, natural convection and gravity from these.
  - `emissivity`.
  - `operating_point`.
  - `accuracy_C` and `range_C`, for the legend.

## New optional key: the board's copper stack

```json
"board": { "layers": 2, "copper_um": 35, "coverage": 0.4 }
```

The keys are the number of copper layers, the copper thickness per layer in µm, and the share of each layer that is copper (0 to 1). **Simulate** starts the board study's board with this stack instead of MöbiusCAD's default of 2 layers, 35 µm and 40 %. With a `gerber/` folder, the coverage is read from the copper itself, so only `layers` and `copper_um` matter then.

## Without the ZIP

The same files can also travel loose:

- Open the STEP, the thermal ZIP and the Gerber files together.
- Or drop Gerber files onto the board while its map or a board study is open.
- In a vault, keep `<name>.step`, `<name>-thermal.zip` and `<name>-gerber.zip` in one folder. Opening either the STEP or the thermal ZIP brings the other two along.
