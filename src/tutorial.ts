// Tutorial "Bracket in 10 steps" (FR-HLP-003): the steps and what in the part's document shows each is done.
// Pure: the panel (tutorialUi.ts) asks `tutorialProgress` again whenever the document may have changed.

import type { PartDoc, SketchFeature } from "./model/types";

export interface TutorialStep {
  /** Short name of the step (an i18n key). */
  title: string;
  /** How to do it (an i18n key). */
  how: string;
  done(doc: PartDoc): boolean;
}

const sketches = (d: PartDoc) => d.features.filter((f): f is SketchFeature => f.type === "sketch");
const bosses = (d: PartDoc) => d.features.filter(f => f.type === "extrude" && f.op === "boss").length;
const has = (d: PartDoc, type: string) => d.features.some(f => f.type === type);
const lines = (s: SketchFeature | undefined) => (s ? s.ents.filter(e => e.t === "line" && !e.cons).length : 0);

export const TUTORIAL_STEPS: TutorialStep[] = [
  {
    title: "Start a sketch on the Top plane",
    how: "Click Sketch on the Sketch tab, then the Top (XY) plane.",
    done: d => sketches(d).length > 0,
  },
  {
    title: "Draw the base rectangle",
    how: "Pick Rectangle, click the origin, then click again up and to the right.",
    done: d => lines(sketches(d)[0]) >= 4,
  },
  {
    title: "Give it sizes: 80 × 50 mm",
    how: "Pick Dimension, click a side, click beside it and type the size. Do the same for the other side; the sketch turns fully defined.",
    done: d => (sketches(d)[0]?.dims.length ?? 0) >= 2,
  },
  {
    title: "Extrude the base 6 mm",
    how: "Exit the sketch, click Extrude on the Features tab, type 6 and confirm with ✓.",
    done: d => bosses(d) >= 1,
  },
  {
    title: "Sketch the wall on the base",
    how: "Click the top face of the base, then Sketch. Draw a 6 mm wide rectangle along one long side.",
    done: d => { const s = sketches(d)[1]; return !!s && "face" in s.plane && lines(s) >= 4; },
  },
  {
    title: "Extrude the wall 40 mm",
    how: "Exit the sketch and extrude it 40 mm upwards: the bracket has its L shape.",
    done: d => bosses(d) >= 2,
  },
  {
    title: "Round the inside corner",
    how: "Click Fillet, pick the edge where the wall meets the base, type 5 and confirm.",
    done: d => has(d, "fillet"),
  },
  {
    title: "Add a mounting hole",
    how: "Click Hole, click the base where the hole goes, choose a size and confirm. A circle sketch removed with Cut works too.",
    done: d => has(d, "hole") || d.features.some(f => f.type === "extrude" && f.op === "cut"),
  },
  {
    title: "Break the sharp edges",
    how: "Click Chamfer, pick the outer edges of the wall, type 1 and confirm.",
    done: d => has(d, "chamfer"),
  },
  {
    title: "Choose a material",
    how: "With nothing selected, click the material button on the Properties tab and pick a steel or an aluminium alloy: Mass properties now gives the weight.",
    done: d => !!d.material,
  },
];

/** Which steps the document shows as done, in step order. */
export const tutorialProgress = (doc: PartDoc) => TUTORIAL_STEPS.map(s => s.done(doc));

/** The step to do next (the first one not done), or -1 when the bracket is finished. */
export const tutorialNext = (done: boolean[]) => done.indexOf(false);
