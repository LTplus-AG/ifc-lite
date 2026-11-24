/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Shared shapes and small helpers of the flat-batch draw stream (`draw-stream.ts`). */
import type { OpaqueDrawMode } from './opaque-draw-variants.js';
import type { OpaqueVisibilityPass } from './opaque-visibility-pass.js';
import type { HlodNode } from './draw-stream-hlod.js';

export type Vec3 = [number, number, number];

/** Per-batch inputs the renderer resolves when the stream (re)builds. */
export interface StreamBatchState {
  alpha: number;
  /** Colour-table anchor (`batchEntityIdAnchor`), null = none. */
  anchor: number | null;
  /** overrideParams.y as `packOverrideParams` writes it (0 = keep own colour). */
  overrideBits: number;
}

/** One spatial node (a chunk cell) of stream members, drawn as one bundle. */
export interface StreamNode {
  coords: Vec3;
  min: Vec3;
  max: Vec3;
  members: number[];          // indices into DrawStream.members
  tris0: number;
  tris1: number;
  entries: number;
  bundles: (GPURenderBundle | null)[]; // [mode * 2 + lod], mode = discardFree * 2 + objectId
  ortho: (GPURenderBundle | null)[];   // orthographic colour/depth pairs at orthoSlot(mode, lod)
}

/**
 * A culled node this frame: a leaf whose members all draw at LOD0 or all at
 * LOD1 (its cached bundles apply), a leaf whose members differ (`picks`, one
 * `MemberPick` per member, drawn without a cached bundle), or a ready HLOD
 * proxy standing in for a subtree.
 */
export type StreamItem = ({ leaf: StreamNode; lod1: boolean; picks?: Uint8Array; proxy?: undefined } | { proxy: HlodNode; leaf?: undefined; lod1?: undefined; picks?: undefined }) & { d: number; px: number };

/** A member's draw this frame, decided per batch like the per-batch loop: contribution-culled, LOD0, LOD1, or either LOD (no LOD1 range). */
export const MemberPick = { Cull: 0, Lod0: 1, Lod1: 2, AnyLod: 3 } as const;
export type MemberPick = (typeof MemberPick)[keyof typeof MemberPick];

export interface StreamFrameStats {
  nodes: number; nodesDrawn: number; draws: number; tris: number; bundlesRecorded: number; entries: number;
  /** Diagnostics: membership rebuilds so far, and bundle-cache invalidations so far. */
  syncs: number; invalidations: number;
  arenaBytes: number; budgetDraws: number; budgetCut: number; proxiesDrawn: number; proxyReady: number; proxyNodes: number; proxyBuildMs: number; proxyBytes: number;
  /** Nodes drawn directly this frame because the first-sight recording cap was reached. */
  directNodes?: number;
}

/** Camera projection the HLOD error test converts world error to screen px with. */
export interface StreamProjection {
  ortho: boolean;
  /** Orthographic half height in metres. */
  orthoHalfHeight: number;
  fovYRadians: number;
  /** Viewport height in CSS px. */
  viewportHeightPx: number;
}

export interface StreamFrameInputs {
  pass: GPURenderPassEncoder;
  mode: OpaqueDrawMode;
  /** Bundles are illegal inside the orthographic visibility proxy: draw directly there. */
  allowBundles: boolean;
  visible: (min: Vec3, max: Vec3) => boolean;
  /** Projected radius in CSS px, or Infinity when culling/LOD is off. */
  projectedPx: (min: Vec3, max: Vec3) => number;
  contribPx: number;
  lodPx: number;
  eye: { x: number; y: number; z: number };
  /** Orthographic frame: record colour + depth bundle pairs and replay them through the visibility pass. */
  ortho?: OpaqueVisibilityPass;
  projection: StreamProjection;
  /** Camera moving: the frame budget may cut the smallest nodes. */
  interacting: boolean;
}

/** Screen CSS px per world metre at distance `d`. */
export function pxPerMetre(p: StreamProjection, d: number): number {
  return p.ortho
    ? p.viewportHeightPx / (2 * Math.max(1e-9, p.orthoHalfHeight))
    : p.viewportHeightPx / (2 * Math.tan(p.fovYRadians / 2) * d);
}

/** Integer cell coordinates of an AABB's centre on a `cell`-sized grid. */
export function cellOf(min: readonly number[], max: readonly number[], cell: number): Vec3 {
  return [Math.floor((min[0]! + max[0]!) / 2 / cell), Math.floor((min[1]! + max[1]!) / 2 / cell), Math.floor((min[2]! + max[2]!) / 2 / cell)];
}

/** Grow `box` to contain the AABB `min`..`max`. */
export function growAabb(box: { min: number[]; max: number[] }, min: readonly number[], max: readonly number[]): void {
  for (let a = 0; a < 3; a++) { box.min[a] = Math.min(box.min[a]!, min[a]!); box.max[a] = Math.max(box.max[a]!, max[a]!); }
}

/** Orthographic bundle-pair index: [colour, depth] at `orthoSlot` and `+1`, per draw mode and LOD like perspective bundles. */
export const orthoSlot = (mode: number, lod1: boolean): number => (mode * 2 + (lod1 ? 1 : 0)) * 2;

/** Bundle-cache index of an opaque draw mode. */
export const modeIndex = (m: OpaqueDrawMode): number => (m.discardFree ? 2 : 0) + (m.objectId ? 1 : 0);

export function aabbDist2(min: readonly number[], max: readonly number[], p: { x: number; y: number; z: number }): number {
  const dx = Math.max(min[0]! - p.x, 0, p.x - max[0]!), dy = Math.max(min[1]! - p.y, 0, p.y - max[1]!), dz = Math.max(min[2]! - p.z, 0, p.z - max[2]!);
  return dx * dx + dy * dy + dz * dz;
}

const ids = new WeakMap<object, number>();
let nextId = 1;
/** Stable identity number of a GPU object, for bundle-cache keys. */
export function idOf(o: object): number { let v = ids.get(o); if (v === undefined) { v = nextId++; ids.set(o, v); } return v; }
