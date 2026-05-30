/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { AABB } from '@ifc-lite/spatial';

export type { AABB };

/** A 3-component vector `[x, y, z]`. */
export type Vec3 = [number, number, number];

/** A 4×4 transform, column-major, length 16. */
export type Mat4 = readonly number[];

/**
 * What a rule looks for between two solids:
 * - `hard`      interpenetration (penetration depth beyond tolerance)
 * - `clearance` separated but within the required gap
 */
export type ClashMode = 'hard' | 'clearance';

/** How a detected clash is classified. `touch` is suppressed unless opted in. */
export type ClashStatus = 'hard' | 'clearance' | 'touch';

export type ClashSeverity = 'critical' | 'major' | 'minor' | 'info';

/**
 * A representation-agnostic element fed to the clash core.
 *
 * Identity is deliberately split: a durable `key` (IfcGUID / USD prim path) for
 * persistence, BCF, dedup and lifecycle; and a runtime `ref` (federated globalId
 * / expressId) for selection and coloring in a renderer.
 *
 * `positions`/`indices` are world-frame triangles (the geometry-pipeline frame,
 * Y-up, RTC-shifted). `transform` is identity unless positions are kept local.
 */
export interface ClashElement {
  key: string;
  ref: number;
  model: string;
  tag: string;
  name?: string;
  storey?: string;
  bounds: AABB;
  positions: Float32Array;
  indices: Uint32Array;
  transform?: Mat4;
}

/** The element identity carried on a `Clash` (no geometry). */
export interface ClashElementRef {
  key: string;
  ref: number;
  model: string;
  tag: string;
  name?: string;
}

/** A single detection rule. Omit `b` for a self-clash within selection `a`. */
export interface ClashRule {
  id: string;
  name: string;
  /** Selector for set A (e.g. `IfcDuct*|IfcPipe*`, `!IfcSpace`). */
  a: string;
  /** Selector for set B. Omitted ⇒ self-clash within A. */
  b?: string;
  mode: ClashMode;
  /** Touching band (m). Defaults to the run-level tolerance. */
  tolerance?: number;
  /** Required gap (m) for `clearance` mode. */
  clearance?: number;
  /** Explicit severity; otherwise inferred from the discipline matrix. */
  severity?: ClashSeverity;
  /** Emit `touch`-classified results instead of suppressing them. */
  reportTouch?: boolean;
}

/** A set of rules run together (Navisworks-style clash matrix). */
export interface ClashMatrix {
  rules: ClashRule[];
}

export interface ClashProgress {
  phase: 'broad' | 'narrow';
  rule: string;
  done: number;
  total: number;
}

/** A precomputed set of element-`key` pairs to skip (voids/hosts/assemblies). */
export type ExclusionSet = Set<string>;

export interface ClashSettings {
  /** Default touching band (m). */
  tolerance?: number;
  /** Apply `exclusions` (voids/hosts/assemblies). Default true. */
  excludeVoidsAndHosts?: boolean;
  /** Pair-exclusion set from an adapter. */
  exclusions?: ExclusionSet;
  /** Safety cap on candidate pairs per rule. Reported in `result.truncated`. */
  maxCandidatePairs?: number;
  signal?: AbortSignal;
  onProgress?: (p: ClashProgress) => void;
}

export interface Clash {
  /** Stable id: derived from the two durable keys + rule id. */
  id: string;
  a: ClashElementRef;
  b: ClashElementRef;
  rule: string;
  status: ClashStatus;
  /** Signed: `<0` penetration depth, `>0` gap. */
  distance: number;
  /** True contact point (hard) or closest-point midpoint (clearance/touch). */
  point: Vec3;
  /** Overlap region (hard) or closest-segment box (clearance/touch). */
  bounds: AABB;
  severity: ClashSeverity;
}

export interface ClashSummary {
  total: number;
  byRule: Record<string, number>;
  byTypePair: Record<string, number>;
  bySeverity: Record<ClashSeverity, number>;
  byStorey?: Record<string, number>;
}

export interface ClashResult {
  clashes: Clash[];
  summary: ClashSummary;
  /** Present only when a cap dropped work — never silent. */
  truncated?: { reason: string; droppedPairs: number };
  rulesRun: ClashRule[];
  settings: { tolerance: number; excludeVoidsAndHosts: boolean };
}

/** A cluster of related clashes — the unit of a single BCF topic (Phase 2). */
export interface ClashGroup {
  id: string;
  title: string;
  members: Clash[];
  bounds: AABB;
  representativePoint: Vec3;
  severity: ClashSeverity;
  discipline?: string;
  storey?: string;
}

export const DEFAULT_CLASH_SETTINGS = {
  tolerance: 0.002,
  excludeVoidsAndHosts: true,
} as const;
