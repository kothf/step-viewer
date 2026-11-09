// Assembly documents (FRS 10, P4): components that place parts by a rigid transform.
// Every source is kept as a part document: a MöbiusCAD part as it is, a STEP/IGES/BREP
// model as a part with one Imported feature, so the kernel evaluates them all the same way.
import type { PartDoc, V3 } from "../model/types";
import type { MotionStudy } from "../motion/types";

/** Rigid transform as the top three rows of a 4×4 matrix, row-major: [r00 r01 r02 tx, r10 r11 r12 ty, r20 r21 r22 tz]. */
export type Tf = number[];

export interface Component {
  id: string;
  /** Instance name shown in the tree, e.g. "Bracket<2>". */
  name: string;
  /** Key into `AsmDoc.parts`. */
  part: string;
  tf: Tf;
  /** Fixed components do not move when dragged or solved (FR-ASM-004); the first one is fixed. */
  fixed?: boolean;
  hidden?: boolean;
  suppressed?: boolean;
  color?: V3;
  /** 0..1, unset = opaque (FR-ASM-025 transparency). */
  opacity?: number;
  /** Sub-assembly only (FR-ASM-006): its own mates solve inside this assembly. */
  flexible?: boolean;
  /** Flexible sub-assembly: where its components ended up, relative to this component, by child id. */
  subTfs?: Record<string, Tf>;
}

/** A component's look in a display state (FR-ASM-025). */
export interface Look { hidden?: boolean; color?: V3; opacity?: number }
/** A named display state: visibility, colour and transparency per component. The active one's looks live on the components. */
export interface DisplayState { id: string; name: string; looks: Record<string, Look> }

export interface AsmDoc {
  schema: 1;
  kind: "assembly";
  id: string;
  name: string;
  units: { length: "mm" | "cm" | "m" | "in" | "ft"; decimals: number };
  components: Component[];
  /** Mates between components (FR-MATE-003), solved in order-independent least squares. */
  mates?: Mate[];
  /** Component patterns (FR-ASM-022): their instances are derived, not stored as components. */
  patterns?: CompPattern[];
  /** Named exploded views (FR-ASM-023). */
  explodes?: ExplodeView[];
  /** Assembly configurations (FR-ASM-026) and the active one (its values live on the document). */
  configs?: AsmConfig[];
  activeConfig?: string;
  /** Assembly features (FR-ASM-027): cuts that exist only in the assembly, applied to the placed components in order. */
  features?: AsmFeature[];
  /** Motion studies (FR-FT-122): keys and motors on mates, explode and camera animation. */
  motions?: MotionStudy[];
  /** Display states (FR-ASM-025) and the active one. */
  states?: DisplayState[];
  activeState?: string;
  /** The documents the components use, embedded (FR-ASM-003), by key. An entry with `asm` is a
   * sub-assembly (rigid, FR-ASM-006); its `doc` is then an empty placeholder part. */
  parts: Record<string, { name: string; file: string; doc: PartDoc; asm?: AsmDoc;
    /** Linked (FR-ASM-003): the source file by path relative to the assembly's folder and the SHA-256 of
     * its bytes when last read; `doc`/`asm` are then the last loaded copy. Unset = embedded. */
    link?: { path: string; hash: string } }>;
}

/** The kernel's answer for an assembly: one mesh per shown component, and mass properties of the solved assembly. */
export interface AsmComponentStatus { id: string; ok: boolean; message?: string }

/** A face of a component, by its persistent name in the part (FR-MATE-010). */
export interface MateRef { comp: string; face: string }

export type MateType = "coincident" | "parallel" | "perpendicular" | "tangent" | "concentric" | "distance" | "angle" | "lock"
  /** Advanced (FR-MATE-004): limits keep a distance or angle in [min, max]; symmetric uses c as the plane; width centres b (and d) between a and c. */
  | "limitdist" | "limitangle" | "symmetric" | "width"
  /** Mechanical (FR-MATE-005): hinge = concentric a/b + coincident c/d; slot = pin axis b centred between slot faces a and c;
   * gear = rotations about axes a and b coupled by `ratio`; screw = concentric a/b and `ratio` mm of travel per turn. */
  | "hinge" | "slot" | "gear" | "screw";

export interface Mate {
  id: string;
  name: string;
  type: MateType;
  a: MateRef;
  b: MateRef;
  /** Normals the same way (aligned) or opposite (anti, the default for face to face). */
  align?: "aligned" | "anti";
  /** Distance (mm) or angle (rad). */
  value?: number;
  /** Distance or angle measured to the other side. */
  flip?: boolean;
  suppressed?: boolean;
  /** Lock: b's transform relative to a's when the mate was made. */
  rel?: Tf;
  /** Symmetric: the symmetry plane; width: the second width face. */
  c?: MateRef;
  /** Width: the second tab face (none when the tab is a cylinder). */
  d?: MateRef;
  /** Limit distance (mm) or angle (rad) range. */
  min?: number;
  max?: number;
  /** Gear: turns of b per turn of a; screw: travel per turn (mm). */
  ratio?: number;
  /** Gear, screw and a concentric with `lockRot`: a's and b's transforms when the mate was made (their motion is measured from there). */
  t0?: [Tf, Tf];
  /** Concentric: b may not turn about the shared axis relative to a (SolidWorks' Lock rotation). */
  lockRot?: boolean;
  /** Lock only: hold just the orientation ("rot") or just the travel along `along` (in a's coordinates, "slide"); motion study motors use these. */
  keep?: "rot" | "slide";
  along?: V3;
}

/** Linear or circular pattern of components along a face's normal / cylinder axis. */
export interface CompPattern {
  id: string;
  name: string;
  kind: "linear" | "circular";
  seeds: string[];
  /** Direction (linear: plane normal or axis direction) or axis (circular: a cylindrical face). */
  dir: MateRef | null;
  /** Total instances, the seed included. */
  count: number;
  /** Linear: spacing (mm). Circular: angle between instances (rad), or the total angle when `equal`. */
  spacing: number;
  equal?: boolean;
  flip?: boolean;
  suppressed?: boolean;
}

export interface ExplodeStep { comps: string[]; dir: V3; dist: number }
export interface ExplodeView { id: string; name: string; steps: ExplodeStep[] }

/**
 * Assembly feature (FR-ASM-027): a hole (circle) or cut extrude (rectangle) that starts on a flat face of
 * `ref.comp` and goes into the material, cutting every component it reaches (or those in `comps`).
 * `at`, `n` (out of the face) and `x` (the rectangle's width direction) are in `ref.comp`'s own
 * coordinates, so the feature moves with that component.
 */
export interface AsmFeature {
  id: string;
  name: string;
  type: "hole" | "cut";
  ref: MateRef;
  at: V3;
  n: V3;
  x: V3;
  /** Hole diameter (mm). */
  dia?: number;
  /** Cut: rectangle width (along x) and height (mm). */
  w?: number;
  h?: number;
  /** Depth (mm) from the face; absent: through all. */
  depth?: number;
  /** Components it may cut (feature scope); absent: all. */
  comps?: string[];
  suppressed?: boolean;
}

/** What an assembly configuration controls (FR-ASM-026). */
export interface AsmConfigState {
  /** Suppressed component ids. */
  suppressed: string[];
  /** Component id → part key (a part configuration is a part entry of its own). */
  parts: Record<string, string>;
  /** Mate values and suppression by mate id. */
  mates: Record<string, { value?: number; min?: number; max?: number; suppressed?: boolean }>;
  /** Suppressed assembly feature ids. */
  features: string[];
}
export interface AsmConfig { id: string; name: string; state: AsmConfigState }
