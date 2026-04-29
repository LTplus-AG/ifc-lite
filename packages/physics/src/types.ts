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

  /**
   * IFC types to skip entirely. The default excludes (a) abstract volumes
   * that overlap their physical hosts and create spurious penetration
   * impulses, plus (b) architectural finishes / MEP elements that aren't
   * load-bearing and only add noise to the solver. Override the list to
   * include any of them.
   *
   * Default-out:
   *   IfcOpeningElement, IfcSpace, IfcZone, IfcVirtualElement,
   *   IfcFurnishingElement, IfcSystemFurnitureElement,
   *   IfcWindow, IfcDoor, IfcRailing, IfcCovering, IfcCurtainWall,
   *   IfcLamp, IfcLightFixture, IfcSanitaryTerminal,
   *   IfcFlowSegment, IfcFlowTerminal, IfcFlowController, IfcFlowFitting,
   *   IfcFlowMovingDevice, IfcFlowStorageDevice, IfcFlowTreatmentDevice,
   *   IfcDistributionElement, IfcDistributionFlowElement,
   *   IfcDistributionControlElement, IfcEnergyConversionDevice.
   */
  excludeIfcTypes?: string[];

  /** How to convert each mesh into a collider shape. Default: `auto`. */
  colliderStrategy?: ColliderStrategy;

  /**
   * If true, record per-frame body poses so the caller can play back the
   * simulation as an animation. Adds memory proportional to
   * `bodies × frames × 7 floats × 4 bytes`. Off by default — only the
   * viewer enables this.
   */
  captureTrajectory?: boolean;

  /**
   * Sample every Nth physics step for the trajectory. Default `1` (every
   * step). Use larger values to halve / third the memory footprint on
   * long simulations.
   */
  trajectoryStride?: number;

  /**
   * Emit `console.info` / `console.warn` lines from the simulator at world
   * build time and at progress checkpoints. Useful for diagnosing
   * "why does this model explode?" — gravity axis, anchor counts, joint
   * counts, max speeds, and the top N most-moved bodies all show up.
   * Off by default.
   */
  debug?: boolean;

  /**
   * Hard upper bound on linear speed in m/s. After every solver step,
   * any dynamic body exceeding this limit is rescaled to it. Acts as a
   * safety net for the rare case where unwelded contact resolution
   * generates an absurd impulse — without it a single bad contact can
   * launch a body to escape velocity and ruin the whole frame.
   * Default `50` m/s — well above terminal velocity for falling rubble
   * and far below the 1e+5 m/s blowups that come out of a misbehaving
   * solver. Set to `Infinity` to disable.
   */
  maxLinearSpeed?: number;
}

/** Per-frame body poses, indexed `frame * bodyCount * 7 + bodyIndex * 7`. */
export interface SimulationTrajectory {
  /** Number of recorded frames. */
  frameCount: number;
  /** Wall-clock seconds between consecutive recorded frames. */
  frameDt: number;
  /** Express IDs in the order their poses appear in `poses`. */
  bodyOrder: number[];
  /**
   * Flat float buffer: per frame, per body, 7 floats — translation (x,y,z)
   * followed by rotation quaternion (x,y,z,w). World-space.
   */
  poses: Float32Array;
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
  excludeIfcTypes: string[];
  colliderStrategy: ColliderStrategy;
  captureTrajectory: boolean;
  trajectoryStride: number;
  debug: boolean;
  maxLinearSpeed: number;
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
  excludeIfcTypes: [
    // Abstract volumes
    'IfcOpeningElement',
    'IfcSpace',
    'IfcZone',
    'IfcVirtualElement',
    // Furniture
    'IfcFurnishingElement',
    'IfcSystemFurnitureElement',
    // Architectural finishes & non-load-bearing
    'IfcWindow',
    'IfcDoor',
    'IfcRailing',
    'IfcCovering',
    'IfcCurtainWall',
    // Lighting / sanitary terminals
    'IfcLamp',
    'IfcLightFixture',
    'IfcSanitaryTerminal',
    // MEP — distribution / flow systems
    'IfcFlowSegment',
    'IfcFlowTerminal',
    'IfcFlowController',
    'IfcFlowFitting',
    'IfcFlowMovingDevice',
    'IfcFlowStorageDevice',
    'IfcFlowTreatmentDevice',
    'IfcDistributionElement',
    'IfcDistributionFlowElement',
    'IfcDistributionControlElement',
    'IfcEnergyConversionDevice',
  ],
  colliderStrategy: 'auto',
  captureTrajectory: false,
  trajectoryStride: 1,
  debug: false,
  maxLinearSpeed: 50,
};

export function resolveOptions(opts: SimulateOptions | undefined): ResolvedSimulateOptions {
  return {
    // Defensive copies — callers commonly reuse the same option object
    // across runs and we don't want mutations to leak back into them, nor
    // share references with DEFAULT_OPTIONS.
    remove: opts?.remove?.slice() ?? DEFAULT_OPTIONS.remove.slice(),
    anchor: opts?.anchor?.slice() ?? DEFAULT_OPTIONS.anchor.slice(),
    connections:
      opts?.connections?.map(([a, b]) => [a, b] as [number, number]) ??
      DEFAULT_OPTIONS.connections.slice(),
    gravity: opts?.gravity ? [...opts.gravity] : [...DEFAULT_OPTIONS.gravity],
    durationSeconds: opts?.durationSeconds ?? DEFAULT_OPTIONS.durationSeconds,
    timeStep: opts?.timeStep ?? DEFAULT_OPTIONS.timeStep,
    adjacencyTolerance: opts?.adjacencyTolerance ?? DEFAULT_OPTIONS.adjacencyTolerance,
    fallThreshold: opts?.fallThreshold ?? DEFAULT_OPTIONS.fallThreshold,
    tiltThreshold: opts?.tiltThreshold ?? DEFAULT_OPTIONS.tiltThreshold,
    groundAnchorTolerance: opts?.groundAnchorTolerance ?? DEFAULT_OPTIONS.groundAnchorTolerance,
    anchorIfcTypes: opts?.anchorIfcTypes?.slice() ?? DEFAULT_OPTIONS.anchorIfcTypes.slice(),
    excludeIfcTypes: opts?.excludeIfcTypes?.slice() ?? DEFAULT_OPTIONS.excludeIfcTypes.slice(),
    colliderStrategy: opts?.colliderStrategy ?? DEFAULT_OPTIONS.colliderStrategy,
    captureTrajectory: opts?.captureTrajectory ?? DEFAULT_OPTIONS.captureTrajectory,
    trajectoryStride: Math.max(1, Math.floor(opts?.trajectoryStride ?? DEFAULT_OPTIONS.trajectoryStride)),
    debug: opts?.debug ?? DEFAULT_OPTIONS.debug,
    maxLinearSpeed:
      opts?.maxLinearSpeed !== undefined && opts.maxLinearSpeed > 0
        ? opts.maxLinearSpeed
        : DEFAULT_OPTIONS.maxLinearSpeed,
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
  /** Per-frame trajectory, present only when `captureTrajectory` was set. */
  trajectory?: SimulationTrajectory;
}
