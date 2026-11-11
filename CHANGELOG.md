# Changelog

All notable changes to MöbiusCAD (formerly STEP Viewer) are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.510.0] - 2026-11-11

### Added

- Centerline and Midpoint line tools in the Line ▾ flyout (FR-SK-012), as in SolidWorks: Centerline chains construction lines; Midpoint line takes the middle first, then one end, and keeps a midpoint relation.
- Dynamic mirror in the sketcher (FR-SK-037): select a line, click Dynamic mirror, then draw; each new entity gets its mirror image about the line with symmetric relations at once, and mirrored chains stay joined.
- Tangent Arc tool in the Arc ▾ flyout (FR-SK-015), as in SolidWorks: click the end of a line or arc, then the arc's end; the arc is tangent to that curve and the next click adds another tangent arc on from it, until Esc or a double-click.

## [1.509.0] - 2026-11-11

### Fixed

- Big assembly drawings no longer stall at "Projecting the views… n to go" when a quick view comes back empty: it is tried again on a finer mesh, then on a coarser one, and on a model too big for the exact view it fails with a message instead of holding up every view behind it for 20+ minutes.

## [1.508.0] - 2026-11-11

### Fixed
- Drawings: a tapped Hole Wizard hole shows its cosmetic thread in the views (thin ¾ circle end-on, dashed major-diameter lines from the side, solid in a section), and its callout reads THRU when the thread is as deep as a through hole.
- Drawings: a plain section view no longer draws the cosmetic threads of material its cut took away.
- Drawings: Line (Annotation tab) chains on from each end and Rectangle and Circle stay on for the next shape, until Esc; a double-click also ends a chain of lines.
- Drawings: switching a sheet between first and third angle keeps the views on the sheet: the swapped layout moves back inside the frame, still lined up.

## [1.507.0] - 2026-11-11

### Added

- Tangent arc from the Line tool (FR-SK-011), as in SolidWorks: while a line chain is open, press A, or move back onto its last point and away, to draw an arc tangent to the last line or arc; the next click places its end and the chain goes on as lines. A chain started on the end of an existing line or arc can begin with a tangent arc too.

## [1.506.0] - 2026-11-11

### Added

- Feature scope (FR-FT-007) on swept and lofted cuts and bosses and on Hole Wizard holes, as on extrudes and revolves.
- Recent commands (FR-UI-113): a right-click on empty space in the view with no command running lists the last five commands, newest first, above Zoom to fit, Isometric and Normal to.

## [1.505.0] - 2026-11-11

### Added

- Feature scope (FR-FT-007), as in SolidWorks: in a part with several bodies, an extruded or revolved cut, or a boss that merges, can act on picked bodies only. Untick All bodies in the Feature scope group and click a face of each body to cut or merge with; the other bodies are left as they are.

## [1.504.0] - 2026-11-11

### Changed

- Section and auxiliary views on a first-angle sheet (ISO, GOST) follow first-angle placement: the view goes on the side the arrows point to, as in ESKD and ISO first angle. Third-angle sheets keep the SolidWorks/ANSI rule (the view on the side it looks from). Views already on a sheet keep their direction.

### Fixed

- The thick ends of a cutting line now lie wholly outside the view, 2 mm clear of the outline (ISO 128-44), instead of running over the part's edge.

## [1.503.0] - 2026-11-11

### Added

- Linear pattern (FR-FT-070): Up to reference, as in SolidWorks. Pick a plane or flat face across the direction and the instances spread from the seed's centre so the last one stops at it, or an offset distance short of it; the spacing follows when the reference moves. Each direction has its own reference.

## [1.502.0] - 2026-11-11

### Added

