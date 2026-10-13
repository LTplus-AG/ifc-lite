/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcSourceBytes } from '@ifc-lite/parser';
import type { ReviewModel, FindingSourceResult } from './types.js';

/** A real host-owned source. Reading this contract never allocates an editor. */
export interface NativeReviewModel extends ReviewModel {
  readonly owner: object;
  readonly store: object;
  readonly source: IfcSourceBytes;
  mutationView(): { getMutationRevision(): number } | null;
  /** Actual columnar rows, preserving duplicate GUIDs/EXPRESS identities.
   * A point lookup cannot establish multiplicity. Missing support stays unknown.
   */
  readonly identityTable?: {
    readonly owner: object;
    readonly expressIdColumn: Uint32Array;
    readonly GlobalIdColumn: Uint32Array;
    readonly stringTable: object;
    readonly count: number;
    rows(): Iterable<{ expressId: number; GlobalId: string }>;
  };
}

export interface ReviewSourceProof {
  readonly modelId: string;
  readonly sourceSHA256: string;
  readonly sourceByteLength: number;
}

export interface ReviewRunProvenance {
  readonly runId: string;
  readonly producer: 'ids' | 'rules';
  readonly definitionSHA256: string;
  readonly capturedAt: string;
  readonly sources: readonly ReviewSourceProof[];
  readonly origin: 'captured';
}

export interface ReviewSpecificationCoverage {
  readonly specificationId: string;
  readonly applicableCount: number;
  readonly passedCount: number;
  readonly failedCount: number;
  readonly detailRows: number;
}

export interface NativeReviewResult extends FindingSourceResult {
  provenance: ReviewRunProvenance[];
  retention?: { policy: 'latest-successful-native-context'; limit: number; inventoryOmitted: boolean; omittedHistoricalRuns: null; captureRefusal: 'capture-bound' | null };
  latestAttempt?: { state: 'pending' | 'succeeded' | 'failed' | 'aborted' | 'refused' | 'superseded';
    refusal?: NativeReviewResult['refusal']; proof: ReviewRunProvenance | null } | null;
  coverage: Array<{ runId: string; specifications: ReviewSpecificationCoverage[] }>;
  availability: 'available' | 'not-run' | 'unavailable';
  /** Closed host facts, never a raw exception or unauthorized model label. */
  refusal?: 'source-unavailable' | 'work-bound' | 'capture-bound' | 'target-changed' | 'scope' | 'sensitive-input' | 'producer-pending' | 'producer-failed' | 'aborted';
}

export interface ReviewCaptureToken {
  readonly runId: string;
}
