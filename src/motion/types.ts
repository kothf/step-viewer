// Motion studies (FRS FR-FT-122, P6 "simple animator"): a timeline of keys and motors that move an
// assembly through its mate solver, animate exploded views and the camera, and record the view.
// Times are seconds; mate values are millimetres or radians, as in `Mate.value`.
import type { V3 } from "../model/types";

/** How a segment eases into the key that ends it. */
/** Between the previous key and this one: straight, a jump at this key (CAD app Snap), or eased at the start, the end or both. */
export type Interp = "linear" | "snap" | "easein" | "easeout" | "ease";

/** A value at a time. */
/** `c`: on appearance keys, the colour the component wears from there (#rrggbb, blended between coloured keys). */
export interface Key { t: number; v: number; interp?: Interp; c?: string }

/** A camera at a time: eye position and the point looked at (world mm). */
/** `zoom` is the orthographic camera's zoom (a perspective view zooms by moving `pos`). */
export interface CamKey { t: number; pos: V3; target: V3; up?: V3; zoom?: number; interp?: Interp }

/** Keys on a distance or angle mate's value (a CAD app: key points on a mate dimension). */
export interface MateTrack { id: string; kind: "mate"; mate: string; keys: Key[]; off?: boolean }

/**
 * A motor (CAD app rotary / linear motor) driving a mate from `start` to `end` seconds.
 * On a distance or angle mate it changes the value; on a concentric, hinge or screw mate it turns
 * (rotary) or slides (linear) the second component about the first one's axis.
 * Constant: `speed` in rpm (rotary) or mm/s (linear). Oscillating: `amp` in radians or mm at `freq` Hz.
 * Distance: `dist` (radians or mm) reached at `end` along a smooth step (CAD app distance motor).
 * Data points: `pts` = [seconds after `start`, radians or mm] rows joined by `fit` (absent = linear; cubic spline or Akima), ends held.
 * Segments: `segs` = [end time after `start` (s), end value (radians or mm), shape] rows, each from where the last ended
 *   (the first from 0 at the start), shaped linear, cubic, quintic, harmonic or cycloidal (CAD app segments motor).
 * Expression: `expr` = the displacement (degrees or mm) as a formula in `t`, seconds after `start` (CAD app expression motor).
 */
/** A segments motor row: end time (s after the motor start), end value (rad or mm), shape of the move. */
export type SegShape = "linear" | "cubic" | "quintic" | "harmonic" | "cycloid";
export type MotorSeg = [number, number, SegShape];

export interface MotorTrack {
  id: string;
  kind: "motor";
  mate: string;
  motion: "rotary" | "linear";
  profile: "constant" | "oscillate" | "distance" | "points" | "segments" | "expr";
  speed: number;
  dist?: number;
  pts?: [number, number][];
  fit?: "cubic" | "akima";
  segs?: MotorSeg[];
  expr?: string;
  amp?: number;
  freq?: number;
  start: number;
  end: number;
  flip?: boolean;
  off?: boolean;
}

/** An exploded view's progress, 0 collapsed … 1 exploded. */
/** `seq`: the steps run one after another over the progress (CAD app animation wizard), not all at once. */
export interface ExplodeTrack { id: string; kind: "explode"; view: string; keys: Key[]; seq?: boolean; off?: boolean }

/** A component's appearance (a CAD app: component visibility and transparency keys): opacity 0 hidden … 1 opaque. */
export interface LookTrack { id: string; kind: "look"; comp: string; keys: Key[]; off?: boolean }

/**
 * A component's placement (CAD app animation: drag a component at a time to key it), for components no
 * mate holds: `d` moves it (world mm) and `r` turns it about world X, then Y, then Z through its own
 * origin (degrees), both from where the assembly has it.
 */
export interface PoseKey { t: number; d: V3; r: V3; interp?: Interp }
export interface PoseTrack { id: string; kind: "pose"; comp: string; keys: PoseKey[]; off?: boolean }

/** View orientation keys. */
export interface CameraTrack { id: string; kind: "camera"; keys: CamKey[]; off?: boolean }

export type Track = MateTrack | MotorTrack | ExplodeTrack | LookTrack | PoseTrack | CameraTrack;

export interface MotionStudy {
  id: string;
  name: string;
  /** Length of the study (s). */
  duration: number;
  /** Frames per second the study is solved and recorded at. */
  fps: number;
  /** Playback: once, loop, or back and forth. */
  play?: "once" | "loop" | "reciprocate";
  tracks: Track[];
  /** Trace paths (Results → Trace Path): points on components followed through the study. */
  traces?: TracePath[];
}

/** A point on a component whose path is drawn and plotted over the study. */
export interface TracePath {
  id: string;
  /** A mate value result instead of a point (Results → Plot of a mate): the distance and angle between the mate's two references; `comp`/`p` are unused. */
  mate?: string;
  /** A proximity result instead of a point: the smallest distance between these two top-level components; `comp`/`p` are unused. */
  gap?: [string, string];
  /** The component (as the solver names it) the point moves with. */
  comp: string;
  /** The point in the component's own coordinates (mm). */
  p: [number, number, number];
  color: string;
  /** Traced relative to this component (top-level id): the path moves with it and the plots are in its coordinates. */
  rel?: string;
  /** What the panel plots (default "dist"). */
  plot?: "dist" | "speed" | "accel" | "x" | "y" | "z" | "angle" | "aspeed";
  /** Hidden in the view. */
  off?: boolean;
  /** Sensor on the plotted quantity: out-of-range frames are marked on the timeline, and `stop` pauses playback where it trips. */
  alert?: { min?: number; max?: number; stop?: boolean };
}