- Linear and Circular pattern (FR-FT-070/071): Instances to skip are picked in the view, as in SolidWorks. Click the Instances to skip box and a dot appears at every instance; a click on a filled dot skips that instance (the preview drops it and the dot turns hollow), a click on a hollow one brings it back. The dot sits on the material the instance changes, so a through-all hole's dot is half way down the plate, not out in space along the cut. Typing instance numbers still works.
- Linear pattern (FR-FT-070): each direction can be set by Up to distance (the distance from the seed to the last instance, shared out equally) instead of the spacing, and Direction 2 has Pattern seed only (it copies the seed alone, not the instances of direction 1).
- Circular pattern (FR-FT-071): Direction 2 turns copies the other way about the same axis, Symmetric (direction 1's count and angle) or with its own count, angle and equal spacing. Its instances are -1, -2… in Instances to skip, and copies that land on direction 1's are left out.

## [1.501.0] - 2026-11-11

### Changed

- A drawing of the assembly open in 3D takes its shape from the parts the assembly has built already instead of building every part again: on the steam engine that step takes about 1.5 s instead of 12 s.

### Fixed

- The Custom… scale box stays the same box while the drawing panel redraws, so typing into it is no longer cut off when a view arrives.

## [1.500.0] - 2026-11-11

### Added

- Recognize Features (FR-FT-102): coil springs on any axis. A spring tilted in a standard plane comes back on a reference plane at an angle about X, Y or Z; one at a compound angle on a plane turned about Z, an axis where it meets XY and a plane turned about that axis, the way cross holes at an angle already do. Angles that come out within 0.002° of a hundredth of a degree are taken as meant (a spring tilted 30° gives a plane at 30°).

## [1.499.0] - 2026-11-11

### Added

- Recognize Features (FR-FT-102): a coil spring (a round wire swept along a helix, so its path does not lie in one plane) comes back as a circle sketch on a standard plane (or a plane offset from one) through the start of the coil, a Helix with its pitch, revolutions, start angle and hand, and a Sweep with a circular profile, which replaces the imported body. The helix is fitted to the middle of the wire, so measured values come back as typed (pitch 5, 3.5 revolutions). The coil's axis must run along X, Y or Z.

## [1.498.0] - 2026-11-11

### Added

- Recognize Features (FR-FT-102): a lofted body, with two flat ends of one outline each (lines, arcs or a circle) and side faces running from one end to the other, comes back as a profile sketch on each end and a Loft with Merge result off, which replaces the imported body. When the plain loft twists, the profiles start at the ends of a straight side edge (Loft connectors). Loft gains Merge result (off adds the lofted body as a new body), like Sweep.

## [1.497.0] - 2026-11-11

### Changed

- Big assembly drawings get their first view about 4 seconds sooner and every later view about a second sooner: the mesh that the fast views of big models are drawn from is no longer refined on small round features far below its own accuracy (the engine assembly: mesh 5.9 s → 1.8 s, each view's hidden-line pass 2.2 s → 1.0 s, with the same lines to within the mesh accuracy).

### Fixed

- A drawing view's quick preview no longer goes missing when the drawing kernel starts over while it is asked for (for example when a section is placed while the exact lines of the other side are being made): it is asked again from the restarted kernel.

## [1.496.0] - 2026-11-11

### Added

- Recognize Features (FR-FT-102): a bent bar of any profile made of lines and arcs (an obround, a square on its corner, a hexagon and so on), bent along straight runs and bends in one plane, comes back as a path sketch, a profile sketch on its first end and a Sweep, like a bent tube does since 1.493.0. A flat bar bent across its width still comes back as an extrude with fillets, which it is.

## [1.495.0] - 2026-11-11

### Changed

- Drawings of big assemblies project each view and each quick preview about a second sooner: the model's bounding box is now found once instead of for every view (on the engine assembly it took about a second each time, so a sheet with its three views, their previews and the view palette saves around ten seconds of work).

## [1.494.0] - 2026-11-11

### Changed

- Section views of a big model show a quick preview with their cut faces hatched as soon as the cut is made, instead of an empty frame until the exact lines are ready (the engine assembly's sections: about 2 to 3 s instead of 5 to 9 s). The exact lines that follow reuse the same cut, so they come at most about half a second later than before.

## [1.493.0] - 2026-11-10

### Added

- Recognize Features (FR-FT-102): a bent round rod or tube (solid or hollow, straight runs and bends in one plane) comes back as a path sketch of lines and arcs on the standard plane holding it, a profile sketch on its first end and a Sweep, so its bends and diameters can be changed. Sweep has a Merge result option for this (off = a new body).

## [1.492.0] - 2026-11-10

### Added

- Rotation centre on an edge (FR-UI-100): a middle click on a straight edge, away from its ends, makes the view turn about the edge's line, shown dashed, as in SolidWorks. Before, the view turned about the clicked point only. A middle click on empty space goes back to turning about the view centre and puts Z up again.

## [1.491.0] - 2026-11-10

### Fixed

- A section view through an axis of a big assembly is ready in seconds instead of never (the engine assembly cut through the crank axis: over 25 minutes to about 12 s). The cutting plane ran exactly through the axes of round parts, a case OpenCASCADE's Boolean handles very slowly, and the whole assembly was cut as one. Now each part is cut on its own (parts wholly behind the plane are kept as they are, parts wholly in front are left out), and the plane is moved 1 µm off, which no drawing can show.
- Deleting a view that is still being projected stops its projection, so the next views no longer wait behind a view that is gone.
- A view switched to another display style (for example Shaded with edges) keeps showing its lines until the new style arrives, instead of an empty frame.
- Auto balloon on a view whose lines are still coming says so instead of placing no balloons without a word.

## [1.490.0] - 2026-11-10

### Fixed

- Drawings: a view clicked in the drawing tree keeps the focus there, so Delete deletes it (drawings exam #36).
- Drawings: Auto balloon keeps the balloons inside the drawing frame and off the title block; with no free room they move in between the view and the frame, clear of each other (drawings exam #39).
- Drawings: with dual dimensions on, a hole table stays in one unit (its Size column took inches while X/Y stayed mm, and the wider table ran over the frame) (drawings exam #41).
- Russian UI: the open arrowhead reads "Открытые" (it said "Открыть"), and the GOST sheet format "ГОСТ 2.104" (drawings exam #42).

## [1.489.0] - 2026-11-10

### Added

- Recognize Fillets and Recognize Features bring back variable radius fillets (FR-FT-102, FR-FT-032): the blend face is removed with Delete Face and comes back as a variable radius Fillet with the radius measured at each end of the edge. Before, such a fillet stayed part of the imported body.

## [1.488.0] - 2026-11-10

### Added

- Recognize Holes and Recognize Features also bring back cross holes at a compound angle, tilted in two directions at once (FR-FT-102): the plane square to the hole is built the way it is in SolidWorks, a Plane at an angle about Z, a reference Axis where that plane meets XY, and a Plane at an angle about that axis. Before, such holes stayed part of the imported body.

- Recognize Extrudes and Recognize Features bring back turned bases whose axis is skew, tilted out of every standard plane (FR-FT-102): the half section is sketched on a Plane at an angle about Z that holds the axis's direction, offset up to the axis when needed, then revolved. Before, such bodies stayed imported.

### Fixed

- Recognize Holes counted cross holes and keyways wrongly in its message (each was counted by its number of features).

## [1.487.0] - 2026-11-10

### Fixed

- Big assembly drawings are ready about a third sooner (the engine assembly's Standard 3 views: 60 s to 40 s). The sheet was redrawn once for every time a view had been asked for while it was still coming, 66 times for three views, and each redraw of a big assembly sheet is megabytes of drawing; now it is redrawn once when a view lands.
- The view palette's thumbnails wait until the sheet's own views are asked for, so the quick previews of the sheet's views show about 10 s sooner.

## [1.486.0] - 2026-11-10

### Added

- Recognize Holes and Recognize Features bring back cross holes at an angle (FR-FT-102): a hole right through a shaft or a blind one whose axis is tilted in a standard plane (for example at 45° round the shaft, or at 30° to its end) comes back on a reference Plane at an angle about the standard axis square to it, then a sketch with an Extruded Cut Through All - Both, or an offset Plane through the rim and a Hole Wizard hole. Before, only cross holes along X, Y or Z were recognised. Holes tilted in two directions at once are still left.
- Plane at angle turns about a standard axis (X, Y or Z through the origin) or a reference axis too, not only a straight model edge (FR-REF-002): pick it in the new **Axis** list of the Plane panel.

## [1.485.0] - 2026-11-10

### Added

- Recognize Extrudes and Recognize Features also bring back a keyway that runs out through the end of a shaft (FR-FT-102): the outline's open side lies on the shaft's end face, so it is sketched there and the blind Extruded Cut leaves the end open as before. Before, only keyways closed all round were recognised.

## [1.484.0] - 2026-11-10

### Added

- Recognize Holes and Recognize Features bring back blind cross holes in shafts and round bars (FR-FT-102): a hole that comes out on a curved face at one end and stops at a flat bottom or a drill point at the other becomes a reference Plane through the farthest point of its rim (the plane tangent to the shaft) and a Hole Wizard hole on it, with its diameter, depth and bottom, when the hole runs along X, Y or Z. Before, such holes stayed part of the imported body.
- Recognize Extrudes and Recognize Features bring back keyways and other closed pockets sunk into a shaft (FR-FT-102): a flat floor whose outline walls rise into curved faces only (no flat face to sketch on) becomes a reference Plane tangent to the shaft, the floor's outline sketched on it and a blind Extruded Cut down to the floor, when the floor faces X, Y or Z. Before, a keyway also stopped the shaft itself from being recognised as a base.
- Hole Wizard: **Reverse direction** under End condition, for holes placed on a reference plane outside the body (on a face the holes still go into the material). The ⇄ button on the depth callout flips it too.

## [1.483.0] - 2026-11-10

### Fixed

- Big assembly drawings get back to work faster still after the drawing kernel frees its memory: the copy of the model kept for the restart is now binary (exact and quicker to read), and after the first fast view it also keeps the model's mesh, so the restart no longer meshes the engine again (about 6 s saved per restart).

## [1.482.0] - 2026-11-10

### Fixed

- Big assembly drawings get back to work much faster after the drawing kernel frees its memory: the restart used to build the whole assembly again (about 12 s for the engine), now it reads a copy of the model's geometry kept from the first load (about 0.3 s). The second drawing worker on smaller models starts the same way.

## [1.481.0] - 2026-11-10

### Fixed

- Big assembly drawings open much sooner: finding the holes for hole callouts took 45 s on the engine assembly (of the ~140 s before Standard 3 views appeared), now about 1 s. Each hole end is checked against its own part with a classifier made once per part.
- Hole callouts on assembly drawings now match each part's own drawing: a pin or bolt sitting in a hole no longer makes it read as blind, and a bolt hole running through two stacked plates is a hole in each plate, not one hole through both.

## [1.480.0] - 2026-11-10

### Fixed

- Big assembly drawings use far less memory per view: each fast view of the engine assembly kept about 100 MB of the drawing kernel's memory, now about 40 MB, so the kernel has to restart (the "Freeing the drawing kernel's memory" pause) less than half as often. The polygonal hidden-line step no longer leaves its edge readers alive and reuses one OpenCASCADE reader, whose memory was never given back when it was deleted.

## [1.479.0] - 2026-11-10

### Fixed (drawings exam, round 3)

- Print (Ctrl+P) gives every sheet its own paper size: a B sheet after an A3 sheet printed on A3 with its right border cut off. The counterbore and countersink symbols print drawn in lines, as in the PDF, instead of depending on a system font.
- Standard 3 views on a sheet that already holds views no longer drops the new set on top of the old one: it goes beside them at the sheet's scale, or onto a new sheet of the same size when there is no room.
- Undoing Add sheet while that sheet was open left no sheet selected, and every later edit failed until the drawing was reopened.
- After going to the model and back to a drawing, the drawing toolbar's menus (Model view, Section, Detail, Annotate, Export) opened and closed at once and other buttons acted twice: each return added the toolbar's listeners again.
- Add sheet keeps the sheet format: a user title block and a custom sheet size went back to the standard ISO block and lost their size on the new sheet.
- The GOST title block's date (10.11.26) no longer runs over its 10 mm cell.

## [1.478.0] - 2026-11-10

### Fixed

- **Drawings of big assemblies ran out of memory (drawings exam round three)**: OpenCASCADE's fast hidden-line pass keeps about 100 MB per view of an engine assembly, so an alternate position after Standard 3 views failed with "malloc failed". The drawing worker is now started over with the same model once its memory passes 1.2 GB (the views already made stay), and a view that still runs out is tried once more on a fresh worker. If even that fails, the message says there was not enough memory for the view instead of quoting OpenCASCADE. The restart loads the model without working out its edges and holes again (the drawing already has them), so it takes less time.

### Changed

- **Drawings say when views are on their way**: while exact views or an alternate position are being projected, the status line under the sheet says "Projecting the views… n to go", and "Freeing the drawing kernel's memory, then projecting…" while the worker starts over, so a slow big-assembly sheet no longer looks stuck.

## [1.477.0] - 2026-11-10

### Added

- **Cross holes through a shaft are recognised (FR-FT-102)**: a round hole right across an imported shaft or round bar, coming out on its curved faces, comes back from Recognize Holes and Recognize Features as a circle sketched on the standard plane square to the hole with an Extruded Cut Through All in both directions, when the hole runs along X, Y or Z. Before, such holes were left in the imported body.

### Fixed

- **Edit sketch shows the whole sketch (Leuenberger exam #96)**: turning normal to a sketch framed only the body, so a sketch reaching past it opened mostly off screen. The view now frames the body and the whole sketch; sketches with one point or none open as before.

## [1.476.0] - 2026-11-10

### Changed

- **Drawings project two views at once**: on a computer with four or more threads a second drawing worker loads the same model and takes every other exact view or section, so Standard 3 views and other sheets with several views finish sooner. Big models (from 1500 edges, which take the fast views) keep one worker, so a second copy cannot run the tab out of memory. It stops after a minute without work; `?drwhelper=0` turns it off.

### Fixed

- **Fast views of big assemblies came out empty (drawings exam round three)**: an older engine copy got Standard 3 views with only centre lines, because the polygonal hidden-line pass returned no lines. A fast view without visible lines now tries again on a fresh, coarser mesh and then falls back to the exact hidden-line removal, and the console says why.
- A view that OpenCASCADE fails on no longer shows a bare "OpenCASCADE error 24": the toast gives the kernel's own message when it has one, else says the model may be too big for the browser's memory.
## [1.475.0] - 2026-11-10

### Fixed

- **Assembly degrees of freedom (Leuenberger exam #94)**: an engine that turned freely could show **Fully defined** in the status bar. Mates that say the same thing twice with directions stored a hair apart (a Lock beside Concentric + Coincident) could be counted as a separate constraint and take the one real freedom away. The count now takes the most independent mate first, so repeats are seen as repeats; a 57-part engine with 148 mates shows its 1 DOF again, and the handwheel's fine screw still counts.
- **Interference detection (exam #95)**: closing the panel while the clearance rows were still being worked out, then opening a part, showed "Interference detection failed: The geometry kernel was stopped." Nothing had failed; the message is no longer shown once the panel is closed.

## [1.474.0] - 2026-11-10

### Added

- **Recognize Holes and Recognize Features find counterbored and countersunk holes (FR-FT-102)**: a counterbored or countersunk hole in an imported body comes back as one Hole of that kind, with its counterbore diameter and depth or its countersink diameter and angle, blind (flat or drilled bottom) or through, as FeatureWorks does. Recognize Features no longer takes a countersink for a chamfer on the hole's edge.

### Fixed

- Recognize Holes mixed up the floors of two counterbores side by side (both floors lie in one plane), so one hole kept its faces.

## [1.473.0] - 2026-11-10

### Fixed

- **Drawings of big assemblies (drawings exam retest)**: the fast hidden-line views now start at 1500 edges instead of 4000, so an older 57-part engine whose Top and Right views stayed previews for 8+ minutes gets exact-looking views in seconds too.
- **Standard 3 views** reduces only as far as needed: the views may now fill the room beside the title block (the 85 % margin applies only to enlarged views), so the engine (430 × 187 × 184 mm) gets 1:2 on A3 instead of 1:5.

## [1.472.0] - 2026-11-10

### Changed

- **Recognised sketches dimensioned the way FeatureWorks does (FR-FT-102)**: the sketches that Recognize Features and Recognize Extrudes make now get the lengths of their horizontal and vertical edges first, longest first, and only then the distances from the origin that are still needed. A rectangle gets its width and height and one corner's place, instead of four distances from the origin. Fully Define Sketch in the sketcher keeps dimensioning from the origin, as SolidWorks does by default.

## [1.471.0] - 2026-11-10

### Added
- Drawings: the bill of materials has a Material column (FR-MAT-001). It shows each part's material, or the materials of its bodies when they have their own; a sub-assembly row stays empty. New BOMs get the column, and a tick box in the BOM's properties adds it to older ones or takes it off.
- My materials can be exported to a file and imported again (FR-MAT-001), to carry your own materials to another browser or computer or share them with colleagues. Import… and Export… sit at the bottom of the material dialog; an imported material replaces one of yours with the same name, and one named like a library material is left out.

### Changed
- Drawings: when a part's bodies have their own materials, the title block lists them all and weighs each body with its own density, instead of the part's material alone.

## [1.470.0] - 2026-11-10

### Added

- **What's behind (FR-PDM-022)**: the Vault tab shows **n behind** when an assembly was checked in against older versions of its parts or sub-assemblies, a drawing against an older version of its model, or a local copy is not the latest version. The view lists each one with what moved on (`plate.mcadprt · v1 → v2`) and an **Update** button, plus **Update all** (sub-assemblies first). Update puts the latest part documents into the assembly, and the latest part or assembly into the drawing's copy of its model, so a drawing now picks up a new part version. A file not checked out is checked out, updated and checked in as a new version in one go; a file checked out to you gets the update in its working copy. Released files say that a change has to be started first. The same Update is on the selected file and in its right-click menu, and **What's behind…** is in the ⋯ menu.
- **Folders in the vault file list (FR-PDM-080)**: files in subfolders (`parts/`, `drawings/`, …) are listed under a header per folder that folds and unfolds (click, or ←/→), with the number of files in it. Folded folders are remembered per vault in this browser.
- **Filter chips** above the list: All, Parts, Assemblies, Drawings, Other files, Checked out to me and Behind, each with its count; they work together with the search.
- The state change dialog says which revision each file will get (**becomes revision B**) before you approve.
- **Reopen vault** on the start card: while no vault is open, the start card offers the vault used last (its folder, or the browser vault).
- **Check-in reminders**: closing a document tab that is checked out to you asks whether to check it in (or, with no changes, to undo the check-out), keep it checked out, or cancel. **Close vault** lists the files with changes not checked in first, and leaving the page with such files makes the browser ask.
- **Details of the selected vault file (FR-PDM-080)**: under its commands, a foldable Details section shows the latest version (who, when, comment), the files it uses (with newer versions marked), the files that use it and its release files. Each is a link that selects that file in the list.

### Changed

- **Release files belong to their part (FR-PDM-036)**: the STEP and PDF a release makes are stored in the released state with the part's revision (they were Work in progress files before), are listed right under the part, assembly or drawing they came from ("Release file of arm.mcadprt · Rev A"), and are made again without a check-out. When the part is made obsolete, its release files of that revision go with it; a change in work leaves them Released.
- The selected assembly's box "Linked components with newer versions" became the general "Uses older versions of:" box, which covers embedded parts and drawings too.

## [1.469.0] - 2026-11-10

### Changed

- **Drawings of big assemblies (drawings exam)**: a model of 4000 edges or more is drawn by a fast hidden-line removal on a fine mesh, then each line is rebuilt from the model: straight edges become exact lines and circles seen end-on become exact arcs (true centre and radius), so dimensions, centre marks and picking work as before; other curves stay polylines within 1/1000 of the model's size. A 57-part engine whose top view never finished now takes seconds per view, and the views queued behind it (alternate positions, sections) no longer wait.
- **Standard 3 views** picks its scale by placing the three views around the title block, using the free room beside it, so a 430 mm engine on A3 is drawn at 1:2 instead of 1:5.

## [1.468.0] - 2026-11-10

### Added

- **Right-click menu on vault files (FR-PDM-080)**: right-click (or long press) a file in the Vault tab for Open, Check out, Check in…, Undo check-out, Get latest, the state changes, History, Where used, Contains, Data card, PDF, Rename / move…, Copy tree… and Delete. The menu key and Shift+F10 open it from the keyboard.
- **Several vault files at once**: Ctrl+click adds or removes a file, Shift+click selects a run, Ctrl+A selects every file shown and Esc goes back to one. With several files selected, the foot of the panel and the right-click menu offer Check out, Check in (one comment for all, files the others use go first), Undo check-out, Get latest, the state changes they have in common, Request change… and Delete (files that use others go to the recycle bin first).

### Changed

- **Slimmer Vault tab top**: Add files…, Add files in this folder…, Save to vault and the search stay; Notifications, Change orders, Release packages, Audit trail, Integrity check, Storage, Export ZIP, Recycle bin, Vault settings, Workflow and the user name moved into a **⋯** menu next to the vault's name (the notification count shows on it). The file list starts about 200 px higher.

## [1.467.0] - 2026-11-10

### Added

- **Recognised sketches are fully defined (FR-FT-102, FR-SK-045)**: Recognize Features and Recognize Extrudes now run Fully define sketch on every sketch they make, as FeatureWorks gives its sketches dimensions. Lines along the axes get horizontal and vertical relations, circles and arcs their diameters and radii, and the points dimensions from the sketch origin, so the base, pocket and revolve sketches can be edited by their dimensions at once. Nothing moves and the body stays the same.

## [1.466.0] - 2026-11-10

### Fixed (drawings exam, round 2)
- The GOST 2.104 title block writes the date as DD.MM.YY (10.11.26), so it fits its 10 mm cell; an ISO date ran over the cell border.

## [1.465.0] - 2026-11-10

### Added

- **Recognize Features (FR-FT-102)**: one command in the Direct menu runs all the recognitions at once, like FeatureWorks' automatic mode. Fillets and chamfers, holes, then pockets, bosses and the base are found, each on the body with the earlier finds taken off, and the tree comes back in modelling order: the base sketch with its Extrude or Revolve, the cuts and bosses, the Hole features, then the Fillets and Chamfers, whose faces and edges are found again on the new body. When the base is found no Delete Face is left in the tree, and chamfers along two directions no longer stop the base from being found. A body the combined way cannot rebuild exactly gets the finds one after another, as the single commands give them.

## [1.464.0] - 2026-11-10

### Fixed (drawings exam, round 2)
- Chain, baseline and ordinate dimensions take a placement click after the second point, like SolidWorks: the row goes where you click, its side sets horizontal or vertical, baseline rows stack outwards, and a point level with one already in an ordinate set no longer prints its value twice. Before, the set was dropped beside the view on top of the dimensions already there (#15).
- Centerline accepts a hole's hidden outline lines (cylinder silhouettes) and circles seen edge-on, as Smart dimension does (#16).
- Balloons work on part drawings: the part is item 1, as in SolidWorks (they were refused).
- Auto balloon keeps balloons clear of each other, of the views and of the annotations already on the sheet (on the 57-component Leuenberger engine many balloons were drawn on top of one another and over dimension texts).
- A bill of materials taller than the room above the title block splits into blocks side by side, each with its header, instead of running off the sheet.
- Centre marks and centrelines follow a crop, a profile detail and breaks like the view's edges (a cropped section still drew the axis of a hole the crop left out).
- Bill of materials, Balloon and Auto balloon clicked while the model is loading say so, instead of "only for assemblies".

## [1.463.0] - 2026-11-10

### Changed

- **Selected Contours look like the feature they make**: in a cut (Extrude Cut, Revolve Cut) the picked regions are filled in the cut preview's yellow instead of the boss orange, so a picked region no longer reads as material being added. Each picked region also gets a darker outline, so two picked neighbours stay apart.

## [1.462.0] - 2026-11-10

### Added

- **Body materials in drawings (FR-MAT-001)**: in a section view of a multibody part, each body's cut faces are hatched by its own material (steel, aluminium, titanium and so on get their own pattern), and the bodies of an assembly component are told apart the same way. The cut list table on a weldment drawing weighs an item by its bodies' own materials when the item has no material of its own.

## [1.461.0] - 2026-11-10

### Fixed

- Sketch fillet rounds a corner where a line meets an arc, or two arcs meet, as SolidWorks does. It used to accept only two lines (exam #90).
- **Ctrl+A** in a sketch selects every sketch entity instead of the page's text (exam #91).
- A centre-point arc runs the way the mouse went round its centre, so a clockwise arc no longer comes out as the long way round (exam #92).
- While an early sketch of a finished part is edited, Properties says there are no bodies before that feature instead of "This part is empty" (exam #93).

## [1.460.0] - 2026-11-10

### Added

- **Draft for each extrude direction (FR-FT-014)**: as in SolidWorks, a blind Direction 2 has its own Draft on/off, angle and Draft outward. Each direction now tapers away from the sketch plane on its own: drafting Direction 1 leaves Direction 2 straight, or each gets its own angle. Two-way extrudes drafted before keep their shape and face names.

## [1.459.0] - 2026-11-10

### Changed

- **Parts open in a fraction of a second**: opening a part used to start a new geometry kernel (OpenCASCADE, 3–5 s to set itself up) every time, even for a part that rebuilds in 0.1 s. The app now sets one kernel up in the background after it starts, and a closed part's kernel is cleared and kept for the next document. Measured on a 4-core machine: a two-feature part 4.3 s → 0.45 s the first time, 3.3 s → 0.1–0.5 s for the next ones; the exact geometry of the first STEP file is ready after 0.8 s instead of 5 s. Devices with 4 GB of memory or less, and `?nospare`, keep the old behaviour.

## [1.458.0] - 2026-11-10

### Added

- **Body materials in assemblies (FR-MAT-001)**: a component whose part has bodies with their own materials is weighed body by body in the assembly's mass properties (mass, centre of mass, moments of inertia) and in the BOM mass and its CSV. Bodies without their own material take the part's.

## [1.457.0] - 2026-11-10

### Added

- **File ▸ Open drawing**: with a part, assembly or model file open, opens the drawing that belongs to it, in its own tab. It is found wherever it is: the drawing already open in a tab, a drawing in the open vault or one among the recent documents. With several drawings you pick one; with none it offers New drawing. The reverse of the drawing's Model button.

## [1.456.0] - 2026-11-10

### Added

- **Extrude Direction 2 with any end condition (FR-FT-011)**: as in SolidWorks, Direction 2 has its own end condition (Blind, Through all, Up to next, Up to vertex, Up to face or plane, Offset from surface, Up to body) and works with every Direction 1 end condition except Mid plane and Through all - both. A blind Direction 2 gets its own orange drag arrow pointing the other way. Extrudes made before keep their shape and face names.

## [1.455.0] - 2026-11-10

### Added

- **Vault in a project folder takes the files already there** (FR-PDM-003): **Add files in this folder…** (Vault tab and Vault menu) lists the files in the vault folder that are not vault files yet, with their subfolders, and adds them where they are: parts, then assemblies, then drawings. A new vault made in a folder that holds files offers this straight away. Before, Add files… put copies at the top of the folder.
- **Switch to** in the Vault menu (FR-PDM-002): with a vault open, the other vault folders used before and the browser vaults are listed, so one vault per project folder is one click away. **Import vault ZIP…** is in the menu too.
- Opening an assembly from the vault lists the components that have newer versions before you choose As checked in, Latest or Latest released.

### Fixed

- Vault: a drawing now references its model (found by the document id its copy of the model carries), and an assembly finds its parts in a subfolder such as `parts/` by name. **Where used** goes part → assembly → drawing and marks a parent that uses an older version. Files added before the file they use are tied to it when it comes in (vault exam V1-V3).
- Vault: a document tab left open while the vault moved on (a roll back, an approval) showed the new version number over the old content. The title now says `v2 · newer v3 in the vault`, and Check out loads the latest first (V7).
- Vault: roll back, undo check-out, get latest, a state change and a double-click on a file already open opened the file in a second tab; it is now reloaded or shown in its own tab (V8).
- Vault: the selected file's commands stay in view at the foot of the panel, however long the file list (V4); the data card of a file not checked out has a **Check out** button (V9); delete and restore say what they did (V10); adding many files shows a progress message (V12); the list of an assembly's parts to add shows one file per line (V2).

## [1.454.0] - 2026-11-10

### Changed

- Drawings: a diameter dimension whose text is outside the circle now stops its leader at the near rim, with one arrow pointing at the circle from outside, as in SolidWorks. Before, the line ran across the whole circle and on to the text, so hole diameters drew long diagonals over the part. Untick **Arrow outside the circle** in the dimension panel for the old line across the circle with two arrows; radius dimensions are unchanged.

## [1.453.0] - 2026-11-10

### Added

- **Material per body (FR-MAT-001)**: in a part with several bodies, right-click a body in the **Solid Bodies** folder and choose **Material…** to give it its own material from the library; **None** gives it the part's material again. Mass properties then weigh each body with its own density (mass, centre of mass and moments of inertia), and the Density row says "from part materials". One undo step. An assembly still weighs such a part with the part's material.

## [1.452.0] - 2026-11-10

### Fixed

- A plain section view no longer draws centre marks and centrelines for holes and bosses the cut took away (drawings exam #4).
- Scale ▾ **Custom…** is typed into a box under the list instead of a browser prompt (drawings exam #17).

## [1.451.0] - 2026-11-10

### Added

- **Features from the sketch you are editing (FR-SK-004)**: there is no need to exit the sketch first. The Sketch tab ends with **Extrude**, **Cut** and **Revolve**, the sketch's right-click menu has them too, and the Features, Surfaces, Sheet Metal and Weldments tabs keep their commands while you sketch (Ctrl+K finds them as well). Picking one exits the sketch and opens the feature on it with its live preview, as in SolidWorks.

## [1.450.0] - 2026-11-10

### Fixed

- Drawings: a round edge seen edge-on (the top of a boss, the end of a shaft in a side view) can be picked for a dimension as the line it looks like, so a boss height or a shaft's overall length can be dimensioned (drawings exam #3, #10).
- Drawings: two cylinder outline lines picked one after the other give the distance between the lines (a step of 2 between Ø20 and Ø24), not between the centres of the circles at their ends (drawings exam #14).

## [1.449.0] - 2026-11-10

### Fixed

- Drawings: **Ctrl+Z** on a drawing undoes the last drawing step only. It used to undo the last feature of the part behind the drawing as well (drawings exam #1).
- Hole table: one row per hole, with its whole callout as the size (Ø6.6 THRU ⌴Ø11 ↧6.4). A counterbored hole was listed twice, and a boss's rim or a chamfer's circle was listed as a hole (drawings exam #5).
- A datum feature no longer takes a letter that a section, detail or auxiliary view already uses, and new view letters skip datum letters (drawings exam #6).
- PDF, PNG and DXF exports draw the counterbore ⌴ and countersink ⌵ symbols in lines; the embedded font has no glyph for them, so they were missing (drawings exam #7).
- DXF R12 writes Ø, ±, ° and Cyrillic as \U+ codes like DXF 2000, so AutoCAD no longer shows "Ã˜" (drawings exam #8).
- A new note is typed straight into its text box, several lines included, instead of a one-line browser prompt (drawings exam #9).
- Offset and half sections: no line where the cutting plane steps between cut faces, and a half section started on the part's edge is hatched again (drawings exam #12, #13).

## [1.448.0] - 2026-11-10

### Added

- **Open the model from a drawing (FR-DRW-001)**: a drawing file opened by itself carries its part, assembly or STEP model. **Model** in the drawing bar now opens that model in its own tab (or shows its tab when it is open already); back on the drawing's tab, the views follow the model as usual.
- **Diameter from a side view (FR-DRW-021)**: with Dimension, click either outline line of a cylinder seen from the side (a disc's or shaft's side, a hole's hidden line) and place the text: the diameter is drawn as a linear dimension with Ø, the same value as on the round view.

### Fixed

- Drawing dimensions between two edges no longer run their extension lines along the edges or across the part: each extension line starts at the end of its edge nearest the dimension line.
- A new dimension on a hole is a diameter also when the model file stores the circle as two half circles (STEP); a radius stays the default for fillets and other arcs.

## [1.447.0] - 2026-11-10

### Fixed

- Assemblies: inserting or replacing a component with another file makes it its own part, even when the file holds the same content as a part already in the assembly, so editing one no longer changes the other (exam #87).
- Replace component counts mates that lost their faces only once the new part is built, so it no longer warns about mates that solve (exam #88).
- Sketches: a tool picked on the sketch command bar shows its options in the panel at once, such as the Fillet radius (exam #89).

## [1.446.0] - 2026-11-10

### Added

- **Text along the leader (FR-DRW-021)**: a radius or diameter dimension can have its text written along its line (the ISO aligned style) instead of on a level shoulder. Outside the circle the leader runs on under the text.

## [1.445.0] - 2026-11-10

### Added

- **Angle dimension arrows (FR-DRW-021)**: a small angle whose arc has no room for two arrowheads gets them outside the sector, on short tails of the arc, the way narrow linear dimensions do. **Arrows** (Auto, Inside, Outside) and **Extension lines** (hide the first, the second or both) in the dimension panel now work for angles as well.

## [1.444.0] - 2026-11-10

### Fixed

- Assemblies: after a part is edited, a mate on a face whose name went away follows the same surface under its new name (exam #84).
- New sketches and holes on a flat face take their X direction from the part's X laid onto the face, so it stays the same across rebuilds (exam #85).
- **Fully define sketch** adds horizontal and vertical relations instead of near-zero dimensions (exam #86).

## [1.443.0] - 2026-11-10

### Added

- Sheet metal Convert to Sheet Metal and Insert Bends have Auto relief (FR-FT-120): corners where two walls' bends meet get a rectangular, obround, circular or tear relief at once, sized by a relief ratio. New features start with Rectangular, 0.5.

### Fixed

- Mitred sheet metal corners (edge flanges, miter flanges, Convert to Sheet Metal) now meet on the corner's bisector plane, as in SolidWorks. Before, the two walls were cut square and overlapped in a thin strip along the inside of the seam, so the flat pattern had slightly more material than the part.


## [1.442.0] - 2026-11-10

### Added

- **Arrow outside the circle (FR-DRW-021)**: a radius or diameter dimension whose text is outside the circle can stop its leader at the rim, with one arrow pointing at it from outside, instead of crossing the circle.

## [1.441.0] - 2026-11-10

### Added

- **Weld tags on weldment drawings (FR-FT-121)**: placing a **Weld table** on a drawing of a weldment part also tags each fillet bead seen in that view with a box holding the bead's item number in the table, so the beads on the view and the rows of the table match. **Tag the beads** in the table's panel tags beads added later; a tag's panel names its weld table row. Weld tags and cut list balloons number their own lists and don't count against each other in Auto balloon.

## [1.440.0] - 2026-11-10

### Added

- **Hole callout options (FR-DRW-022)**: a hole callout on a drawing can leave the number of equal holes (4×) out of its automatic text and take a line of text below it, such as EQ SP.

### Fixed

- A hole table no longer repeats the number of holes in the size of a Hole feature.

## [1.439.0] - 2026-11-10

### Added

- **Extension line gap and overshoot (FR-DRW-025)**: a drawing's Drafting style sets the gap extension lines leave at the outline (0 to 2 mm; 0 for drawings that touch the outline as ISO 129 allows) and how far they run past the dimension line (1 to 3 mm).

## [1.438.0] - 2026-11-10

### Fixed

- **Slot mate ends (Leuenberger exam #81)**: a Slot mate now keeps the pin between the slot's rounded ends, like SolidWorks' free slot mate, instead of letting it run past them. The ends are found from the slot's two end cylinders; inside the slot the pin still slides freely, so the mate takes no extra freedom away.
- **Touching boss joins the body (exam #82)**: a boss extrude standing on the body with a gap of sketch round-off (a few millionths of a millimetre, e.g. from a snapped edge) became a second solid body. When a plain join leaves the new material apart, it is joined again with a 0.00001 mm tolerance.
- **Interference detection (exam #83)**: coincident faces, such as a shaft in a bore of its own size or a foot on a plate, no longer show as interferences of "0 mm³": an overlap thinner than 0.0001 mm on average counts as touching, and shows only with **Treat coincidence as interference**.

## [1.437.0] - 2026-11-10

### Added

- **Arrowheads per dimension (FR-DRW-021)**: a drawing dimension has an **Arrowheads** choice of its own: Document (the drafting style's), Filled, Open, Dot or Oblique stroke, so a tight chain can use dots while the rest keeps arrows.

## [1.436.0] - 2026-11-10

### Added

- **Vault menu** (FR-PDM-002, FR-PDM-080): a **Vault** button in the header, also **File ▸ Vault…** and so reachable from a drawing. With no vault open it offers **New vault in a folder…**, **Open vault folder…**, the vault folders used before and the vaults kept in the browser. With a vault open it has the commands for the document on screen: **Save to vault**, **Check out**, **Check in…**, **Undo check-out**, **Get latest** and **History…**, then Add files, search, the file list, settings and Close vault. The button is lit while a vault is open. Until now the vault was only a small tab in the side panel.
- **Vault folders are remembered**: a vault made or opened in a folder on disk is listed in the Vault menu and on the Vault tab, so it opens again with one click (the browser asks for access to the folder once per session). Keep one vault per project folder and switch between them from the menu. Open vault folder… on a folder without a vault offers to create one there. Folder vaults need Chrome or Edge on a computer; other browsers say so and keep browser vaults with Export ZIP.
- **Assemblies and drawings in the vault** (FR-PDM-010, FR-PDM-081): Save to vault takes the open part, assembly or drawing. An assembly or drawing opened from the vault is tied to its vault file like a part: the title shows version, state and lock, **Save** writes the vault's working copy while it is checked out to you and is refused otherwise, and Check in stores the edits on screen as the next version. Before, only parts could be saved back.
- With the side panel folded away, on a phone or over a drawing, the vault's file list opens in a window.

## [1.435.0] - 2026-11-10

### Added

- **Diameter as a linear dimension (FR-DRW-021)**: a drawing's diameter dimension has a **Display** choice: Diameter, or a linear dimension across the circle, horizontal or vertical, with extension lines from the rim and the Ø kept.

## [1.434.0] - 2026-11-10

### Added

- **Material from the assembly (FR-MAT-001)**: right-click a component and choose **Material…** to pick its part's material from the library without opening the part. Every instance of that part follows, and the BOM and mass properties update. It is one undo step.

## [1.433.0] - 2026-11-10

### Fixed

- **File ▸ Export ▸ STEP for parts and assemblies**: the STEP button in the Export panel said "STEP export needs a STEP, IGES or BREP model" for a part you model or an assembly. It now saves them like the command bar's STEP button does.
- **DXF 2000 of a big drawing sheet**: export failed with "Maximum call stack size exceeded" on sheets with many lines (the Leuenberger engine drawing). It now saves.
- **Export on an empty part**: PNG, mesh and PDF report buttons did nothing when there was no body yet; they now say so.

## [1.432.0] - 2026-11-10

### Added

- **Datum feature options (FR-DRW-023)**: a drawing's datum feature can have an **Open triangle** (an outline instead of the filled one) and a **Bent leader**, which leaves the edge square to it and then runs level to the letter's frame.

## [1.431.0] - 2026-11-10

### Added

- **Balloons on weldment part drawings (FR-FT-121)**: a balloon on a drawing of a weldment part now shows the body's cut list item number, as in SolidWorks: click an edge of a member, plate or weld bead and place the balloon. **Auto balloon** puts one balloon on each cut list item seen in the view, and the balloon's panel names the item and stacks other items under it. The numbers match the Cut List dialog and the cut list table, and follow the part.

## [1.430.0] - 2026-11-10

### Added

- **Tolerance frame text (FR-DRW-023)**: a drawing's geometric tolerance has **Text above the frame** (such as 2×) and **Text below the frame** boxes; the text is written left-aligned over and under the feature control frame and moves with it.

## [1.429.0] - 2026-11-10

### Fixed

- **ASA and PC/ABS (FR-MAT-001)**: both now follow a named general purpose grade's data sheet and show **Checked against:**. ASA (Luran S 778T): modulus 2.5 GPa, yield 54 MPa (were 2.3 GPa and 48 MPa). PC/ABS (Bayblend T65 XF): modulus 2.35 GPa, yield 54 MPa (were 2.2 GPa and 52 MPa). 149 of 170 materials are checked; the other 21 still say they are not.

## [1.428.0] - 2026-11-10

### Added

- **Selected Contours: hover highlight and Planar Surface** (FR-FT-010): while the Selected Contours box has focus, the sketch region under the pointer lights up blue before you click, as in SolidWorks. Planar Surface takes Selected Contours too, so a sketch whose lines cross or branch can fill just the regions you pick.

## [1.427.0] - 2026-11-10

### Added

- **Foreshortened radius (FR-DRW-021)**: a drawing's radius dimension can be **Foreshortened**: its line starts on the arc and stops short of the centre with a jog, for a centre far away or off the sheet.

## [1.426.0] - 2026-11-10

### Fixed

- **Beryllium copper CuBe2 (FR-MAT-001)**: the density of the age hardened alloy is 8.36 g/cm³ (8.25 was the value before hardening), thermal conductivity 97 W/(m·K), specific heat 440 J/(kg·K) and expansion 17.5 · 10⁻⁶/K, after a maker's data sheet. Modulus and strengths already matched, and the material now shows **Checked against:**. 147 of 170 materials are checked; the other 23 still say they are not.

## [1.425.0] - 2026-11-10

### Added
- Bend tables for sheet metal (FR-FT-120): the Base Flange's Bend allowance type has a new choice, Bend table, with K-factors, bend allowances or bend deductions by inside radius (rows) and bend angle (columns), typed or pasted into the panel. Each bend reads its value from the table, interpolated between rows and columns; outside the table the nearest row or column is used. A button fills in DIN 6935 K-factors for the thickness. Sheet Metal Properties shows a K-factor table's value at the default radius.

## [1.424.0] - 2026-11-10

### Fixed

- **Sketch Trim on circles that lines only touch** (Leuenberger exam #76): a circle with tangent lines ending on it was deleted whole ("no crossings"), with its dimensions and relations, and where it was cut the new arc ends were loose points on the lines instead of the lines' own ends. A line end held On curve now cuts the circle there, tangent touches count within the solver's tolerance, and the cut uses the other curve's end, so the outline stays one closed, fully defined loop.
- **Face names of arcs next to a smaller concentric curve** (#77): an extruded arc's side face could take the name of a hole or slot end sharing its centre (and the hole became "…:1"), so mates and references named the wrong face. New parts match each face to its sketch curve by a point on the edge; parts saved before keep their face names, so their mates still find them.
- **Arrow keys after a heads-up view button** (#78): after a click on Front, Top… in the view bar the arrow keys did nothing; they turn the view again.
- **Mate names** (#79): a new mate no longer repeats the name of one still in the assembly after another of its type was deleted.

### Added

- **Rename mates** (#80): **Rename** in a mate's menu in the assembly tree.

## [1.423.0] - 2026-11-10

### Added

- **Surface finish options (FR-DRW-023)**: a drawing's surface finish symbol can carry a **Second requirement** under the first, a **Lay** symbol (=, ⊥, X, M, C, R, P), a **Machining allowance** and the **All around** circle, laid out as in ISO 1302.

## [1.422.0] - 2026-11-10

### Added

- **Cut list table on drawings (FR-FT-121)**: Annotate ▾ **Cut list table** puts a weldment's cut list on the sheet, like SolidWorks' Weldment Cut List table: click a view of the weldment, then place the table. It lists each item with the number it has in the Cut List dialog, its quantity, its description (the one typed for the item, else the profile, plate size or weld), the length and both end angles of each member. Select it to leave out the weld beads (they have the weld table) or add a mass column; excluded items are left out, and the table follows the part.

## [1.421.0] - 2026-11-10

### Added

- **Selected Contours for Extrude and Revolve (FR-FT-010)**: a feature can use only some regions of its sketch, as in SolidWorks, and sketches whose lines cross or branch (a rectangle with a line across it, two overlapping circles, a circle inside a shape) now work. Click in the **Selected Contours** box and click the regions in the view: picked ones are filled orange, a second click takes one off, **Use all regions** goes back to the whole sketch. When the sketch has no plain closed outline, the box opens first by itself. Neighbouring regions picked together give one clean body with no seam.

### Fixed

- **Saving names the file (exam #9)**: in a browser without the save dialog, the first Save (and every Save as) of a part or assembly now asks for the file name instead of downloading "Part1.mcadprt"; the part takes that name.

## [1.420.0] - 2026-11-10

### Changed

- **Teak, mahogany and balsa checked (FR-MAT-001)**: these three woods now show **Checked against:** with a link to the USDA Wood Handbook chapter on mechanical properties (modulus 10 700, 10 300 and 3 400 MPa at 12 % moisture). The rows already matched. 146 of 170 materials are checked; the other 24 still say they are not.

## [1.419.0] - 2026-11-10

### Added

- **Balloon styles (FR-DRW-023)**: a drawing balloon's **Style** can be a circle split by a line with the BOM quantity below, a triangle, a hexagon, a rectangle or just an underline; stacked balloons and the leader follow the outline.

## [1.418.0] - 2026-11-10

### Added

- **Note justification and leader options (FR-DRW-023)**: a drawing note's lines can be centred or set to the right (**Justify**), its leader can end in a dot or plainly instead of an arrow (**Leader end**), and **Bent leader** gives it a short level shoulder at the text.

### Changed

- **Release workflow**: the GitHub Pages deployment gives up a stuck first try after 4 minutes and tries once more, instead of failing the run after 10.

## [1.417.0] - 2026-11-10

### Changed

- **PA66-GF30 checked (FR-MAT-001)**: Nylon PA66-GF30 now shows **Checked against:** with a link to a BASF Ultramid A3WG6 data sheet (density 1.36 g/cm³, modulus 10 GPa, 190 MPa, dry as moulded). The row already matched. 143 of 170 materials are checked; the other 27 still say they are not.

## [1.416.0] - 2026-11-10

### Changed

- **PE-LD checked (FR-MAT-001)**: Polyethylene PE-LD now shows **Checked against:** with a link to a maker's stock shape data sheet (density 0.92 g/cm³, modulus 207 MPa, 9.8 MPa at yield). The row already matched. 142 of 170 materials are checked; the other 28 still say they are not.

## [1.415.0] - 2026-11-10

### Added

- **Recognize Extrudes makes turned bases (FR-FT-102)**: an imported body of revolution (a stepped shaft, a bush, a flange, with cones, rounded grooves and ball ends) comes back as a sketch of its half section with a centreline and a Revolve that makes a new body; the imported body is deleted, and recognised pockets and bosses go on the new one. It works when the axis lies in a standard plane or runs parallel to one (a reference plane through the axis is added then). Bodies with a skew axis are handled as before.

## [1.414.0] - 2026-11-10

### Added

- **Recognize Extrudes makes the base too (FR-FT-102)**: when an imported body without its pockets and bosses is a plain prism (a plate, a block, a profile with straight sides, also with round holes through it), it comes back as a sketch on one end with an Extrude, the imported body is deleted, and the recognised cuts and bosses go on the new body. The whole part is then made of sketches and extrudes you can edit, with no Delete Face. Other bodies are handled as before.

## [1.413.0] - 2026-11-10

### Changed

- **Douglas fir and water checked (FR-MAT-001)**: Wood (Douglas fir) and Water now show **Checked against:** with a link. Douglas fir is compared with Oregon State University's table from the USDA Wood Handbook (air-dry weight 545 kg/m³, modulus 13 400 MPa), water with the USGS density table. 141 of 170 materials are checked; the other 29 still say they are not.

## [1.412.0] - 2026-11-10

### Added
- Convert to Sheet Metal (FR-FT-120): a lip ring round an opening (one face shared by several walls) now gives each picked wall its own lip, straight across to the ring's inner edge, and the lips meet mitred at the corners like the walls. Every further wall at a corner is mitred too: in the plane bisecting the two bend edges when both chains have the same walls, else where the walls' mid-planes meet.

### Fixed
- Convert to Sheet Metal: with four walls round a face, a wall's second mitre could keep the wrong side and leave the wall running on past its corner (hidden in the part, where the solid trimmed it, but not in the panel outlines). Each mitre now keeps the side the wall's own bend edge lies on.

## [1.411.0] - 2026-11-10

### Added

- **Recognize Extrudes takes notches cut right through at an edge (FR-FT-102)**: a notch, a cut-off corner or a half-round cut-out in the outline of an imported body that goes through its whole thickness is removed and made again as a sketch on the face with a **Through all** Extruded Cut. When a cut can be read two ways (through from one face, blind from the next), the sketch goes on the larger face.

## [1.410.0] - 2026-11-10

### Added

- **Weld table on drawings (FR-FT-121)**: in a drawing of a weldment part, Annotate ▾ Weld table lists the part's fillet beads: click a view, then place the table. Each kind of bead (continuous, intermittent or staggered, by leg size) gets a row with its item number, ISO 2553 leg (z4, z5×8), total length along the root and how many beads, then a total row. Cut list items marked Exclude are left out, and the table follows the part when it changes.

## [1.409.0] - 2026-11-10

### Added
- Drawings: a linear or arc length dimension can hide its first, second or both extension lines (**Extension lines** in the dimension's panel), for a dimension taken to an edge that already draws the line. **Horizontal text in the dimension line** keeps a linear dimension's text level and puts it in a gap of the dimension line, as ISO 129 method 2 and ASME drawings do (FR-DRW-021).

## [1.408.0] - 2026-11-10

### Added

- **Recognize Extrudes takes cuts open to the side (FR-FT-102)**: a step, a slot running across a face or a notch at an edge of an imported body (a flat floor under straight walls that reach one flat top, open where the floor meets the outside) is removed and made again as a sketch on the top face with a blind Extruded Cut, so its outline and depth can be edited.

## [1.407.0] - 2026-11-10

### Changed

- **Two more plastics checked (FR-MAT-001)**: Nylon PA66 and PMMA (acrylic) now show **Checked against:** with a link to a maker's data sheet. 139 of 170 materials are checked; the other 31 still say they are not. Nylon PA66 follows the stock shape sheet: modulus 3.3 → 2.4 GPa, strength 85 → 83 MPa. PMMA already matched its sheet.

## [1.406.0] - 2026-11-10

### Added

- **Recognize Extrudes takes nested shapes (FR-FT-102)**: a pocket in the floor of another pocket, a cut in the top of a boss or a boss on a pocket floor are now recognised together. The inner shape is removed first and put back last, on the face the outer extrude makes, so each one stays editable on its own.

## [1.405.0] - 2026-11-10

### Changed

- **Four more materials checked (FR-MAT-001)**: POM (Delrin), PEEK, PET (PET-P) and OSB/3 now show **Checked against:** with a link to a stock shape or board maker's data sheet. 137 of 170 materials are checked; the other 33 still say they are not. Values changed to match the sheets: POM (Delrin) modulus 3.1 → 2.4 GPa, strength 70 → 76 MPa and expansion 110 → 120; PEEK modulus 4.0 → 4.5 GPa and strength 98 → 110 MPa; PET density 1.39 → 1.38, modulus 3.5 → 3.2 GPa, strength 90 → 69 MPa, expansion 60 → 70, specific heat added; OSB/3 density 0.65 → 0.6.

## [1.404.0] - 2026-11-10

### Added
- Sheet Metal Properties (FR-FT-120): a new command on the Sheet Metal tab lists the cut-list values of the flat pattern: the smallest bounding box round it (length, width, area), sheet thickness, bend radius and K-factor, the flat pattern's area, the cutting length round the outside and round the openings, the number of cut outs and bends, and the mass when the part has a material. Export CSV saves them in millimetres and kilograms.

### Fixed
- A circle inside a base flange's closed sketch now cuts a hole in the plate; it used to add the disc back on.

## [1.403.0] - 2026-11-10

### Added

- Move component: a "Turn by" box turns the component by a typed angle about the axis of its concentric, hinge or screw mate, and the parts mated to it follow (typed rotations used to be about the world axes only).

### Changed

- Mate: two flat faces that cannot be made Coincident either way round, but can be Parallel (side faces of a part its other mates already hold), start as Parallel instead of showing "over-defined".

## [1.402.0] - 2026-11-10

### Added

- **Recognize Extrudes (FR-FT-102)**: a new command in the Direct flyout, beside Recognize Holes and Recognize Fillets. Pockets and bosses with straight walls on a flat face (blind pockets with a flat floor, cuts through the body, bosses with a flat top; lines and arcs in the outline) are removed with Delete Face and made again as a sketch on that face with an Extruded Cut or Boss, so the outline and the depth of an imported body can be edited. Round pockets stay with Recognize Holes. Only finds that rebuild to the same solid are kept.

## [1.401.0] - 2026-11-10

### Added
- Rip (FR-FT-120): cut a narrow gap along straight edges where two flat walls of a thin-walled solid meet, so Insert Bends can unfold the walls apart. Rip both directions (the gap on the corner's bisector, also on outside edges) or along one wall only, so the other wall keeps the corner (inside corner edges), with a gap of your choice (0.1 mm by default). It works on any solid, before or after the sheet metal base.

## [1.400.0] - 2026-11-10

### Fixed
- Releases were cancelled when main CI had no result for the commit: the Release workflow then ran the whole smoke test in one job, which no longer fits in its 20 minutes. It now runs the smoke test in the same 6 parallel shards as CI, waits only for a CI run that has really started, and publishes in a separate job.

## [1.399.0] - 2026-11-10

### Changed

- **Four plastics checked (FR-MAT-001)**: PLA, PETG, PEI (Ultem 1000) and PE-HD now show **Checked against:** with a link to a maker's or stockist's data sheet. 133 of 170 materials are checked; the other 37 still say they are not. Values changed to match the sheets: PEI modulus 3.2 → 3.6 GPa and strength 105 → 110 MPa, PE-HD modulus 1.0 → 1.1 GPa.

## [1.398.0] - 2026-11-10

### Added

- **Recognize Fillets finds more chamfers (FR-FT-102)**: chamfers on round edges, such as the broken edge of a shaft end or a boss, and chamfers with two different distances now come back as Chamfer features too, with their distances, so they can be changed or deleted on an imported body.

## [1.397.0] - 2026-11-10

### Added
- Text below a dimension (FR-DRW-021): **Text below** in a drawing dimension's panel adds a second line under the dimension line, centred under the value (2 PLACES, for instance).

## [1.396.0] - 2026-11-10

### Added

- **Fillet beads along curved edges (FR-FT-121)**: a Fillet Bead now follows any edge where its two face sets meet, not only straight and round ones: the ellipse where a round tube stands tilted on a plate, the saddle where a tube meets another tube, and edges between curved faces such as cones. The bead's cross-section follows the changing angle between the faces along the edge; a closed run (all round a tube) becomes one ring-shaped bead, and From/to length and intermittent welds work along these edges too. Edges where the faces become tangent are still skipped, with a warning.

## [1.395.0] - 2026-11-10

### Changed

- CI: on main the run in progress finishes and only the newest commit pushed meanwhile waits for a run, so main CI no longer queues behind every merge. A newer push to a PR still cancels its older run.

## [1.394.0] - 2026-11-10

### Added

- **Touch gestures (FR-UI-091)**: on a tablet, holding a finger still for about half a second opens the menu a right-click opens: on a Features tree row, an assembly component, a selection breadcrumb, the rollback bar or a motion study lane. Held on a face it shows the context toolbar, and while a command runs it gives OK and Cancel, the fillet edge helpers or the sketch menu. One finger turns the view and two fingers pan and zoom it, as before; a finger that moves never opens a menu.

## [1.393.0] - 2026-11-10

### Added

- **Weldment defaults (FR-FT-121)**: a new Structural Member starts with the profile, size, corner treatment, weld gap and butt end used last, as in SolidWorks; a new End Cap with the last thickness, inset, direction and corner; a new Gusset with the last leg lengths, thickness, profile, chamfers and location; a new Fillet Bead with the last leg sizes. They are remembered in this browser; picks, paths, positions and descriptions always start empty, and a custom sketch profile is never carried to another part.

## [1.392.0] - 2026-11-10

### Added
- Note borders in drawings (FR-DRW-023): **Border** in the note panel frames the text with a rectangle, a rounded frame or a circle, and the leader starts on the frame.

## [1.391.0] - 2026-11-10

### Added
- Tab and Slot (FR-FT-120): tabs grow out of a straight edge of a sheet face, in its plane, through the face they meet (on another body or the sheet itself), which gets matching slots with a clearance all round. Set the tab length and height, the number of tabs with an edge offset or a fixed spacing, and optionally round the slot corners. The tabs are part of the flat pattern, and slots cut in the sheet show in it like any cut.

## [1.390.0] - 2026-11-10

### Added

- **Recognize Fillets (FR-FT-102)**: the new command beside Recognize Holes finds the fillets and chamfers of a body, an imported one above all, removes them with Delete Face and makes them again as Fillet and Chamfer features, one per size. After that you can change a radius, or delete the fillet, on a STEP part. It finds fillets on straight and round edges with their corner patches, and equal-distance chamfers on straight edges. A fillet that runs round other fillets is taken off first and put back last. Only finds that rebuild to exactly the same solid are kept.

## [1.389.0] - 2026-11-10

### Changed
- Hole callouts in drawings follow the drafting style (FR-DRW-022): their sizes take the drawing's default decimals and, with dual dimensions on, show inches in brackets, as in `Ø5.0 [0.20] ↧12.0 [0.47]`. Angles and thread sizes stay as they are.

## [1.388.0] - 2026-11-10

### Added

- **Cutting plan in the cut list (FR-FT-121)**: with a stock bar length typed, **Cutting plan** under the weldment cut list's Stock lengths table lists the pieces to cut from each bar and what is left of it, equal bars put together. The CSV export ends with the same plan.

## [1.387.0] - 2026-11-10

### Added

- **Selection box colours in more panels (FR-SEL-011)**: Extrude's Start at, Up to and Body boxes, Revolve's Up to, the Hole Wizard's Face and Up to, Mirror's Plane, the faces to mirror or pattern and Split's plane now have their own colours too. The picked face is drawn in its box's colour with a small tag naming the box, so you see which pick went where.

## [1.386.0] - 2026-11-10

### Added
- Dimension arrows by hand in drawings (FR-DRW-021): a linear dimension's **Arrows** can be set to **Inside** or **Outside** the extension lines, instead of following the room there is.

## [1.385.0] - 2026-11-10

### Changed

- **More material values checked (FR-MAT-001)**: ten more library materials now show **Checked against:** with a link (tool steels X153CrMoV12, X40CrMoV5-1 and 90MnCrV8, high speed steel HS6-5-2, bearing steel 100Cr6, stainless 1.4125, titanium Grade 4 and Ti-6Al-4V, ASTM A500 Grade B, C22). 129 of 170 materials are checked; the other 41 still say they are not. One value changed: HS6-5-2 density 8.10 → 8.12 g/cm³.

## [1.384.0] - 2026-11-10

### Added

- **Bars to buy in the cut list (FR-FT-121)**: type a **Stock bar length** (and the **Saw kerf**) under the weldment cut list's Stock lengths table, and each section shows how many bars to buy and what is left of them; members longer than a bar are counted apart. The values are saved with the part and go into the CSV export.

## [1.383.0] - 2026-11-10

### Added
- Reference and basic dimensions in drawings (FR-DRW-021): a dimension's **Display** can be **Reference**, which puts the whole value in parentheses, or **Basic**, which boxes it as a theoretically exact value and leaves out any tolerance, the drawing's default included.

## [1.382.0] - 2026-11-10

### Changed

- **More material values checked (FR-MAT-001)**: 72 more library materials were compared with public pages (EN 10083, EN 10088, EN 10130, EN 10277 and EN 10293 tables, producer datasheets for stainless steels, aluminium, copper alloys, cast irons and plastics, the Wood Database and others), so 119 of the 170 materials now show **Checked against:** with a link. The checks confirmed the values; one changed: bronze CuSn8 elastic modulus 110 → 115 GPa.
- A material that has not been compared with a public page yet says **Not checked against a public reference yet.** in the dialog (51 materials: tool steels, several plastics and rubbers, carbon and aramid composites, four woods, a few others). Its values still name their source.

## [1.381.0] - 2026-11-10

### Added

- **Tutorial "Bracket in 10 steps" (FR-HLP-003)**: the start screen has a tutorial button. It opens a new part named Bracket with a step list at the top of the right panel: sketch the base, size it, extrude it, add the wall, a fillet, a hole, chamfers and a material. Each step ticks itself when the part has it and unticks on undo, the next step shows what to click, and any step can be opened again. The list follows the bracket's document tab and closes with ✕.

## [1.380.0] - 2026-11-10

### Added
- Dual dimensions in drawings (FR-DRW-021): the sheet's drafting style has **Dual dimensions**, which adds every length in inches in brackets after the millimetres (25.4 [1.000]), with its own number of decimals. Tolerances follow (±, limits), angles stay as they are, and one dimension can be switched on or off with its **Dual dimension** box.

## [1.379.0] - 2026-11-10

### Added

- **Stock lengths in the cut list (FR-FT-121)**: under the weldment cut list a **Stock lengths** table sums the members of each section: how many pieces and their total length, so the bar to order is read straight off. Items ticked **Exclude from cut list** are left out, and the CSV export ends with the same table.

## [1.378.0] - 2026-11-10

### Changed
- Model items layout (FR-DRW-020): imported model dimensions are stacked outside the view with the shorter ones nearer the outline, so extension lines no longer cross dimension lines. The gaps (10 mm from the view, 8 mm apart) are sheet millimetres at any view scale, a later import starts beyond the dimensions already on that side, and radius or diameter texts on one centre turn aside instead of sharing a place.

## [1.377.0] - 2026-11-10

### Added

- **Document tabs keep the view (FR-DOC-003)**: a part, an assembly or a model file comes back to its tab with the camera it was left with, and a part with its selected Features row, instead of the fitted isometric view.
- **Section view in the heads-up bar (FR-UI-022)**: the bar at the top of the view has a Section view button: it cuts the model at the selected flat face, or through the middle on the front plane; a second click turns the cut off and keeps its planes, a third brings it back. The bar moves aside when it would reach the ✓ ✕ corner or the view cube.

## [1.376.0] - 2026-11-10

### Added

- **Weld both sides (FR-FT-121)**: a fillet bead's new **Weld both sides** option also welds the other side of each flat plate picked in face set 1, so a plate standing on another gets its two fillets from one pick. Staggered intermittent welds then alternate between the two sides, and the weld symbol shows two triangles (◺◹).

## [1.375.0] - 2026-11-10

### Changed

- **Material values checked (FR-MAT-001)**: the density, elastic modulus, yield and tensile strength of the library's materials were compared with public pages of the standards' tables, producers' data sheets and handbooks. 47 materials now show **Checked against:** with a link to the page in the Material dialog; the others keep only their named source.
- Corrected: die cast aluminium A380 density 2.74 → 2.71 g/cm³; cast bronze CuSn12-C 8.6 → 8.7 g/cm³ and 100 → 97 GPa; gunmetal CuSn5Zn5Pb5-C 8.8 → 8.7 g/cm³; sintered silicon carbide 3.1 → 3.15 g/cm³; gold 79 → 78 GPa; aluminium bronze CuAl10Ni5Fe4 115 → 120 GPa; ASTM A500 Grade B shaped tube yield 315 → 317 MPa (46 ksi); Inconel 718 tensile 1241 → 1276 MPa (185 ksi, ASTM B637).
- Cast aluminium EN AC-42100 T6 is named **sand cast**, which is what its 190 / 230 MPa are. The EN 10083 source says which size each condition is for (normalized ≤ 16 mm, quenched and tempered 16–40 mm), and the EN 10088 source that the sheet values are for hot rolled plate.

## [1.374.0] - 2026-11-09

### Added

- **Gusset profile options (FR-FT-121)**: a polygonal weldment gusset can now have different flats at its two ends, as SolidWorks' polygonal profile does. **Other end** in the Gusset panel takes the same width as before, **Its own width** (the flat at face 2), or **By profile angle**, where the sloping edge's angle from face 1 sets it (it starts at the angle the profile already has, so nothing jumps). The inner corner's chamfer can take a **Different distance along face 2**, for a chamfer that clears an unequal leg weld. An angle too shallow for the legs fails the feature with a message saying what to change.

## [1.373.0] - 2026-11-10

### Added
- Slot end axes from the side (FR-DRW-023): a view that looks at a slot from the side draws the axis of each rounded end (half a cylinder with material around it), like a hole's centreline. Rounded bar ends and fillets get none.

## [1.372.0] - 2026-11-09

### Added

- **Material library (FR-MAT-001)**: 170 materials in 14 categories instead of the 14 densities: structural, carbon, alloy and tool steels, stainless steels, cast irons, aluminium, copper, titanium and nickel alloys, magnesium, zinc and other metals, plastics, rubbers, composites, glass and ceramics, woods and wood panels. Each has its density, elastic modulus, Poisson's ratio, yield and tensile strength, thermal conductivity, specific heat, thermal expansion and a colour, with the source named (EN, ASTM and GOST product standards give minimum strengths; handbooks and data sheets typical values). A value the source does not give is left empty.
- **Material dialog**: Part properties ▸ Material and the Mass page open the library: categories on the left, a list with search, the properties on the right. Search takes the name, the grade or another standard's designation (`1.4301`, `AISI 316L`, `Д16Т`, `сталь 45`), in English or Russian. Enter or a double-click applies; **Use the material's colour** also colours the part.
- **My materials**: **New material…** or **Copy to my materials…** keeps your own materials in the browser. A part stores its material's values in its file, so it opens the same on another computer.
- A weldment cut list item's Material list is grouped by category and includes your materials; section hatching in drawings picks its pattern from the material's category.

### Changed

- The part's material is no longer a drop-down; its density can still be typed over under the button.

## [1.371.0] - 2026-11-09

### Added

- **Named views (FR-UI-104)**: the Space orientation picker has a Named views row: type a name and press Save view (or Enter) to store the camera; a click on a named view goes back to it, ✕ deletes it. Parts and assemblies keep their named views in the document (saved with it, left alone by undo and redo); model files keep them for the session.
- **Heads-up view bar (FR-UI-022)**: with a part or an assembly open, the view commands float at the top centre of the view, as in SolidWorks: Zoom to area, Previous view, the standard views, projection and display style. For model files they stay in the header.
- **Assembly selection breadcrumbs (FR-SEL-009)**: a click on a component in an assembly shows the chain face › part feature › component › its sub-assemblies › assembly at the top left of the view; a crumb selects that component as in the tree, a right-click opens its menu, Shift+D brings the bar to the cursor and Esc hides it.
- **Feature values on the model (FR-UI-115)**: a click on a feature in the Features tree shows its dimensions on the model, as a double click on its face does, and both now show the feature's own values too (angle, radius, distance, thickness, spacing, instance count…) in blue labels beside its faces; a click on one opens the Modify box and ✓ changes the feature as one undo step.
- **Modify box options (FR-UI-114)**: the box has an increment field that sets the step of the arrows, ↑/↓ and the wheel (remembered for lengths, angles and counts); a sketch dimension's name in the title can be retyped to rename it; ⇄ Reverse direction flips an extrude depth or another feature value that has a direction, together with the value, as one undo step.

### Fixed

- The heads-up view bar no longer covers the selection filter and the status line at the top left of the view.

## [1.365.0] - 2026-11-09

### Added
- Default tolerance in the drafting style (FR-DRW-025): with nothing selected, the sheet panel's Default tolerance (±) and Default angle tolerance (±°) apply to every dimension without a tolerance of its own. A dimension's Tolerance row then reads Document, and None turns the default off for that dimension.
- Centre marks on spheres (FR-DRW-023): a whole sphere (a ball end, a knob) gets a centre cross from any side, unless a circle seen end-on already marks that centre.

## [1.363.0] - 2026-11-10

### Changed

- Extrude and Revolve open with the cursor in Depth (or Angle), so a typed size goes straight there.
- Extrude seen straight down the sketch's normal turns to a three-quarter view on the sketch's side, so the depth and its arrow can be seen.
- Cut on a sketch beside the part (a reference plane under it): when the whole part lies on the sketch normal's side, the cut starts reversed, towards the part, instead of cutting nothing.
- A new empty part's Properties page says to start a sketch on a plane, not "Open a model to begin."
- The right panel's page tabs show every name when they fit; when they don't, only the open page keeps its name and the others show their icon with a tooltip (the names ran into the next tab).

### Fixed

- Coincident mate between two flat faces: the first guess is face to face; when that cannot be solved and the aligned one can (a part that cannot turn over, such as a die block on a pin), the panel takes Aligned instead of refusing the mate. A choice made in the panel stays.
- Screw mates: moving the nut (a distance mate, a drag) now turns the screw. The solver measured axis offsets × the assembly size, which made its damping swamp the screw's gentle turn, so a handwheel driving a fork could not move; offsets are now in mm, the screw keeps its turn count within a step, and the damping adapts (Levenberg–Marquardt).
- Overall size of a modelled part is taken from the exact geometry (a Ø15 cylinder read 14.995 × 14.998 from its mesh).

## [1.357.0] - 2026-11-09

### Added

- **Sub-weldments in the cut list (FR-FT-121)**: right-click a cut list item or a weldment body in the Features tree and pick **Create sub-weldment** to list that part of the weldment on its own, as SolidWorks does. The sub-weldment is a folder in the Cut list with its items under it; rename it with a double-click or F2, add more items or bodies to it with **Add to Sub-weldment1** (or take them out with **Remove from sub-weldment**), and **Dissolve sub-weldment** puts its items back. An item whose bodies sit in different places is split, each part with its own quantity (a weld bead's length and mass share out by its bodies); item properties typed in the Cut List dialog stay shared. Clicking a sub-weldment highlights its bodies, the Cut List dialog heads each one's rows with its name, and the CSV gets a Sub-weldment column.

## [1.356.0] - 2026-11-09

### Added
- Insert Bends and Convert to Sheet Metal follow walls that don't touch the fixed face (FR-FT-120): Insert Bends finds the next wall across each wall's far edge (a hat section's brims, a Z section's flanges) and bends it too, the right way round; Convert to Sheet Metal does the same for each wall far edge you pick, so a box can become a C channel with lips.
- Corner Relief at return flanges and three-bend corners (FR-FT-120): a flange off a flange's end (a return) now makes a corner with that flange's bend, and where it meets a two-bend corner the relief covers all three bend zones. The panel names three-bend corners.
- Sheet Metal Gusset tip shapes (FR-FT-120): a Rounded tip (a half round across the rib's width) or a flat tip with filleted edges; the groove follows, and the flat pattern still leaves the gusset out.

## [1.355.0] - 2026-11-09

### Added
- Thread callouts from geometry (FR-DRW-022): a hole read from the shape with a cosmetic thread on it now adds the thread line ("M6-6H ↧10", or the drill depth or THRU when the thread runs the full length), so a tapped hole cut without the Hole wizard reads like one made with it, and equal tapped holes are counted together.
- Default decimals in the drafting style (FR-DRW-025): with nothing selected, the sheet panel's Linear decimals and Angle decimals set the precision of every dimension that has none of its own; Auto keeps the old behaviour (up to two, trailing zeros dropped).

## [1.354.0] - 2026-11-09

### Added

- **Magnifying glass (FR-SEL-010)**: press G over the view for a round inset showing the area round the cursor magnified 4× (the wheel inside it changes the factor from 2× to 16×). Hovering, snapping and clicks inside the lens act on the magnified point, so small edges and vertices are easy to pick. G or Esc closes it; Esc does not leave the command that is open.
- **Selection box flow (FR-UI-109)**: once a selection box that takes one item (a plane, an axis, an edge, a body) has it, focus moves to the next empty required box of the panel by itself, also back to an earlier one left empty (a linear pattern's direction picked before its seeds); boxes that take many items (fillet edges, faces to draft) keep focus. A panel opens on its first empty required box, also when an existing feature is edited.
- **Selection breadcrumbs (FR-SEL-009)**: after picking a face or an edge of a part, a bar at the top left of the view shows the chain up to the part (face or edge → feature → its sketch → body → part; a picked plane → part). Hovering a crumb lights it up in the view, a click selects it as in the Features tree, a right-click opens its tree menu. Shift+D brings the breadcrumbs, or the ✓/✕ corner while a command is open, to the cursor (D stays the distance tool); Esc hides them.
- **Value callouts (FR-UI-110)**: while a feature panel is open, its main values (thickness, distance, offset, angle, spacing, instances, pitch, height…) show in small labels on the model by the feature's result, as in SolidWorks. A click opens the Modify box; the value goes through the panel field, so the panel and the callout always agree, and a ⇄ beside the first callout reverses the direction when the feature has one. Extrude, revolve, fillet, chamfer, end caps, gussets and flanges keep their drag handles and callouts.

## [1.353.0] - 2026-11-09

### Changed

- **Smart measure's hint no longer covers the model**: the "Smart measure: click a point, edge or face…" prompt moved from the banner over the top of the view into the status bar, as SolidWorks shows its prompts. Tools you pick on purpose (Distance, Angle, Section…) still show their pick count banner.

## [1.352.0] - 2026-11-09

### Added

- **Corner callouts and Locate profile for structural members (FR-FT-121)**: while a Structural Member is open, each corner where its segments meet shows a callout in the view with its treatment (End miter, End butt 1, End butt 2 or None), as SolidWorks' corner spheres do. Click one to pick a treatment for that corner alone, or *As set for the member*; a corner with its own treatment is shown in bold, and the Corners group in the panel follows. **Profile position** of a custom (sketch) profile now also lists every point of the profile sketch, so any of them can sit on the path, for group 1 and for each group. **Locate profile** beside it zooms to the start of the path and shows the profile's points there (sketch points and the box's anchors); click one and the profile moves so that point lies on the path, as in SolidWorks.

## [1.351.0] - 2026-11-09

### Added

- **Rotation centre (FR-UI-100)**: a middle click without a drag on a vertex, an edge or a face sets the point the view turns about, as in SolidWorks, with a small blue marker; a middle click on empty space goes back to the view centre. Opening another model clears it. An edge gives the clicked point on it (the view still orbits with Z up, so it does not turn about the edge's line).
- **Undo inside a command (FR-UI-108)**: while a feature panel is open, Ctrl+Z / Ctrl+Y and the Undo / Redo buttons step through the panel's own changes (picks, values, options, the box in focus) without leaving it. The document's undo list is not touched until ✓.
- **Units in the status bar (FR-UI-116)**: the unit and decimals show at the right of the status bar; a click picks millimetres, centimetres, metres, inches or feet and the decimals. With a part open the unit is the part's own, saved with it and changed as one undo step (values stay stored in mm), and opening a part shows its unit. Mass still shows in g/kg.
- **Command tooltips (FR-UI-112)**: hovering a command bar button (or focusing it from the keyboard) shows its name, its shortcut key and a one-line description; a disabled button says why (Undo in a command with nothing to undo, Undo while a command runs elsewhere). Inside a feature command the Undo and Redo buttons step the panel's own changes.
- **Hide and show under the cursor (FR-UI-105)**: with the pointer over the view, Tab hides the body (in a part) or the component (in an assembly) under it, Shift+Tab shows a hidden one under it again, and holding Ctrl+Shift+Tab draws the hidden ones see-through so a click shows one, as in SolidWorks. Each is one undo step. Items hidden from the tree work the same way once hidden in this session.
- **Colour-coded selection boxes (FR-SEL-011)**: the selection boxes of a feature panel each have their own colour (orange, blue, green, purple), shown on the box's left edge; the picks of each box are drawn in the view in its colour, with a small tag naming the box ("Faces to draft", "Neutral plane", "Face set 1"…) when a panel has several. Fillet and chamfer edges, face fillet and full round face sets, draft, shell, delete/move/offset/replace face and split line use it.

## [1.350.0] - 2026-11-09

### Added

- **Rollback commands (FR-HIS-012)**: the Features tree's right-click menu has Roll back to here, Roll to previous (back to where the rollback bar was before its last move), Roll forward past this and Roll to end, and right-clicking the rollback bar gives Roll to previous and Roll to end. A part saved rolled back reopens rolled back with a notice above the tree, "The part is rolled back: N features are not shown", and a Roll to end button (AT-UX-14).
- **Tree housekeeping (FR-HIS-013)**: Shift+C folds the whole Features tree (folders, Solid Bodies, the cut list and the sketches under their extrudes and revolves; the ▸ beside a feature or ←/→ unfold it again). Hovering a sketch, plane, axis, point, coordinate system, curve or body row shows an eye button that hides or shows it, and hidden items have an outlined icon, as in SolidWorks.

### Changed

- The FRS gap tables (`docs/FRS-modelling.md`) now mark the habits and features built since 1.85.0 as done, with the release that brought each.

## [1.349.0] - 2026-11-09

### Added
- Hole callouts read from the geometry (FR-DRW-022): on a model with no Hole feature (a STEP file, a cut extrude), a hole callout now counts the holes of that size entered from the same side ("4× Ø6.6 THRU"), and adds the counterbore (⌴Ø11 ↧6.4) or countersink (⌵Ø13.44 × 90°) found from the coaxial cylinders and cones. The depth is measured from the entry face to the end of the drill, without its point; THRU now means open at both ends rather than as long as the part. Hole tables list each hole without the count.

## [1.348.0] - 2026-11-09

### Added

- Sheet Metal → Normal Cut (FR-FT-120): SolidWorks' Extruded Cut with Normal cut. A closed sketch is projected along its normal onto the sheet, and every panel and bend it lands on is cut square to the sheet there (radially through bends), so the flat pattern gets clean openings with no slanted walls. End condition Link to thickness (default), Blind or Through all, with Reverse direction.
- Sheet Metal → Convert to Sheet Metal (FR-FT-120): turn a solid into a sheet metal part, as SolidWorks' Convert to Sheet Metal. Click the face that stays fixed, then the straight edges of it to bend along; each face across a bend edge becomes a flange as long and at the angle the solid has, with the thickness inside the solid, so the part keeps its outside size. Edges between converted faces are ripped and mitred (Rip gap). Holes and shaped ends of the converted faces carry over, in the flat pattern too. It starts a sheet metal part like a base flange.
- Corner Relief options (FR-FT-120): an Obround relief (rounded as far as it goes, keeping the clearance round the face's own corner) and Add fillet corners with a radius for rectangular reliefs; both follow into the flat pattern.
- Sheet Metal Gusset options (FR-FT-120): a different profile length on the second face, and several gussets along the bend, spaced centre to centre about the position.
- Sheet Metal → Insert Bends (FR-FT-120): turn a thin-walled solid (a shelled box, a bent section) into sheet metal, as SolidWorks' Insert Bends. Click an outside face to stay fixed; its sharp edges to other flat walls become bends of the given radius, the thickness is the walls' own, and corners between walls are ripped. Holes in the walls carry over.

## [1.346.0] - 2026-11-09

### Changed

- CI runs the browser smoke test in 6 parallel shards instead of 4, balanced by measured block times, so a CI run takes about 6–7 minutes instead of about 10. The smoke test prints each block's time at the end of a run.

## [1.344.0] - 2026-11-09

### Added

- **Evaluate ▸ Mass properties**, like SolidWorks' Mass Properties: a panel beside the view with mass, volume, surface area, centre of mass, the principal axes and principal moments of inertia at the centre of mass (drawn in the view as red, green and blue lines through the centre of mass), the moments and products of inertia at the centre of mass aligned with the output coordinate system (Lxx…) and at its origin (Ixx…), in kg·mm² or g·mm² (following the display unit). Products use positive notation (Lxy = ∫xy dm). It follows the selection, visibility, units and coordinate system while open; **Include hidden bodies**, **Recalculate** and **Copy to clipboard** (FR-MAT-002).
- Your own output axes: **Pick axes** and click a flat face, straight edge, circle, cylinder or point, or **Type axes…** with an origin and the X and Z directions; a part's coordinate system features and the active CSYS are listed too, and the chosen axes are drawn while the panel is open.
- Moments of inertia for every model, not only modelled parts: exact from the B-rep (OpenCASCADE) once the kernel has read the file, from the mesh until then and for STL/OBJ/3MF. Assemblies add their components with each part's own material (the density field for parts without one), like the BOM. The Mass tab and the PDF report list the principal moments and axes and the moments at the centre of mass and at the origin.

### Changed

- A mass override on a modelled part scales the moments of inertia with the mass, as SolidWorks does.
- Multibody modelled parts get exact volume and centre of mass too (only single solids did).

## [1.343.0] - 2026-11-09

### Added

- **Coped cuts on structural members (FR-FT-121)**: Structural Member gets SolidWorks' choice for butted ends. **Simple cut** keeps the flat end square to the face the member stops at; **Coped cut** makes the end follow the shape of the member it stops at, so a round tube meeting another gets its saddle (fish-mouth) end, ready to weld. A weld gap moves the coped end back along the member.

## [1.342.0] - 2026-11-09

### Added

- **Copy and paste features (FR-HIS-014)**: as in SolidWorks, Ctrl+C on a sketch, an extrude, a revolve or a hole in the Features tree and Ctrl+V with a flat face or a plane selected puts a copy on it (an extrude or revolve brings a copy of its sketch). Ctrl+dragging the tree row onto a face or plane does the same, and the tree's right-click menu has Copy and Paste. The paste is one undo step. References that cannot follow are listed: On edge relations become fixed points, pierce relations are removed, the sketch X axis follows the new plane, and Up to … ends go back to Blind.

## [1.341.0] - 2026-11-09

### Added
- Centrelines on cones and tori in drawings (FR-DRW-023): a cone, torus or revolved face seen from the side (a taper, a countersink, a groove, an O-ring) gets a centreline on its axis, 2 mm past its ends, like cylinders; a part with no cylinder on that axis now gets one too.

## [1.340.0] - 2026-11-09

### Added

- Sheet Metal → Sheet Metal Gusset (FR-FT-120): a stiffening rib pressed across a bend, as SolidWorks' Sheet Metal Gusset (flat type). Click the bend to place it, centred or at a distance from the bend's end; the profile length runs along each face from the inside virtual sharp, and the width is the rib's outside width. The rib keeps the sheet's thickness, with the matching groove outside, and the flat pattern leaves it out. Bends with gussets can't be unfolded.

## [1.339.0] - 2026-11-09

### Added

- Angle mates are signed: a new angle mate turns about the direction its two faces make when it is made, so +30° and −30° are different positions and a negative angle can be typed.
- Assembly Undo and Redo tips name the step ("Undo: Move pin<1>", "Undo: Add Coincident2").
- The Delete key deletes the mate, component, pattern, exploded view or feature selected in the assembly tree.

### Changed

- Mate: when a new mate cannot be solved from where the parts stand, the solver tries again with the component turned about its own axes (90°, 180°, 270°), so a mate made half a turn away no longer reads as over-defined. When it still fails, the message says the parts may be too far apart; adding a mate takes down that error.
- Distance mate between flat faces: Aligned / Anti-aligned now picks the side the second face faces, and a negative distance flips the dimension.
- Move component: Enter applies a box and goes on to the next one; on the last box it closes the panel.
- Inserted components go into the view, right of its middle, instead of in a line beside the model; they are numbered by their file name, so the first insert of a file is <1>.
- Save as names the part after its file, so the title, the document tab (without the unsaved mark) and Insert component's list of open documents show that name.

### Fixed

- Save snapshots: a snapshot cut short by closing the page (an empty file) is no longer listed, so Restore no longer fails on it.
- Tree context menus near the bottom of the window open upwards and stay inside it.
- Components fixed or locked inside a closed linkage no longer show 1 DOF from round-off.
- Undo after Move edits shows the restored pose in the Move panel (typed angles of the undone pose are dropped).

## [1.338.0] - 2026-11-09

### Added

- Motion studies: **Key all** adds a key at the playhead to every track that is on, each holding what it shows there, as SolidWorks Place key does, and selects them together so they move as one. Right-clicking the ruler or an empty part of a track offers it at that time (FR-FT-122).

### Fixed

- Motion studies: a key added in the middle of a colour blend on an appearance track keeps the colour shown there instead of dropping it.

## [1.337.0] - 2026-11-09

### Changed

- Assemblies: the mate solver is much faster on big linkages. Each Jacobian column only re-evaluates the mates of the component it moves, the damped step solves the smaller of its two equivalent systems, and the degrees of freedom come from a Gram-Schmidt null space in place of a Jacobi eigen-solve. Motion study frames and constrained drags skip the degrees of freedom altogether. A 50-link hinge chain now solves in about 0.5 s instead of 8 s (exam bug 62: about 57 s per motion frame with the steam engine's link motion).

## [1.336.0] - 2026-11-09

### Added

- **Structural member alignment (FR-FT-121)**: Structural Member gets SolidWorks' Alignment. Pick a straight sketch line (any 2D or 3D sketch line, construction lines too) and choose whether the profile's vertical or horizontal axis points along it: every segment turns its profile that way, square to the segment, and the rotation angle turns it on from there. Members of a 3D sketch can now all face one way instead of following world Z.
## [1.335.0] - 2026-11-09

### Added

- **Fly-out feature tree (FR-UI-003)**: while a feature, sketch or plane command is open its panel fills the Features tab (as SolidWorks' PropertyManager replaces the FeatureManager), and the feature tree flies out at the top left of the view, so planes, sketches and features can still be picked from it. As in SolidWorks it shows folded to the part name: click the name to open it (remembered). It is see-through until the pointer is over it, and has no suppress or delete buttons, so a click in the view can't remove a feature. Starting a command brings the Features tab forward. On phones the tree stays under the panel.

## [1.334.0] - 2026-11-09

### Added
- Hole rows in drawings (FR-DRW-023): three or more end-on holes of one size evenly spaced on a line (a row, or the rows and columns of a grid) get one centreline through them, 2 mm past the end holes, and a short centre line across each hole in place of the cross. The view panel's Hole rows box turns it off.

## [1.333.0] - 2026-11-09

### Added

- Sheet Metal → Corner Relief (FR-FT-120): cuts a relief where two bends meet at a corner of one face, as SolidWorks' Corner Relief for two-bend corners. Rectangular covers both bend zones with a clearance past them, Circular is centred where the bend centre lines cross, Tear is a small round at the inside corner; the size is the relief ratio × thickness or a typed value. Every corner is relieved until some are picked, by ticking them in the panel or clicking near them in the view. The relief comes off the panels and is wrapped onto the bends, so the flat pattern and its DXF show it too.

## [1.332.0] - 2026-11-09

### Added

- Motion studies: appearance keys can carry a **colour**. Tick **Colour** on a key and pick one: the component wears it from that key and blends to the next coloured key, as SolidWorks appearance keys do. Coloured keys show their colour on the timeline, and the component gets its own colour back when the track goes (FR-FT-122).

## [1.331.0] - 2026-11-09

### Added

- **From/to length fillet beads (FR-FT-121)**: Fillet Bead gets SolidWorks' Bead length choice. **From/to length** welds only part of each run of edges: from the Start offset for the Length you type, or measured from the other end with Start from the other end. The weld symbol shows the length (◺ z4 50), the cut list gives the welded length, and an intermittent weld fills just that stretch.

## [1.330.0] - 2026-11-09

### Added

- Mate: Alt+click picks the face behind the one under the cursor, and again cycles through every face there, so faces hidden behind others can be mated (Select Other).
- Concentric mate: Lock rotation, which stops the second component turning about the shared axis.
- The assembly status shows the free degrees of freedom of the whole assembly ("Under defined, 1 DOF"; a linkage that moves as one counts once), and the selected component's own.
- Header below 1600 px: a ▾ button beside Fit lists the standard views that no longer fit.

### Changed

- Mate panel: after ✓ adds a mate the panel says what was added and that ✓ again closes it; the Mate button with faces picked starts a new mate instead of closing the panel.
- Assembly tree: the show/hide button is always shown (faint until hovered), so hidden components are easy to find and show.
- Motion study: Play first calculates the frames still to solve a few at a time, showing "Calculating frame k of n" and keeping the page responsive; Play or Pause again cancels. A big assembly's first Play froze the page for minutes.
## [1.329.0] - 2026-11-09

### Added

- **Preferences (FR-UI-080)**: Display ▾ → Preferences… opens one dialog for the settings that were spread over panels and menus, as SolidWorks' System Options. **Modelling**: units and decimals, image quality (Coarse rebuilds faster, Fine draws smoother; the exact geometry is the same), **Verification on rebuild** (each feature's body is checked, and a feature that leaves it invalid gets a warning in the tree and What's wrong), how soon unsaved work is kept for recovery (after each change, 10 s … 5 min, or off), and the ↑/↓ and spin arrow steps for lengths and angles. **Sketch**: rotate the view to the sketch plane on opening, automatic relations, relation glyphs, model edge snapping, slot dimensions, grid and grid snap, and a legend of the sketch colours. **Mouse**: middle button pans or rotates (SolidWorks), wheel zoom direction, and Mouse gestures. Defaults resets the open page; the sketch panel and quick bar toggles stay in step.

## [1.328.0] - 2026-11-09

### Added

- Sheet Metal → Unfold and Fold (FR-FT-120): Unfold flattens the picked bends (or all of them) with a clicked flat face kept in place, so ordinary features can cut across them; Fold bends them back. Cuts made across a flat bend wrap onto the bend with lengths on the neutral surface kept, cuts in the panels move with them, and forms and other added material go with their panel. Other sheet metal features wait until the bends are folded back; a Flat-Pattern after an Unfold folds back first.

## [1.327.0] - 2026-11-09

### Added
- **File menu like SolidWorks (FR-UI-010)**: the blue Open file button is now **File ▾**, and drawings have the same button. It has New part / assembly / drawing, Make assembly from part, Open (Ctrl+O), Close (Ctrl+Alt+W), Close all, Save (Ctrl+S), Save as (Ctrl+Shift+S; for a STEP or mesh model it saves a copy of the file), Save all (Ctrl+Alt+S), Pack and Go, Export, Print (Ctrl+P: the drawing, or the 3D view as shown), Properties, the recent documents and Exit. Commands that don't apply are greyed out.
- **Pack and Go**: the chosen open documents in one .zip, with each assembly's parts as separate files under `parts/` if you like.
- **Recent documents**: the last 8 files you opened or saved are listed at the bottom of the File menu (numbered, so 1–8 open them from the keyboard) and open again without the file picker.

### Changed
- The New part button and its ▾ arrow are as tall as the File button, with a bigger arrow.

## [1.326.0] - 2026-11-09

### Added
- Arc slot centre marks in drawings (FR-DRW-023): an arc slot seen end-on gets a centre-line arc through its end centres, 2 mm past both ends, and a radial centre line across each rounded end.

## [1.325.0] - 2026-11-09

### Fixed

- Sketch relation glyphs sit beside their line, arc or circle (out along its normal, at the middle) instead of on it, so a click on the curve no longer picks its glyph and Delete no longer removes the relation instead of the curve.
- Fully define sketch dimensions arc and circle centres and the ends of construction lines first (a slot's centreline), then other curve points, instead of the derived tangent points of a slot's caps.
- "The sketch is already defined there: added as a reference dimension" is a passing note now, not a warning that stays until closed.
## [1.324.0] - 2026-11-09

### Added

- **Hover link between the Features tree and the view (FR-UI-061)**: point at a feature, body or cut list item in the Features tree and its faces light up see-through blue in the view; point at a face in the view and the tree marks the row of the feature that made it. It works while no command is open, as in SolidWorks.

## [1.323.0] - 2026-11-09

### Added

- Motion studies: a motor's panel now plots its **Displacement**, **Velocity** or **Acceleration** over the study, with the playhead, like the SolidWorks motor graph. It works for every profile, so you can check a data point or segments motor for jumps before you play it (FR-FT-122).

## [1.322.0] - 2026-11-09

### Added

- **End cap thickness ratio (FR-FT-121)**: Weldments → End Cap → Offset has SolidWorks' Use thickness ratio: the inset is a multiple of the capped member's wall thickness (0.5 on an SHS 40×40×3 = 1.5 mm in from the edges), so caps on tubes of different walls follow them. On a solid section the wall is taken as 2 × area / perimeter (a flat bar's or a channel leg's thickness); Internal caps keep their clearance.

## [1.321.0] - 2026-11-09

### Added

- **Forming tools (FR-FT-120)**: Sheet Metal → Forming Tool presses a library form into a flat face of the sheet, like dropping a SolidWorks forming tool on a face: a **Dimple** (round, with drafted walls), an **Embossed rib** (a long rounded rib), a **Louver** (a hood open on one side) or an **Extruded hole** (a hole with a collar). Click the face to place a tool, and click again for more; the positions can also be typed. The form keeps the sheet's thickness and stands out of the picked face, or the other one with Reverse direction. The flat pattern leaves forms out, as SolidWorks does: their outlines go on a FORM_TOOL layer in the DXF, and an extruded hole leaves its pre-pierce hole.

## [1.320.0] - 2026-11-09

### Added
- Slot centre marks in drawings (FR-DRW-023): a straight slot seen end-on gets a centreline along it, 2 mm past both ends, and a centre line across each rounded end.

### Fixed
- The rounded ends of a slot were marked as full circles, because their arcs on the top and bottom faces added up to 360°.

## [1.319.0] - 2026-11-09

### Added

- **Measured values into input boxes (FR-MEA-002)**: drag a length, diameter, radius or angle from the measurement card onto a box in a feature panel or any other number box, and it goes in as if typed. A box that already shows the value's unit gets the bare number; another gets number and unit (say 1.5 in in a millimetre box), which the box reads as an expression. Clicking a value still copies it.

## [1.318.0] - 2026-11-09

### Added

- Motion studies: a **Motion segments** motor profile, like SolidWorks' segments motor. Each row is a segment with its end time, end value and shape (linear, cubic, quintic, harmonic or cycloid), and each segment starts where the last one ended, so a cam-like rise, dwell and return takes three rows (FR-FT-122).

## [1.317.0] - 2026-11-09

### Fixed

- A reference dimension in a sketch follows the geometry: the property panel, equations and drawings showed the value from when it was placed after a driving dimension changed the sketch.
- Midpoint (and other relations between a point and a curve) moves the point, not the curve: a free point given a Midpoint on a line goes to its middle instead of the line and everything on it shifting towards the point.
- Smart Dimension in a sketch takes a model edge clicked at its middle as the edge (it made a midpoint there), so a plate's edges can be dimensioned with one click each.
- The sketch status line at the top of the view no longer swallows clicks on the geometry under it.
- Dragging a mated component that can only turn about an axis (a wheel on a shaft) turns it about that axis; it used to stay put. A drag that leaves every component where it was adds no undo step and doesn't mark the assembly modified.
## [1.316.0] - 2026-11-09

### Added

- **Mouse gestures (FR-UI-024)**: turn them on in Display ▾ → Mouse gestures…, then press the right button in a part or a sketch, drag in a direction and release to run that direction's command. A radial guide around the press point shows the 4 (or 8) commands and lights the one you point at. By default a part offers Top, Right, Front and Normal to (8 directions add Isometric, Sketch, Extrude and Zoom to fit), and a sketch offers Line, Circle, Dimension and Rectangle (plus Arc, Trim, Fillet and Normal to). Every direction's command can be changed. A right-click without a drag still opens the menu, Esc cancels a gesture, and panning moves to the middle button (Ctrl+middle in a sketch) while gestures are on.

## [1.315.0] - 2026-11-09

### Added

- **Unequal leg fillet beads (FR-FT-121).** Fillet Bead gets SolidWorks' **Equal leg lengths** box: untick it to give the bead a **Leg on set 1** and a **Leg on set 2** of their own, for a fillet weld that runs further up a tube than along the plate, say. The weld symbol shows both legs (◺ z6×8), and the cut list groups such welds by both legs.

## [1.314.0] - 2026-11-09

### Added

- **Vent (FR-FT-120)**: Sheet Metal → Vent cuts ventilation openings through a flat face of the sheet from one sketch on it, like SolidWorks' Vent. The largest closed loop is the boundary; lines that end on it are ribs and circles inside it are spars, both kept as material of the width you set (Rib width, Spar width). The openings show in the flattened part and its DXF like any other cut.

## [1.313.0] - 2026-11-09

### Added
- Bolt circles in drawings (FR-DRW-023): holes of one size evenly spaced on a circle (a full or partial circular pattern, or the corners of a square) get a centre-line circle, or an arc over the holes, with a radial mark on each hole and a cross on the pattern centre, in place of separate crosses. Bolt circles in the view panel turns them off.

## [1.312.0] - 2026-11-09

### Added

- Motion studies: a **Data points** motor chooses how its rows are joined, like SolidWorks: **Linear** (as before), **Cubic spline** (a smooth curve through every row) or **Akima** (smooth too, but it keeps flat runs flat next to a step instead of overshooting) (FR-FT-122).

## [1.311.0] - 2026-11-09

### Fixed

- Return to assembly after Open part froze the 3D view when a part feature was still selected: the part's drag-arrow hook ran on every frame without its document and threw. A failing frame hook can no longer stop the view from drawing.
- Centrepoint arc slot: an end click on an existing sketch point now uses that point (it made a new point 0.0004 mm away with no relation).
- Esc in a sketch with nothing left to clear no longer offers to discard a changed sketch (a stray Esc then Enter lost the work); it says how to keep or discard the changes. An unchanged sketch still closes on Esc.
- The sketch origin can be selected with a click (for Midpoint, Coincident or a dimension to it); a drag from it still box-selects.

## [1.310.0] - 2026-11-09

### Added

- **Sketch toggles on the quick access bar (FR-UI-055)**: while sketching, the quick access bar has Grid, Snap to grid and Inferences (automatic relations) buttons next to Quick snaps, so they can be switched without opening the sketch panel. They stay in step with the panel's check boxes and are remembered; turning Snap to grid on also shows the grid.

## [1.309.0] - 2026-11-09

### Added

- **More weldment profiles (FR-FT-121).** The Structural Member library adds UPE parallel flange channels (EN 10365, 80 to 300), HEM heavy H-beams (EN 10365, 100 to 300) and IPN tapered flange I-beams (DIN 1025-1, 80 to 300, 14 % flange slope); cut list items are named UPE, HEM and IPN.

## [1.308.0] - 2026-11-09

### Added

- **Dimensions on section cut faces** (FR-DRW-021): in a section view (straight, offset, half or broken-out, and details of them) Smart dimension, hole callouts, notes and the other annotations can pick the edges of the hatched cut faces, such as the two walls of a cut hole. Each cut edge is named after the model face the plane cuts through, so its dimension follows the part after a rebuild.

## [1.307.0] - 2026-11-09

### Added

- **Cross Break (FR-FT-120)**: Sheet Metal → Cross Break marks flat faces of the sheet with two crossed lines from corner to corner, the shallow stiffening break used on large panels, like SolidWorks' Cross-Break. Click the top or bottom faces, set the break radius and angle, and Reverse direction to raise it the other way. The lines are drawn on the model and on the flattened part, and the flat pattern DXF gets them on a CROSS_BREAK layer; the solid itself stays flat, as in SolidWorks.

## [1.306.0] - 2026-11-09

### Added

- Motion studies: motors get SolidWorks' **Expression** profile. The angle (degrees) or distance (mm) is typed as a formula in `t`, the seconds after the motor start, such as `30*sin(2*pi*t)` (sin and cos take radians). Text that doesn't give a number is refused with the reason (FR-FT-122).

## [1.305.0] - 2026-11-09

### Added

- **Merge miter trimmed bodies (FR-FT-121).** Structural Member adds **Merge miter trimmed bodies**, as in SolidWorks: the members at each mitred corner are fused into one body, so a welded frame of four mitred tubes is one body, listed once in the cut list with the lengths of its segments added up. With a weld gap the mitred ends don't touch and stay separate bodies. The box shows when a corner of the member is mitred.
## [1.304.0] - 2026-11-09

### Added

- **Quick previews of drawing views** (FR-DRW-016): views of a big model (80 edges or more, or once an exact view took longer than 0.4 s) first show a paler preview from OCCT's polygonal hidden-line removal, then the exact lines replace it. On the CAx-IF test parts the preview comes in about 14 times sooner than the exact view (0.1–0.3 s instead of 1.8–4 s). Dimensions, picking and exports always use the exact lines.

## [1.303.0] - 2026-11-09

### Added

- **Sketch grid and Snap to grid (FR-SK-041)**: the sketch panel's new Grid section shows a grid on the sketch plane (every fifth line and the lines through the origin stronger) and can snap points to it. The spacing follows the zoom in 1-2-5 steps unless you type one. With Snap to grid on, a point that snaps to nothing else (no end point, curve or inference) goes to the nearest grid node; a horizontal or vertical inference keeps its line and snaps the other coordinate; hold Ctrl to place freely. Both are off by default and remembered.
- **Alignment inference (FR-SK-042)**: while drawing, a point whose x or y comes within a few pixels of a sketch point's that the cursor passed over (SolidWorks' woken points, the last four) lines up with it exactly, shown by a dotted line from that point, as in SolidWorks. No relation is added. It follows the Horizontal/vertical snap preference, and Ctrl turns it off with the other inferences.

## [1.302.0] - 2026-11-09

### Added

- **Lofted Bend (FR-FT-120)**: Sheet Metal → Lofted Bend joins two open profiles of lines and arcs, each sketched on its own plane, with a sheet of thickness, like SolidWorks' Lofted-Bend with the Bent method. The sheet is made of flat facets with sharp folds between them (Facets per arc sets how finely arcs are split), so it unfolds exactly: Flatten and the flat pattern DXF show the developed outline with every fold as a bend line (up or down), and drawings get the flat pattern view and bend table. Facets lying in one plane stay one face. Typical uses are transitions such as square-to-round ducts and hoppers.

## [1.300.0] - 2026-11-09

### Added

- **Exclude from cut list (FR-FT-121).** Each item in the weldment Cut List dialog has an Exclude box, as in SolidWorks: an excluded item stays in the list, struck through, but gets no item number, adds nothing to the total mass and is left out of the CSV. The Cut list folder in the Features tree marks it as excluded.

## [1.298.0] - 2026-11-09

### Added

- **Fully define sketch (FR-SK-045)**: a Fully define sketch button beside an under-defined sketch's status in the sketch panel, and the same item in the right-click menu on empty space. It adds horizontal/vertical relations to lines within 1° of level or plumb, diameters to circles, radii to arcs, then horizontal and vertical dimensions from the origin to the points, keeping only what removes freedom, until the sketch is fully defined. One undo takes it all back.

## [1.297.0] - 2026-11-09

### Added

- **Centre of mass on drawings**: tick Centre of mass in a view's panel to mark the model's centre of mass with the quartered circle symbol, as SolidWorks' Center of Mass model item does. It follows the model when it changes, and Dimension picks it like a corner, so you can dimension from the centre of mass to an edge or another point. The symbol prints and exports with the sheet.
## [1.296.0] - 2026-11-09

### Added

- **Swept Flange (FR-FT-120)**: Sheet Metal → Swept Flange runs a sketched profile of lines and tangent arcs along the clicked edges of the sheet, like SolidWorks' Swept Flange. Each arc becomes a bend of its own radius (the profile is the outside of the first bend, so an arc on the outside of a bend gives an inner radius of the arc minus the thickness), sharp corners use the bend radius, and flanges on edges meeting at a corner are mitred as in Miter Flange. The flat pattern unrolls every bend.

## [1.295.0] - 2026-11-09

### Added

- **Cut list item material (FR-FT-121).** Each item in the weldment Cut List dialog can have its own material, as in SolidWorks: its mass, the total and the CSV (new Material column) follow that material's density. Items left on Part material use the part's material, as before.

## [1.290.0] - 2026-11-09

### Added

- **Quick snaps (FR-SK-046)**: while drawing in a sketch, pick one snap type for the next point only: End point, Midpoint, Centre point, Quadrant point, Intersection, Tangent, Perpendicular, Parallel, Nearest or Horizontal/vertical. Pick it from the Quick snaps button in the quick access bar or from the right-click menu (Quick snaps ▸). Only that snap works, in a wider radius, and it keeps its relation: a midpoint or crossing gets a midpoint or intersection relation, and a tangent or perpendicular line gets that relation to the curve. The quick snap clears once the point is placed; Esc clears it sooner.
- **Snap preferences**: the sketch panel's Snaps section turns each snap type on or off for automatic snapping, and the choice is remembered. Midpoints, quadrants and intersections can now snap automatically too; they start off.

## [1.286.0] - 2026-11-09

### Added

- Motion studies: **⧉** next to New duplicates the shown study with all its tracks, keys and results, so a variant can be tried without losing the original (SolidWorks: Duplicate on the study tab) (FR-FT-122).

## [1.284.0] - 2026-11-09

### Added

- **Bend table on flat pattern drawing views (FR-FT-120)**: Annotate ▾ → Bend table, click a flat pattern view and place the table. The bend lines get tags A, B, … (top to bottom, then left to right) in place of their notes, and the table lists each bend's direction, angle and inner radius, like SolidWorks' Bend Table. The table follows the model and the interface language.

## [1.282.0] - 2026-11-09

### Added

- **Instant 2D (FR-SK-067)**: a selected driving dimension in a sketch shows a round handle at its moving end. Dragging it changes the value in steps that suit the zoom (Shift: ten times finer), with a ruler of snap ticks along the drag, and the sketch follows as it solves. Releasing is one undo step; Esc during the drag puts the value back. Dimensions given by an equation have no handle.
- **Dimension placement lock (FR-SK-068)**: while placing a dimension, a right-click locks the type it shows (horizontal, vertical or aligned), so the text can be placed anywhere; the preview label turns solid with a lock, and another right-click frees it. Esc still cancels only the placement.

## [1.279.0] - 2026-11-09

### Added

- **Trim/Extend planar trim (FR-FT-121).** Trimming a member against another body now offers SolidWorks' **Planar trim** next to **Body trim**: the member gets a flat end square to its axis where it first meets the body, instead of an end shaped like the body. Weld gap works with it too.

## [1.276.0] - 2026-11-09

### Added

- **Sketch on the drawing sheet**: Line, Rectangle, Circle and Polyline on the Annotation tab (and in Annotate ▾) draw on the sheet itself, as SolidWorks lets you sketch in a drawing. Clicks snap to the model's corners and circle centres in a view, and run horizontal or vertical when close to it; a polyline ends with Enter or closes on its first point. Select an entity to give it an ISO 128 line type (thin, visible, centre, hidden or phantom) or type its length, width and height, or diameter. Entities export to PDF, SVG and DXF on the layer of their line type.
## [1.275.0] - 2026-11-09

### Added

- **Sketch context menu (FR-SK-045)**: a right-click without moving in a sketch opens a menu with Select chain, Construction geometry on/off, the relations that fit the selection, Merge points, Delete, Zoom to selection, Exit sketch and Discard. An item under the cursor that isn't selected becomes the selection first. While drawing, the menu cancels the shape or ends a spline; with the line tool a right-click ends the chain at once, like a double-click.
- Zoom to selection (the view navigation key) frames the selected sketch items while sketching.

## [1.274.0] - 2026-11-09

### Added

- Motion studies: two more motor profiles, as in SolidWorks. **Distance** turns or moves the mate by a set angle or distance between the motor's start and end, starting and stopping smoothly. **Data points** follows rows of time after the motor start and value, typed or pasted from a spreadsheet, in straight lines between them (the motor ends at the last row) (FR-FT-122).

## [1.271.0] - 2026-11-09

### Added

- **Cuts across bends in the flat pattern (FR-FT-120)**: a cut made by an ordinary feature that crosses a bend now shows in the flat pattern and its DXF. The part of the cut inside the bend is unrolled from the bend's neutral surface, so it keeps its true length across the bend strip; before, only the cut's parts on flat faces appeared.

## [1.269.0] - 2026-11-09

### Added

- Motion studies: **SVG** next to CSV in a trace, mate value or proximity result saves its plot as a stand-alone SVG image (titled with the study and the plotted quantity, no playhead line) (FR-FT-122).

## [1.268.0] - 2026-11-09

### Added

- **Trim/Extend weld gap (FR-FT-121).** Trim/Extend gets SolidWorks' **Weld gap**: the trimmed members stop that far short of the face, plane or body they are trimmed to. With End butt the stopping member ends short of the other's side, and an End miter splits the gap between the two ends.

## [1.266.0] - 2026-11-08

### Added

- **Drag to merge (FR-SK-043)**: dragging a sketch point onto another point or the origin joins them with a coincident relation, and onto a curve adds On curve; the glyph by the cursor shows which while you hover the target. Hold Ctrl while releasing to drop the point without a relation.
- **Copy by drag (FR-SK-044)**: Ctrl+drag of selected sketch entities makes copies. Relations and dimensions among the copied entities are copied too; relations to the rest of the sketch are not. A Ctrl+click without moving still deselects.
- **Cursor position while sketching (FR-SK-047)**: the status bar shows the cursor's x, y in sketch coordinates and document units next to the sketch status.

## [1.263.0] - 2026-11-09

### Added

- **Datum targets on drawings (ISO 5459, FR-DRW-023)**: Annotate ▾ Datum target (also on the Annotation tab) marks where a part rests on a datum. Click a point on an edge, then place the frame circle: the lower half shows the target label (A1, A2… after the last datum letter), the upper half the area size. In the panel the target can be a point (a cross), a line (a cross on a phantom line of the length you type) or a hatched area of the diameter you type. The target follows the model like the other annotations and is framed in orange when its edge is gone.
## [1.259.0] - 2026-11-08

### Added

- **Miter flange (FR-FT-120)**: Sheet Metal → **Miter Flange** runs an open profile of lines, sketched on a plane square to an edge and starting at it, along the edges clicked in the view. Each line of the profile becomes a bend and a flat flange, with lengths to the virtual sharps on the profile's side, and flanges on edges that meet at a corner of the face are mitred at every level with the corner gap between them, as in SolidWorks. The flat pattern unfolds them like any other flange.

## [1.256.0] - 2026-11-08

### Added

- Motion studies: **Images** saves every frame of the study at its frame rate as numbered PNG images (up to 1920 px wide) in a ZIP, like SolidWorks' Save Animation as a series of images, for editing in a video program (FR-FT-122).

## [1.253.0] - 2026-11-08

### Added

- **Trim/Extend to a plane (FR-FT-121).** With *Face or plane*, the Trimming boundary's new **Plane** list takes Top, Front, Right or any reference plane above the feature, so members can be cut at, or lengthened up to, a plane that isn't a face of the model, as in SolidWorks. Picking a face again goes back to the face.

## [1.252.0] - 2026-11-08

### Added

- Motion studies: a Proximity result is drawn in the view as a dashed line between the two components' nearest points, moving with the playhead (FR-FT-122).

## [1.251.0] - 2026-11-08

### Added

- **Automatic relations while drawing (FR-SK-052)**: besides horizontal and vertical, a line now snaps perpendicular to the line the chain came from, tangent to the arc it came from, and parallel or perpendicular to a line hovered on the way, and keeps that relation. A glyph by the cursor shows the relation the next click adds (also coincident and on curve). Hold Ctrl to place a point with no snapping or relations, as in SolidWorks; **Automatic relations** in the sketch panel turns them off.
- **Relation glyphs (FR-SK-053)**: hovering a relation glyph lights up the entities it ties, and **Show relations** in the sketch panel hides the glyphs (a relation selected in the list still shows its own).

## [1.250.0] - 2026-11-08

### Added

- **Flat pattern views in drawings (FR-FT-120)**: a sheet metal part's drawing now offers a Flat pattern tile in the View palette, and Flat pattern in a model view's Configuration list. The view shows the unfolded part, with each bend line drawn as a centre line and a bend note along it ("UP 90° R2", in the sheet's language), as SolidWorks does. Either can be turned off in the view's properties.

## [1.248.0] - 2026-11-08

### Added

- Weld symbols on drawings (ISO 2553 system A, FR-DRW-023, SolidWorks' Weld Symbol): Annotation → **Weld symbol** points an arrow at the joint you click (or stands alone) and draws the reference line. The panel sets the arrow-side and other-side welds (fillet, square butt, single V, single bevel, plug, spot) with their size and length, all around, field weld and a tail note; a weld on the other side alone adds the dashed identification line, and a symmetric weld sits across the line. The symbols are drawn from lines, so PDF, SVG and DXF show them the same, and the symbol follows the model like the other annotations.

## [1.247.0] - 2026-11-08

### Added

- **More weldment profiles (FR-FT-121).** Structural Member's library adds EN 10056-1 unequal angles (30x20x3 to 150x100x10, standing on the short leg), EN 10365 HEB beams (100 to 300) and square bars (8 to 60 mm), named L, HEB and SQ in the cut list.
## [1.245.0] - 2026-11-08

### Added

- Motion studies: **Proximity** (in Add track…) plots the smallest distance between two components over the study, or how fast it changes, like SolidWorks' proximity sensor. Pick the two components in its panel; the values save as CSV, and Alert below/above with Stop playback work on it as on the other results (FR-FT-122).

## [1.241.0] - 2026-11-08

### Fixed

- **Offline start picks up new versions behind a CDN.** The page registers its service worker as `sw.js?v=<version>` and asks the browser to skip its HTTP cache for it. aerocat.tech's Cloudflare kept `sw.js` for a day, so visitors got the worker of an older release (1.169.0 while 1.219.0 was deployed), which precached that release's files. Every release now has its own worker URL.

## [1.240.0] - 2026-11-08

### Added

- **Linked sketch offsets (FR-SK-034)**: Offset entities now works as in SolidWorks. By default the copy keeps offset relations to its source and gets one distance dimension, so editing that dimension or moving the source moves the copy with it (turn off **Follow the source** for a static copy, as before). **Both sides** offsets to both sides at once, and for an open chain **Cap ends** closes the two copies with arcs about the source ends or with straight lines. Offsets of arcs and circles are dimensioned as the gap between the concentric curves. The relation glyph is ⇉.

## [1.239.0] - 2026-11-08

### Added

- Motion studies: the Interference panel has a **Stop playback** box. With it ticked, playing pauses at the frame where an interference from the last check starts, as a SolidWorks interference sensor does (FR-FT-122).

## [1.237.0] - 2026-11-08

### Fixed

- Drawing dimensions: one click on an end-on circle made of several arcs (a revolved part's rim) gave a radius such as R15. The fullest edge now wins, so it gives Ø30.
- Drawing dimensions: a circle smaller than the snap distance (a Ø5 rod at 1:1, a Ø12 bore at 1:2) could not be picked, because its centre point or a nearby line end always won. A circle right under the cursor now beats a point that is not, and a first pick on a circle takes the circle even where another edge ends on it (a cross hole's curve on a shaft).
- Text widths on drawings follow the embedded DejaVu Sans. Fit deviations (Ø12H7 +0.018/0) no longer overlap the dimension text or each other, and long title block values shrink to fit their cell or, in the big cells, break into two lines instead of running past the frame.

## [1.236.0] - 2026-11-08

### Added

- **Closed Corner for sheet metal (FR-FT-120)**: a new Closed Corner command on the Sheet Metal tab closes the open corner between two flanges made separately, like SolidWorks' Closed Corner. Click a flange's end face and choose Overlap (it runs over the other flange's end) or Underlap (it stops at the other flange, a gap short of it). The other flange's end moves to meet it, and the flat pattern follows.

## [1.234.0] - 2026-11-08

### Added

- **Pierce relation (FR-SK-051)**: select one sketch point and the relations list offers Pierce, as in SolidWorks. Click a model edge that crosses the sketch plane and the point moves to where the edge pierces the plane, then stays there: when the model changes, the point follows the edge. Straight edges count as infinite lines and arcs as whole circles; when an edge crosses the plane more than once, the point takes the crossing nearest to it. If the edge later disappears or no longer reaches the plane, the relation is marked dangling and can be re-attached to another edge. The relation glyph is ⊕.

## [1.233.0] - 2026-11-08

### Changed

- **Embossed text and other many-region extrudes build several times faster.** The regions of one sketch are now joined in a single boolean operation instead of one after another, and a boss that only stands on the body (its sketch plane is the body's outer face, as with a nameplate's lettering) is glued on without intersecting the faces that lie on each other. The Leuenberger nameplate (a 25-letter emboss, 441 faces) builds in 2.8 s instead of 16 s, with the same faces, names, volume and area. A boss that reaches into the body still takes the full boolean.

## [1.232.0] - 2026-11-08

### Changed

- **Assemblies build on all CPU cores (FR-ARC-016).** WebAssembly runs one thread per instance, so the geometry kernel used to build an assembly's parts one after another on a single core. Opening an assembly now also starts up to 3 helper kernel workers (2 on a 4- or 8-thread CPU; more made builds slower, since every kernel instance competes for the CPU while it starts) that build the distinct parts at the same time, biggest first, while the assembly's own worker takes its share. A helper sends the exact body back as BREP with its named faces, plus its analysed mesh, so measurements, mates, interference and STEP export work as before. Only parts the assembly does not hold yet go to the helpers; editing one part still rebuilds just that part. On a 4-core machine the 23-part Leuenberger valve stage builds its parts in 4.7 s instead of 10.3 s; on a 4-core/8-thread i7 the 34-part engine builds in about 18 s instead of 32 s (one part, the nameplate with its embossed text, takes 15 s of that by itself). Helpers stop after 30 s idle to give their memory back. `?workers=N` sets the number of helpers and `?workers=0` turns it off.

## [1.231.0] - 2026-11-08

### Added

- Motion studies: trace paths and mate value results work as **sensors**, like SolidWorks' motion study sensors. Set **Alert below** and/or **Alert above** on the plotted quantity: the out-of-range times show as orange bands in the result's timeline row and the readout says Out of range; with **Stop playback** ticked, playing stops at the frame where the value goes out of range (FR-FT-122).

## [1.229.0] - 2026-11-08

### Fixed

- The 3D view no longer stays blank after the graphics card resets (a lost WebGL context, which can happen while switching between heavy document tabs). The view and the view cube draw again as soon as the browser gives the context back, with the lighting rebuilt; if it does not come back, a message says to save and reload instead of leaving an empty view with only the X/Y/Z labels.
- A part opened after a STEP file in another tab no longer shows that STEP file's header (protocol, author, CAD system) in Properties.

## [1.226.0] - 2026-11-08

### Added

- Motion studies: explode steps can run **one after another**, as SolidWorks' animation wizard does. With several steps in the exploded view the Explode wizard moves them in turn (Collapse brings them back in reverse); the **Step by step** box on an explode key turns it on or off for that track (FR-FT-122).

## [1.219.0] - 2026-11-08

### Changed

- **✓ and ✕ are always in reach.** The title row of every PropertyManager panel (features, sheet metal, weldments, surfaces, assembly commands) stays pinned at the top while the panel scrolls, so accepting no longer needs a scroll back up. The sketch panel, sketch pattern/move/rotate/scale, Sketch plane and Part properties moved their OK/Cancel (and Exit sketch) from the bottom into that row.
- Confirmation corner (FR-UI-021): the ✓/✕ in the view now sit at the top right, beside the view cube, as in SolidWorks, and assembly commands (Mate, Explode, patterns, Toolbox, Interference, assembly features) get one too. In a sketch pattern the corner applies the pattern instead of leaving the sketch.

## [1.215.0] - 2026-11-08

### Added

- **Spline tangent and Equal curvature (FR-SK-050, FR-SK-051)**: select a spline and a line, arc or another spline that meet at an end, and the relations list offers Tangent and Equal curvature, as in SolidWorks. Tangent turns the spline's end along the other curve; Equal curvature also matches the bend on both sides of the joint (a smooth G2 blend), which suits style splines and conics. Ends joined by a coincident relation count as meeting. The relation glyph is κ.
- **Sketch orientation (FR-SK-002)**: Edit sketch plane has an X axis box. Click it, then click a straight model edge, and the sketch turns so its X axis runs along that edge (projected onto the plane); Reverse X axis turns it round, and Use the plane direction goes back. If the edge later disappears or ends up square to the plane, the sketch keeps the plane's own direction and shows a warning.

## [1.211.0] - 2026-11-08

### Added

- Centrelines and centre marks put in by hand on drawings (FR-DRW-023, SolidWorks' Centerline and Center Mark). Annotation → **Centerline** takes two parallel edges (the line halfway between them, over the length of both) or two points such as hole centres; **Center mark** puts a cross on a circle or an arc seen end-on, so rounded corners and slot ends can be marked too (the automatic marks cover full circles only). Both follow the model when it changes, are drawn on the CENTER layer in every export, and can be selected on their lines to change how far they run past the geometry.

## [1.208.0] - 2026-11-08

### Added

- Drawings of an assembly: a model view can show **one component alone** (view panel → Components), so part details go on the assembly's own drawing. Its projected and section views follow, and its centre marks, smart dimensions and hole callouts use only that component's edges.

### Fixed

- Switching a drawing between first and third angle projection left the views where they were, so the view under the front view silently became a bottom view. Each projected view now stays the same view and moves across its parent, and a projected view dragged across its parent stops on its own side (as in SolidWorks).

## [1.206.0] - 2026-11-08

### Added

- **Break Corner for sheet metal (FR-FT-120)**: a new Break Corner command on the Sheet Metal tab chamfers or rounds outside corners of the sheet through its thickness, like SolidWorks' Break-Corner/Corner-Trim. Click the short edges across the thickness at the corners, pick Chamfer (distance) or Fillet (radius), and the corner is cut in the face's outline, so the flat pattern and its DXF show it too. A flange can then go on the new chamfer edge.

## [1.205.0] - 2026-11-08

### Added

- Motion studies: **Interference** check, as SolidWorks' Results → Interference Detection. It poses every frame of the study and lists the pairs of components that enter one another with the times (click a time to go there), marks those times in red on the ruler and saves the list as CSV. Pairs that already touch at the start, such as a pin in its hole, are left out unless **Treat coincidence as interference** is ticked (FR-FT-122).

## [1.202.0] - 2026-11-08

### Added

- Revision clouds on drawing sheets (Annotation → **Revision cloud**): click the corners of the changed area, then the first corner again or Enter. The cloud takes the last revision letter from the revision table (shown in a triangle), its arc size and letter can be changed in the panel, and it is picked on its outline only, so views inside it stay draggable. It goes into every export like the rest of the sheet.

## [1.200.0] - 2026-11-08

### Added

- Drawing model views of a part with configurations can show another configuration (FR-DRW-010): pick it under **Configuration** in the view panel. Projected, section and detail views made from that view follow it, and dimensions on them measure that configuration.

## [1.199.0] - 2026-11-08

### Added

- Motion studies: **Mate value** results (Add track… → Mate value), as SolidWorks' Results → Plot of a mate. The distance or the angle between a mate's two faces is plotted over the study, or how fast it changes; the angle keeps counting past full turns, so a crank's angle reads 360, 720 and so on. The values save as CSV (FR-FT-122).

## [1.197.0] - 2026-11-08

### Added

- Drawing notes can link to sheet properties (FR-DRW-023): `$PRP:"Material"` (also `$PRPSHEET:`) shows the title block's value, so the note follows the model and the sheet. The Note panel's **Link to property** list inserts one. Unknown names stay as typed.

## [1.196.0] - 2026-11-08

### Fixed

- **↑ and ↓ did nothing in the Top and Bottom views.** Tilting the view from Top or Bottom (to look down a hole, say) silently did nothing, because the tilt axis was taken from the world's up direction, which has no sideways part when looking straight down. They now tilt about the screen's horizontal axis. Turning up from Front also went over the top and back; it now stops at the top, as intended.

## [1.194.0] - 2026-11-08

### Added

- **Mitred edge flange corners (FR-FT-120)**: when an edge flange is put on edges that meet at a corner of the same face, the flanges now run on past the corner and are mitred where they meet, like SolidWorks. A new Corner gap setting, 0.1 mm by default, sets the gap left between them. It works for every flange position and shows in the flat pattern.

## [1.191.0] - 2026-11-08

### Added

- Motion studies: a trace path can be traced **Relative to** another component, as in SolidWorks' Trace Path. The path is then the one seen from that component (the shape a cam or slot would need), drawn moving with it, and its plots and CSV are in that component's coordinates (FR-FT-122).

## [1.190.0] - 2026-11-08

### Added

- **DXF 2000 and single-sheet PDF (FR-DRW-030).** Export ▾ DXF 2000 (this sheet) writes an AutoCAD 2000 (AC1015) file in millimetres with the same layers and line types as the R12 export, polylines as LWPOLYLINE and Cyrillic text as Unicode escapes, for programs that no longer read R12. Export ▾ PDF (this sheet) writes only the sheet you are on.

## [1.189.0] - 2026-11-08

### Fixed

- **Move component lost the turn about X at ±90° about Y.** Typing About X, then About Y = 90 or -90, then About Z rebuilt the placement without the X turn: after each box the panel read the angles back from the placement, and at ±90° about Y that reading folds the X turn into Z and shows X as 0. The panel now keeps the angles you typed while they still give the component's rotation.

## [1.187.0] - 2026-11-08

### Added

- Motion studies: trace path results plot more, as SolidWorks' Results → Plot. Besides the distance, speed and X/Y/Z of the picked point, the plot shows its **Acceleration** and the component's **angle** (how far it has turned since the start, counted on past a full turn, about the axis it turns most about) and **angular speed**. The CSV gains acceleration and angle columns (FR-FT-122).

## [1.184.0] - 2026-11-08

### Added

- **Gusset offset and thickness side (FR-FT-121).** Gusset's location gets an **Offset** (in from the start or end, or from the middle towards the end) and, at a start or end location, the thickness goes on the **Inner side**, **Both sides** or the **Outer side**, as in SolidWorks.

## [1.183.0] - 2026-11-08

### Added

- **Detail view by profile (FR-DRW-013).** Detail ▾ Profile frames a detail view by corners you click on a view (click the first corner again or press Enter to close it) instead of a circle, as SolidWorks' profile detail. The view's lines, hatching and shading are trimmed to the profile, the profile is drawn on the parent with the letter at its top-right corner and around the detail view, and picks inside it work as in a circle detail. Detail ▾ Circle is the circle detail as before.

## [1.181.0] - 2026-11-08

### Added

- **Fit deviations from ISO 286 (FR-DRW-021).** A drawing dimension with a Fit tolerance (H7, g6, js6, K7, P7, s6 and so on) can show the code, its deviations from the ISO 286 tables or both, as SolidWorks does ("Ø16H7 +0.018/0"). The panel lists the limits the code gives at that size; letters D to S (d to s for shafts), grades IT3 to IT14, sizes up to 500 mm. A hole/shaft pair such as H7/g6 shows its code.

## [1.180.0] - 2026-11-08

### Added

- **Edge flange length arrow (FR-FT-120)**: an edge flange shows a drag arrow on the tip of its flange, like the SolidWorks handle. Dragging it changes the flange length with a live preview, and clicking its label lets you type the length. It also works on a flange selected in the Features tree, which applies the change on release. While the flat pattern shows, the arrow is hidden.

## [1.178.0] - 2026-11-08

### Added

- **Aligned section (FR-DRW-012).** Section ▾ Aligned section takes the end of the first leg, the centre and the end of the second leg on a view. The material on the second leg's side is turned about the centre into the first leg's plane before the cut, so spokes and holes on a bolt circle show at their true distance from the centre, as in SolidWorks. The cutting line shows both legs with arrows at each end, and each component keeps its own hatching.

## [1.177.0] - 2026-11-08

### Added

- **End cap thickness direction (FR-FT-121).** End Cap chooses **Outward** (the plate past the end), **Inward** (the overall length stays: the member is cut back by the plate's thickness, its new end face keeps its name) or **Internal** (the plate fits inside a tube's inner outline with a clearance, flush with the end), as in SolidWorks. The thickness arrow follows the plate.

## [1.176.0] - 2026-11-08

### Added

- **End cap corner fillets (FR-FT-121).** End Cap's corner treatment can round the plate's corners (Fillet, with a radius) as well as chamfer them, as in SolidWorks.

### Fixed

- End cap corner treatment only touches sharp corners: on a tube with a rounded outline it no longer chamfers the seams where the flat sides meet the round corners.

## [1.175.0] - 2026-11-08

### Added

- Motion studies: trace paths, as SolidWorks' Results → Trace Path. **Add track… → Trace path…** asks for a click on a moving component; the path of that point over the study is drawn in the view with a marker that follows the playhead. Its row (show/hide, delete) opens a panel that plots the distance from the start, the speed or X/Y/Z against time with the playhead on the plot, shows the position and speed at the playhead and the path length, and saves the points as CSV (time, X, Y, Z, speed) (FR-FT-122).

## [1.174.0] - 2026-11-08

### Fixed

More from modelling the Leuenberger steam engine through the UI:

- Faces the mesh fit misread (a short boss taken for a sphere, a hole cut by a cross hole taken as "other") take the exact cylinder from the B-rep, so they can be measured as cylinders and picked for Concentric mates.
- View keys (arrows, Ctrl+arrows, Z) pressed while a standard view is still turning the camera start from where that move ends, not from the half-way camera.

## [1.173.0] - 2026-11-08

### Added

- **Merge arc segment bodies (FR-FT-121).** Structural Member adds **Merge arc segment bodies**, as in SolidWorks: an arc of the path and the segments that run on tangent from it become one bent body, listed once in the cut list with its whole length along the centreline.

## [1.169.0] - 2026-11-08

### Fixed

- **Russian part names in STEP files** show as Cyrillic in the Model tree and the file info, not as "ÏË31à-ï_÷åðí". Many Russian CAD exports write names as raw Windows-1251 bytes, and OpenCASCADE read them as Latin-1. Names are now decoded again: Windows-1251 when the file's names look Cyrillic (decided once per file, so real Latin-1 names such as "Müller" stay as they are), UTF-8 written through \X\ escapes, and UTF-16 code units written as bytes. The STEP header reader also understands \X4\ and \S\ escapes. Cyrillic text falls back to Noto Sans / DejaVu Sans / Liberation Sans on systems without Segoe UI or Roboto (Linux), for Cyrillic letters only, so Latin text keeps its look.

## [1.168.0] - 2026-11-08

### Added

- **All-around and field weld flags (FR-FT-121).** A fillet bead's panel adds **Weld all around** and **Field weld**: the weld symbol in the view then shows the ISO 2553 circle (○) and the site-weld flag (⚑), as in ○ ⚑ ◺ z4.

## [1.167.0] - 2026-11-08

### Added

- **Perimeter circle (FR-SK-014)**: the Circle ▾ menu adds Perimeter circle, as in SolidWorks. Click three points or curves: the circle passes through the points and touches the lines, circles and arcs you click, with tangent relations, so three sides of a triangle give its inscribed circle (or an outside one, depending on where you click). The preview follows the pointer before the third click.

## [1.166.0] - 2026-11-08

### Added

- **Weld symbols on fillet beads (FR-FT-121).** Every fillet bead shows its weld symbol in the 3D view, in ISO 2553 short form: the fillet triangle, the leg size (z4), and for intermittent welds the weld length, Z when staggered and the pitch in brackets (◺ z4 50 Z (100)). Clicking the symbol opens the bead for editing; **Show weld symbol** in the bead's panel hides it.

## [1.164.0] - 2026-11-08

### Added

- **Style spline (FR-SK-019)**: the Line ▾ menu adds Style spline, as in SolidWorks. Click its control points: the curve starts and ends at the first and last ones and is pulled towards the others without passing through them, with the control polygon drawn while you sketch and when it is selected. Drag a control point to reshape it. The kernel gets the same B-spline (cubic, clamped, uniform knots) as one exact edge, so extrudes, cuts and revolves follow it exactly.

## [1.163.0] - 2026-11-08

### Added

- **Intermittent fillet beads (FR-FT-121).** Fillet Bead gets SolidWorks' Intermittent weld option: welds of a set length every pitch (centre to centre) from the start of each run of edges, following round corners; **Staggered** starts every other run half a pitch on, so welds on two sides of a joint alternate. The cut list lists intermittent and staggered welds as their own rows with the weld length and pitch, and the length is the total weld actually laid.

## [1.161.0] - 2026-11-08

### Added

- **Hole position table**: the Hole panel lists every hole centre with typed X/Y positions. On a face square to a world axis the columns are the two world axes in that face, so typed positions match the drawing.

### Fixed

Found while modelling the Leuenberger steam engine through the UI only:

- Assemblies: placed parts never got exact geometry (their faces lost the face type when moved), so axes and radii came from the mesh and valid mates were refused as "over-defined". Parts now get exact faces again, and a solve that stalls within 1e-5 of the model size (mesh-only components) counts as solved.
- Revolve accepts a profile line lying on the axis as the axis, as SolidWorks does.
- Hole: counterbore, countersink and counterdrill sizes still at their automatic values follow a typed diameter (a Ø3.2 countersink kept the M6 head). Clicking a curved face says "Pick a flat face or a plane: this one is curved."
- Sketcher: a typed line chain ending on the sketch origin joins it; typed sizes place dimensions clear of the geometry; sketch fillets work on construction corners and virtual sharps; tangency at a shared end counts once, so a fully dimensioned slot shows 0 DOF.
- The arrow keys turn the view while a command button has focus (they did nothing after clicking Mate or Insert).

## [1.160.0] - 2026-11-08

### Added

- **Cut list item properties (FR-FT-121).** In the weldment Cut List dialog each item's description, part number and notes can be typed, like SolidWorks' cut list item properties. They are kept with the part (and survive rebuilds while the item stays the same size), rename the item in the Features tree's Cut list folder and go into the CSV as extra columns.

## [1.158.0] - 2026-11-08

### Added

- **Toolbox** (FR-ASM-028): the assembly's Fasteners command is now Toolbox, with standard parts grouped as screws, nuts, washers, pins, keys and bearings. New: countersunk socket screws (ISO 10642), set screws (ISO 4026), thin, nylon insert and flange nuts (ISO 4035, 7040, 4161), small and large washers (ISO 7092, 7093), dowel and spring pins (ISO 2338, 8752), square-ended parallel keys (DIN 6885 B) and deep groove ball bearings (625 to 6306). Every size is a configuration, as before. With Size from the hole on, clicking a hole picks the size that fits it: the largest screw, nut or washer that passes, the pin of that diameter, or the bearing whose outside diameter matches the bore. Countersunk and set screws, pins and bearings go in flush with the face around the hole; the seat is also found past a countersink.
- **McMaster-Carr parts** (FR-ASM-028): the McMaster-Carr button opens their catalogue in a new tab. Download a part's 3-D STEP file there and drop it on the open assembly (dropping parts or STEP/IGES/BREP files on an assembly now inserts them as components). The part number and description come from the file name, and the BOM gets a Vendor column with a link to the product page (also in the CSV). The component menu gets Buy at McMaster-Carr. Nothing is fetched from McMaster-Carr's site, as their terms don't allow it.

## [1.157.0] - 2026-11-08

### Added

- **Conic, parabola and equation driven curve (FR-SK-021)**: the Circle ▾ menu adds Parabola (focus, vertex, then the start and the end) and Conic (start, end, the top vertex where the end tangents meet, then a point that sets rho, shown at the cursor; rho can be changed in the panel). The Line ▾ menu adds Equation driven curve: y = f(x) or x(t), y(t) with a range, typed in the panel, added with fixed ends. Conics reach the kernel as exact rational curves, so their volumes and areas are exact; equation curves follow their two end points when moved, rotated, scaled or mirrored.

## [1.156.0] - 2026-11-08

### Added

- Motion studies: stretch and copy key points by dragging, as in SolidWorks. Alt+drag a key to stretch the timing: several selected keys stretch about the key at the other end of the selection, and a single key stretches the whole study (keys and motors) from 0 so that key lands where you drop it. Keys stop at the study's ends and never pass keys that are not stretched. With several keys selected, the panel's **Time scale** (%) does the same from the keyboard. Ctrl+drag a key, or one of several selected keys, to copy it (them) to the drop point; dashed copies follow the pointer while you drag (FR-FT-122).

## [1.153.0] - 2026-11-08

### Added

- **Trim/Extend End miter and End butt (FR-FT-121).** Trim/Extend has an End miter type, as in SolidWorks: pick a face of one member, then a face of the other. Both are lengthened (or shortened) to where their axes meet and cut on the plane that halves the corner, so two members from separate sketches or features meet in a clean mitre. Members that run parallel are refused with a message. **End butt 1** and **End butt 2** join the same two members square: one stops at the other's side and the other runs on to its far side.

## [1.152.0] - 2026-11-08

### Added

- **3-point rectangles and parallelogram (FR-SK-013)**: the Rectangle ▾ menu adds 3-point corner rectangle (two corners set the first side at any angle, the third click the width), 3-point centre rectangle (centre, middle of a side, then a corner) and Parallelogram (three corners, the fourth follows), all with a live preview and the relations that keep their shape.

## [1.151.0] - 2026-11-08

### Added

- **Cut list folder (FR-FT-121).** A weldment part's Features tree has a Cut list folder under Solid Bodies, as in SolidWorks: one row per cut list item (profile, length and quantity, plates and welds too). Clicking an item highlights its bodies in the view; a double click or the context menu opens the Cut List dialog. Selecting a body in Solid Bodies now highlights it as well.

## [1.150.0] - 2026-11-08

### Added

- Motion studies: select several keys at once, as in SolidWorks. Ctrl+click or Shift+click adds a key to the selection, dragging on an empty part of the tracks draws a box that selects the keys it touches, and Ctrl+A selects every key (Esc clears). Selected keys move together (drag one of them, or Alt+←/→), take an interpolation from the key menu or the panel, delete together, and copy together: keys copied from one track paste onto any track of the same kind at the playhead, keys from several tracks paste back onto their own tracks, keeping their spacing (FR-FT-122).

## [1.147.0] - 2026-11-08

### Added

- **Structural member groups (FR-FT-121).** Each segment in the Structural Member panel has a group list. Segments moved to a new group get their own profile position, rotation angle and mirror, so a frame's rails and posts can face different ways within one feature. Group 1 keeps the settings above.
- **Pick member path segments in the view (FR-FT-121).** While a Structural Member is open, clicking a line or arc of the path sketch (or a face of the member's preview) ticks or unticks that segment, as in SolidWorks; a segment of another sketch starts the selection over with that sketch.

## [1.146.0] - 2026-11-08

### Added

- **Section hatching by material and component** (FR-DRW-012): a section's cut faces are hatched by the material of the part they belong to (ANSI32 steel, ANSI33 brass, bronze and copper, ANSI38 aluminium, ANSI34 plastics and rubber, ANSI37 lead and zinc, ANSI31 anything else), and in an assembly (or a multibody part) neighbouring components are hatched at another angle and spacing so they tell apart. Hatch pattern in the view panel of a section or broken-out section picks one pattern for the whole view instead.

## [1.144.0] - 2026-11-08

### Added

- **Slot tools (FR-SK-017)**: the Slot ▾ menu now has Centerpoint straight slot (centre, one end, width), Centerpoint arc slot (arc centre, start, end, width) and 3-point arc slot (start, end, a point on the arc, width) next to the straight slot, all with a live preview. Every slot gets its width and its length (straight) or centre-line radius (arc) as dimensions, and the Modify box opens on them in turn; Add dimensions in the panel turns that off.

### Fixed

- **Sketch solver**: two arcs joined end to end and tangent there were counted as unconstrained, so such sketches showed too many degrees of freedom; the rank test is also less sensitive to rounding, so redundant relations no longer read as fully defining.

## [1.143.0] - 2026-11-08

### Added

- **Sweep end tangency (FR-FT-080)**: next to Start tangency, End tangency "Path tangent" ends a sweep with the profile square to the path. With Keep normal constant the profile turns gradually from its sketch plane at the start to square at the end. Not with a guide curve or a closed path.

## [1.142.0] - 2026-11-08

### Added

- **Text along a curve (FR-SK-020)**: a selected sketch text can follow a line, arc, circle, spline or ellipse of the sketch (Along curve in the text panel), starting where its start point is nearest. Flip side runs it the other way, so text round a circle stands on top instead of hanging inside. The letters stay closed regions for Extrude and Cut.

## [1.141.0] - 2026-11-08

### Added

- **Geometry pattern option (FR-FT-074)**: linear, circular, sketch/table driven patterns and mirror of features have a Geometry pattern box. On (the default) copies the seed's shape as before; off rebuilds each extrude or revolve where the instance lands, so end conditions such as up to face hold at every instance.

## [1.140.0] - 2026-11-08

### Fixed

- **Assembly stuck on "Rebuilding…"**: switching to another document tab while an assembly was still rebuilding (the first build takes a few seconds while the geometry kernel starts) left the assembly waiting for ever once you came back, so inserting more components did nothing. Parking a document now ends its kernel work cleanly, and the assembly builds again when shown. The same fix covers parts parked mid-rebuild.
- A new part no longer takes the name of a part already open in another tab (two empty parts were both Part1).

### Added

- **Modify box** (FR-UI-114): placing or double-clicking a sketch dimension opens a small box next to it with the dimension name, the value (expressions allowed), spin arrows, ✓, ✕ and ⟲ Rebuild, as in SolidWorks. The sketch follows the value as you type; Enter or ✓ keeps it, Esc or ✕ puts the old value back. ↑/↓ and the mouse wheel step the value (Shift ×10, Alt ×0.1).
- **Feature dimensions on the model** (FR-UI-115): double-click a face to show the dimensions of the feature that made it (its sketch dimensions and extrude depth) on the model. Click one to change it in the Modify box: ⟲ rebuilds with the typed value, ✓ keeps it as one undo step, ✕ goes back. Esc or a click elsewhere hides them.
- **Resizable panels** (FR-UI-002): drag the inner edge of the left and right panels, the drawing side panel or the top of the motion study timeline to resize them; the sizes are remembered, a double-click on the edge restores the default, and the edge also works from the keyboard (arrow keys). Dialogs resize from their corner and open at the size you left them.

## [1.139.0] - 2026-11-08

### Added

- **Section at the sketch plane (FR-SK-006)**: the sketch bar's Section button cuts the model at the sketch plane while you sketch, hiding the material in front of it. It stays on for later sketches until turned off, and the cut goes away when you leave the sketch.
- **Configuration table (FR-CFG-003)**: the Configurations panel exports every configuration as a CSV table, one row per configuration and one column per value: dimensions and feature values (mm, degrees or expressions), pattern counts, suppression (S/U), variables and material. Importing a table (comma or semicolon separated) updates the configurations it names and adds new ones, as one undo step.

## [1.138.0] - 2026-11-08

### Added

- **Cuts in the sheet metal flat pattern (FR-FT-120)**: holes and cuts that ordinary features (extrude cuts, holes) make in the flat faces of a sheet metal part now show in the flat pattern. The material each feature took out of a face is moved onto the pattern with that face, so a hole in a flange lands where the flange lies when unfolded. The flat pattern DXF then takes its outline from the pattern itself, holes included (circles and arcs stay exact). Exported while folded, the DXF has the sheet outline only and says to flatten first. Cuts across a bend aren't unrolled yet.

## [1.137.0] - 2026-11-08

### Added

- **Sketch text (FR-SK-020)**: the Text tool (sketch Point ▾ menu) places text from the bundled DejaVu fonts (sans, serif, monospace, bold and italic) at a capital-letter height. Its letters are closed regions, so Extrude embosses them and Cut engraves them. Select a text to change its words, font, height or angle; drag, dimension or relate its start point like any other point.

## [1.135.0] - 2026-11-08

### Added

- **Edit in context (FR-ASM-030)**: right-click a component and choose Edit in context. Its part opens with the rest of the assembly shown see-through around it.
  - A sketch on a flat face of another component is an external reference, marked -> in the Features tree.
  - Back in the assembly, the sketch follows that face whenever the components move or change.
  - External References (Features → Plane ▾) lists each one with its state: in context, out of context (->?) or locked (->*). You can lock them one by one or all at once.

## [1.134.0] - 2026-11-08

### Added

- **Setback fillets (FR-FT-033)**: an edge fillet's Setback parameters take corners where three or more filleted edges meet. At each one the fillets stop a setback distance from the corner and one smooth patch, tangent to the faces around it, blends the corner instead of the rolling-ball corner. Each corner has its own distance.

## [1.133.0] - 2026-11-08

### Added

- Sheet metal, first slice of FRS P6 (FR-FT-120), on a new **Sheet Metal** tab of the part's command bar:
  - **Base Flange/Tab**: a closed sketch becomes a flat plate; an open chain of lines becomes a bent flange of a given depth, with bends at the corners.
  - Sheet metal parameters on the base flange: thickness, bend radius, K-factor, bend allowance or bend deduction, rectangular bend relief and its ratio, and gauge tables (mild steel, stainless steel, aluminium) that fill in thickness, radius and K-factor.
  - **Edge Flange** on straight edges picked in the view, with a live preview: angle, length to the outer or inner virtual sharp, material inside / material outside / bend outside, a custom bend radius, and offsets from the edge ends (bend reliefs are cut automatically).
  - **Hem**: closed or open (with a gap), material inside or outside.
  - **Flatten** shows the flat pattern on the plane of the base flange, with up and down bend lines; click again to fold it back. The flat pattern is exact: every bend takes its bend allowance.
  - **Flat pattern DXF**: the outline and the bend lines (layers OUTLINE, BEND_UP, BEND_DOWN) as DXF R12 in millimetres.
  - **Sketched Bend**: a line sketched on a flat face folds the face along it: angle, bend centerline / bend starts at the line / bend ends at it, which side folds, direction and a custom radius. The flat pattern keeps the face's size.
  - **Tab**: on a part with a base flange, Base Flange/Tab turns a closed sketch drawn beside a flat face (touching its edge) into a tab of the sheet's thickness that joins the flat pattern.
  - **Jog**: two opposite bends along a sketched line offset the rest of the face, by an outside, inside or face-to-face distance at any angle.

## [1.131.0] - 2026-11-08

### Added

- **Loft connectors (FR-FT-082)**: the Loft panel has a Connectors group with a start point per profile. The loft joins the picked points, so matching corners stop a loft from twisting and a corner further round twists it on purpose. Automatic keeps the old behaviour. This completes the loft options of FR-FT-082.

## [1.129.0] - 2026-11-08

### Added

- **Document tabs** (FR-DOC-003, FR-UI-120): every part, assembly, drawing and model file you open or make gets a tab at the bottom of the window, as in SolidWorks.
  - A click switches documents; each keeps its undo history.
  - A drawing's tab shows the sheet over the model it was made from, and the model's tab takes you back to it.
  - ✕ or a middle click closes a tab and asks first when it has unsaved changes.
  - New drawing on a model whose drawing is already open goes to that drawing's tab.
- **Insert component from open documents**: in an assembly, Insert component lists the parts open in other tabs, then Browse….
- **Make assembly from part** keeps the part open in its own tab.

## [1.126.0] - 2026-11-08

### Added

- **Check-Heal feature (FR-FT-131)** in Features → Bodies ▾: checks every body and heals it in the feature tree. Faces whose edges are closer than the tolerance are sewn, faulty faces are fixed with ShapeFix and closed shells become solids; Merge faces that lie on one surface joins faces split by earlier features. The panel reports free edges, validity and solid bodies before and after, and faces keep their names, so later features stay attached.

## [1.125.0] - 2026-11-08

### Added

- Motion studies: zoom the timeline in and out (⊕ / ⊖, the + and − keys, or Ctrl+wheel about the pointer) to place keys a frame apart in long studies, and ⤢ fits the whole study again, as SolidWorks' timeline zoom buttons do. The ruler ticks follow the zoom, and the zoomed timeline scrolls to keep the playhead in view while it plays (FR-FT-122).

## [1.122.0] - 2026-11-08

### Added

- **Shaded drawing views** (FR-DRW-010): a view's Display style can be Shaded (grey faces, no lines) or Shaded with edges (grey faces under the visible edges), lit from over the viewer's left shoulder. Detail, crop and break views follow it. PDF, SVG, PNG and print show the shading; DXF keeps the lines only. Section views stay line drawings.

## [1.121.0] - 2026-11-08

### Added

- **Command bar** (FRS 13.2, FR-UI-010 to FR-UI-013, FR-UI-117 to FR-UI-119): one tabbed bar under the header holds every 3D command, as in SolidWorks' CommandManager.
  - A part shows the tabs **Features**, **Sketch**, **Surfaces**, **Weldments** and **Evaluate**. An assembly shows **Assembly** and **Evaluate**. A plain model shows **Evaluate**.
  - The measuring tools, which had their own row in the header, are now on the **Evaluate** tab.
  - Undo ▾, Redo, Save ▾ and STEP sit at the right end of the tab strip.
  - Entering a sketch switches to the Sketch tab; leaving it goes back to Features.
  - The bar switches to icons only when it is too narrow, and the arrow keys move between tabs.
- **Make assembly from part** (New ▾): a new assembly with the open part as its first component, fixed at the origin, including unsaved changes.
- **Ctrl+K command search** (FR-UI-014): type part of a command's name and press Enter to run it.
- **Check sketch for feature** (FR-SK-073): the sketch panel checks the sketch for an extrude, revolve, loft or sweep profile, sweep path or rib, and points at open ends, overlaps, crossings and zero-length lines.
- **Sizes typed while drawing**: while you draw a line, rectangle or circle, typing a number opens length or size boxes; Enter places the shape with driving dimensions.

### Changed

- The right panel's tabs (Measurements, Section, Display, Properties) moved from the header to the top of the right panel.
- The part and assembly status lines keep their place below the view; the filter bar no longer shifts the view.

## [1.120.0] - 2026-11-08

### Added

- **Curved structural members (FR-FT-121).** Arcs in a Structural Member's path sketch now make bent members: the profile is revolved along the arc, and the cut list gives the arc length. Where a line runs on smoothly from an arc nothing is cut. At a sharp corner the line runs through the arc, and two arcs meet in a mitre. The segment list and the Corners group show arcs as "Arc n" and lines as "Line n".

## [1.119.0] - 2026-11-08

### Added

- **Loft guide curves (FR-FT-082).** The Loft panel has a Guide curves group: pick open sketches or curves that touch every profile, and the loft's sections grow and shrink to pass through them, like SolidWorks. One guide scales the sections evenly; two or more stretch them towards each guide, so two guides on the sides of a rectangle widen it without making it taller. A guide that misses a profile is reported.

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

[Unreleased]: https://github.com/kothf/step-viewer/compare/v1.510.0...HEAD
[1.510.0]: https://github.com/kothf/step-viewer/compare/v1.509.0...v1.510.0
[1.509.0]: https://github.com/kothf/step-viewer/compare/v1.508.0...v1.509.0
[1.508.0]: https://github.com/kothf/step-viewer/compare/v1.507.0...v1.508.0
[1.507.0]: https://github.com/kothf/step-viewer/compare/v1.506.0...v1.507.0
[1.506.0]: https://github.com/kothf/step-viewer/compare/v1.505.0...v1.506.0
[1.505.0]: https://github.com/kothf/step-viewer/compare/v1.504.0...v1.505.0
[1.504.0]: https://github.com/kothf/step-viewer/compare/v1.503.0...v1.504.0
[1.503.0]: https://github.com/kothf/step-viewer/compare/v1.502.0...v1.503.0
[1.502.0]: https://github.com/kothf/step-viewer/compare/v1.501.0...v1.502.0
[1.501.0]: https://github.com/kothf/step-viewer/compare/v1.500.0...v1.501.0
[1.500.0]: https://github.com/kothf/step-viewer/compare/v1.499.0...v1.500.0
[1.499.0]: https://github.com/kothf/step-viewer/compare/v1.498.0...v1.499.0
[1.498.0]: https://github.com/kothf/step-viewer/compare/v1.497.0...v1.498.0
[1.497.0]: https://github.com/kothf/step-viewer/compare/v1.496.0...v1.497.0
[1.496.0]: https://github.com/kothf/step-viewer/compare/v1.495.0...v1.496.0
[1.495.0]: https://github.com/kothf/step-viewer/compare/v1.494.0...v1.495.0
[1.494.0]: https://github.com/kothf/step-viewer/compare/v1.493.0...v1.494.0
[1.493.0]: https://github.com/kothf/step-viewer/compare/v1.492.0...v1.493.0
[1.492.0]: https://github.com/kothf/step-viewer/compare/v1.491.0...v1.492.0
[1.491.0]: https://github.com/kothf/step-viewer/compare/v1.490.0...v1.491.0
[1.490.0]: https://github.com/kothf/step-viewer/compare/v1.489.0...v1.490.0
[1.489.0]: https://github.com/kothf/step-viewer/compare/v1.488.0...v1.489.0
[1.488.0]: https://github.com/kothf/step-viewer/compare/v1.487.0...v1.488.0
[1.487.0]: https://github.com/kothf/step-viewer/compare/v1.486.0...v1.487.0
[1.486.0]: https://github.com/kothf/step-viewer/compare/v1.485.0...v1.486.0
[1.485.0]: https://github.com/kothf/step-viewer/compare/v1.484.0...v1.485.0
[1.484.0]: https://github.com/kothf/step-viewer/compare/v1.483.0...v1.484.0
[1.483.0]: https://github.com/kothf/step-viewer/compare/v1.482.0...v1.483.0
[1.482.0]: https://github.com/kothf/step-viewer/compare/v1.481.0...v1.482.0
[1.481.0]: https://github.com/kothf/step-viewer/compare/v1.480.0...v1.481.0
[1.480.0]: https://github.com/kothf/step-viewer/compare/v1.479.0...v1.480.0
[1.479.0]: https://github.com/kothf/step-viewer/compare/v1.478.0...v1.479.0
[1.478.0]: https://github.com/kothf/step-viewer/compare/v1.477.0...v1.478.0
[1.477.0]: https://github.com/kothf/step-viewer/compare/v1.476.0...v1.477.0
[1.476.0]: https://github.com/kothf/step-viewer/compare/v1.475.0...v1.476.0
[1.475.0]: https://github.com/kothf/step-viewer/compare/v1.474.0...v1.475.0
[1.474.0]: https://github.com/kothf/step-viewer/compare/v1.473.0...v1.474.0
[1.473.0]: https://github.com/kothf/step-viewer/compare/v1.472.0...v1.473.0
[1.472.0]: https://github.com/kothf/step-viewer/compare/v1.471.0...v1.472.0
[1.471.0]: https://github.com/kothf/step-viewer/compare/v1.470.0...v1.471.0
[1.470.0]: https://github.com/kothf/step-viewer/compare/v1.469.0...v1.470.0
[1.469.0]: https://github.com/kothf/step-viewer/compare/v1.468.0...v1.469.0
[1.468.0]: https://github.com/kothf/step-viewer/compare/v1.467.0...v1.468.0
[1.467.0]: https://github.com/kothf/step-viewer/compare/v1.466.0...v1.467.0
[1.466.0]: https://github.com/kothf/step-viewer/compare/v1.465.0...v1.466.0
[1.465.0]: https://github.com/kothf/step-viewer/compare/v1.464.0...v1.465.0
[1.464.0]: https://github.com/kothf/step-viewer/compare/v1.463.0...v1.464.0
[1.463.0]: https://github.com/kothf/step-viewer/compare/v1.462.0...v1.463.0
[1.462.0]: https://github.com/kothf/step-viewer/compare/v1.461.0...v1.462.0
[1.461.0]: https://github.com/kothf/step-viewer/compare/v1.460.0...v1.461.0
[1.460.0]: https://github.com/kothf/step-viewer/compare/v1.459.0...v1.460.0
[1.459.0]: https://github.com/kothf/step-viewer/compare/v1.458.0...v1.459.0
[1.458.0]: https://github.com/kothf/step-viewer/compare/v1.457.0...v1.458.0
[1.457.0]: https://github.com/kothf/step-viewer/compare/v1.456.0...v1.457.0
[1.456.0]: https://github.com/kothf/step-viewer/compare/v1.455.0...v1.456.0
[1.455.0]: https://github.com/kothf/step-viewer/compare/v1.454.0...v1.455.0
[1.454.0]: https://github.com/kothf/step-viewer/compare/v1.453.0...v1.454.0
[1.453.0]: https://github.com/kothf/step-viewer/compare/v1.452.0...v1.453.0
[1.452.0]: https://github.com/kothf/step-viewer/compare/v1.451.0...v1.452.0
[1.451.0]: https://github.com/kothf/step-viewer/compare/v1.450.0...v1.451.0
[1.450.0]: https://github.com/kothf/step-viewer/compare/v1.449.0...v1.450.0
[1.449.0]: https://github.com/kothf/step-viewer/compare/v1.448.0...v1.449.0
[1.448.0]: https://github.com/kothf/step-viewer/compare/v1.447.0...v1.448.0
[1.447.0]: https://github.com/kothf/step-viewer/compare/v1.446.0...v1.447.0
[1.446.0]: https://github.com/kothf/step-viewer/compare/v1.445.0...v1.446.0
[1.445.0]: https://github.com/kothf/step-viewer/compare/v1.444.0...v1.445.0
[1.444.0]: https://github.com/kothf/step-viewer/compare/v1.443.0...v1.444.0
[1.443.0]: https://github.com/kothf/step-viewer/compare/v1.442.0...v1.443.0
[1.442.0]: https://github.com/kothf/step-viewer/compare/v1.441.0...v1.442.0
[1.441.0]: https://github.com/kothf/step-viewer/compare/v1.440.0...v1.441.0
[1.440.0]: https://github.com/kothf/step-viewer/compare/v1.439.0...v1.440.0
[1.439.0]: https://github.com/kothf/step-viewer/compare/v1.438.0...v1.439.0
[1.438.0]: https://github.com/kothf/step-viewer/compare/v1.437.0...v1.438.0
[1.437.0]: https://github.com/kothf/step-viewer/compare/v1.436.0...v1.437.0
[1.436.0]: https://github.com/kothf/step-viewer/compare/v1.435.0...v1.436.0
[1.435.0]: https://github.com/kothf/step-viewer/compare/v1.434.0...v1.435.0
[1.434.0]: https://github.com/kothf/step-viewer/compare/v1.433.0...v1.434.0
[1.433.0]: https://github.com/kothf/step-viewer/compare/v1.432.0...v1.433.0
[1.432.0]: https://github.com/kothf/step-viewer/compare/v1.431.0...v1.432.0
[1.431.0]: https://github.com/kothf/step-viewer/compare/v1.430.0...v1.431.0
[1.430.0]: https://github.com/kothf/step-viewer/compare/v1.429.0...v1.430.0
[1.429.0]: https://github.com/kothf/step-viewer/compare/v1.428.0...v1.429.0
[1.428.0]: https://github.com/kothf/step-viewer/compare/v1.427.0...v1.428.0
[1.427.0]: https://github.com/kothf/step-viewer/compare/v1.426.0...v1.427.0
[1.426.0]: https://github.com/kothf/step-viewer/compare/v1.425.0...v1.426.0
[1.425.0]: https://github.com/kothf/step-viewer/compare/v1.424.0...v1.425.0
[1.424.0]: https://github.com/kothf/step-viewer/compare/v1.423.0...v1.424.0
[1.423.0]: https://github.com/kothf/step-viewer/compare/v1.422.0...v1.423.0
[1.422.0]: https://github.com/kothf/step-viewer/compare/v1.421.0...v1.422.0
[1.421.0]: https://github.com/kothf/step-viewer/compare/v1.420.0...v1.421.0
[1.420.0]: https://github.com/kothf/step-viewer/compare/v1.419.0...v1.420.0
[1.419.0]: https://github.com/kothf/step-viewer/compare/v1.418.0...v1.419.0
[1.418.0]: https://github.com/kothf/step-viewer/compare/v1.417.0...v1.418.0
[1.417.0]: https://github.com/kothf/step-viewer/compare/v1.416.0...v1.417.0
[1.416.0]: https://github.com/kothf/step-viewer/compare/v1.415.0...v1.416.0
[1.415.0]: https://github.com/kothf/step-viewer/compare/v1.414.0...v1.415.0
[1.414.0]: https://github.com/kothf/step-viewer/compare/v1.413.0...v1.414.0
[1.413.0]: https://github.com/kothf/step-viewer/compare/v1.412.0...v1.413.0
[1.412.0]: https://github.com/kothf/step-viewer/compare/v1.411.0...v1.412.0
[1.411.0]: https://github.com/kothf/step-viewer/compare/v1.410.0...v1.411.0
[1.410.0]: https://github.com/kothf/step-viewer/compare/v1.409.0...v1.410.0
[1.409.0]: https://github.com/kothf/step-viewer/compare/v1.408.0...v1.409.0
[1.408.0]: https://github.com/kothf/step-viewer/compare/v1.407.0...v1.408.0
[1.407.0]: https://github.com/kothf/step-viewer/compare/v1.406.0...v1.407.0
[1.406.0]: https://github.com/kothf/step-viewer/compare/v1.405.0...v1.406.0
[1.405.0]: https://github.com/kothf/step-viewer/compare/v1.404.0...v1.405.0
[1.404.0]: https://github.com/kothf/step-viewer/compare/v1.403.0...v1.404.0
[1.403.0]: https://github.com/kothf/step-viewer/compare/v1.402.0...v1.403.0
[1.402.0]: https://github.com/kothf/step-viewer/compare/v1.401.0...v1.402.0
[1.401.0]: https://github.com/kothf/step-viewer/compare/v1.400.0...v1.401.0
[1.400.0]: https://github.com/kothf/step-viewer/compare/v1.399.0...v1.400.0
[1.399.0]: https://github.com/kothf/step-viewer/compare/v1.398.0...v1.399.0
[1.398.0]: https://github.com/kothf/step-viewer/compare/v1.397.0...v1.398.0
[1.397.0]: https://github.com/kothf/step-viewer/compare/v1.396.0...v1.397.0
[1.396.0]: https://github.com/kothf/step-viewer/compare/v1.395.0...v1.396.0
[1.395.0]: https://github.com/kothf/step-viewer/compare/v1.394.0...v1.395.0
[1.394.0]: https://github.com/kothf/step-viewer/compare/v1.393.0...v1.394.0
[1.393.0]: https://github.com/kothf/step-viewer/compare/v1.392.0...v1.393.0
[1.392.0]: https://github.com/kothf/step-viewer/compare/v1.391.0...v1.392.0
[1.391.0]: https://github.com/kothf/step-viewer/compare/v1.390.0...v1.391.0
[1.390.0]: https://github.com/kothf/step-viewer/compare/v1.389.0...v1.390.0
[1.389.0]: https://github.com/kothf/step-viewer/compare/v1.388.0...v1.389.0
[1.388.0]: https://github.com/kothf/step-viewer/compare/v1.387.0...v1.388.0
[1.387.0]: https://github.com/kothf/step-viewer/compare/v1.386.0...v1.387.0
[1.386.0]: https://github.com/kothf/step-viewer/compare/v1.385.0...v1.386.0
[1.385.0]: https://github.com/kothf/step-viewer/compare/v1.384.0...v1.385.0
[1.384.0]: https://github.com/kothf/step-viewer/compare/v1.383.0...v1.384.0
[1.383.0]: https://github.com/kothf/step-viewer/compare/v1.382.0...v1.383.0
[1.382.0]: https://github.com/kothf/step-viewer/compare/v1.381.0...v1.382.0
[1.381.0]: https://github.com/kothf/step-viewer/compare/v1.380.0...v1.381.0
[1.380.0]: https://github.com/kothf/step-viewer/compare/v1.379.0...v1.380.0
[1.379.0]: https://github.com/kothf/step-viewer/compare/v1.378.0...v1.379.0
[1.378.0]: https://github.com/kothf/step-viewer/compare/v1.377.0...v1.378.0
[1.377.0]: https://github.com/kothf/step-viewer/compare/v1.376.0...v1.377.0
[1.376.0]: https://github.com/kothf/step-viewer/compare/v1.375.0...v1.376.0
[1.375.0]: https://github.com/kothf/step-viewer/compare/v1.374.0...v1.375.0
[1.374.0]: https://github.com/kothf/step-viewer/compare/v1.373.0...v1.374.0
[1.373.0]: https://github.com/kothf/step-viewer/compare/v1.372.0...v1.373.0
[1.372.0]: https://github.com/kothf/step-viewer/compare/v1.371.0...v1.372.0
[1.371.0]: https://github.com/kothf/step-viewer/compare/v1.365.0...v1.371.0
[1.365.0]: https://github.com/kothf/step-viewer/compare/v1.363.0...v1.365.0
[1.363.0]: https://github.com/kothf/step-viewer/compare/v1.357.0...v1.363.0
[1.357.0]: https://github.com/kothf/step-viewer/compare/v1.356.0...v1.357.0
[1.356.0]: https://github.com/kothf/step-viewer/compare/v1.355.0...v1.356.0
[1.355.0]: https://github.com/kothf/step-viewer/compare/v1.354.0...v1.355.0
[1.354.0]: https://github.com/kothf/step-viewer/compare/v1.353.0...v1.354.0
[1.353.0]: https://github.com/kothf/step-viewer/compare/v1.352.0...v1.353.0
[1.352.0]: https://github.com/kothf/step-viewer/compare/v1.351.0...v1.352.0
[1.351.0]: https://github.com/kothf/step-viewer/compare/v1.350.0...v1.351.0
[1.350.0]: https://github.com/kothf/step-viewer/compare/v1.349.0...v1.350.0
[1.349.0]: https://github.com/kothf/step-viewer/compare/v1.348.0...v1.349.0
[1.348.0]: https://github.com/kothf/step-viewer/compare/v1.346.0...v1.348.0
[1.346.0]: https://github.com/kothf/step-viewer/compare/v1.344.0...v1.346.0
[1.344.0]: https://github.com/kothf/step-viewer/compare/v1.343.0...v1.344.0
[1.343.0]: https://github.com/kothf/step-viewer/compare/v1.342.0...v1.343.0
[1.342.0]: https://github.com/kothf/step-viewer/compare/v1.341.0...v1.342.0
[1.341.0]: https://github.com/kothf/step-viewer/compare/v1.340.0...v1.341.0
[1.340.0]: https://github.com/kothf/step-viewer/compare/v1.339.0...v1.340.0
[1.339.0]: https://github.com/kothf/step-viewer/compare/v1.338.0...v1.339.0
[1.338.0]: https://github.com/kothf/step-viewer/compare/v1.337.0...v1.338.0
[1.337.0]: https://github.com/kothf/step-viewer/compare/v1.336.0...v1.337.0
[1.336.0]: https://github.com/kothf/step-viewer/compare/v1.335.0...v1.336.0
[1.335.0]: https://github.com/kothf/step-viewer/compare/v1.334.0...v1.335.0
[1.334.0]: https://github.com/kothf/step-viewer/compare/v1.333.0...v1.334.0
[1.333.0]: https://github.com/kothf/step-viewer/compare/v1.332.0...v1.333.0
[1.332.0]: https://github.com/kothf/step-viewer/compare/v1.331.0...v1.332.0
[1.331.0]: https://github.com/kothf/step-viewer/compare/v1.330.0...v1.331.0
[1.330.0]: https://github.com/kothf/step-viewer/compare/v1.329.0...v1.330.0
[1.329.0]: https://github.com/kothf/step-viewer/compare/v1.328.0...v1.329.0
[1.328.0]: https://github.com/kothf/step-viewer/compare/v1.327.0...v1.328.0
[1.327.0]: https://github.com/kothf/step-viewer/compare/v1.326.0...v1.327.0
[1.326.0]: https://github.com/kothf/step-viewer/compare/v1.325.0...v1.326.0
[1.325.0]: https://github.com/kothf/step-viewer/compare/v1.324.0...v1.325.0
[1.324.0]: https://github.com/kothf/step-viewer/compare/v1.323.0...v1.324.0
[1.323.0]: https://github.com/kothf/step-viewer/compare/v1.322.0...v1.323.0
[1.322.0]: https://github.com/kothf/step-viewer/compare/v1.321.0...v1.322.0
[1.321.0]: https://github.com/kothf/step-viewer/compare/v1.320.0...v1.321.0
[1.320.0]: https://github.com/kothf/step-viewer/compare/v1.319.0...v1.320.0
[1.319.0]: https://github.com/kothf/step-viewer/compare/v1.318.0...v1.319.0
[1.318.0]: https://github.com/kothf/step-viewer/compare/v1.317.0...v1.318.0
[1.317.0]: https://github.com/kothf/step-viewer/compare/v1.316.0...v1.317.0
[1.316.0]: https://github.com/kothf/step-viewer/compare/v1.315.0...v1.316.0
[1.315.0]: https://github.com/kothf/step-viewer/compare/v1.314.0...v1.315.0
[1.314.0]: https://github.com/kothf/step-viewer/compare/v1.313.0...v1.314.0
[1.313.0]: https://github.com/kothf/step-viewer/compare/v1.312.0...v1.313.0
[1.312.0]: https://github.com/kothf/step-viewer/compare/v1.311.0...v1.312.0
[1.311.0]: https://github.com/kothf/step-viewer/compare/v1.310.0...v1.311.0
[1.310.0]: https://github.com/kothf/step-viewer/compare/v1.309.0...v1.310.0
[1.309.0]: https://github.com/kothf/step-viewer/compare/v1.308.0...v1.309.0
[1.308.0]: https://github.com/kothf/step-viewer/compare/v1.307.0...v1.308.0
[1.307.0]: https://github.com/kothf/step-viewer/compare/v1.306.0...v1.307.0
[1.306.0]: https://github.com/kothf/step-viewer/compare/v1.305.0...v1.306.0
[1.305.0]: https://github.com/kothf/step-viewer/compare/v1.304.0...v1.305.0
[1.304.0]: https://github.com/kothf/step-viewer/compare/v1.303.0...v1.304.0
[1.303.0]: https://github.com/kothf/step-viewer/compare/v1.302.0...v1.303.0
[1.302.0]: https://github.com/kothf/step-viewer/compare/v1.300.0...v1.302.0
[1.300.0]: https://github.com/kothf/step-viewer/compare/v1.298.0...v1.300.0
[1.298.0]: https://github.com/kothf/step-viewer/compare/v1.297.0...v1.298.0
[1.297.0]: https://github.com/kothf/step-viewer/compare/v1.296.0...v1.297.0
[1.296.0]: https://github.com/kothf/step-viewer/compare/v1.295.0...v1.296.0
[1.295.0]: https://github.com/kothf/step-viewer/compare/v1.290.0...v1.295.0
[1.290.0]: https://github.com/kothf/step-viewer/compare/v1.286.0...v1.290.0
[1.286.0]: https://github.com/kothf/step-viewer/compare/v1.284.0...v1.286.0
[1.284.0]: https://github.com/kothf/step-viewer/compare/v1.282.0...v1.284.0
[1.282.0]: https://github.com/kothf/step-viewer/compare/v1.279.0...v1.282.0
[1.279.0]: https://github.com/kothf/step-viewer/compare/v1.276.0...v1.279.0
[1.276.0]: https://github.com/kothf/step-viewer/compare/v1.275.0...v1.276.0
[1.275.0]: https://github.com/kothf/step-viewer/compare/v1.274.0...v1.275.0
[1.274.0]: https://github.com/kothf/step-viewer/compare/v1.271.0...v1.274.0
[1.271.0]: https://github.com/kothf/step-viewer/compare/v1.269.0...v1.271.0
[1.269.0]: https://github.com/kothf/step-viewer/compare/v1.268.0...v1.269.0
[1.268.0]: https://github.com/kothf/step-viewer/compare/v1.266.0...v1.268.0
[1.266.0]: https://github.com/kothf/step-viewer/compare/v1.263.0...v1.266.0
[1.263.0]: https://github.com/kothf/step-viewer/compare/v1.259.0...v1.263.0
[1.259.0]: https://github.com/kothf/step-viewer/compare/v1.256.0...v1.259.0
[1.256.0]: https://github.com/kothf/step-viewer/compare/v1.253.0...v1.256.0
[1.253.0]: https://github.com/kothf/step-viewer/compare/v1.252.0...v1.253.0
[1.252.0]: https://github.com/kothf/step-viewer/compare/v1.251.0...v1.252.0
[1.251.0]: https://github.com/kothf/step-viewer/compare/v1.250.0...v1.251.0
[1.250.0]: https://github.com/kothf/step-viewer/compare/v1.248.0...v1.250.0
[1.248.0]: https://github.com/kothf/step-viewer/compare/v1.247.0...v1.248.0
[1.247.0]: https://github.com/kothf/step-viewer/compare/v1.245.0...v1.247.0
[1.245.0]: https://github.com/kothf/step-viewer/compare/v1.241.0...v1.245.0
[1.241.0]: https://github.com/kothf/step-viewer/compare/v1.240.0...v1.241.0
[1.240.0]: https://github.com/kothf/step-viewer/compare/v1.239.0...v1.240.0
[1.239.0]: https://github.com/kothf/step-viewer/compare/v1.237.0...v1.239.0
[1.237.0]: https://github.com/kothf/step-viewer/compare/v1.236.0...v1.237.0
[1.236.0]: https://github.com/kothf/step-viewer/compare/v1.234.0...v1.236.0
[1.234.0]: https://github.com/kothf/step-viewer/compare/v1.233.0...v1.234.0
[1.233.0]: https://github.com/kothf/step-viewer/compare/v1.232.0...v1.233.0
[1.232.0]: https://github.com/kothf/step-viewer/compare/v1.231.0...v1.232.0
[1.231.0]: https://github.com/kothf/step-viewer/compare/v1.229.0...v1.231.0
[1.229.0]: https://github.com/kothf/step-viewer/compare/v1.226.0...v1.229.0
[1.226.0]: https://github.com/kothf/step-viewer/compare/v1.219.0...v1.226.0
[1.219.0]: https://github.com/kothf/step-viewer/compare/v1.215.0...v1.219.0
[1.215.0]: https://github.com/kothf/step-viewer/compare/v1.211.0...v1.215.0
[1.211.0]: https://github.com/kothf/step-viewer/compare/v1.208.0...v1.211.0
[1.208.0]: https://github.com/kothf/step-viewer/compare/v1.206.0...v1.208.0
[1.206.0]: https://github.com/kothf/step-viewer/compare/v1.205.0...v1.206.0
[1.205.0]: https://github.com/kothf/step-viewer/compare/v1.202.0...v1.205.0
[1.202.0]: https://github.com/kothf/step-viewer/compare/v1.200.0...v1.202.0
[1.200.0]: https://github.com/kothf/step-viewer/compare/v1.199.0...v1.200.0
[1.199.0]: https://github.com/kothf/step-viewer/compare/v1.197.0...v1.199.0
[1.197.0]: https://github.com/kothf/step-viewer/compare/v1.196.0...v1.197.0
[1.196.0]: https://github.com/kothf/step-viewer/compare/v1.194.0...v1.196.0
[1.194.0]: https://github.com/kothf/step-viewer/compare/v1.191.0...v1.194.0
[1.191.0]: https://github.com/kothf/step-viewer/compare/v1.190.0...v1.191.0
[1.190.0]: https://github.com/kothf/step-viewer/compare/v1.189.0...v1.190.0
[1.189.0]: https://github.com/kothf/step-viewer/compare/v1.187.0...v1.189.0
[1.187.0]: https://github.com/kothf/step-viewer/compare/v1.184.0...v1.187.0
[1.184.0]: https://github.com/kothf/step-viewer/compare/v1.183.0...v1.184.0
[1.183.0]: https://github.com/kothf/step-viewer/compare/v1.181.0...v1.183.0
[1.181.0]: https://github.com/kothf/step-viewer/compare/v1.180.0...v1.181.0
[1.180.0]: https://github.com/kothf/step-viewer/compare/v1.178.0...v1.180.0
[1.178.0]: https://github.com/kothf/step-viewer/compare/v1.177.0...v1.178.0
[1.177.0]: https://github.com/kothf/step-viewer/compare/v1.176.0...v1.177.0
[1.176.0]: https://github.com/kothf/step-viewer/compare/v1.175.0...v1.176.0
[1.175.0]: https://github.com/kothf/step-viewer/compare/v1.174.0...v1.175.0
[1.174.0]: https://github.com/kothf/step-viewer/compare/v1.173.0...v1.174.0
[1.173.0]: https://github.com/kothf/step-viewer/compare/v1.169.0...v1.173.0
[1.169.0]: https://github.com/kothf/step-viewer/compare/v1.168.0...v1.169.0
[1.168.0]: https://github.com/kothf/step-viewer/compare/v1.167.0...v1.168.0
[1.167.0]: https://github.com/kothf/step-viewer/compare/v1.166.0...v1.167.0
[1.166.0]: https://github.com/kothf/step-viewer/compare/v1.164.0...v1.166.0
[1.164.0]: https://github.com/kothf/step-viewer/compare/v1.163.0...v1.164.0
[1.163.0]: https://github.com/kothf/step-viewer/compare/v1.161.0...v1.163.0
[1.161.0]: https://github.com/kothf/step-viewer/compare/v1.160.0...v1.161.0
[1.160.0]: https://github.com/kothf/step-viewer/compare/v1.158.0...v1.160.0
[1.158.0]: https://github.com/kothf/step-viewer/compare/v1.157.0...v1.158.0
[1.157.0]: https://github.com/kothf/step-viewer/compare/v1.156.0...v1.157.0
[1.156.0]: https://github.com/kothf/step-viewer/compare/v1.153.0...v1.156.0
[1.153.0]: https://github.com/kothf/step-viewer/compare/v1.152.0...v1.153.0
[1.152.0]: https://github.com/kothf/step-viewer/compare/v1.151.0...v1.152.0
[1.151.0]: https://github.com/kothf/step-viewer/compare/v1.150.0...v1.151.0
[1.150.0]: https://github.com/kothf/step-viewer/compare/v1.147.0...v1.150.0
[1.147.0]: https://github.com/kothf/step-viewer/compare/v1.146.0...v1.147.0
[1.146.0]: https://github.com/kothf/step-viewer/compare/v1.144.0...v1.146.0
[1.144.0]: https://github.com/kothf/step-viewer/compare/v1.143.0...v1.144.0
[1.143.0]: https://github.com/kothf/step-viewer/compare/v1.142.0...v1.143.0
[1.142.0]: https://github.com/kothf/step-viewer/compare/v1.141.0...v1.142.0
[1.141.0]: https://github.com/kothf/step-viewer/compare/v1.140.0...v1.141.0
[1.140.0]: https://github.com/kothf/step-viewer/compare/v1.139.0...v1.140.0
[1.139.0]: https://github.com/kothf/step-viewer/compare/v1.138.0...v1.139.0
[1.138.0]: https://github.com/kothf/step-viewer/compare/v1.137.0...v1.138.0
[1.137.0]: https://github.com/kothf/step-viewer/compare/v1.135.0...v1.137.0
[1.135.0]: https://github.com/kothf/step-viewer/compare/v1.134.0...v1.135.0
[1.134.0]: https://github.com/kothf/step-viewer/compare/v1.133.0...v1.134.0
[1.133.0]: https://github.com/kothf/step-viewer/compare/v1.131.0...v1.133.0
[1.131.0]: https://github.com/kothf/step-viewer/compare/v1.129.0...v1.131.0
[1.129.0]: https://github.com/kothf/step-viewer/compare/v1.126.0...v1.129.0
[1.126.0]: https://github.com/kothf/step-viewer/compare/v1.125.0...v1.126.0
[1.125.0]: https://github.com/kothf/step-viewer/compare/v1.122.0...v1.125.0
[1.122.0]: https://github.com/kothf/step-viewer/compare/v1.121.0...v1.122.0
[1.121.0]: https://github.com/kothf/step-viewer/compare/v1.120.0...v1.121.0
[1.120.0]: https://github.com/kothf/step-viewer/compare/v1.119.0...v1.120.0
[1.119.0]: https://github.com/kothf/step-viewer/compare/v1.118.0...v1.119.0
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
