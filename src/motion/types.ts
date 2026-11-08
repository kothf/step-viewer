// Motion studies (FRS FR-FT-122, P6 "simple animator"): a timeline of keys and motors that move an
// assembly through its mate solver, animate exploded views and the camera, and record the view.
// Times are seconds; mate values are millimetres or radians, as in `Mate.value`.
import type { V3 } from "../model/types";

/** How a segment eases into the key that ends it. */
/** Between the previous key and this one: straight, a jump at this key (SolidWorks Snap), or eased at the start, the end or both. */
export type Interp = "linear" | "snap" | "easein" | "easeout" | "ease";

/** A value at a time. */
export interface Key { t: number; v: number; interp?: Interp }

/** A camera at a time: eye position and the point looked at (world mm). */
/** `zoom` is the orthographic camera's zoom (a perspective view zooms by moving `pos`). */
export interface CamKey { t: number; pos: V3; target: V3; up?: V3; zoom?: number; interp?: Interp }

/** Keys on a distance or angle mate's value (SolidWorks: key points on a mate dimension). */
export interface MateTrack { id: string; kind: "mate"; mate: string; keys: Key[]; off?: boolean }

/**
 * A motor (SolidWorks rotary / linear motor) driving a mate from `start` to `end` seconds.
 * On a distance or angle mate it changes the value; on a concentric, hinge or screw mate it turns
 * (rotary) or slides (linear) the second component about the first one's axis.
 * Constant: `speed` in rpm (rotary) or mm/s (linear). Oscillating: `amp` in radians or mm at `freq` Hz.
 */
export interface MotorTrack {
  id: string;
  kind: "motor";
  mate: string;
  motion: "rotary" | "linear";
  profile: "constant" | "oscillate";
  speed: number;
  amp?: number;
  freq?: number;
  start: number;
  end: number;
  flip?: boolean;
  off?: boolean;
}

/** An exploded view's progress, 0 collapsed … 1 exploded. */
export interface ExplodeTrack { id: string; kind: "explode"; view: string; keys: Key[]; off?: boolean }

/** A component's appearance (SolidWorks: component visibility and transparency keys): opacity 0 hidden … 1 opaque. */
export interface LookTrack { id: string; kind: "look"; comp: string; keys: Key[]; off?: boolean }

/**
 * A component's placement (SolidWorks animation: drag a component at a time to key it), for components no
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
}
