/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Public input/output types for `@ifc-lite/physics`.
 *
 * Mirrors the shape of `ifc-lite-physics` (Rust) one-for-one so callers can
 * swap between the browser/Node JS runtime and the native Rust runtime
 * without changing call sites.
 */

/** Single mesh fed to the physics world. Coordinates are IFC convention (Z-up, meters). */
export interface PhysicsMesh {
  expressId: number;
  ifcType: string;
  /** Vertex positions as flat `[x, y, z, x, y, z, ...]` triplets. */
  positions: Float32Array | number[];
  /** Triangle indices as flat `[a, b, c, a, b, c, ...]` triplets. */
  indices: Uint32Array | number[];
}

export interface AABB {
  min: [number, number, number];
  max: [number, number, number];
}

export type AnchorReason = 'explicit' | 'ifcType' | 'lowestElement';

export type Stability = 'stable' | 'tilted' | 'falling' | 'removed';

/**
 * Collider shape strategy:
 * - `trimesh`: exact, slow, contact-unstable for thin elements.
 * - `convexHull`: dramatically faster + more stable, loses concavity.
 * - `auto` (default): per IFC type — convex for column/beam/member/footing/pile,
 *   trimesh for slab/wall/roof/etc. that routinely have openings.
 */
export type ColliderStrategy = 'auto' | 'trimesh' | 'convexHull';

export interface SimulateOptions {
  /** Express IDs to delete from the world before stepping. */
  remove?: number[];
  /** Express IDs to keep fixed regardless of inferred anchoring. */
  anchor?: number[];
  /**
   * Pre-computed connection pairs (typically extracted from
   * `IfcRelConnectsElements`, `IfcRelConnectsPathElements`, or
   * `IfcRelConnectsStructuralMember`). Each pair becomes a fixed joint, in
   * addition to AABB-touch inference. Pairs referencing express IDs not in
   * `meshes` are silently skipped; duplicates against AABB are collapsed.
   */
  connections?: Array<[number, number]>;
  /** Gravity in m/s² (IFC Z-up). Default: `[0, 0, -9.81]`. */
  gravity?: [number, number, number];
  /** Total simulated time in seconds. Default: `3.0`. */
  durationSeconds?: number;
  /** Per-step time delta. Default: `1/60`. */
  timeStep?: number;
  /** AABB-touch tolerance for joint inference, in meters. Default: `0.05`. */
  adjacencyTolerance?: number;
  /** Vertical displacement above which a body is classified `falling`. Default: `0.20` m. */
  fallThreshold?: number;
  /** Angular displacement above which a non-falling body is `tilted`. Default: `0.05` rad. */
  tiltThreshold?: number;
  /** Treat any element whose AABB minimum Z lies within this distance of the model floor as anchored. Default: `0.05` m. */
  groundAnchorTolerance?: number;
  /** IFC types to treat as anchors regardless of position. Default: footings, piles, foundations. */
  anchorIfcTypes?: string[];

  /** How to convert each mesh into a collider shape. Default: `auto`. */
  colliderStrategy?: ColliderStrategy;
}

/** Resolved options with all defaults filled in. */
export interface ResolvedSimulateOptions {
  remove: number[];
  anchor: number[];
  connections: Array<[number, number]>;
  gravity: [number, number, number];
  durationSeconds: number;
  timeStep: number;
  adjacencyTolerance: number;
  fallThreshold: number;
  tiltThreshold: number;
  groundAnchorTolerance: number;
  anchorIfcTypes: string[];
  colliderStrategy: ColliderStrategy;
}

export const DEFAULT_OPTIONS: ResolvedSimulateOptions = {
  remove: [],
  anchor: [],
  connections: [],
  gravity: [0, 0, -9.81],
  durationSeconds: 3.0,
  timeStep: 1 / 60,
  adjacencyTolerance: 0.05,
  fallThreshold: 0.2,
  tiltThreshold: 0.05,
  groundAnchorTolerance: 0.05,
  anchorIfcTypes: ['IfcFooting', 'IfcPile', 'IfcFoundation'],
  colliderStrategy: 'auto',
};

export function resolveOptions(opts: SimulateOptions | undefined): ResolvedSimulateOptions {
  return {
    remove: opts?.remove ?? DEFAULT_OPTIONS.remove.slice(),
    anchor: opts?.anchor ?? DEFAULT_OPTIONS.anchor.slice(),
    connections: opts?.connections ?? [],
    gravity: opts?.gravity ?? [...DEFAULT_OPTIONS.gravity],
    durationSeconds: opts?.durationSeconds ?? DEFAULT_OPTIONS.durationSeconds,
    timeStep: opts?.timeStep ?? DEFAULT_OPTIONS.timeStep,
    adjacencyTolerance: opts?.adjacencyTolerance ?? DEFAULT_OPTIONS.adjacencyTolerance,
    fallThreshold: opts?.fallThreshold ?? DEFAULT_OPTIONS.fallThreshold,
    tiltThreshold: opts?.tiltThreshold ?? DEFAULT_OPTIONS.tiltThreshold,
    groundAnchorTolerance: opts?.groundAnchorTolerance ?? DEFAULT_OPTIONS.groundAnchorTolerance,
    anchorIfcTypes: opts?.anchorIfcTypes ?? DEFAULT_OPTIONS.anchorIfcTypes.slice(),
    colliderStrategy: opts?.colliderStrategy ?? DEFAULT_OPTIONS.colliderStrategy,
  };
}

export interface BodyOutcome {
  expressId: number;
  ifcType: string;
  stability: Stability;
  anchored: boolean;
  anchorReason: AnchorReason | null;
  /** Translation magnitude from start to end position, meters. */
  displacement: number;
  /** Vertical (Z) displacement, signed. Negative = fell. */
  verticalDisplacement: number;
  /** Final angular displacement in radians. */
  angularDisplacement: number;
}

export interface SimulationResult {
  bodies: BodyOutcome[];
  removed: number[];
  stable: number[];
  falling: number[];
  tilted: number[];
  anchored: number[];
  /** Connection graph used for joint inference: pairs of express IDs welded together. */
  joints: Array<[number, number]>;
}
