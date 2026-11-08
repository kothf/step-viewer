# Changelog

All notable changes to MöbiusCAD (formerly STEP Viewer) are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.118.0] - 2026-11-08

### Added

- Motion studies: the key point menu (right-click a key, the menu key or Shift+F10) sets how the motion runs into the key, as in SolidWorks: Linear, Snap (jump: the value holds, then jumps at the key), Ease in, Ease out or Ease in/out. Keys show it by their shape (FR-FT-122).
- Copy and paste keys: Ctrl+C copies the selected key, Ctrl+V pastes it onto the selected track at the playhead; right-clicking an empty part of a track offers Add key here and Paste here. Keys paste onto tracks of the same kind (a distance key onto distance mates, an angle key onto angle mates).

## [1.116.0] - 2026-11-08

### Added

- **Recognize Holes (FR-FT-102).** Sweep ▾ → Recognize Holes finds the round holes in the body, through or blind with a flat or drilled bottom, like SolidWorks FeatureWorks. A Delete Face fills them, and they come back as Hole features, one per face and size. An imported STEP body gets holes you can resize, move or delete, and the solid stays the same.

## [1.115.0] - 2026-11-08

### Added

- **Weldments** (FR-FT-121), Structural Member:
  - **Corners**: each corner where the member's lines meet can have its own treatment (mitre, butt 1, butt 2 or none), kept when the member's corner treatment changes, like picking a corner in SolidWorks.
  - **Weld gap**: a gap at every corner, split between the two ends of a mitre; a butted member stops that far short of the one running through. The cut list lengths follow.
  - **Description** for the cut list, in place of the profile's name.

## [1.114.0] - 2026-11-08

### Added

- **Offset and half sections** in drawings (FR-DRW-012, Section ▾). Offset section takes a cutting path: after the first leg, each click adds a leg along or square to it (Enter or a second click on the last point ends it). Every leg along the first cuts, the square legs step between them, and the cut faces on all those planes are hatched. Half section takes the start, the centre and the end of the step and cuts only up to the centre, so half the view stays whole. The cutting path is drawn with thick ends and bends, with arrows at its ends (only at the start for a half section).
- **Components left uncut** in assembly sections (FR-DRW-012): a section's panel lists the assembly's components under Don't cut, plus a Fasteners box that ticks every fastener from the library at once. Those components are drawn whole in the section.

## [1.112.0] - 2026-11-08

### Added

- **Hole table** in drawings (FR-DRW-024; Annotate ▾ and the Annotation tab). Click the origin on a view (a corner or a circle centre), then place the table. It lists every hole the view shows end-on with its X and Y from the origin along the view's axes and its size from the hole feature (Ø16 THRU, M6-6H…). Each size gets a letter from the smallest up (A1, A2, B1…), and the tags are written beside the holes, with X and Y arrows at the origin. The table follows the model; select it to set the decimals or to take the holes again after the model changed (Update holes). A hole that disappears frames the table in orange.
- **Inspection dimensions** (FR-DRW-021): tick Inspection dimension in a dimension's panel and its text sits in an obround frame.


## [1.110.0] - 2026-11-08

### Added

- **Weldments** (FR-FT-121):
  - **Gusset**: two arrows in the view, one per leg, change the lengths along face 1 and face 2 by dragging (also from the tree, like extrude depth); click an arrow's value to type it.
  - **Fillet Bead**: **Tangent propagation** (on by default) brings in the faces that run on smoothly from a picked one, so picking one side of a square tube and the plate gives a bead all round it, round corners included.
  - Bead pieces that meet end to end are fused into one bead body; the cut list gives its length along the root.

## [1.108.0] - 2026-11-08

### Added

- **Indent (FR-BODY-007).** Pick a target body and the tool bodies pressed into it. The tools are cut out of the target, grown by the clearance, and a wall of the given thickness follows their shape on the side they press into, like SolidWorks' Indent on a stamped plate. **Cut** leaves only the pocket. The tool bodies stay. Find it in Sweep ▾ next to Combine.
- **Sweep start tangency (FR-FT-080).** Start and End Tangency → **Path tangent** turns a profile that is not square to the path so that it starts square to it.

## [1.107.0] - 2026-11-08

### Added

- View navigation as in mechanical CAD (FRS 13.13, FR-UI-101 to FR-UI-104):
  - **Arrow keys** turn the view 15°, **Shift+arrows** 90°, **Ctrl+arrows** pan.
  - **Z** zooms out and **Shift+Z** zooms in.
  - **Alt+Z** goes back to the previous view, through the last 20 view changes. Orbiting, standard views, Normal to and fits all count.
  - A **double middle click** fits the model.
  - **Space** opens the orientation picker at the cursor: the six views laid out as an unfolded cube, plus Isometric, Normal to, Zoom to fit, Zoom to selection, Zoom to area and Previous view.
  - **Zoom to area** frames a box you drag.
  - **Zoom to selection** frames the picked face, edge or parts.
- Part modelling commands (FR-UND-005, FR-UI-043, FR-UI-106, FR-UI-107, FR-UI-111, FR-HIS-022):
  - The **Undo** and **Redo** tooltips name the step ("Undo: Add Extrude1").
  - **Undo ▾** lists the last 20 steps; picking one undoes back to it.
  - **Enter** with no command running repeats the last feature command.
  - The feature panel's **📌 Keep visible** pushpin opens the same command again after OK; **Ctrl+Enter** does it once.
  - A **right-click** without a drag while a command runs offers **OK** and **Cancel** (fillet and chamfer keep their edge helpers below).
  - New feature panels start with the options used last for that command (end condition, merge, chamfer type, shell outward, rib side; never sizes or picked geometry).
  - **What's wrong**: the error count above the feature tree opens a list of the features with errors and warnings. A click selects one; a double click edits it.

### Changed

- Camera moves take 300 ms, down from 450 ms. They apply at once when the system asks for reduced motion.

### Fixed

- New assembly (or opening one) while a part was open left the part modelling bar and the "Start a sketch on a plane" card showing in the assembly.

## [1.106.0] - 2026-11-08

### Added

- Motion studies: placement tracks move and turn a component that no mate holds over the study (keys with a move along X/Y/Z in mm and turns about X/Y/Z in degrees about its own origin), as dragging a component at a time in SolidWorks' animator (FR-FT-122).
- Camera keys keep the orthographic zoom, which changes smoothly between keys.

## [1.104.0] - 2026-11-08

### Added

- More dimension types in drawings (FR-DRW-021):
  - **Arc length.** Select a radius dimension on an arc seen end-on and set its Type to Arc length: a dimension arc concentric with the edge, radial extension lines and the value with the arc symbol (◠15.71).
  - **Chamfer.** Select an angle dimension between a chamfer and the edge next to it and set its Type to Chamfer: a leader to the chamfer and "2 × 45°" (the run along the other edge and the angle). Either line can be picked first; the shorter one is the chamfer.
  - **Chain, baseline and ordinate dimensions** (Annotate ▾ and the Annotation tab): click a base point (a corner or a circle centre), then one point after another. Each click adds its dimension at once, above the view for horizontal ones and to its right for vertical ones (the first step decides which). Baseline dimensions stack 7 mm apart; ordinate dimensions start with a 0 at the base and stand their values at the end of each extension line. Enter or Esc ends; every dimension can be dragged and follows the model like any other.

## [1.101.0] - 2026-11-08

### Added

- **Relations to model edges in sketches (FR-SK-064).** In the sketcher, click a model edge in the view (not a sketch item) and it is referenced into the sketch as a construction copy that follows the edge. It joins the selection, so Parallel, Coincident, Equal, Tangent, Concentric and the other relations work straight against model geometry, like picking an edge in SolidWorks' Add Relations.

## [1.100.0] - 2026-11-08

### Added

- Chamfer and shell options from FRS Appendix G (FR-FT-041, FR-FT-060):
  - **Offset face chamfer.** Both faces move in by the distance, and the chamfer runs where they meet, so it stays even where the faces are not square.
  - **Vertex chamfer.** Click an edge next to a corner of three straight edges, and the corner is cut off at three distances along its edges.
  - **Multi-thickness shell.** Flat faces picked under Multi-thickness settings get walls of their own thickness, thicker or thinner than the shell.
- Draft and loft options from FRS Appendix G (FR-FT-061, FR-FT-062, FR-FT-082):
  - **Parting line draft.** Pick the direction of pull and the edges of the parting line, and the face on one side of each edge tapers from it.
  - **Rib draft.** A rib normal to its sketch can taper away from the sketch plane, inward or outward.
  - **Loft start and end constraints.** Normal to profile makes the loft leave the first profile and reach the last one square to them, with a tangent length.
- Holes and end conditions from FRS Appendix G (FR-FT-050, FR-FT-012):
  - **New hole types.** Clearance, Counterdrill (a larger drill to a depth with a 118° cone at its bottom) and Slot (length and angle in the face, rounded ends).
  - **Hole end conditions.** Up to next goes through the first wall the hole meets. Up to face or plane stops at a picked plane or flat face.
  - **Extrude Up to body.** Pick any face of another body, and the extrude stops where it meets that body.
- Pattern options from FRS Appendix G (FR-FT-070, FR-FT-071, FR-FT-072, FR-FT-073):
  - **Copy faces or bodies.** Linear pattern, Circular pattern and Mirror can copy faces instead of features. Click all the faces of a boss or a cut, and each copy adds or removes the same shape. They can also copy bodies, and each copy becomes a new body. Mirror's **Merge solids** joins each mirrored body to its original.
  - **Sketch driven pattern** (pattern ▾): a copy at each free point of a sketch, moved from the seed's centroid or a picked reference point.
  - **Table driven pattern** (pattern ▾): copies moved by X, Y offsets typed one row per copy, along the part's axes or a coordinate system.

## [1.99.0] - 2026-11-08

### Added

