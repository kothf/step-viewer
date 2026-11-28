# 3D sketch: test list and comparison with other CAD apps

What a 3D sketch (FR-SK-080) must do, checked by hand on the packaged app. Hands-on scenario:
`tests/human/sketch3d.mjs` (ids below); unit tests: `tests/unit/sketch3d.test.ts`.

Status: **1.762.0** = before this round, **now** = after it. ✓ works, ✗ missing or broken, — not tested.

## A. Start, finish, undo

| Id | Test | Other CAD apps | 1.762.0 | now |
|----|------|----------------|---------|-----|
| A1 | 3D Sketch (Sketch tab, Curves flyout) opens with the Line tool and its panel | same | ✓ | ✓ |
| A2 | ✓ adds the 3D sketch to the tree; ✓ with nothing drawn says what is missing | same | ✓ | ✓ |
| A3 | ✕ throws the changes away | same | ✓ | ✓ |
| A4 | Edit from the tree opens it again with the Select tool, no stale chain | same | ✗ (state kept from the last edit) | ✓ |
| A5 | Ctrl+Z / Ctrl+Y inside the sketch take back / put again the last change | same | ✓ | ✓ |

## B. Drawing

| Id | Test | Other CAD apps | 1.762.0 | now |
|----|------|----------------|---------|-----|
| B1 | Line: each click draws from the last point (a chain) | same | ✓ | ✓ |
| B2 | A rubber band follows the pointer from the last point before the click | yes | ✗ | ✓ |
| B3 | The plane through the last point is shown; Tab turns it XY → YZ → ZX | space handle, Tab | ✓ | ✓ |
| B4 | Points land on model vertices, edges and faces | same | ✓ | ✓ |
| B5 | A click on an existing point joins it (closes a loop); the point lights before the click | same | ✓ / ✗ no highlight | ✓ |
| B6 | Esc ends the chain, Esc again leaves the tool; a further Esc never throws a changed sketch away | same | ✗ (the whole sketch was discarded) | ✓ |
| B7 | Spline: clicks add points to one spline, previewed through the pointer | same | ✓ / ✗ no preview | ✓ |
| B8 | A line drawn close to X, Y or Z snaps onto it and gets Along X/Y/Z, with the axis shown by the pointer; Ctrl draws it as it is | yes (cursor shows X/Y/Z) | ✗ | ✓ |
| B9 | A point on a 2D sketch point follows that sketch | same | ✓ | ✓ |
| B10 | Coordinates typed in the point table move the point | yes (PropertyManager) | ✓ | ✓ |
| B11 | Dragging a point in the view moves it, the relations hold | yes | ✗ | ✓ |
| B12 | Sketch fillet: a corner of two lines rounded with a radius (asked at once, R shown on the arc; the lines keep the sharp corner for dimensions); a sweep follows the arc | yes | ✗ | ✓ (1.764.0) |
| B13 | Arc through 3 points: start, end, then a point it passes through (previewed through the pointer); the chain goes on from its end | yes (3 Point Arc) | ✗ | ✓ (1.774.0) |
| B14 | Points clicked on a model face, edge or vertex are held there (On face, On edge, On model vertex) and follow the model when it changes | same | ✗ (only snapped, then left behind) | ✓ (1.774.0) |

## C. Selection

| Id | Test | Other CAD apps | 1.762.0 | now |
|----|------|----------------|---------|-----|
| C1 | A click selects one item; Ctrl/Shift+click adds; a click on empty space clears | same | ✗ (plain click added) | ✓ |
| C2 | Hovering a point or line lights it before the click | yes | ✗ | ✓ |
| C3 | Delete removes the selection with its relations and dimensions; Esc clears the selection | same | ✓ / ✗ Esc | ✓ |

## D. Relations

| Id | Test | Other CAD apps | 1.762.0 | now |
|----|------|----------------|---------|-----|
| D1 | Along X/Y/Z, Parallel to XY/YZ/ZX, Parallel, Perpendicular, Equal, Coincident, Fix | same | ✓ | ✓ |
| D2 | A relation that cannot hold is refused with a message, nothing moves | same | ✓ | ✓ |
| D3 | Relation glyphs show on the lines and points; a click selects what they hold | yes | ✗ | ✓ |
| D4 | A relation is deleted from the list | same | ✓ | ✓ |
| D5 | Midpoint and On line (a point and a line) | yes | ✗ | ✓ |
| D6 | Tangent between a spline and a line (or two splines) at a shared end | yes | ✗ | ✓ (1.764.0) |
| D7 | On XY / YZ / ZX: a point on a standard plane; refused with a message when it cannot hold | yes | ✗ | ✓ (1.768.0) |
| D8 | Tangent between a line and an arc at a shared end | yes | ✗ | ✓ (1.774.0) |

## E. Dimensions

| Id | Test | Other CAD apps | 1.762.0 | now |
|----|------|----------------|---------|-----|
| E1 | Length of a line, distance between points; the value drives the geometry | same | ✓ | ✓ |
| E2 | Dimensions show their value in the view; a click opens the Modify box, the sketch follows while typing | yes | ✗ | ✓ |
| E3 | Angle between two lines | yes | ✗ | ✓ |
| E4 | A dimension typed as an expression of global variables follows the variables | yes | ✗ (kept the old value) | ✓ |
| E5 | The panel says how many degrees of freedom are left, or Fully defined | same | ✓ | ✓ |
| E6 | Distance from a point to a standard plane (XY, YZ, ZX), shown in the view and typed in the Modify box | yes | ✗ | ✓ (1.768.0) |
| E7 | Angle of a line to a standard plane (XY, YZ, ZX), shown in the view and typed in the Modify box | yes | ✗ | ✓ (1.773.0) |
| E8 | Radius of an arc, shown in the view and typed in the Modify box | yes | ✗ | ✓ (1.774.0) |

## F. Use of the 3D sketch

| Id | Test | Other CAD apps | 1.762.0 | now |
|----|------|----------------|---------|-----|
| F1 | Sweep with a circular profile follows the 3D sketch (sharp corners) | same | ✓ | ✓ |
| F2 | Sweep with a sketch profile along it (sharp corner and sketch fillet) | same | — | ✓ (unit test, 1.768.0) |
| F3 | Structural member on the 3D sketch's lines | same | ✓ (weldments tests) | ✓ |
| F4 | A branch is refused as a path with a clear message | same | ✓ | ✓ |
| F5 | Hide/Show from the tree; Hide/Show items ▸ Curves | same | ✓ | ✓ |
| F6 | Save and open keeps the 3D sketch | same | ✓ | ✓ |
| F7 | Russian UI: every new text translated | — | — | ✓ |
| F8 | Sweep along a path with an arc (exact arc edge); a sharp corner next to an arc or spline is refused with a message instead of a broken solid | same | ✗ (volume 0) | ✓ (1.774.0) |
