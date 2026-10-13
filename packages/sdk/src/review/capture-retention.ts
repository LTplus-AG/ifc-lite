/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { NativeReviewModel, NativeReviewResult, ReviewCaptureToken, ReviewRunProvenance,
  ReviewSourceProof, ReviewSpecificationCoverage } from './capture-types.js';
import type { FindingSourceResult } from './types.js';

export interface OwnedTarget {
  model: NativeReviewModel;
  view: ReturnType<NativeReviewModel['mutationView']>;
  revision: number;
  proof: ReviewSourceProof;
}
export interface CaptureAttempt {
  token: ReviewCaptureToken;
  models: readonly NativeReviewModel[];
  order: number | null;
  outcome: 'pending' | 'succeeded' | 'failed' | 'aborted' | 'refused' | 'superseded';
  refusal?: NativeReviewResult['refusal'];
  targets?: OwnedTarget[];
  provenance?: ReviewRunProvenance;
  superseded: boolean;
  proofHistoryUncertain?: boolean;
  laterFailure?: NativeReviewResult['refusal'];
}
export interface SettledCapture {
  attempt: CaptureAttempt;
  targets: OwnedTarget[];
  provenance: ReviewRunProvenance;
  facts: FindingSourceResult;
  coverage: ReviewSpecificationCoverage[];
  laterFailure?: NativeReviewResult['refusal'];
}
function sameContext(a: CaptureAttempt, b: CaptureAttempt): boolean {
  if (!a.provenance || !b.provenance || !a.targets || !b.targets) return false;
  return a.provenance.producer === b.provenance.producer
    && a.provenance.definitionSHA256 === b.provenance.definitionSHA256
    && a.targets.length === b.targets.length && a.targets.every(target => b.targets?.some(other =>
      target.model.id === other.model.id && target.model.owner === other.model.owner
      && target.model.store === other.model.store && target.model.source === other.model.source
      && target.proof.sourceSHA256 === other.proof.sourceSHA256
      && target.proof.sourceByteLength === other.proof.sourceByteLength));
}

/** Two bounded roles: pending reservations and latest successful native contexts. */
export class CaptureRetention {
  readonly pending = new Map<string, CaptureAttempt>();
  readonly settled = new Map<string, SettledCapture>();
  latest: CaptureAttempt | null = null;
  inventoryOmitted = false;
  captureRefusal: 'capture-bound' | null = null;
  private order = 0;
  constructor(readonly capacity: number) {}