- **Alternate position views** (FR-DRW-015), in assembly drawings: select a model, projected or auxiliary view and click Add component… under Alternate position in its panel. Click an edge of a component, then where that point goes: the component (with its sub-assembly's parts) is drawn again there in thin phantom lines (ISO 128 long dash, double dot).
  - Move across, Move up and Turn (about the picked point, as seen in the view) can be typed; Remove takes one off. Detail views of the view show it too.
  - The phantom lines are in PDF, SVG, PNG and print, and on their own PHANTOM layer and linetype in DXF.

## [1.98.0] - 2026-11-08

### Added

- Motion studies: appearance tracks fade a component in or out, or hide and show it, over the study (opacity keys 0–100 %, **Hidden** / **Shown** set a key), as SolidWorks' component visibility and transparency keys (FR-FT-122).
- Motion timeline: Alt+←/→ moves the selected key one frame (Shift: ten), without passing its neighbours.

## [1.97.0] - 2026-11-08

### Added

- **Weldments** (FR-FT-121):
  - **Custom profile (sketch)** in Structural Member: the largest closed region of a 2D sketch (holes included; lines, arcs and circles kept exact) is the cross-section, with the sketch origin on the path or any of the nine box points. The cut list names it after the sketch.
  - Corners where three or more members meet: the first member runs through (End butt 2: the last) and the others stop square at its faces, so the cut list shows real lengths.
  - **End Cap**: a thickness arrow to drag in the view (also from the tree, like extrude depth) and a **Thickness inward** option.

## [1.96.0] - 2026-11-08

### Added

- **Broken-out section** (FR-DRW-015): select a model, projected or auxiliary view and click Broken-out section in its panel, then click the corners of an area on the view. Enter, or a click on the first corner, cuts the material inside away down to the middle of the model and hatches the cut.
  - Depth from the front (mm) sets how deep it goes; hatch spacing and angle are set as for sections. Redraw the outline and Remove broken-out section are in the same group.
  - Detail views of the view show the cut too, and it is kept in the drawing file and in every export.

## [1.94.0] - 2026-11-08

### Added

- **Motion studies** (FR-FT-122, FRS P6): **Motion study** on the assembly bar opens a timeline under the view, as SolidWorks' MotionManager does.
  - Key tracks on distance and angle mates; select a key to type its time, value and interpolation (linear or ease in/out), drag keys along the timeline, double-click a track to add one.
  - Motors on mates: rotary (rpm) or linear (mm/s), constant speed or oscillating, from a start to an end time, on distance, angle, concentric, hinge and screw mates. The other components follow through the mate solver, frame by frame from the one before, so linkages keep their branch; frames that cannot be solved are reported.
  - Exploded view and camera tracks, and the animation wizard: Explode, Collapse and Rotate model fill a track over the study.
  - Play once, loop or back and forth at 0.25× to 4×; scrub the ruler; Space, ←/→, Home and End in the pane.
  - Record a WebM video of the view in real time, or save an animated GIF.
  - Several named studies per assembly, saved in the `.mcadasm` file, with undo.
## [1.92.0] - 2026-11-08

### Added

- **Weldments** (FR-FT-121), in the new Weldments ▾ menu of the feature bar:
  - **Structural Member**: a standard profile along the lines of a sketch or 3D sketch, one body per line. Profiles: EN 10219 square, rectangular and round tube, EN 10056 equal angle, DIN 1026 UPN channel, EN 10365 IPE and HEA beams, flat and round bar. Corners where two lines meet are mitred, butted (either line runs through) or left alone; the profile can sit on any of nine points of its box, turn and mirror. The view follows every panel change.
  - **Trim/Extend**: members cut back to a flat face's plane or another body, or lengthened up to it.
  - **End Cap** (thickness, inset, corner chamfer), **Gusset** (triangular or polygonal, inner chamfer, at the middle or either end of the corner) and **Fillet Bead** along straight and round edges (flat faces, tubes on plates, the round corners of hollow sections).
  - **Cut List…**: members grouped by profile, length and end angles, plates by size, welds by leg, with quantities and mass (the part's material, else steel), exported as CSV.

## [1.90.0] - 2026-11-08

### Added

- **User sheet formats** (FR-DRW-004): with nothing selected, New title block… (or Edit title block…) in the sheet panel opens a title block editor.
  - It starts from the ISO block. Set the block's size and each cell's position, size, field (any title block field, the scale, sheet, size, units or the projection symbol), label and text size, with a live preview.
  - Add a PNG or JPEG logo (up to 512 KB) and place it.
  - Save and use puts the block on the sheet, which keeps its own copy so the drawing file opens the same anywhere. It also saves the block in this browser's library, listed under My formats in the Sheet format menu for other sheets and drawings.
  - Export format / Import format… share a format as a small JSON file.
  - The logo is drawn on screen and in PDF, SVG and PNG exports; DXF leaves it out.

## [1.89.0] - 2026-11-08

### Added

- **Sketch relations to the model** (FR-SK-042, FR-SK-052): while sketching, points snap to model vertices, edge midpoints and circle centres (projected onto the sketch plane), shown with the usual snap marker.
  - A snapped point is tied to the model through a construction copy of the edge with an On edge relation, so it follows when the model changes.
  - **Smart Dimension** takes model edges and vertices too: click a sketch curve, then a model edge, then where the dimension goes.
  - **Snap to model geometry** in the sketch panel turns it off.

### Changed

- While sketching, the middle mouse button rotates the view (FR-UI-020). It still pans elsewhere.
- Smart Dimension with one item picked: clicking a second item dimensions the pair instead of placing the first item's dimension.
- A new part shows its origin planes at once, without a "Rebuild" step.
## [1.88.0] - 2026-11-08

### Added

- **Intersect** (FR-BODY-007) in Sweep ▾: picked solids and surfaces (or all of them) cut each other into closed regions.
  - The panel lists the regions by volume. Untick the ones to leave out.
  - The kept regions replace the picked solids, merged into one body unless **Merge result** is off.
  - **Consume surfaces** removes the surfaces used. Faces keep the names of the faces they came from, so later features stay attached.
- **Untrim Surface** (FR-FT-100) in Surface ▾: a one-face surface goes back to the bounds of its underlying surface, or only its holes are filled.

## [1.87.0] - 2026-11-08

### Added

- **Drawing view properties** (FR-DRW-017):
  - Cosmetic threads of a part are drawn on its views, ISO 6410 style: thin lines at the thread diameter with a thick limit line from the side (dashed for a tapped hole, unless the view is a section), and a thin ¾ circle end-on. A view's Cosmetic threads box hides them.
  - Sketches: tick Sketches on a view to show the part's visible sketches as thin lines (DXF layer SKETCH).
  - Alignment: Break alignment lets a projected, section or auxiliary view move on its own (and stay put when its parent moves); Default alignment puts it back in line with its parent.

## [1.86.0] - 2026-11-08

### Added

- **Drafting style for drawings** (FR-DRW-025): with nothing selected, the sheet panel's new Drafting style group sets, for the whole drawing:
  - the annotation text height (2.5, 3.5 or 5 mm), with arrows sized to match;
  - the arrowheads (filled, open, dot or oblique stroke);
  - the ISO 128 line group (0.25, 0.35, 0.5 or 0.7 mm visible lines, thin lines half as wide).

  The style is saved in the drawing and used in every export.

## [1.85.0] - 2026-11-08

### Added

- Sweep, loft and helix options from FRS P5 (FR-FT-080, FR-FT-082, FR-FT-083):
  - **Twist along path**: a sweep turns its profile about the path by a set angle from start to end.
  - **Guide curve**: a sweep's profile grows, shrinks and turns so that its edge keeps touching a guide curve (a sketch, helix, curve or 3D sketch).
  - **Centerline**: a loft follows a path between its profiles instead of the straight join.
  - **Variable pitch** helix: a table of height, pitch and diameter rows; pitch and diameter change linearly between rows.

## [1.84.0] - 2026-11-08

### Added

- **Linked components in the vault** (FR-ASM-003, FR-PDM-020/022): a linked assembly component is tied to the exact vault version its file hash names, even when newer versions exist.
  - Contains marks linked components ⛓ and shows when the vault holds a newer version.
  - The selected assembly lists its outdated links. **Update links** on the checked-out assembly brings them to the latest versions; check it in to keep them.
  - Opening an assembly with its latest components updates the link hashes too, and renaming a part rewrites the link path.
- **Crop view and break view** in drawings (FR-DRW-015): select a view for **Crop** (click two corners; only what is inside stays) or a **Vertical / Horizontal break** (click the two ends of the part to leave out). The view closes up to a 6 mm gap with zig-zag break lines. Dimensions and annotations stay on their geometry and keep their true values. **Remove crop** and **Remove breaks** undo them.

## [1.83.0] - 2026-11-08

### Added

- **3D Sketch** (FR-SK-080) in Sweep ▾:
  - Click to place points in space. Each click draws a line, or a spline with the Spline tool, from the last point.
  - Points land on model vertices and faces. Otherwise they go on the sketch plane (XY, YZ or ZX) through the last point. Tab turns the plane and Esc ends the chain.
  - The panel lists the points, which you can edit or fix, and the lines and splines.
  - Select lines or points in the view or the panel to add relations: along X/Y/Z, parallel to a plane, parallel, perpendicular, equal and coincident. You can also add length and distance dimensions, which take expressions.
  - A least-squares solver keeps everything satisfied and says how many degrees of freedom are left. A change that conflicts is undone.
  - One chain of lines and splines is a **Sweep** or **Swept Surface** path.

### Changed

- Sweeps mitre sharp corners of their path instead of stretching the profile round them.

## [1.82.0] - 2026-11-08

### Added

- 3D curves (FR-FT-085) in Sweep ▾:
  - **Curve Through XYZ Points**: a smooth curve through points in part coordinates. Type them in a table, or read them from a CSV or text file with one `x, y, z` per line (semicolon files with decimal commas work too). It can be closed.
  - **Composite Curve**: model edges joined end to end into one curve.
  - **Projected Curve**: a sketch's chain of curves projected along its normal onto faces. It projects onto all faces or only the ones you click, and keeps the nearest piece in front of the sketch. Reverse projection looks the other way first.
  - All three are drawn in the view, can be hidden like a helix, and work as **Sweep** paths. A new sweep picks the last curve as its path.
- **Swept Surface** (FR-FT-100) in Surface ▾: a sketch's chain of curves, open or closed, moved along a path (a sketch, helix or curve) into an open surface. Follow path or Keep normal constant.

## [1.81.0] - 2026-11-08

### Added

- **Assembly features** (FR-ASM-027): the new **Assembly cut** command makes a hole or a rectangular cut extrude that exists only in the assembly.
  - Click a flat face where it starts, then set the size and the depth (or Through all).
  - Under Feature scope, pick which components it may cut; by default it cuts every component it reaches.
  - It moves with the component it starts on, a red preview shows the tool, and the cut faces can be mated to.
  - The tree lists it under Assembly features (edit, suppress, delete), and a feature that cuts nothing is marked.
- **Assembly configurations** (FR-ASM-026): **Add configuration** in the assembly's menu. Each configuration keeps:
  - which components are suppressed;
  - the part configuration each component uses (component menu → **Configuration…**, shown after its name in the tree);
  - mate values and suppression;
  - which assembly features are suppressed.

  Click a configuration in the tree to switch to it.

## [1.80.0] - 2026-11-08

### Added

- **Geometry compare in the vault** (FR-PDM-050): comparing two versions of a part or an assembly builds both. A table gives volume, mass, surface area, size and centre of mass for each, with the change. A 3D view shows material only in the older version in red and only in the newer one in green, over what both share.
- **Check in referenced files too** (FR-PDM-011): checking in an assembly lists the parts and sub-assemblies it uses that you have checked out. Changed ones are ticked, and they go in first.
- The title of a part opened from the vault says when its local copy is **modified** or **outdated** (FR-PDM-016).
- Drawings (FR-UI-072): an **Annotation** tab beside the view palette holds every annotation tool. **Inference lines**: a view you place or drag lines up with another view's centre when it comes close, with an orange guide.

## [1.79.0] - 2026-11-08

### Added

- **Fastener library** (FR-ASM-028): the new **Fasteners** command in the assembly bar. It covers:
  - ISO 4762 socket head, ISO 4017 / 4014 hex head and ISO 7380 button head screws;
  - ISO 4032 hex nuts and ISO 7089 plain washers;
  - sizes M2 to M20, with preferred lengths.

  Pick the standard, size and length, then click the cylindrical face of a hole near the end the fastener goes in. It is inserted on the face there with a concentric and a coincident mate, and the panel stays open for more holes. Each fastener is a parametric part, with every size as a configuration. The same fastener again shares its part, so the BOM counts it.
- **Mate references** (FR-MATE-011): component menu → **Mate references…** names up to three faces of a part, and the reference is stored in the part. Inserting a part that has a reference of the same name mates it to the component that has one, the selected one first: flat faces coincident, cylinders concentric.

## [1.78.0] - 2026-11-08

### Added

- **Surface analyses** (FR-MEA-005) under **Display → Analysis**:
  - **Draft**: colours the model by its draft against a pull direction (an axis or the selected flat face). Green has at least the minimum draft, yellow too little, red faces the other way.
  - **Zebra stripes**: stripes reflected off the surfaces; where they run on smoothly across an edge, the faces are tangent.
  - **Curvature**: blue for flat, through to red for the tightest curves, with the smallest radius on the scale.
  - **Thickness**: a ray into the material from every point finds the opposite wall. Red is thinner than the minimum wall you set.
  - **Undercut**: points that a two-part mould could not release along the pull direction are red.

  A panel in the view sets the direction and limits and gives each colour's share of the area.
- **View palette** in drawings (FR-UI-072): the model's seven standard views, drawn small beside the sheet. Drag one onto the sheet, or click it and then the sheet.

## [1.77.0] - 2026-11-08

### Added

- **Composite feature control frames** (FR-DRW-023): in a geometric tolerance with more than one row, tick Composite with the row above. The rows then share one characteristic cell. **All around** puts the circle at the leader's bend.
- **BOM of one sub-assembly** (FR-DRW-030): select the parts list and choose a sub-assembly under Of. The list and the sheet's balloons then cover just its parts.
- **Release files** (FR-PDM-036): releasing a drawing in the vault stores its PDF beside it, and releasing a part or an assembly stores its STEP, named `<part number>_rev<revision>`. This can be turned off in Vault settings. The new **PDF** button on a drawing makes its PDF; a drawing that is not released gets a faint NOT RELEASED across each sheet.
- STEP files made by the vault carry the **revision** as the product definition formation id, and the part number and description in the product (FR-PDM-034).
- **Full-text search** (FR-PDM-043): Advanced search has Text inside files, which searches drawing notes and tables, document properties, feature and component names, and the text of text files.

## [1.76.0] - 2026-11-08

### Added

- **Mechanical mates** (FR-MATE-005), in a new group of the Mate panel:
  - **Hinge**: concentric plus coincident in one mate. Click the two cylinders, then a flat face on each part.
  - **Slot**: keeps a pin centred between the side faces of a slot, free to slide along it.
  - **Gear**: couples the turns of two cylinders by a ratio. It starts at the radius ratio; Reverse is for internal gears.
  - **Screw**: concentric, and the part moves along the axis by the distance per revolution as it turns.

  Drag a part and the coupled one follows.
- **Clearance check** (FR-ASM-021) in the Interference panel: set a minimum clearance, and every pair of components closer than that, without overlapping, is listed with its distance. An orange line joins the nearest points.

## [1.75.0] - 2026-11-08

### Added

- **Drawing compare** in the vault (FR-PDM-051): comparing two versions of a drawing draws both and overlays them sheet by sheet. Lines only in the older version are red, lines only in the newer one green, and each sheet says how much changed.
- **Assemblies in the vault** (FR-PDM-003/020/022): adding an assembly offers to add the parts it embeds as files of their own. Its parts then count as its references, so Contains, Where used, BOM compare and rename/move work for it. Opening it asks how components resolve: **as checked in**, **latest** or **latest released**. The latter two put those versions of the part files, and of sub-assemblies, in place of the copies saved in the assembly.

## [1.74.0] - 2026-11-08

### Added

- **Flexible sub-assemblies** (FR-ASM-006): right-click a sub-assembly → **Make flexible**. Its own mates then solve inside the parent assembly, and the parent can mate its parts to the sub-assembly's parts (a piston that follows a crank). **Make rigid** puts them back where the sub-assembly has them. Flexible sub-assemblies are marked in the tree.
- **Linked components** (FR-ASM-003, FR-IO-011): right-click a component → **Link to file…**. The assembly keeps the file's path and the SHA-256 of its content, plus the last loaded copy. **Update links…** asks for the project folder, reads again every linked file whose content changed (found by its path, or by its name anywhere in the folder) and marks missing files with ⚠; those components keep showing their last copy. **Embed in the assembly** drops the link.

### Changed

- Faster assemblies with repeated parts (FR-ASM-031): each part is analysed once (B-rep faces, edges and exact values) and every component of it gets a moved copy, instead of analysing each instance's mesh again.

## [1.73.0] - 2026-11-08

### Added

- **Parts-only bill of materials** (FR-ASM-024, FR-DRW-030): select the parts list on an assembly drawing and switch List to Parts only. It then lists the parts inside sub-assemblies instead of the sub-assemblies, with the same part used in several places on one row, and the balloons on that sheet follow its numbering.
- **Stacked balloons**: select a balloon and pick Stack another item. The extra items stack under it in touching circles and share one leader, which leaves from the circle nearest the part. Auto balloon skips items already in a stack.
- The GOST 2.104 title block takes the **technical control** and **standards control** signatures and the **letter** (one character per cell), typed in the sheet panel or by double-clicking the cell.

### Changed

- A surface finish symbol placed on a slanted or vertical edge now stands on that edge, readable from the bottom or the right of the sheet (ISO 1302).

## [1.72.0] - 2026-11-08

### Added

- More surfaces (FRS 9.11, FR-FT-100) in Surface ▾: **Revolved Surface** turns the curves of a sketch about one of its lines (angle, reverse); **Lofted Surface** runs an open surface through profile sketches, open or closed chains, smooth or ruled; **Trim Surface** cuts a surface with a plane, a flat face or another surface and keeps the piece you click (the larger one if you don't).
- **Filled Surface** patches a closed opening of a surface body, the one next to where you click, and sews the patch on unless Merge result is off. **Extend Surface** grows a one-face surface past all its edges by a distance, following its own shape.
- **Delete Face** has a new option, **Delete (leave a surface)**: the faces leave the solid and the rest of it becomes an open surface body, ready to patch, knit or thicken.

### Fixed

- A solid turned into a surface (or deleted) by one feature came back when a later feature was added or edited.

## [1.71.0] - 2026-11-08

### Added

- **Assembly drawings** (FR-DRW-030): New drawing with an assembly open draws the assembly with exact hidden lines, every shown component placed; dimensions and annotations work on it as on a part, and the drawing follows the assembly when it changes.
- **Bill of materials** (Annotate ▾): the parts list goes on top of the title block with the header at the bottom, one row per part or sub-assembly with its part number, description and quantity (pattern instances counted). Its rows come from the assembly, so they update with it; the column headings can be renamed.
- **Balloons**: click an edge of a component, then place the balloon; it shows the part's item number from the BOM and keeps it when the assembly changes. **Auto balloon** numbers every part seen in the selected view, on its longest visible edge, spread around the view.

## [1.70.0] - 2026-11-08

### Added

- Surfaces (FRS 9.11, FR-FT-100), in the new Surface ▾ menu: **Extruded Surface** sweeps every curve of a sketch, open or closed, into open surfaces (depth, mid plane, reverse); **Planar Surface** fills a closed sketch; **Offset Surface** copies faces of solids or surfaces at a distance, or in place at 0. Surface bodies show in the view and can be picked, but have no volume and stay out of mass properties.
- **Knit Surface** sews surface bodies along their shared edges within a tolerance; **Create solid** turns surfaces that close a volume into a new solid body.
- **Thicken** grows a surface body into a solid to side 1, side 2 or both, merged with the body unless Merge result is off. The panels show the result live while you pick and type.
- **Move Face** can now translate faces by X/Y/Z (only the part of the move along each face's normal changes a flat face) or rotate them about an edge of the face, besides offsetting them (FR-FT-101).
- **Replace Face** (Surface ▾) replaces flat faces of a solid with a surface body: the faces around them grow or shrink to meet it, and later features keep the face's name (FR-FT-101).

## [1.69.0] - 2026-11-08

### Added

- **Geometric tolerances** (FR-DRW-023, Annotate ▾): feature control frames to ISO 1101 / ASME Y14.5 with all 14 characteristics, drawn from lines and arcs so they look the same in every export. Click an edge first for a leader, or place the frame on its own. Select it to pick the characteristic, a Ø tolerance zone, the maximum or least material condition, up to three datums, and to add more rows.
- **Datum features**: click an edge (or a hole's circle), then place the framed letter; the filled triangle sits on the edge and the letters run A, B, C… across the drawing.
- **Surface finish** (ISO 1302): click on an edge to put the symbol on it, away from it for a leader, or on empty space for a free symbol; any process, material removed or not removed, with the roughness and the production method.
- **Revision table and general tables** (FR-DRW-024): the revision table goes in the frame's top-right corner and grows to the left; Add revision fills in the next letter and today's date. General tables take any number of rows and columns. Cells are edited in the panel; headers that you leave alone follow the interface language.
- **GOST 2.104** title block (form 1, 185 × 55) and frame, beside ISO and ANSI.
- **PNG export** of the sheet at 300 dpi, with the resolution recorded in the file.
- Annotations whose model edge disappears after a part change are framed in orange on screen (FR-DRW-026); a datum keeps its letter, a hole callout shows "?".

## [1.68.0] - 2026-11-08

### Added

- **Dimensions on drawings** (FR-DRW-021): **Dimension** (D) works like SolidWorks' Smart Dimension. Click a line for its length, a circle for its diameter (an arc for its radius), two points (corners or circle centres) for the distance between them, a point and a line or two parallel lines for the square distance, or two lines at an angle for the angle; the dimension follows the cursor as a preview, and the side you move to makes it horizontal, vertical or aligned. Edges highlight under the cursor and corners snap.
- Dimensions are drawn to ISO 129: thin extension lines with a gap, filled arrows (outside when there is no room), 3.5 mm text above the line, reading from the bottom or the right. Select a dimension by its text to drag it, change its direction, decimals, prefix and suffix, type text over the value, or give it a tolerance: ±, deviations (stacked), limits, or an ISO 286 fit such as H7.
- Dimensions are associative (AT-P5-3): they hold on to the model's edges by the names of the faces they join, so after the part changes they find their edges again and show the new values.
- **Model items** (FR-DRW-020, Annotate ▾): the part's driving sketch dimensions and extrude depths go into the view where each reads best (looking square at its sketch, or for a depth, from the side), once each, outside the view.
- **Hole callouts** (FR-DRW-022, Annotate ▾): click a hole's edge, then place the callout. The text comes from the hole feature (count, diameter, depth or THRU, thread, counterbore and countersink), or from the cylinder for other holes; it can be typed over.
- **Centre marks and centrelines** (FR-DRW-023): drawn automatically on round holes and bosses seen end-on and on cylinders seen from the side, in the centre line type; a view setting turns them off.
- **Notes** (Annotate ▾): text on the sheet or on a view (it moves with the view), with a leader when an edge is clicked first.
- Annotations export to PDF, SVG and DXF (ANNOT and CENTER layers) and follow the interface language, with a decimal comma in Russian.

## [1.67.0] - 2026-11-08

### Added

- Collision detection while dragging components: tick it in the Move panel and a drag stops where the component would enter another, even on a fast drag (FR-MATE-002).
- Inferred mates: hold Alt while dragging a component by a face and drop it on a face of another component; a cylinder on a cylinder makes a concentric mate, a flat face on a flat face a coincident one (FR-MATE-007).
- Direct editing on any body, imported ones too (FR-FT-101): **Move Face** pushes flat faces out or in along their normals (the new side faces merge into the faces next to them), and **Delete Face** removes faces and heals the gap from the faces around them. Both are in the Sweep ▾ menu.

## [1.66.0] - 2026-11-08

### Added

- **Section views** (FR-DRW-012, AT-P5-2): Section ▾ in the drawing workspace draws a horizontal, vertical or two-point cutting line on a view; the line follows the cursor and snaps to circle centres, line ends and midpoints. Then the section view follows the cursor on the side it looks from, lined up with its parent, and a click places it. The cut faces are hatched (spacing and angle per view), the parent shows the cutting line with thick ends, arrows and letters, and the view is labelled SECTION A-A. Flip direction looks from the other side.
- **Detail views** (FR-DRW-013): click the centre of a circle on a view (it snaps too), then its radius, then place the view. It shows the parent's lines (and hatching) clipped to the circle at twice the parent's scale, with DETAIL B and its scale under it, and the circle and letter on the parent. The radius can be typed in the view's properties.
- **Auxiliary views** (FR-DRW-014): click a straight edge of a view, then place the view square to it; it stays lined up and the parent gets a lettered arrow.
- Section, detail and auxiliary views are listed under their parent in the drawing tree, drag only along their viewing direction, carry a letter that can be changed (the next free letter, skipping I, O and Q) and export to PDF, SVG and DXF (hatching on its own HATCH layer).

## [1.65.0] - 2026-11-07

### Added

- Advanced mates: limit distance and limit angle (a range, so they keep the freedom inside it), symmetric (two faces or axes mirrored in a plane) and width (a tab centred in a slot, between two faces or on a cylinder's axis), in the Mate panel's Advanced mates group (FR-MATE-004).
- Display states: named sets of visibility, colour and transparency per component, added from the assembly's right-click menu and switched in the tree's Display states folder (FR-ASM-025).
- Component transparency from the right-click menu.
- Open part from an assembly component: the part opens in the modeller with a Return to assembly bar, and the edit comes back to the assembly as one undo step, with its mates kept (FR-ASM-007).
- Sub-assemblies: a saved assembly inserted as a component moves as one rigid piece, with its parts listed under it in the tree, and counts in mass properties, interference and STEP export (FR-ASM-001/006).
- Replace component with another part, assembly or STEP/IGES/BREP model; mates keep the faces they find by name and a warning counts the ones that could not (FR-ASM-008).
- Suppress and unsuppress components, and per-component colour, from the tree's right-click menu.
- BOM as top-level items or parts only; parts only counts parts inside sub-assemblies together with the same parts at the top (FR-ASM-024).

## [1.64.0] - 2026-11-07

### Added
- **Drawings** (FRS section 11, FR-DRW-001/002/003/010/011/016/030/031). **New drawing** in the New ▾ menu opens a drawing of the open part or STEP / IGES / BREP model in its own workspace. It starts with the **standard 3 views** (front, top and side, lined up) at a standard scale that fits the sheet.
- **Model view ▾** places any orientation (the six sides, isometric, or the current 3D view). The view follows the cursor with its real lines as a preview, as in SolidWorks. After the click, moving around it and clicking adds **projected views** in first or third angle (diagonal ones give isometric views); Esc or ✓ ends.
- Views are computed by OpenCASCADE's exact hidden-line removal in a worker. Lines and arcs stay exact, hidden edges are dashed, and back edges that lie under visible ones are left out. Per view: scale (sheet, parent's or own), display style (hidden lines dashed, removed, or wireframe), tangent edges (visible, thin or removed) and an optional label.
- Drag views to move them: projected views follow their parent, and a side or top view only slides along its alignment.
- **Sheets**: A4–A0 and ANSI A–E, landscape or portrait, first angle (ISO) or third angle (ANSI), with a frame, zone marks and an ISO 7200 or ANSI title block. The title block fills itself from the part (title, part number, revision, author, material, mass from the part's material) and from the sheet (scale, size, sheet n/m); every field can be typed over. Double-click the title block to edit it. More sheets go in tabs below the sheet.
- A drawing of a modelled part is associative: change the part and the views update.
- **Save** (Ctrl+S) writes a `.mcaddrw` file that holds the model too, so it opens on its own. **Export**: PDF of all sheets at their real size (vector, with an embedded DejaVu Sans font, so Cyrillic text works), SVG or DXF R12 of a sheet (millimetres, one layer per line type with HIDDEN and CENTER linetypes), and printing at 1:1 through the browser (Ctrl+P). Undo and redo cover every change.

## [1.63.0] - 2026-11-07

### Added
- **Interference detection** (FR-ASM-020, AT-P4-4) in the assembly bar: every pair of shown components whose solids overlap, with the overlap volume, listed in the panel and drawn red in the view (click a pair to pick it out). Option to treat touching faces as interference.
- **Bill of materials** (FR-ASM-024, AT-P4-5): one row per part with item number, part number, description, material, quantity and mass, and CSV export.
- **Assembly STEP export** (AT-P4-6): a STEP assembly with each part once and one named instance per shown component, in place; it reopens in the viewer with the same placements.
- **Component patterns** (FR-ASM-022): **Pattern** makes linear copies of components along a flat face's normal or a cylinder's axis, or circular copies about a cylinder's axis (count, spacing or total angle with equal spacing, reverse). The copies are previewed see-through before ✓, follow their seeds, are listed under the pattern in the tree and counted in the BOM.
- **Exploded views** (FR-ASM-023): **Explode** builds a named view in steps (components, direction, distance), with **Auto explode** to start from; the view explodes and collapses animated from the Exploded views folder in the tree, and is saved in the assembly.

## [1.62.0] - 2026-11-07

### Added
- **Assemblies** (FRS 10: FR-ASM-001..005, FR-MATE-001/002): **New assembly** in the new ▾ menu beside New part, and on the start card. **Insert component** places a MöbiusCAD part or a STEP, IGES or BREP model; the first one is fixed at the origin, the next float beside it, and the same part inserted again shares its source. Drag a floating component in the view, or type its position and rotation in **Move component**. The assembly tree marks fixed (f) and floating (-) components and hides, fixes/floats and deletes them; undo and redo; mass properties of the whole assembly; save and open `.mcadasm` files (the parts are embedded), also from the vault.
- **Mates** (FR-MATE-003/006/008/009, AT-P4-1..3): **Mate** picks a flat or cylindrical face on each of two components and previews the likely mate at once (quick mate). Coincident, parallel, perpendicular, tangent, concentric, lock, distance and angle, with alignment and flip. The mate solver moves components as little as possible, reports each component's remaining degrees of freedom ((f), (-), (+) or fully defined in the tree, and the assembly's state in the bar) and refuses a conflicting mate without moving anything. Mated components drag only along their free directions. The Mates folder edits, flips, suppresses and deletes mates. When a part's geometry changes, its mates are solved again.

## [1.61.0] - 2026-11-07

### Added
- **Insert part** (FR-BODY-005): **Insert body** also takes a MöbiusCAD part (`.mcadprt`). The part is rebuilt on its own and its result goes in as a body, kept in this part's file (a broken link, as in SolidWorks), with Check and heal available.

### Fixed
- Parts that use reference geometry, holes, patterns, sweeps, body features or any feature beyond sketches, extrudes, revolves, fillets and chamfers can be opened again from `.mcadprt` files. Before this, opening them stopped with "Unknown feature type".

## [1.60.0] - 2026-11-07

### Added
- **Solid Bodies folder** (FR-BODY-001) at the top of the Features tree: every body of the part with **show/hide**, **colour** and **delete** (which adds a Body-Delete/Keep feature); double-click to rename. Bodies are named after the feature that made them and keep their settings through later features. Hidden bodies leave the view but still count in the mass properties.

## [1.59.0] - 2026-11-07

### Added
- **Face fillet and full round fillet** (FR-FT-032): the Fillet panel has a **Fillet type**. A face fillet rounds every edge where face set 1 meets face set 2; a full round replaces the centre faces between two parallel side faces with a half round tangent to both (the radius is half the gap). Both preview live.
- **Scale** (FR-BODY-006), in the **Sweep ▾** menu: scales the picked bodies (all when none are picked) about their centroid or the origin, uniformly or per axis. Faces keep their names, so later features still find them.

## [1.58.0] - 2026-11-07

### Added
- **Insert body** (FR-FT-130/131, AT-P3-4), in the **Sweep ▾** menu: a STEP, IGES or BREP file goes into the part as an **Imported** feature (kept in the part file, so it opens without the original). **Check and heal** sews faces whose edges are closer than the tolerance, fixes the shape and closes shells into solids, and reports free edges and validity before and after. A file with faces but no solids is healed from the start. The imported body joins the part as its own body.

## [1.57.0] - 2026-11-07

### Added
- **Multibody parts** (FRS 9.10). Extrude and revolve bosses have **Merge result** (on by default); off makes a new body. New in the **Sweep ▾** menu: **Combine** (add, subtract the tools from a main body, or keep the common part), **Split** (cut bodies by a plane into separate bodies; split and combine back keeps the volume, AT-P3-3), **Body-Move/Copy** (translate and rotate about an axis, or copy) and **Body-Delete/Keep**. Bodies are picked by clicking any face of them, and the panels show how many bodies the part has.
- **Variable radius fillet** (FR-FT-032): each edge goes from a start radius to an end radius, typed in the list or by clicking the callouts at the edge ends.

## [1.56.0] - 2026-11-07

### Added
- **Rib** (FR-FT-062), in the **Sweep ▾** menu. An open line or arc chain sketched beside the part becomes a wall that runs to the body: thickness on the first side, both sides or the second side, **Parallel to sketch** (a corner gusset) or **Normal to sketch** (ribs across a hollow, sketched above it), with **Flip material side**. It goes the way that meets the body and previews live.
- **Split Line** (FR-FT-084), in the **Sweep ▾** menu. A sketch is projected along its normal, both ways, and splits the faces it crosses (or only the faces you click), so each piece can take its own colour, draft or mate. The body keeps its shape.
- **3MF export** (Export → 3MF) for 3D printing: each body as a closed mesh in millimetres with its colour, written in the active coordinate system like the other mesh exports. It reads back into MöbiusCAD as the same solid.

## [1.55.0] - 2026-11-07

### Added
- **Helix/Spiral** (FR-FT-083). In the new **Sweep ▾** menu: a helix on the circle of a sketch, set by pitch and revolutions, height and revolutions, or height and pitch, with start angle, clockwise, reverse direction and taper. It is exact (a line on a cylinder or cone) and drawn in the view while you edit it.
- **Sweep and Cut-Sweep** (FR-FT-080/081). A closed profile sketch, or a **circular profile** of a set diameter that needs no sketch, moved along a helix or a sketch path (lines, arcs, splines joined end to end); Follow path or Keep normal constant. A Ø2 circle along a 10-turn helix gives a spring whose volume matches π·r²·L to 1e-4. The result previews live; a cut shows the material it removes.
- **Loft and Cut-Loft** (FR-FT-082). Through two or more closed profiles in order, smooth or with straight (ruled) sections, optionally closed back to the first. Profiles are picked in the panel; the last two unused sketches are offered first.

## [1.54.1] - 2026-11-07

### Fixed
- The Vault tab could fail to draw for a moment while it re-read the vault (the file list and their status were updated separately). The two are now swapped in together.

## [1.54.0] - 2026-11-07

### Added
- **Converted edges follow the model** (FR-SK-064). Convert entities now adds an **On edge** relation: the copied lines, arcs and circles move with their model edge whenever the part rebuilds, and features made from the sketch follow. When the edge is gone, the relation turns **dangling**: the curve keeps its place and is drawn in olive, the sketch gets a warning in the tree, and the sketch panel offers **Re-attach** (click the new edge, or drag the dangling glyph onto it) or **Delete dangling relations** to keep the curves free.
- **Dimension names** (FR-SK-065). Hovering a dimension shows its full name, such as `D1@Sketch2`, as equations use it. Select one dimension to rename it in the sketch panel; expressions that use it follow, and so do expressions using a renamed sketch. **Show dimension names** puts the names next to the values.
- **Draggable dimension text** (FR-SK-066). Drag a dimension's value to move it; the position is stored with the sketch. Ordinate values move with their row.
- **Edit sketch plane** (FR-SK-007). Right-click a sketch in the tree: pick another plane or flat face, the sketch shows there live in orange, and ✓ moves it. On edge curves on the new plane follow their edges again, or dangle if they no longer resolve.

## [1.53.0] - 2026-11-07

### Added
- **Shared vault on a synced folder** (FR-PDM-070/071). Locks are written as their own records, so two people checking out the same file over a slow sync never overwrite each other. The earlier check-out wins and the later one is shown to both. A check-in over a version someone else checked in meanwhile is refused, and you can **save your work as a new file** or **discard** it. An Admin can **break a lock** (logged with a reason). Shared vaults also keep every file record, so a sync conflict loses nothing.
- **Change requests and change orders** (FR-PDM-053). **Request change…** on a file records a title, the reason, the affected files and who to notify. **Change orders** lists them. **Approve** moves the released files to Change pending, **Reject** needs a comment, and **Close and release** takes every file through review to its next revision together and writes the order number on the released versions.
- **Release packages** (FR-PDM-054). Files released together, or by a change order, are recorded as a package. **Export ZIP** saves those exact versions as `name_revB.ext` files with a list.
- **Notifications** (FR-PDM-061). The **Notifications** button counts what others did since your last visit (check-ins, releases, change orders) and what was addressed to you or your role.
- **Workflow editor** (FR-PDM-035). Edit the states (colour, can be checked out, released, obsolete) and the transitions (next revision, role, comment, released references, required fields), export and import the workflow as JSON, or reset it to the default.

## [1.52.0] - 2026-11-07

### Added
- **Revisions and lifecycle in the vault** (FR-PDM-030..034, 037). Every vault file now has a state: Work in progress, In review, Released, Change pending or Obsolete, shown with a coloured dot in the Vault tab. **Change state** moves a file: Submit for review, Approve, Reject, Change, Submit change and Make obsolete. Approve gives the next revision (A, B, C …) and writes the revision, state, approver and date into a part's properties as a new version. The dialog lists the file and the files it uses in the same state, with what blocks the change and what only warns, before anything is written, so an assembly and its parts can be released together. Only files in Work in progress or Change pending can be checked out. The title shows `v12 · Rev B · Released`.
- **Data cards and numbering** (FR-PDM-040/041). **Data card** edits the part number, description, material, project and any other fields while the file is checked out. Fields can be text, number, date, list, checkbox or user, can be required for release, and map to the part's properties both ways. **New number** takes the next number from the vault's pattern (for example `MC-{YYYY}-{0000}`), and numbers are never reused. New files can be numbered as they are added.
- **References, Contains and Where used** (FR-PDM-020..022, 052). The vault records which files an assembly or drawing uses, and the version each was checked in against. **Contains** shows the tree with quantities, as checked in, latest or latest released, with a bill of materials you can save as CSV. **Where used** shows every file above it.
- **Rename / move, Copy tree and Recycle bin** (FR-PDM-023..025). Renaming or moving a file updates the files that use it, each with a new version. **Copy tree** copies an assembly with the parts you choose into a folder, with a prefix, suffix or find/replace and new part numbers, and points the copies at each other. **Delete** moves a file to the **Recycle bin**, which restores it, and a file still in use cannot be deleted.
- **Search and compare** (FR-PDM-042, 050). Search the vault by name, any data card field, state, revision, who has it checked out, kind, date, or "contains a file with Material = Aluminium 6061", and save searches. **History** compares two versions: data card, added and removed features, changed parameters (old → new), references and BOM changes.
- **Vault settings**: revision scheme (letters with or without I, O, Q, S, X, Z, numbers, ESKD letters or your own list, with optional pre-release revisions X1, X2 …), numbering pattern, data card fields, and user roles for a shared vault (Designer, Checker, Approver, Admin).

## [1.51.0] - 2026-11-07

### Added
- **Ordinate and centerline diameter dimensions** in the sketcher (FR-SK-063). Horizontal and Vertical ordinate, in the Dimension ▾ menu, dimension a row of points from one base: click the base, where the values go, then each point. The base shows 0. A dimension from a centerline to a point or a parallel line, placed on the far side of the centerline, becomes a ⌀ diameter (twice the distance), as SolidWorks does for revolve profiles.

### Changed
- Polygon moved into the Rectangle ▾ menu of the sketch toolbar (still on G), so the toolbar keeps to two rows with the new Dimension ▾ menu.

## [1.50.0] - 2026-11-07

### Added
- More sketch relations (FR-SK-051). **Intersection** keeps a point where two curves cross: select the point and two lines, circles, arcs or ellipses. **Merge points** appears when two points are selected and joins them into one. The second point is replaced by the first in every curve, relation and dimension, and a curve left with no length goes. The "along X/Y of another point" relation is the existing Horizontal / Vertical on two points.
- **Heat-set insert** holes in the hole wizard, for brass threaded inserts melted into 3D-printed plastic. Sizes M2 to M8 fill a straight, flat-bottomed hole at the insert makers' usual diameter (M3: Ø4.0 mm), 1 mm deeper than the insert. The panel shows the insert length and the least wall to leave around the hole.

## [1.49.0] - 2026-11-07

### Added
- **Intersection curve** in the sketcher (FR-SK-036), in the Offset ▾ menu. Click model faces, and the curves where the sketch plane cuts them are added to the sketch, fixed in place like converted edges. Flat faces give lines, and round faces square to the sketch give circles or arcs on their exact radius. Any other face gives a spline through the cut.

## [1.48.0] - 2026-11-07

### Added
- **Sketch assistant** (FR-SLV-009). When a sketch is over-defined, for example after an undo, an equation change or an opened file, the sketch panel now lists the relations and dimensions whose deletion makes it solve again. The conflicting ones are tried first, and pairs are offered only when no single item works. **Show** highlights an option in the sketch, and **Delete** removes it as one undoable step.

## [1.47.0] - 2026-11-07

### Added
- **Offline start** (FR-STO-030). A service worker keeps this version's app files and the STEP reader in the browser after the first visit, so MöbiusCAD starts without a network connection. The full OpenCASCADE build (50 MB, for modelling and exact geometry) is kept the first time it loads. Each release gets its own cache and the old one is removed. The page itself is always fetched fresh when online, so new versions show at once. A one-time note says when offline start is ready.

## [1.46.0] - 2026-11-07

### Added
- **Coordinate system** reference feature (FR-REF-005), under Plane ▾. Pick an origin (a vertex, or a reference point in the tree; the part origin if none), a Z direction and an X direction (a straight or round edge, a flat or round face, or a reference axis). Each direction can be reversed, and X is made square to Z. It shows as a red/green/blue triad. Right-click it in the tree and choose **Use for measurements and export**: positions, ΔX/ΔY/ΔZ, the centre of mass in Mass properties and STL/OBJ/glTF exports are then in that frame. The frame follows the model through rebuilds.
- Mesh exports (STL, OBJ, glTF) now use the active coordinate system, whichever way it was set.

## [1.45.0] - 2026-11-07

### Added
- **Under-defined analysis** in the sketcher (FR-SLV-010). Select a sketch item and orange arrows show the directions it can still move. A point free in the plane gets four arrows, and a point that can only slide along a line or circle gets two. A fully defined item shows none. The solver works these out from the free motions (null space) of its constraint system.

## [1.44.0] - 2026-11-07

### Added
- **Snapshots** (FR-STO-005). Every save of a part outside a vault also keeps a snapshot in this browser, up to the last 20 per part. The new ▾ next to Save opens **Save as…** and **Snapshots…**. Snapshots… lists them by time and size, with **Restore**, which puts the part back to that save as one undoable step, and **Open as copy**. A vaulted part points you to its History instead.

## [1.43.0] - 2026-11-07

### Added
- **Mass property override** (FR-MAT-004). Part properties has a new "Override mass properties" option for purchased or simplified parts. Enter the real mass in kg and, if you like, the centre of mass in mm. Mass properties then shows those values marked "(overridden)", and the centre-of-mass marker moves to the entered point. Any value left empty stays calculated. The override is saved in the part file.

## [1.42.0] - 2026-11-07

### Added
- **Multiple radius fillet** (FR-FT-031). Tick "Multiple radius fillet" in the Fillet panel and each picked edge gets its own radius field in the edge list. Every edge shows its own callout in the view (R1, R2…), which you can click to type that edge's size. Edges you don't change use the default radius. Unticking it puts every edge back on one radius.

## [1.41.0] - 2026-11-07

### Added
- **More extrude end conditions** (FR-FT-012). **Up to next** stops at the next face the profile meets: a boss fills the gap up to the body, and a cut goes through the material until it first opens into a void. **Up to vertex** ends level with a picked vertex (click near the end of an edge) or a reference point, extruding toward it.
- **Start from** for extrudes (FR-FT-013): the sketch plane, an **Offset** from it (the drag arrow moves with it), a parallel **face or plane**, or level with a **vertex**. It works with every end condition.

## [1.40.0] - 2026-11-07

### Added
- **Vault backup and storage** (FR-PDM-007/008).
  - **Export ZIP** saves the whole vault, or only the latest versions: settings, history, audit trail, stored versions and working files.
  - **Import vault ZIP…** on the Vault tab's start screen turns a backup into a new vault in this browser, so a vault moves between computers.
  - **Storage** lists the space each file takes, with every stored version counted once. **Purge old versions** keeps the last *n* versions of each file. Older versions stay in the history, marked "purged", but their content is deleted. Purges are logged in the audit trail.

## [1.39.0] - 2026-11-07

### Added
- **Local vault** (FRS 12.5, FR-PDM-001…016, 060, P2 first slice). The new **Vault** tab in the left panel creates or opens a vault. A vault can live in this browser's private storage, which every browser has, or in a folder on disk (Chromium). It keeps every version of every file in a hidden `.mcadvault/` folder beside the working files. Each version's bytes are stored once, under their SHA-256. Each file has a record, and every action is appended to an audit log.
  - **Save part to vault** puts the open part in as version 1, checked out to you. **Add files…** vaults any file, such as STEP, PDF, DXF or images.
  - **Check out / Check in / Undo check-out**. A vaulted file is read-only until you check it out: a bar above the feature tree offers Check out, and Save refuses to write over the vault copy. Check in asks for a comment and can keep the file checked out; an unchanged file makes no new version. The title shows the version and the lock, and the file list shows the version, a lock badge with the user, and "modified".
  - **History** lists every version with date, user, comment and size, plus the file's events. From there you can open any version read-only, or **Roll back**, which adds a new version with the old content, so history is never rewritten.
  - **Get latest**, the **Audit trail** (with CSV export) and an **Integrity check** for missing or damaged versions and unused objects.
  - Set your user name at the top of the tab; check-outs also record which browser made them.

## [1.38.0] - 2026-11-07

### Added
- **Modelled (helical) threads** (FR-FT-055). Tick "Modelled (helical) thread" in the Cosmetic thread panel to cut the real thread form into the part, for 3D printing. It cuts a 60° V groove along a helix at the size's pitch over the thread length (or up to the end of the cylinder). Internal threads cut from the tap drill out to the major diameter, and external threads cut from the shaft in to the minor diameter. The groove starts one pitch outside the end face so it runs out cleanly. It takes several seconds to rebuild, so leave it off while you are still designing.

## [1.37.0] - 2026-11-07

### Added
- **Main planes in the view.** The Top, Front and Right planes are now always drawn, faintly, so you can pick them in the view as well as in the tree. Click one away from the model to select it; the context toolbar offers Sketch and Normal to. Hide or show each one from its right-click menu in the tree.
- **Show sketches used by features.** A sketch that an extrude or revolve uses is still hidden by default, as in SolidWorks, but Show in its right-click menu draws it over the body again (Hide puts it away).
- **Normal to button and N shortcut.** Normal to, next to the standard views, and the **N** key turn the view square to the selected flat face, the selected plane or the open sketch; pressing again shows the other side. The point/normal measurement moved from N to **V**.
- **Centre and midpoint inference.** Hovering a circle or arc edge shows its centre, and hovering a straight edge its midpoint, as a faint marker (as in SolidWorks). Move onto the marker to pick it, even when the model hides that point, as at the far end of a hole.

- **Shaded cosmetic threads** (FR-FT-054). Cosmetic threads and tapped holes now show a helical thread texture on the cylinder over the thread's length, as SolidWorks' shaded cosmetic threads do, as well as the dashed circles. The stripes follow the thread's pitch.
- **Pinned measurements follow the model.** In a part you are modelling, a pinned measurement remembers the faces and edges it was taken on, by their persistent names, and measures them again after every rebuild, like a SolidWorks reference dimension. Widen the block, and the pinned edge length changes with it. If the geometry is gone, the measurement keeps its old value and is marked "out of date".

### Fixed
- **Hole wizard snapping.** A hole clicked near the origin now lands exactly on it (the origin projected onto the hole's face), and clicks also snap to model vertices, arc centres, midpoints and quadrant points lying on the face. Before, the point was rounded from wherever the cursor hit, so it was a little off.

## [1.36.0] - 2026-11-07

### Added
- **Selection helpers for Fillet and Chamfer** (FR-SEL-005). Right-click an edge while picking edges and choose one of three helpers. Select loop takes the boundary of the face under the cursor that runs through the edge. Select tangency takes the smooth chain. The third helper takes every round edge of the same radius, or every straight edge of the same length, such as all the holes of one size.

## [1.35.0] - 2026-11-07

### Added
- **Spline in sketches** (FR-SK-019), in the Line ▾ menu: click the points the curve passes through. A double-click ends it, and clicking the first point again closes it. It is a smooth (C2) cubic interpolating spline, parametrised by chord length. Its points are ordinary sketch points, so dragging, dimensions and relations on them reshape the curve. Closed splines, or open ones joined to other curves, make regions that extrude, revolve and cut as a single exact B-spline face. Splines also work with sketch mirror, patterns, move, rotate, scale and box selection.

## [1.34.0] - 2026-11-07

### Added
- **Ellipse and partial ellipse in sketches** (FR-SK-018), in the Circle ▾ menu. Click the centre, the end of the major axis, then a point on the ellipse; a partial ellipse also takes a start and an end and runs counter-clockwise. The centre and the two axis points are sketch points, so you dimension and relate them like any other: the solver keeps the minor axis square to the major one and the arc ends on the curve. Points can be made coincident with an ellipse or concentric to it. Ellipses extrude, revolve and cut as exact OCCT ellipses, and they follow sketch mirror, patterns, move, rotate, scale and box selection.

## [1.33.0] - 2026-11-07

### Added
- **Hole favourites** (FR-FT-056): in the Hole panel, Save as favourite keeps the current definition under a name. That covers the type, size, fit, diameters, counterbore or countersink, thread depth and end condition. Choosing a favourite applies it in one step, and Delete favourite removes it. Favourites are kept in this browser and work across parts.

## [1.32.0] - 2026-11-07

### Added
- **Cosmetic thread** (FR-FT-054): pick a round edge of a hole or a shaft. The feature works out whether the thread is internal or external, fills in the nearest ISO metric size (matched by tap drill for holes and by nominal diameter for shafts) and draws the thread as dashed circles. Internal threads show the major diameter and external ones the minor diameter. The length runs to the end of the cylinder or is set by a value. The geometry is unchanged.

### Fixed
- A revolve set to Up to face or plane now counts the plane or face as its parent, so reordering and parent marks take it into account.

## [1.31.0] - 2026-11-07

### Added
- **Tangent propagation** for Fillet and Chamfer (FR-SEL-005): clicking an edge also picks the edges that run on smoothly from it, such as the whole rounded outline of a plate. It is on by default, as in SolidWorks, and there is a checkbox for it in the panel.
- **Feature tree filter** (FR-HIS-011): type in the box above the Features tree to show only the features whose name matches. A folder stays visible while any of its features match.

## [1.30.0] - 2026-11-07

### Added
- **Folders in the Features tree** (FR-HIS-009): right-click a feature and choose Add to new folder, or add it to the folder of the feature above or below. A click on the folder opens or closes it (also Enter, ← and →), double-click or F2 renames it, and deleting a folder keeps its features.
- **Freeze bar** (FR-HIS-024): Freeze up to here on a feature's menu keeps that feature and everything above it as built; they are not rebuilt and can't be edited, suppressed, deleted or moved until you choose Unfreeze all. Features below the bar still rebuild on the frozen body.

## [1.29.0] - 2026-11-07

### Added
- **Linear and circular sketch patterns** (FR-SK-038): select sketch entities and click Linear pattern or Circular pattern in the sketch toolbar. A PropertyManager sets spacing, instances and angle for one or two directions, or the centre, instances and total angle (equal spacing or a fixed step); the green preview updates as you type. Each copy keeps an equal relation to its seed (lines in a linear pattern also stay parallel). A lone point selected with the entities is taken as the circular pattern's centre.
- **Move, copy, rotate and scale sketch entities** (FR-SK-039): Move (delta X/Y), Rotate (centre and angle) and Scale (centre and factor) with the same live preview. Copy adds transformed copies; in place, Keep relations decides whether relations and dimensions to the rest of the sketch stay (and pull back) or are removed. Dimensions inside a scaled selection scale with it.
- **Revolve options** (FR-FT-022): Revolve type Blind, Mid plane or **Up to face or plane** (a flat face or plane through the axis; the revolve stops where the profile first meets it), **Direction 2** with its own angle, and **Thin feature** (a wall inside, outside or centred on the profile).

## [1.28.0] - 2026-11-07

### Added
- Extrude end conditions (FR-FT-012): **Offset from surface** stops short of a face or plane by a distance (or goes past it, reversed), and cuts get **Through all - both**.
- **Draft while extruding** (FR-FT-014): the side faces taper inward or outward by an angle, for blind and mid-plane extrudes.
- **Thin feature** (FR-FT-015): an extrude can make a wall of a set thickness along a closed profile, inside it, outside it (rounded outer corners) or centred on it.

## [1.27.0] - 2026-11-07

### Added
- **DXF into a sketch** (FR-SK-040, AT-P2-5): the DXF button in the sketch toolbar imports lines, arcs, circles and polylines (bulges become arcs) into the open sketch, scaled from the file's units. Shared end points join, so closed outlines extrude straight away.
- **Sketch mirror** (FR-SK-037): select entities and the line to mirror about, then click Mirror. The copies are tied to the originals with symmetric relations (circles also equal), so they follow when the originals change.

### Fixed
- A sketch region with a hole inside it (a circle in a rectangle, say) could extrude with the hole's volume added instead of removed. Hole contours are now always wound against the outer one.

## [1.26.0] - 2026-11-07

### Added
- **Configurations** (FR-CFG-001/002): variants of a part from ◇ at the top of the Features tree. Each keeps its own dimension and parameter values, instance counts, variables, suppressed features and material; switching rebuilds the part, and undo can switch back.
- **Reorder features** (FR-HIS-006): drag a feature in the tree onto another, or press Alt+↑/↓. A sketch used only by the moved feature goes with it. A move that would put a feature before something it uses is refused with the reason.
- **Parent/child marks** (FR-HIS-007): with a feature selected, ↑ marks the features it uses and ↓ the ones that use it.

## [1.25.0] - 2026-11-07

### Added
- **Equations** (FR-PAR-001..005): global variables (length, angle or plain number, with a comment) in a panel opened from Σ at the top of the Features tree. Any value box takes a variable's name or an expression of them, like `Width/2 + 5`.
- **Draft** (FR-FT-061): tapers the picked faces by an angle about a neutral plane (a flat face or a plane); the faces keep their size where they cross it, and Reverse direction tapers the other way.
- Sketch dimensions have names (`D1@Sketch1`) that other values and variables can use.
- Expressions are kept with each value and re-evaluated whenever a variable or a referenced dimension changes; sketches whose dimensions change are solved again. Circular references and unknown names are shown as errors next to the variable.

### Fixed
- Hole wizard: clicks made before the face's frame is ready are no longer lost (only one of two quick clicks became a hole).
- Input errors such as an unknown name are translated in the Russian interface.

## [1.24.0] - 2026-11-07

### Added
- **Hole wizard** (FR-FT-050..053): simple, counterbore, countersink and tapped holes, blind (with a 118° drill point or a flat bottom) or through all. Click a flat face, then click where each hole goes; click a hole again to remove it.
- ISO metric sizes M2–M24 (FR-FT-051) fill the sizes: ISO 273 clearance holes (close, normal or loose), counterbores for ISO 4762 cap screws, 90° countersinks for ISO 10642, and tap drills. Typing a size makes the hole custom.
- Tapped holes show a dashed **cosmetic thread** at the major diameter and keep the thread size, pitch and depth.
- Holes can be patterned and mirrored like other cuts.

## [1.23.0] - 2026-11-07

### Added
- **Shell** (FR-FT-060): hollows the body to a wall thickness, inward or outward; click the faces to leave open, or none for a closed hollow body.
- **Linear pattern** (FR-FT-070): copies of extrudes, cuts, revolves, mirrors or patterns along one or two directions (an edge, a face's normal or a reference axis), with spacing, instance count and instances to skip.
- **Circular pattern** (FR-FT-071): copies about an axis (a round edge or face, a straight edge or a reference axis), spread equally over an angle or at a set angle apart.
- **Mirror** (FR-FT-072): mirrors the picked features, or the whole body when none are picked, about a plane or flat face.
- Copies that miss the body, or land where material is already gone, are skipped with a warning listing them (FR-FT-075). Pick the features to copy by clicking their faces or their rows in the tree; the pattern tools share a ▾ button on the feature bar.

### Fixed
- The header refits its tools when the text inside it changes (the open file or its status), not only when the window is resized, so it no longer overflows at 1280–1366 px.

## [1.22.0] - 2026-11-07

### Added
- **Context toolbar** (FR-UI-026): clicking a face or an edge of a part opens a small bar by the cursor, as in SolidWorks: Sketch and Normal to on a flat face, Fillet and Chamfer on an edge (they start with that edge), and Edit sketch / Edit feature for the feature that made it. It fades as the pointer moves away.
- **Selection filter** (FR-SEL-003): F5 or the Filter button turns faces, edges or vertices off so clicks pick only what is wanted, in measuring and modelling alike; Clear resets it.
- **Select other** (FR-SEL-004): Alt+click picks the face hidden behind the one under the cursor; Alt+click again at the same spot for the next.

## [1.21.0] - 2026-11-07

### Added
- Reference **Axis** (FR-REF-003) from a straight edge, a cylindrical or conical face, or two planes, and reference **Point** (FR-REF-004) at a vertex, an arc or circle centre, a face centre or an edge midpoint. Both sit under the Plane ▾ flyout, show in the tree and can be hidden.
- **S shortcut bar** (FR-UI-025): press S to open the most-used commands at the cursor, sketch tools in a sketch and features otherwise.
- **Box selection** in sketches (FR-SEL-002): drag left to right to select what lies fully inside, right to left to also catch what the box crosses.

### Changed
- S no longer switches to Select in a sketch; Esc does.

## [1.20.0] - 2026-11-07

### Added
- Sketch **Slot** (W, FR-SK-017): two centres, then the width; two lines and two end arcs, tangent and equal, on a construction centre line.
- Sketch **Extend** (E, FR-SK-031) lengthens a line or arc to the next curve, and **Split** (FR-SK-032) cuts it in two where you click.
- Sketch **Chamfer** (FR-SK-033): bevels the corner of two lines by the distance set in the panel.
- **Offset entities** (O, FR-SK-034): offsets a circle, or a whole chain of joined lines and arcs, to the cursor's side with a live preview; corners are re-joined and arcs stay concentric.
- **Convert entities** (FR-SK-035): copies the model edges you click, or all edges of a face, into the sketch as fixed lines, circles and arcs.

### Changed
- The sketch toolbar groups related tools behind a ▾ flyout, as in SolidWorks (Rectangle, Circle, Arc, Trim/Extend/Split, Fillet/Chamfer, Offset/Convert); each button shows the last tool picked from it, and Dimension sits next to Select. The bar wraps instead of running under the view cube.

## [1.19.4] - 2026-11-07

### Added
- Revolve angle handle: an orange arc about the axis with a grip at the end angle. Drag it round the axis to set the angle (1° steps, Shift for 0.1°, up to a full turn; Mid plane sweeps both ways). Selecting a revolve in the tree and dragging its grip edits it at once as one undo step, like the extrude arrow.
- Cut preview: while a cut (extrude or revolve) is open, the material it removes is shown as a see-through yellow body with its outline, as in SolidWorks.

### Fixed
- Dragging a handle keeps working when the pointer leaves the 3D view; the release is no longer lost.

## [1.19.3] - 2026-11-07

### Changed
- Feature panels are laid out like SolidWorks' PropertyManager: ✓/✕ at the top, then titled groups (Extrude: From, Direction 1, Direction 2; Revolve: Axis of revolution, Direction 1, Profile; Fillet and Chamfer: Items, Parameters, Options; Plane: First reference, Placement).
- Fillet and Chamfer list the picked edges ("Edge 1", "Edge 2"…) with a remove button on each, and show the whole new rounded or bevelled face as a see-through yellow ghost over the body.
- An extrude or revolve being edited shows its new faces tinted yellow, as a preview.
- While drawing in a sketch, a label at the cursor gives the live size (length and angle, radius, width × height).

### Fixed
- A value being typed in a feature panel is no longer put back to the old one when a rebuild finishes before Enter is pressed.

## [1.19.2] - 2026-11-06

### Fixed
- Fillet and Chamfer preview live again, SolidWorks style: while edges are picked on the body, the new faces show in see-through yellow and a callout at the first edge gives the radius or distances; it follows every change of edges or size. A size that does not fit shows its error in the panel at once.

## [1.19.1] - 2026-11-06

### Fixed
- **New part** on the start screen hides the start card at once, instead of leaving it up until the geometry kernel has loaded.

## [1.19.0] - 2026-11-06

### Added
- Drag to extrude or cut: an orange arrow on the model sets the depth of an Extrude or Cut with the mouse while its panel is open, with a live preview and the value beside the arrow (Shift: finer steps). Select an extrude in the tree and drag its arrow to change it at once, as one undo step (FRS FR-FT-017, FR-UI-027).
- Reference planes (**Plane**): offset from a standard plane, a flat face or another plane, or at an angle about a straight edge. Sketches go on them like on the standard planes, and they are drawn in the view (FR-REF-002).
- Extrude and Cut **Up to face or plane**, and **Flip side to cut** to keep the material inside the profile (FR-FT-011, FR-FT-016).
- Chamfer with two distances, or a distance and an angle, with a flip of the measuring face; Fillet **Keep features that fit** skips edges it cannot round and says how many (FR-FT-034, FR-FT-040).
- Sketch tools: 3-point circle, 3-point arc, polygon (3 to 64 sides on a construction circle), trim up to the nearest crossings, and sketch fillet with tangent relations and a radius dimension; the sketch panel lists every relation with select and delete (FR-SK-014..016, 030, 033, 055).
- Feature tree: rollback bar (drag it, or use the arrow keys), F2 rename, a right-click menu (edit, edit sketch, rename, suppress, hide plane, roll back, delete), sketches nested under the feature that uses them, the selected feature's faces highlighted in the view, and warnings shown in amber (FR-HIS-002..008).
- Part properties (double-click the part name): name, title, part number, description, revision, author, material and colour. The material presets the mass panel, which now lists the principal moments and axes of inertia of a modelled part from the exact geometry (FR-DOC-007, FR-MAT-001..003).
- An empty part shows buttons to start a sketch on Top, Front or Right (FR-HLP-005).
- Views: Ctrl+1 to Ctrl+7 for the standard views, Ctrl+8 normal to the sketch or the selected flat face (again for the other side); Ctrl+B rebuilds and Ctrl+Q rebuilds everything with a fresh kernel (FR-UI-030/031, FR-HIS-020).
- Leaving a sketch makes its edits one undo step on the part (FR-UND-003); starting Extrude from inside a sketch leaves the sketch and uses it (FR-SK-004); an edge picked with Smart measure is taken by Fillet and Chamfer (FR-SEL-006).

### Changed
- New sketches and features go in at the rollback bar.
- Clicking a face picks it even where a standard plane is drawn in front of it.

## [1.18.0] - 2026-11-06

### Added
- Part modelling, the first slice of the parametric modeller in [docs/FRS-modelling.md](docs/FRS-modelling.md) (phases P0 and P1). **New part** (the page icon next to Open, or on the start screen) starts a part with a feature history; the **Features** tab lists the origin planes, sketches and features, and a command bar over the view holds the commands, SolidWorks style, with ✓ / ✕ in the corner of the view.
- Sketcher on Top (XY), Front (XZ), Right (YZ) or any flat face: lines, corner and centre rectangles, circles, arcs and points, with snapping and automatic horizontal, vertical and coincident relations. Smart dimensions take units and arithmetic (`25.4 mm`, `1in`, `100/3`, `30deg`). Relations: coincident, horizontal, vertical, parallel, perpendicular, collinear, equal, tangent, concentric, midpoint, symmetric, fix, plus construction geometry. A constraint solver shows free (blue), fully defined (black) and over-defined (red) geometry and the degrees of freedom left, and geometry can be dragged.
- Features: Extrude and Cut (blind, mid plane, through all, second direction, reverse), Revolve (boss or cut, any angle, around a sketch line), Fillet and Chamfer on edges picked in the view (a face picks all its edges). The view previews the result while values are typed. Faces and edges keep their names through edits, so changing an early feature rebuilds the later ones on the moved faces.
- Edit any feature by double-clicking it, suppress or delete it (dependent features are named first), undo and redo every step (Ctrl+Z / Ctrl+Y, 200 steps).
- Part files: **Save** (Ctrl+S) writes a `.mcadprt` file (a zip with the feature history as JSON, stable for version control), and Open reads it back. **STEP** exports the solid. Unsaved changes are kept in the browser and offered for recovery on the start screen after a crash or a closed tab.
- Modelled parts use the existing tools: Smart measure, sections, mass properties and exports work on them with exact geometry.
- The geometry kernel is full OpenCASCADE (opencascade.js) in a worker, which keeps the part's history cached so edits near the end rebuild fast; a worker that crashes or grows too large is restarted from the document.
- Unit tests for the kernel, the sketch solver, expressions and documents (`npm run test:unit`, run in CI), and modelling checks in the smoke test.
- Help has a Modelling page, and the new interface is in Russian too.

### Changed
- The Parasolid parser from parasolid-kit is now kept in this repository (`native/parasolid-core`) instead of being fetched from GitHub at build time, so it can be fixed here. It reads all test files exactly as before.

## [1.17.0] - 2026-11-06

### Added
- Section button: press **Section** in the header and click a face. A flat face puts the plane on that face; a cylinder cuts through its axis, square to the view. The face under the pointer is highlighted while choosing and Esc cancels. The plane's sheet and drag arrows are anchored at the click instead of the model centre.

## [1.16.0] - 2026-11-06

### Added
- SolidWorks parts (.sldprt) and assemblies (.sldasm) open directly, with no SolidWorks needed. MöbiusCAD reads the Parasolid model stored inside each part and rebuilds it as exact geometry (planes, cylinders, cones, spheres, tori, fillets, B-splines and intersection curves), so measurements, sections, mass properties and STEP export all work as on a STEP file. Parts made from imported STEP bodies and files from before SolidWorks 2015 open too.
- Assemblies are put together from their component list with each part's placement, sub-assemblies included, and keep their tree and part names. Drop the assembly with its part files, or drag the whole folder onto the window; parts that are missing are named in a notice and left out.
- When a file has no geometry that can be read, SolidWorks' own preview picture is shown instead.
- The Parasolid reader is parasolid-kit (MIT / Apache-2.0), compiled to WebAssembly (about 190 KB compressed) and loaded only when a SolidWorks file is opened.

## [1.15.0] - 2026-11-06

### Added
- Drag arrows on section planes. A new section plane appears as a see-through sheet with two arrows along its normal, one on each side, at the middle of the cut. Drag either arrow to slide the plane through the model; the caps, cut curves, cut area and the offset in the Section panel follow live, and the camera stays put. The arrows keep the same size on screen at any zoom and turn orange under the pointer. **↕** on a plane brings them back after Esc, and **⟳** swaps them for the rotation rings.

## [1.14.1] - 2026-11-06

### Changed
- One header row. The measuring tools and the right-panel pages (Properties, Section, Explode, Mass, Export) moved from the strip under the header into the header itself, next to the display modes, projection and Fit, which are now icons (hover for the name and key). The header stays one row from 1366 px wide, in English and Russian: when space runs short the page labels fold into icons, then the Display label, then the name beside the logo (the logo's tooltip keeps it). Only narrower windows and phones put the tools on a second row.
- A **Display** menu in the header holds what used to be loose controls: **Origin axes** and **Ambient occlusion** (was Axes and AO, now with a short note on what ambient occlusion does), mesh quality, and the measurement units, decimals and colour.

## [1.14.0] - 2026-11-06

### Changed
- Tools are always in view. A tool strip under the header holds every measuring tool (Smart, point–point, min distance, radius, diameter, centre–centre, edge length, angle, 3-point angle, point / normal, bounding box, note), the right-panel pages (**Properties**, **Section**, **Explode**, **Mass**, **Export**) and the units, decimals and measurement colour, so nothing needs scrolling to reach. The right panel shows one page at a time instead of a long stack of sections; click the open page again to hide the panel. Labels fold into icons on narrower screens (hover for the name and key), and on phones the strip wraps onto two rows. Adding a section plane from anywhere brings up the Section page.

## [1.13.2] - 2026-11-06

### Changed
- The app version is shown under the MöbiusCAD name in the 3D view's header on screens 1360 px wide and up (1366 px laptops included; it used to need 1600 px). On narrower screens the logo's tooltip shows the name and version.

## [1.13.1] - 2026-11-06

### Changed
- STEP, IGES and BREP files open faster. OpenCASCADE now loads and warms up while the page is idle, so the first file no longer waits for it (a 0.6 MB, 41-part assembly shows in 2.4 s instead of 3.5 s; small parts open about twice as fast), and rebuilding faces and edges from the mesh takes about 40% less time.
- Exact values arrive sooner. The exact-geometry kernel is kept running between files instead of being restarted for each one (its start-up took 4–5 s every time), starts as soon as you pick or drag a file, and on machines with 6 or more cores reads the file alongside the import instead of after it. The part's surface area is now the sum of its exact face areas, saving a second integration. On the same assembly exact values now arrive about 10 s after opening the first file (was 15 s) and about 4.3 s after opening each file after that (was 9.3 s).

## [1.13.0] - 2026-11-05

### Added
- Exact geometry: once a STEP, IGES or BREP model is open, a full OpenCASCADE kernel (opencascade.js, WebAssembly, about 15 MB compressed and cached by the browser) reads the file again in the background and matches its faces and edges to the ones on screen. Volume, centre of mass, surface and face areas, edge lengths, circle and arc radii come from the B-rep from then on, cones and tori are recognised, freeform faces get their real curvature, and the Smart card says where the values come from. There is no switch: measurements just become exact, and the status bar shows when the kernel is ready.
- STEP export (**STEP** in Export): the whole model with its assembly, names and colours, or only the visible parts when some are hidden. PCB sets export the board body (outline, cut-outs, slots and holes, at the board thickness) as a STEP solid from the PCB Export panel.
- Section profile to DXF and SVG: **DXF** and **SVG** buttons on each section plane save its cut curves as a 2D drawing in millimetres (DXF R12 for CAD, laser or waterjet; SVG at 1:1), one layer per part. Lines stay lines, holes become true circles and arcs.
- Notes: the **✎ Note** tool (`T`) places a text note with a leader on the model. Drag the note to move it, double-click to edit it. Notes are saved with the measurements and drawn into PNG exports and the PDF report.
- Open STL, OBJ and 3MF mesh files. Their triangles are grouped into planar and curved faces, so planes, holes (cylinders), spheres, edges and circles can be measured like a STEP model, along with sections, mass properties and the other tools.

## [1.12.0] - 2026-11-01

### Added
- About / Credits in Help (the **About** tab): the logo and version, who made it, links to the blog post, the source on GitHub and this changelog, the libraries MöbiusCAD is built on, and a collapsible list of every open-source package in the build with its version, licence and authors, in both languages. The list is generated by the build from the packages that actually end up in the bundle, so it can't go out of date, and the full licence texts ship in `THIRD-PARTY-LICENSES.txt` next to `index.html`. It ends with the MIT licence and a no-warranty note: measurements come from the tessellated model, so check critical dimensions against the original before ordering parts or boards.

## [1.11.0] - 2026-11-01

### Added
- English / Russian interface. The **EN / RU** button in the header switches every label, tooltip, screen-reader name, hint, result card, measurement list and dialog at once, without reloading or losing the open model or board, and the choice is remembered (the first visit follows the browser language; `?lang=ru` or `?lang=en` in the URL also works). Stored measurements switch too. PDF reports and CSV / JSON exports stay in English.
- Help (the **?** button, `F1` or `?`): sections on getting started, the 3D model view, measuring, the PCB view and all keyboard shortcuts, plus an About page, in both languages.
- First-use tips: a short hint the first time you open a model or board, get a Smart result, measure two holes, add a section, use the 3D board or the tree filter. Each shows once; **Turn off tips** stops them and **Show tips** in Help turns them back on.

### Fixed
- The model view header no longer runs off the right edge between 1024 and 1600 px wide (the theme, help and panel buttons were cut off at 1280 px): below 1600 px it shows the logo without the name, a short **Open** and only **Fit** of the standard views (the others stay on the view cube and keys), with tighter buttons below 1280 px.

## [1.10.1] - 2026-10-31

### Fixed
- 3D board no longer flickers or shows streaky traces while rotating. Each side is now one surface with the copper, solder mask and silkscreen composited into its texture (with mipmaps), instead of stacked layers that fought over depth and thin alpha-tested traces that shimmered. Copper under the mask shows as lighter green, exposed copper stays metallic.

## [1.10.0] - 2026-10-31

### Added
- 3D board view for Gerber sets: a 2D / 3D switch in the PCB header (keys `2` and `3`). The board outline is extruded to the board thickness (1.6 mm by default, set under Board) with its cut-outs and drilled holes, plated holes get copper barrels, and copper, solder mask and silkscreen are drawn on both sides in their physical colours (or the colour picked in the layer list). Drag orbits, right or middle drag pans and the wheel zooms, as in the model view; Fit, zoom and Bottom view work in 3D too, and the layer list still shows and hides layers.
- Measuring on the 3D board: Smart, Point–point, Clearance, Polyline and Area work with snapping on the side you look at (only that side's layers, drills and outline are picked), share the measurement list with the flat view, and PNG export captures the 3D view.
- **Measure as 3D model** (Board panel) opens the board body in the model view, so its tools work on the PCB: thickness, hole diameters and pitch, angles, sections, mass properties, STL / OBJ / glTF export. **Back to PCB** returns to the layers.

### Fixed
- README and package homepage link to the app's new address, aerocat.tech/tools/mobiuscad/.

## [1.9.0] - 2026-10-31

### Changed
- The app is now called **MöbiusCAD** (formerly STEP Viewer): new name in the header, page title, help dialog, PDF inspection report and release titles. The repository, archive name and URL path (`/tools/step-viewer/`) stay the same.

### Added
- MöbiusCAD logo in the header, as the favicon (16/32/48 px), Apple touch icon and in a web app manifest (192/512 px icons), so the app can be installed with its own name and icon.

## [1.8.0] - 2026-10-31

### Added
- UI/UX standards, mainly for the PCB view. Header shows the open file with a status badge (loading, open, error) and stays above everything. The side panels collapse with the hamburger / panel buttons or Ctrl+[ and Ctrl+] (⌘ on macOS), and the state is remembered per screen size.
- Responsive PCB layout: full panels from 1280 px; from 768 to 1279 px the layer panel floats over the board and the tool panel stays docked; below 768 px a bottom navigation bar (Board, Layers, Results, Tools) opens the panels as full-screen sheets.
- Toasts stack in the bottom-right corner: information and success close after 4 s, warnings and errors stay until you dismiss them.
- Dialogs have a blurred backdrop, keep keyboard focus inside, close with Esc and return focus. Help also closes on a backdrop click; "Clear all" measurements now asks in a dialog that a stray backdrop click can't dismiss (PCB and 3D).
- Keyboard access: every PCB control is reachable with Tab and shows a 2 px focus ring; layers reorder with Alt+↑ / Alt+↓; measurement lists use real buttons; the 3D model tree works with the arrow keys, Enter and H; tabs switch with ←/→. Icon buttons, swatches and badges have text labels for screen readers, and form fields are linked to their labels.
- Empty states with an illustration and a call to action for the layer list, the measurement lists and the model tree; skeleton placeholders in the panels when loading takes longer than 300 ms; a spinner on PNG/SVG export, PDF report and mass calculation.
- Inline validation for the density field in Mass properties (red message under the field, announced to screen readers).

### Changed
- Colour tokens meet WCAG 2.1 AA contrast in light and dark themes (muted text, accent, error red #D32F2F). Font stack starts with Inter; PCB panels use 14 px body text. Hover, pressed, focus and disabled states on buttons and fields, with 180 ms ease-in-out transitions; export and clear buttons are disabled while there is nothing to export.

## [1.7.1] - 2026-10-31

### Changed
- PCB layer panel is simpler: each layer has only show/hide, colour and drag-to-reorder. The opacity slider, the per-layer remove button and the "+ Add layers" toolbar button are gone; every layer of an opened set is shown.

## [1.7.0] - 2026-10-31

### Added
- PCB / Gerber view. Open Gerber RS-274X and Gerber X2 layers, Excellon drill files (`.drl`, `.txt`, `.xln`) or a `.zip` of a whole set; several files can be dropped at once and more added later. Layer types come from X2 file functions or common file names (KiCad, Altium/Protel, Eagle). Standard and macro apertures, arcs, regions, clear polarity, step and repeat, G85 and routed slots and inch or metric drill formats are read in a worker, so large sets don't freeze the page (a 10 MB, 270,000-object layer opens in a few seconds).
- Layer panel: visibility, colour, opacity, drag-to-reorder stacking, remove; show or hide all. Dark 2D canvas with zoom to cursor, pan (drag, Space+drag, middle drag, pinch), fit, zoom buttons and a mirrored bottom view.
- Measuring on PCB geometry: Smart (one click: pad aperture and size, track width and length, arc radius and sweep, hole diameter and plating, region area, X2 net, pin and pad function; two clicks: pitch and edge-to-edge clearance), point to point with ΔX/ΔY legs, clearance, polyline length and polygon area. Shift+click a pad, region or closed outline such as the board edge for its exact area, arcs included.
- PCB snapping to corners and track ends, midpoints, pad and hole centres, track edges and the perpendicular foot on a track edge, each switchable; a live tooltip at the cursor; units mm, inch or mil with 0 to 4 decimals.
- PCB measurement list (show/hide, delete, clear, CSV), board summary (size, track and pad counts, holes, smallest hole, narrowest track) and PNG or SVG export of the view with the measurements.

## [1.6.1] - 2026-10-31

### Fixed
- The marker on the first pick of a two-click measurement stays the same size on screen when zooming. It was a solid dot sized to the model, so zooming in grew it into a disc that covered the geometry behind it; it is now a small hollow ring that leaves the picked point and its surroundings visible. The centre-of-gravity marker keeps a constant screen size too.

## [1.6.0] - 2026-10-31

### Changed
- Picking respects what you can see. In Shaded, Shaded+Edges and HLR, vertices, edges, centres and faces hidden behind a body (or behind a section cap) are no longer snapped or highlighted; Wire and X-ray still pick through the model.
- Hover and selection edge highlights hide behind the model in opaque modes instead of drawing through it.
- More accurate snapping in dense scenes: faces under a ring of probes around the cursor contribute their edges, so an edge right beside the cursor is found even when the face under the cursor belongs to another part, and an edge half hidden behind its own body snaps on the half that shows. In X-ray every face along the cursor ray contributes.

## [1.5.1] - 2026-10-31

### Fixed
- Smart measure no longer freezes on two big faces, such as the two sides of a PCB with many holes: face-to-face distance now walks both faces' BVHs and stops as soon as it finds the plane gap. Board thickness on a 4,000-triangle face takes milliseconds instead of about 30 seconds.
- Edge-to-face distance uses the face's BVH too, so a long edge against a big face no longer stalls.

## [1.5.0] - 2026-10-31

### Removed
- Draft angle and wall thickness analysis, along with the Analysis panel. Mass properties are unchanged.

## [1.4.0] - 2026-10-30

### Added
- Every two-point distance (point to point, centre to centre and pitch, edge to edge, point or centre to a line or plane, shortest distance) draws thin red, green and blue ΔX, ΔY and ΔZ legs, each with its own dimension label. The legs follow the active CSYS and appear in PNG and PDF snapshots.
- X, Y, Z axes from the model origin (0, 0, 0), with letters at the tips. Toggle them with "Axes" in the toolbar (remembered).

### Changed
- Orthographic projection is the default; the last choice is remembered.
- The readout card is docked in the bottom-left corner by default; ⇱ floats it beside the measurement.
- Releases can be started from GitHub's Actions tab (Release → Run workflow): it tags `main` itself after the tests pass, so no tag push is needed. The release reuses the CI result of the commit instead of testing again, and CI on `main` now runs every commit at once.

## [1.3.0] - 2026-10-30

### Added
- Smart measure covers the full single and two-entity matrix:
  - Straight edge: midpoint alongside length, direction and ΔX/ΔY/ΔZ. Arc: the normal of its plane.
  - Planar face: perimeter (all loops). Cylinder: length along the axis and a point on the axis.
  - Freeform face: smallest and largest radius of curvature, estimated from the tessellation.
  - Whole part ("⬚ Whole part" in the readout): bounding box, volume, surface area and centre of gravity.
  - Point to straight edge or plane: perpendicular distance to the infinite line or plane, with the foot point and whether it lies on the edge or its extension.
  - Parallel edges: alignment offset. Non-parallel straight edges: intersection point, real or on the extension, or the skew distance between the lines. Non-parallel planes: direction of the intersection line and a point on it.
  - Two round features: minimum edge-to-edge and maximum outer span next to centre to centre, with a Centre to centre / Minimum / Maximum switch in the readout that redraws the dimension, and the axis relation (parallel, concentric, perpendicular, skewed).
- Point-to-point distance draws its ΔX, ΔY and ΔZ legs along the axes in red, green and blue.
- The readout card has its own units and decimals switches. Click any value in it to copy it (a single length or angle is copied as the bare number).
- Feet as a display unit, and a Decimals setting (auto or 0 to 6 places).
- JSON export of measurements: raw values in millimetres and radians, world points, every detail row, and the text as displayed.
- User coordinate system: "⌖ CSYS here" in the readout sets a frame on a planar face (Z its normal, X along its longest edge), a straight edge (X along it), a circle or cylinder (Z its axis) or a vertex. Coordinates, directions and ΔX/ΔY/ΔZ everywhere (readout, properties, status bar, the axis legs) re-project at once; "Global CSYS" goes back. Exports keep world values.
- Quadrant snaps (0°, 90°, 180°, 270°) on circles and arcs, ranked with midpoints.
- Intersection snaps (red X): where a face's straight edges would meet past a fillet or chamfer, offered on that face and on the fillet beside it.
- The readout card floats beside the measurement and follows it as the view turns; ⇲ docks it in the corner (remembered).
- Measurements record their component (tree path and part number), shown in a new Component column of the CSV export and PDF report.

### Changed
- Snap markers: vertex a solid orange square, midpoint a green triangle, quadrant a green diamond, centre a cyan circle with crosshair, intersection a red X, face a blue diamond. Snap radius 15 px; circle centres rank with vertices.

## [1.2.0] - 2026-10-30

### Added
- Smart measure, now the default tool: click one point, edge or face for its size (diameter, radius, length, area, position), then a second to measure between them. It chooses the measurement itself: pitch or centre distance for holes, bosses, arcs and cylinders; normal distance for parallel faces and lines; centre to face or line; angle for non-parallel entities; otherwise the shortest distance, with the other values listed as details. Pin keeps a result; clicking empty space or Esc clears it.
- Round planar faces (disc tops, washers) count as circles, and a half-arc of a split circle reads as the full circle.
- Version number under the app name.

### Changed
- Measurement labels on the model are one compact line; details show in a readout card in the corner of the viewport, so results no longer cover the model. The floating toolbar is gone; "Section here" moved to the readout.
- CSV and PDF exports use each measurement's specific title.

### Fixed
- Shortest distance between parallel planar faces returned the plane gap even when the faces do not overlap (two coplanar faces gave 0 mm). It now measures between the faces and lists the plane gap separately.

## [1.1.0] - 2026-10-30

### Added
- Section profiles: where a plane cuts the model, the cut curves are computed, drawn on top of the caps and classified like model edges (line, circle, arc, curve). Cylinders cut square to their axis and spheres give exact circles with the surface's radius and centre.
- Measuring on the cut: snapping to profile curves, their vertices, midpoints and circle centres, and to points on the cap faces. "Snap to cut only" restricts snapping to the section plane; otherwise cut features join the normal 3D snaps.
- Cut area per plane (net of holes), with the number of curves and circles.
- 3-point section plane; planes named XY / YZ / XZ; up to 3 planes at once.
- Plane gizmo: drag the arrow to move or the rings to tilt the plane; numeric offset with a step and −/+ buttons; azimuth and elevation of the normal in degrees.
- ANSI31 hatching on caps (on by default) and caps coloured per part.

## [1.0.0] - 2026-10-30

### Added
- Opens STEP (AP203, AP214, AP242), IGES and BREP files in the browser with OpenCASCADE (occt-import-js, WebAssembly) in a worker; nothing is uploaded.
- B-rep topology rebuilt from the tessellation: faces classified as plane, cylinder or sphere; edges as line, circle, arc or curve, with exact radii, centres, axes and lengths.
- Display modes: shaded with edges, shaded, wireframe, hidden line, X-ray; perspective and orthographic; NavCube with 26 clickable views; view presets; optional ambient occlusion; light and dark themes.
- Measurements with snapping to vertices, midpoints, circle centres, face centres, edges and faces: point to point, shortest distance (point, edge, face in any pair), radius, diameter, centre to centre and hole pitch, edge and arc length, angle between edges/faces, 3-point angle, point coordinates with surface normal, bounding box. Colours, show/hide, saved per file in the browser, CSV and PDF export.
- Contextual floating toolbar for the selected face or edge.
- Multi-plane section (X, Y, Z, from a face, from the view) with solid stencil caps, numeric offsets and flipping.
- Exploded view from the assembly hierarchy and manual part dragging.
- Mass properties (volume, mass with material presets, surface area, centre of mass, bounding box).
- Draft angle and wall thickness heatmaps.
- Model tree with show/hide, isolate, colour and opacity per part or sub-assembly, and filters by name, size and volume.
- STEP header, schema, product revisions, materials and PMI entity counts shown as model metadata.
- Export: PNG (2-4x, optional transparent background, with labels), STL, OBJ, glTF (GLB), PDF inspection report.

[Unreleased]: https://github.com/kothf/step-viewer/compare/v1.118.0...HEAD
[1.118.0]: https://github.com/kothf/step-viewer/compare/v1.116.0...v1.118.0
[1.116.0]: https://github.com/kothf/step-viewer/compare/v1.115.0...v1.116.0
[1.115.0]: https://github.com/kothf/step-viewer/compare/v1.114.0...v1.115.0
[1.114.0]: https://github.com/kothf/step-viewer/compare/v1.112.0...v1.114.0
[1.112.0]: https://github.com/kothf/step-viewer/compare/v1.110.0...v1.112.0
[1.110.0]: https://github.com/kothf/step-viewer/compare/v1.108.0...v1.110.0
[1.108.0]: https://github.com/kothf/step-viewer/compare/v1.107.0...v1.108.0
[1.107.0]: https://github.com/kothf/step-viewer/compare/v1.106.0...v1.107.0
[1.106.0]: https://github.com/kothf/step-viewer/compare/v1.104.0...v1.106.0
[1.104.0]: https://github.com/kothf/step-viewer/compare/v1.101.0...v1.104.0
[1.101.0]: https://github.com/kothf/step-viewer/compare/v1.100.0...v1.101.0
[1.100.0]: https://github.com/kothf/step-viewer/compare/v1.99.0...v1.100.0
[1.99.0]: https://github.com/kothf/step-viewer/compare/v1.98.0...v1.99.0
[1.98.0]: https://github.com/kothf/step-viewer/compare/v1.97.0...v1.98.0
[1.97.0]: https://github.com/kothf/step-viewer/compare/v1.96.0...v1.97.0
[1.96.0]: https://github.com/kothf/step-viewer/compare/v1.94.0...v1.96.0
[1.94.0]: https://github.com/kothf/step-viewer/compare/v1.92.0...v1.94.0
[1.92.0]: https://github.com/kothf/step-viewer/compare/v1.90.0...v1.92.0
[1.90.0]: https://github.com/kothf/step-viewer/compare/v1.89.0...v1.90.0
[1.89.0]: https://github.com/kothf/step-viewer/compare/v1.88.0...v1.89.0
[1.88.0]: https://github.com/kothf/step-viewer/compare/v1.87.0...v1.88.0
[1.87.0]: https://github.com/kothf/step-viewer/compare/v1.86.0...v1.87.0
[1.86.0]: https://github.com/kothf/step-viewer/compare/v1.85.0...v1.86.0
[1.85.0]: https://github.com/kothf/step-viewer/compare/v1.84.0...v1.85.0
[1.84.0]: https://github.com/kothf/step-viewer/compare/v1.83.0...v1.84.0
[1.83.0]: https://github.com/kothf/step-viewer/compare/v1.82.0...v1.83.0
[1.82.0]: https://github.com/kothf/step-viewer/compare/v1.81.0...v1.82.0
[1.81.0]: https://github.com/kothf/step-viewer/compare/v1.80.0...v1.81.0
[1.80.0]: https://github.com/kothf/step-viewer/compare/v1.79.0...v1.80.0
[1.79.0]: https://github.com/kothf/step-viewer/compare/v1.78.0...v1.79.0
[1.78.0]: https://github.com/kothf/step-viewer/compare/v1.77.0...v1.78.0
[1.77.0]: https://github.com/kothf/step-viewer/compare/v1.76.0...v1.77.0
[1.76.0]: https://github.com/kothf/step-viewer/compare/v1.75.0...v1.76.0
[1.75.0]: https://github.com/kothf/step-viewer/compare/v1.74.0...v1.75.0
[1.74.0]: https://github.com/kothf/step-viewer/compare/v1.73.0...v1.74.0
[1.73.0]: https://github.com/kothf/step-viewer/compare/v1.72.0...v1.73.0
[1.72.0]: https://github.com/kothf/step-viewer/compare/v1.71.0...v1.72.0
[1.71.0]: https://github.com/kothf/step-viewer/compare/v1.70.0...v1.71.0
[1.70.0]: https://github.com/kothf/step-viewer/compare/v1.69.0...v1.70.0
[1.69.0]: https://github.com/kothf/step-viewer/compare/v1.68.0...v1.69.0
[1.68.0]: https://github.com/kothf/step-viewer/compare/v1.67.0...v1.68.0
[1.67.0]: https://github.com/kothf/step-viewer/compare/v1.66.0...v1.67.0
[1.66.0]: https://github.com/kothf/step-viewer/compare/v1.65.0...v1.66.0
[1.65.0]: https://github.com/kothf/step-viewer/compare/v1.64.0...v1.65.0
[1.64.0]: https://github.com/kothf/step-viewer/compare/v1.63.0...v1.64.0
[1.63.0]: https://github.com/kothf/step-viewer/compare/v1.62.0...v1.63.0
[1.62.0]: https://github.com/kothf/step-viewer/compare/v1.61.0...v1.62.0
[1.61.0]: https://github.com/kothf/step-viewer/compare/v1.60.0...v1.61.0
[1.60.0]: https://github.com/kothf/step-viewer/compare/v1.59.0...v1.60.0
[1.59.0]: https://github.com/kothf/step-viewer/compare/v1.58.0...v1.59.0
[1.58.0]: https://github.com/kothf/step-viewer/compare/v1.57.0...v1.58.0
[1.57.0]: https://github.com/kothf/step-viewer/compare/v1.56.0...v1.57.0
[1.56.0]: https://github.com/kothf/step-viewer/compare/v1.55.0...v1.56.0
[1.55.0]: https://github.com/kothf/step-viewer/compare/v1.54.1...v1.55.0
[1.54.1]: https://github.com/kothf/step-viewer/compare/v1.54.0...v1.54.1
[1.54.0]: https://github.com/kothf/step-viewer/compare/v1.53.0...v1.54.0
[1.53.0]: https://github.com/kothf/step-viewer/compare/v1.52.0...v1.53.0
[1.52.0]: https://github.com/kothf/step-viewer/compare/v1.51.0...v1.52.0
[1.51.0]: https://github.com/kothf/step-viewer/compare/v1.50.0...v1.51.0
[1.50.0]: https://github.com/kothf/step-viewer/compare/v1.49.0...v1.50.0
[1.49.0]: https://github.com/kothf/step-viewer/compare/v1.48.0...v1.49.0
[1.48.0]: https://github.com/kothf/step-viewer/compare/v1.47.0...v1.48.0
[1.47.0]: https://github.com/kothf/step-viewer/compare/v1.46.0...v1.47.0
[1.46.0]: https://github.com/kothf/step-viewer/compare/v1.45.0...v1.46.0
[1.45.0]: https://github.com/kothf/step-viewer/compare/v1.44.0...v1.45.0
[1.44.0]: https://github.com/kothf/step-viewer/compare/v1.43.0...v1.44.0
[1.43.0]: https://github.com/kothf/step-viewer/compare/v1.42.0...v1.43.0
[1.42.0]: https://github.com/kothf/step-viewer/compare/v1.41.0...v1.42.0
[1.41.0]: https://github.com/kothf/step-viewer/compare/v1.40.0...v1.41.0
[1.40.0]: https://github.com/kothf/step-viewer/compare/v1.39.0...v1.40.0
[1.39.0]: https://github.com/kothf/step-viewer/compare/v1.38.0...v1.39.0
[1.38.0]: https://github.com/kothf/step-viewer/compare/v1.37.0...v1.38.0
[1.37.0]: https://github.com/kothf/step-viewer/compare/v1.36.0...v1.37.0
[1.36.0]: https://github.com/kothf/step-viewer/compare/v1.35.0...v1.36.0
[1.35.0]: https://github.com/kothf/step-viewer/compare/v1.34.0...v1.35.0
[1.34.0]: https://github.com/kothf/step-viewer/compare/v1.33.0...v1.34.0
[1.33.0]: https://github.com/kothf/step-viewer/compare/v1.32.0...v1.33.0
[1.32.0]: https://github.com/kothf/step-viewer/compare/v1.31.0...v1.32.0
[1.31.0]: https://github.com/kothf/step-viewer/compare/v1.30.0...v1.31.0
[1.30.0]: https://github.com/kothf/step-viewer/compare/v1.29.0...v1.30.0
[1.29.0]: https://github.com/kothf/step-viewer/compare/v1.28.0...v1.29.0
[1.28.0]: https://github.com/kothf/step-viewer/compare/v1.27.0...v1.28.0
[1.27.0]: https://github.com/kothf/step-viewer/compare/v1.26.0...v1.27.0
[1.26.0]: https://github.com/kothf/step-viewer/compare/v1.25.0...v1.26.0
[1.25.0]: https://github.com/kothf/step-viewer/compare/v1.24.0...v1.25.0
[1.24.0]: https://github.com/kothf/step-viewer/compare/v1.23.0...v1.24.0
[1.23.0]: https://github.com/kothf/step-viewer/compare/v1.22.0...v1.23.0
[1.22.0]: https://github.com/kothf/step-viewer/compare/v1.21.0...v1.22.0
[1.21.0]: https://github.com/kothf/step-viewer/compare/v1.20.0...v1.21.0
[1.20.0]: https://github.com/kothf/step-viewer/compare/v1.19.4...v1.20.0
[1.19.4]: https://github.com/kothf/step-viewer/compare/v1.19.3...v1.19.4
[1.19.3]: https://github.com/kothf/step-viewer/compare/v1.19.2...v1.19.3
[1.19.2]: https://github.com/kothf/step-viewer/compare/v1.19.1...v1.19.2
[1.19.1]: https://github.com/kothf/step-viewer/compare/v1.19.0...v1.19.1
[1.19.0]: https://github.com/kothf/step-viewer/compare/v1.18.0...v1.19.0
[1.18.0]: https://github.com/kothf/step-viewer/compare/v1.17.0...v1.18.0
[1.17.0]: https://github.com/kothf/step-viewer/compare/v1.16.0...v1.17.0
[1.16.0]: https://github.com/kothf/step-viewer/compare/v1.15.0...v1.16.0
[1.15.0]: https://github.com/kothf/step-viewer/compare/v1.14.1...v1.15.0
[1.14.1]: https://github.com/kothf/step-viewer/compare/v1.14.0...v1.14.1
[1.14.0]: https://github.com/kothf/step-viewer/compare/v1.13.2...v1.14.0
[1.13.2]: https://github.com/kothf/step-viewer/compare/v1.13.1...v1.13.2
[1.13.1]: https://github.com/kothf/step-viewer/compare/v1.13.0...v1.13.1
[1.13.0]: https://github.com/kothf/step-viewer/compare/v1.12.0...v1.13.0
[1.12.0]: https://github.com/kothf/step-viewer/compare/v1.11.0...v1.12.0
[1.11.0]: https://github.com/kothf/step-viewer/compare/v1.10.1...v1.11.0
[1.10.1]: https://github.com/kothf/step-viewer/compare/v1.10.0...v1.10.1
[1.10.0]: https://github.com/kothf/step-viewer/compare/v1.9.0...v1.10.0
[1.9.0]: https://github.com/kothf/step-viewer/compare/v1.8.0...v1.9.0
[1.8.0]: https://github.com/kothf/step-viewer/compare/v1.7.1...v1.8.0
[1.7.1]: https://github.com/kothf/step-viewer/compare/v1.7.0...v1.7.1
[1.7.0]: https://github.com/kothf/step-viewer/compare/v1.6.1...v1.7.0
[1.6.1]: https://github.com/kothf/step-viewer/compare/v1.6.0...v1.6.1
[1.6.0]: https://github.com/kothf/step-viewer/compare/v1.5.1...v1.6.0
[1.5.1]: https://github.com/kothf/step-viewer/compare/v1.5.0...v1.5.1
[1.5.0]: https://github.com/kothf/step-viewer/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/kothf/step-viewer/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/kothf/step-viewer/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/kothf/step-viewer/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/kothf/step-viewer/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/kothf/step-viewer/releases/tag/v1.0.0
