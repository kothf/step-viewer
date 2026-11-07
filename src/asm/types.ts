// Assembly documents (FRS 10, P4): components that place parts by a rigid transform.
// Every source is kept as a part document: a MöbiusCAD part as it is, a STEP/IGES/BREP
// model as a part with one Imported feature, so the kernel evaluates them all the same way.
import type { PartDoc, V3 } from "../model/types";

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
}

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
  /** The documents the components use, embedded (FR-ASM-003), by key. */
  parts: Record<string, { name: string; file: string; doc: PartDoc }>;
}

/** The kernel's answer for an assembly: one mesh per shown component, and mass properties of the solved assembly. */
export interface AsmComponentStatus { id: string; ok: boolean; message?: string }

/** A face of a component, by its persistent name in the part (FR-MATE-010). */
export interface MateRef { comp: string; face: string }

export type MateType = "coincident" | "parallel" | "perpendicular" | "tangent" | "concentric" | "distance" | "angle" | "lock";

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
