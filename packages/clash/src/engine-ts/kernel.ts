/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { AABB, ClashElement, ClashRule, ClashStatus, Vec3 } from '../types.js';

/**
 * One detected clash, in kernel terms: a pair of GLOBAL element indices plus the
 * geometric verdict. The orchestrator turns this into a `Clash` (identity,
 * severity, exclusions). This is the seam between orchestration (shared, pure
 * TypeScript) and the geometry kernel (TypeScript today, Rust/WASM in Phase 3).
 */
export interface NarrowRecord {
  /** Global index into the ingested `elements` array. */
  a: number;
  /** Global index into the ingested `elements` array. */
  b: number;
  status: ClashStatus;
  distance: number;
  point: Vec3;
  bounds: AABB;
}

export interface RuleDetection {
  records: NarrowRecord[];
  /** Candidate pairs skipped by a `maxPairs` cap (for transparency). */
  candidatesDropped: number;
}

/**
 * The geometry backend: broad phase + narrow phase for one rule. Implementations
 * must be interchangeable — given the same elements and rule they produce the
 * same records (modulo floating-point), which is what the differential test
 * pins. Selection, exclusions, severity and identity live in the orchestrator,
 * never here.
 */
export interface ClashKernel {
  /** Ingest the elements once (build any indices). */
  prepare(elements: ClashElement[]): void;
  /**
   * Detect clashes for one rule. `groupA`/`groupB` are GLOBAL element indices;
   * `groupB === null` means a self-clash within `groupA`. Returned records carry
   * GLOBAL element indices. `maxPairs` caps candidate pairs (Infinity = no cap).
   */
  detectRule(
    elements: ClashElement[],
    groupA: number[],
    groupB: number[] | null,
    rule: ClashRule,
    tolerance: number,
    maxPairs: number,
  ): RuleDetection;
  /** Release any resources (e.g. a WASM session). Optional. */
  dispose?(): void;
}