  private nextOrder(): number {
    // Only relative ordering among at most 65 live records matters. Resequence
    // before a fixed bound; never accumulate lifetime counters or tombstones.
    if (this.order >= 128) {
      const records = new Set([...this.pending.values(), ...[...this.settled.values()].map(x => x.attempt),
        ...(this.latest ? [this.latest] : [])]);
      const ordered = [...records].filter(x => x.order !== null).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      ordered.forEach((item, index) => { item.order = index + 1; }); this.order = ordered.length;
    }
    return ++this.order;
  }
  private replaceLatest(next: CaptureAttempt): void {
    const previous = this.latest;
    if (previous?.refusal && previous.provenance && previous.targets) {
      for (const pending of this.pending.values()) {
        if ((pending.order ?? -1) >= (previous.order ?? -1)) continue;
        if (!pending.targets) pending.proofHistoryUncertain = true;
        else if (sameContext(previous, pending)) pending.laterFailure = previous.refusal;
      }
    }
    this.latest = next;
  }
  refuse(models: readonly NativeReviewModel[], refusal: NativeReviewResult['refusal']): void {
    this.replaceLatest({ token: { runId: crypto.randomUUID() }, models, order: this.nextOrder(),
      outcome: 'refused', refusal, superseded: false });
  }
  reserve(models: readonly NativeReviewModel[]): CaptureAttempt | null {
    if (this.pending.size >= this.capacity) { this.refuse(models, 'work-bound'); return null; }
    const attempt: CaptureAttempt = { token: { runId: crypto.randomUUID() }, models, order: this.nextOrder(),
      outcome: 'pending', superseded: false };
    this.pending.set(attempt.token.runId, attempt); this.replaceLatest(attempt);
    return attempt;
  }
  prepare(attempt: CaptureAttempt, targets: OwnedTarget[], provenance: ReviewRunProvenance): void {
    if (this.pending.get(attempt.token.runId) !== attempt) throw new Error('Native Review reservation is no longer pending');
    // Proof completion cannot turn an older attempt into the latest operation.
    attempt.targets = targets; attempt.provenance = provenance;
    if ([...this.settled.values()].some(capture => sameContext(attempt, capture.attempt)
      && (capture.attempt.order ?? -1) > (attempt.order ?? -1))) attempt.superseded = true;
  }
  fail(attempt: CaptureAttempt, refusal: NativeReviewResult['refusal'], outcome: 'failed' | 'aborted' | 'refused'): void {
    if (this.pending.get(attempt.token.runId) !== attempt) return;
    this.pending.delete(attempt.token.runId); attempt.outcome = outcome; attempt.refusal = refusal;
    for (const other of this.pending.values()) {
      if (sameContext(attempt, other) && (attempt.order ?? -1) > (other.order ?? -1)) other.laterFailure = refusal;
      // A proven failure that is no longer latest has no retained descriptor
      // for a later proof to compare. Preserve bounded uncertainty instead of
      // treating an older, currently unproven context as a current success.
      else if (this.latest !== attempt && attempt.provenance && attempt.targets && !other.targets
        && (other.order ?? -1) < (attempt.order ?? -1)) other.proofHistoryUncertain = true;
    }
    for (const capture of this.settled.values()) {
      if (sameContext(attempt, capture.attempt) && (attempt.order ?? -1) > (capture.attempt.order ?? -1)) capture.laterFailure = refusal;
    }
  }
  complete(attempt: CaptureAttempt, facts: FindingSourceResult, coverage: ReviewSpecificationCoverage[]): void {
    if (!attempt.targets || !attempt.provenance || attempt.order === null) throw new Error('Native Review reservation has no producer proof');
    const matching = [...this.settled.values()].find(capture => sameContext(attempt, capture.attempt));
    this.pending.delete(attempt.token.runId);
    if (attempt.superseded || matching && (matching.attempt.order ?? -1) > attempt.order) {
      attempt.outcome = 'superseded'; return;
    }
    const latest = this.latest;
    if (latest?.refusal && (latest.order ?? -1) > attempt.order && sameContext(attempt, latest)) {
      attempt.laterFailure = latest.refusal;
    }
    if (attempt.proofHistoryUncertain) {
      // Missing bounded history cannot prove that this old proof was not
      // superseded. Refuse its capture, preserving the independent report.
      attempt.outcome = 'refused'; attempt.refusal = 'capture-bound'; this.captureRefusal = 'capture-bound';
      this.inventoryOmitted = true; return;
    }
    for (const other of this.pending.values()) {
      if (sameContext(attempt, other) && (other.order ?? Number.POSITIVE_INFINITY) < attempt.order) other.superseded = true;
    }
    if (matching) this.settled.delete(matching.attempt.token.runId);
    else if (this.settled.size >= this.capacity) {
      const oldest = this.settled.keys().next().value;
      if (oldest === undefined) throw new Error('Native Review retention has no settled context to retire');
      for (const other of this.pending.values()) {
        if (!other.targets && (other.order ?? -1) < attempt.order) other.proofHistoryUncertain = true;
      }
      this.settled.delete(oldest); this.inventoryOmitted = true;
    }
    attempt.outcome = 'succeeded';
    this.settled.set(attempt.token.runId, { attempt, targets: attempt.targets, provenance: attempt.provenance, facts, coverage, ...(attempt.laterFailure ? { laterFailure: attempt.laterFailure } : {}) });
  }
}
