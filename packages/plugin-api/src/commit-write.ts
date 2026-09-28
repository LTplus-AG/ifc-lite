/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// ============================================================================
// Writes: creating a model, and creating a commit on it.
//
// Only providers declaring `capabilities.commits.write` implement these. The
// host path that uses them is the revision resolver — a user opening or
// uploading a file, being asked "is this a new version of a model you
// already have?", and answering.
// ============================================================================

import type { IdentityEntryLike } from './commit-history.js';

export interface CreateModelInput {
  readonly projectId: string;
  readonly name: string;
  readonly containerId?: string;
  readonly discipline?: string;
  readonly meta?: Record<string, unknown>;
}

/** What the user decided about a file the resolver offered candidates for. */
export type RevisionDecision = 'revision-of' | 'new-model';

/**
 * The resolver's record of that decision, stored with the commit so a later
 * reader can see WHY this file was filed under this model — and by what
 * evidence, since matching is heuristic and the person, not the resolver,
 * made the call. Opaque to the provider except for storage.
 */
export interface RevisionResolutionRecord {
  readonly decision: RevisionDecision;
  readonly candidateModelId?: string;
  readonly candidateCommitId?: string;
  /** Resolver package and version, e.g. `@ifc-lite/model-match@0.1.0`. */
  readonly resolver: string;
  readonly verdict: string;
  readonly evidence: Readonly<Record<string, string | number | boolean>>;
  readonly decidedAt: string;
}

export interface CreateCommitInput {
  readonly projectId: string;
  readonly modelId: string;
  /**
   * The head the caller evaluated against; `null` for a new model's first
   * commit. A mismatch throws `conflict` rather than silently branching —
   * two people uploading the same model minutes apart is the ordinary case,
   * not the exotic one.
   */
  readonly expectedParentId: string | null;
  readonly fileName: string;
  readonly bytes: ArrayBuffer;
  readonly message?: string;
  /** Client-generated UUID. Replaying a call with the same key returns the same commit. */
  readonly idempotencyKey: string;
  readonly resolution?: RevisionResolutionRecord;
  /** Reviewed element identity against `expectedParentId`, if any. */
  readonly identity?: readonly IdentityEntryLike[];
  readonly signal?: AbortSignal;
  readonly onProgress?: (sent: number, total?: number) => void;
}
