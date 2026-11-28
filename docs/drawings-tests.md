# Drawings: test list and comparison with other CAD apps

Scope: section views, hole callouts, geometric tolerances, and how a drawing follows edits of its model.
Checked by hand on the packaged app (every action a real click, drag or key). Hands-on scenario:
`tests/human/drwexam.mjs` (ids below); unit tests: `tests/unit/drawing*.test.ts`.

Status: **1.764.0** = before this round, **now** = after it. ✓ works, ✗ missing or broken, — not tested.

## A. Section views

| Id | Test | Other CAD apps | 1.764.0 | now |
|----|------|----------------|---------|-----|
| A1 | Section ▸ Horizontal cutting line: one click on a view puts the cutting line there, snapped to a hole centre | same (line snaps to centres) | ✓ | ✓ |
| A2 | The section previews while the cursor moves, and lands on the side the arrows say (first angle: where the arrows point) | same | ✓ | ✓ |
| A3 | The section is labelled "SECTION A-A" with its scale; the cutting line carries the letters A at both ends | same | ✓ | ✓ |
| A4 | Cut faces are hatched; the hole shows as two walls with no hatch between them | same | ✓ | ✓ |
| A5 | The section lines up with its parent and moves only along that line when dragged | same (aligned, Alt to free) | ✓ | ✓ |
| A6 | Flip direction from the view's properties looks the other way, arrows flip with it | same | ✓ | ✓ |
| A7 | A second section gets the next letter (B-B) | same | ✓ | ✓ |
| A8 | A dimension can be put on the cut face (depth of the hole in the section) | same | ✓ | ✓ |
| A9 | Deleting the parent asks / also removes the section; Undo puts both back | same (asks) | ✓ | ✓ |
| A10 | Half section and offset section through the hole and a corner | same | ✓ | ✓ |
| A11 | Tapped holes the cutting plane misses are not drawn as cut in the section (no thread lines through solid material) | same | ✗ drawn as cut | ✓ |

## B. Hole callouts

| Id | Test | Other CAD apps | 1.764.0 | now |
|----|------|----------------|---------|-----|
| B1 | Hole Callout on a plain through hole made by the Hole feature: "Ø8 THRU" placed at once | same | ✓ | ✓ |
| B2 | Counterbore hole: Ø, ⌴ Ø depth on separate lines | same | ✓ | ✓ |
| B3 | Tapped hole: thread size and depth (M6 ↧ L), drill size | same | ✓ | ✓ |
| B4 | Two equal holes of one feature: "2× …" | same | ✓ | ✓ |
| B5 | Callout on a side view (hole seen edge-on) points at the hole's line | same | ✓ | ✓ |
| B6 | Double-click opens the callout dialog; added text stays after OK | same | ✓ | ✓ |
| B7 | Dragging the callout moves its text, the leader stays on the hole | same | ✓ | ✓ |
| B8 | Hole made by a plain cut (no Hole feature) gets a callout from the geometry | same | ✓ | ✓ |

## C. Geometric tolerances

| Id | Test | Other CAD apps | 1.764.0 | now |
|----|------|----------------|---------|-----|
| C1 | Geometric Tolerance tool: click places a frame after the dialog's OK, with the symbol and value picked there | same (dialog) | ✓ | ✓ |
| C2 | Datum letters A, B in the frame's datum cells; Ø and Ⓜ inserted from the buttons | same | ✓ | ✓ |
| C3 | A Datum feature symbol "A" on an edge; the next one is "B" | same | ✓ | ✓ |
| C4 | A frame clicked onto a dimension sits under its text and moves with it | same | ✓ | ✓ |
| C5 | A frame with a leader to an edge, dragged: the leader stays on the edge. Flatness (a form tolerance) takes no datum | same; form tolerances have their datum cells greyed out | ✗ datum A stayed | ✓ |
| C6 | Double-click a frame edits it; Cancel changes nothing | same | ✓ | ✓ |
| C7 | Delete a dimension: its attached frame goes too; Undo brings both back | same | ✓ | ✓ |
| C8 | Frames and symbols come out in the PDF/SVG export | same | ✓ | ✓ |

## D. Following model edits

| Id | Test | Other CAD apps | 1.764.0 | now |
|----|------|----------------|---------|-----|
| D1 | Change the block's depth in the part, come back to the drawing: views redraw at once | same (rebuild on activate) | ✓ | ✓ |
| D2 | The dimension of that edge shows the new value | same | ✓ | ✓ |
| D3 | Change the hole diameter: the callout text follows | same | ✓ | ✓ |
| D4 | The section follows (new depth, same cutting line) | same | ✓ | ✓ |
| D5 | Geometric tolerance frame on a dimension stays attached | same | ✓ | ✓ |
| D6 | Delete the hole in the part: its callout and dimensions show as dangling, not lost | same (dangling colour) | ✓ | ✓ |
| D7 | Undo in the part brings the hole back and the annotations re-attach | same | ✓ | ✓ |
| D8 | Save the drawing, open it again: views, section, callouts, frames all there | same | ✓ | ✓ |
| D9 | Views are drawn at once on reopen (saved lines) and replaced by exact ones | same | ✓ | ✓ |

Run: `node tests/human/drwexam.mjs` (part Plate, stages A–D) and `PART=Flange node tests/human/drwexam.mjs`
(stage E: tapped holes, a hole cut by a sketch, a dimension on a cut face, a half section, deleting a parent view).
Parts are made by hand first: `drwpart.mjs`, `drwpart2.mjs`. Screenshots: `tests/drw/`.

## Bugs found

1. **Flatness kept datum A** (C5). A frame made with a leader starts as perpendicularity to A; picking Flatness in the
   dialog left "A" in the frame, which ISO 1101 does not allow (form tolerances relate to no datum).
   Fix: picking straightness, flatness, roundness or cylindricity clears the row's datums and greys out its datum cells.
2. **Threads of holes the section does not cut were drawn as cut** (A11). In a half section through one hole, the tapped
   holes 50 mm behind the cut showed thread lines in solid lines over the hatching, and in the unsectioned half too.
   Fix: a thread is drawn as cut only where a cut face runs through it; behind the cut it is hidden (left out in a view
   without hidden lines), in the part cut away it is not drawn. Views drawn without hidden lines no longer show hidden
   threads dashed either.

Checked and not bugs: datum letters follow the section letters (A-A, B-B, then datum C), as decided in the earlier
drawings exam (#6); a section shows the counterbore at the bottom (first-angle projection).
