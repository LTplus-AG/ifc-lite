/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ValidationReport } from '@ifc-lite/ids';
import { CaptureRetention, type OwnedTarget as Target } from './capture-retention.js';
import { validationFindings } from './validation.js';
import { reviewSHA256, reviewValueFits, reviewContainsSecret } from './capture-budget.js';
import type { NativeReviewModel, NativeReviewResult, ReviewCaptureToken, ReviewRunProvenance,
  ReviewSourceProof } from './capture-types.js';



function targetState(target: Target, models: readonly NativeReviewModel[]) {
  const live = models.find(model => model.id === target.model.id);
  const replaced = !live || live.owner !== target.model.owner || live.store !== target.model.store || live.source !== target.model.source;
  return { replaced, stale: replaced || live?.mutationView() !== target.view
    || (target.view?.getMutationRevision() ?? 0) !== target.revision };
}

/** Actual producer-start ownership, never a reconstructed last-result fingerprint. */
export class NativeReviewCaptures {
  private readonly retention: CaptureRetention;
  // Owner-local credentials never enter captures, output, errors or persistence.
  private readonly credentials = new Set<string>();
  private credentialBytes = 0;
  private credentialBound = false;

  constructor(private readonly capacity = 32) {
    if (!Number.isSafeInteger(capacity) || capacity < 0 || capacity > 32) throw new Error('Invalid native Review capture bound');
    this.retention = new CaptureRetention(capacity);
  }

  /** Called only with values the actual run already resolved under its grants. */
  enrollCredentials(values: readonly string[]): void {
    if (this.credentialBound) return;
    if (values.length > 256) { this.credentialBound = true; return; }
    for (const supplied of values) {
      // Bound before encoding/trimming an arbitrarily large SDK input.
      if (supplied.length > 16_384) { this.credentialBound = true; return; }
      // Native XML text uses trim(); both exact known forms stay protected.
      const normalized = supplied.trim();
      for (const value of normalized === supplied ? [supplied] : [supplied, normalized]) {
        if (!value || this.credentials.has(value)) continue;
        const bytes = new TextEncoder().encode(value).byteLength;
        if (this.credentials.size >= 128 || bytes > 16_384 || this.credentialBytes + bytes > 1_048_576) {
          // Retain all previously known values and permanently fail this owner
          // closed; dropping an old value would reopen an earlier capture leak.
          this.credentialBound = true; return;
        }
        this.credentials.add(value); this.credentialBytes += bytes;
      }
    }
  }

  acceptsEvidence(value: unknown): boolean {
    if (this.credentialBound) return false;
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string'
      && !reviewContainsSecret(serialized, [...this.credentials]);
  }

  private protect(result: NativeReviewResult): void {
    if (this.acceptsEvidence(result)) return;
    result.runs = []; result.findings = []; result.provenance = []; result.coverage = []; result.latestAttempt = null;
    result.availability = 'unavailable'; result.refusal = this.credentialBound ? 'work-bound' : 'sensitive-input';
  }

  async begin(producer: 'ids' | 'rules', definition: string, models: readonly NativeReviewModel[], liveModels: () => readonly NativeReviewModel[],
    allowed: (id: string) => boolean, signal?: AbortSignal): Promise<ReviewCaptureToken | null> {
    if (!models.length || models.length > 64 || definition.length > 1_048_576
      || models.some(m => m.id.length > 1_024 || m.name.length > 4_096)
      || models.reduce((sum, m) => sum + m.source.byteLength, 0) > 67_108_864) {
      this.retention.refuse([], 'work-bound'); return null;
    }
    if (!this.acceptsEvidence([definition, models.map(model => [model.id, model.name])])) {
      this.retention.refuse([], this.credentialBound ? 'work-bound' : 'sensitive-input'); return null;
    }
    // Reserve before ANY proof await. Settled native contexts use a separate
    // bounded role and never make this a lifetime limit on valid analysis.
    const attempt = this.retention.reserve(models);
    if (!attempt) return null;
    const refuse = (code: NativeReviewResult['refusal']) => {
      this.retention.fail(attempt, code, code === 'aborted' ? 'aborted' : 'refused'); return null;
    };
    if (signal?.aborted) return refuse('aborted');
    if (models.some(m => !m.source.byteLength || !m.source.contentKey)) return refuse('source-unavailable');
    try {
      const targets: Target[] = [];
      for (const model of models) {
        const view = model.mutationView();
        const revision = view?.getMutationRevision() ?? 0;
        const proof: ReviewSourceProof = { modelId: model.id, sourceByteLength: model.source.byteLength,
          sourceSHA256: await model.source.withMaterializedAsync(reviewSHA256) };
        if (model.mutationView() !== view || (view?.getMutationRevision() ?? 0) !== revision) return refuse('target-changed');
        targets.push({ model, view, revision, proof });
      }
      const provenance: ReviewRunProvenance = { runId: attempt.token.runId, producer,
        definitionSHA256: await reviewSHA256(new TextEncoder().encode(definition)), capturedAt: new Date().toISOString(),
        sources: targets.map(x => x.proof), origin: 'captured' };
      const current = liveModels();
      if (signal?.aborted) return refuse('aborted');
      if (targets.some(target => !allowed(target.model.id))) return refuse('scope');
      if (current.length > 64 || targets.some(target => targetState(target, current).stale)) return refuse('target-changed');
      if (!this.acceptsEvidence([definition, models.map(model => [model.id, model.name])])) {
        return refuse(this.credentialBound ? 'work-bound' : 'sensitive-input');
      }
      // The pending reservation is still held. No await separates final
      // ownership/permission checks and attaching the proven producer context.
      this.retention.prepare(attempt, targets, provenance);
      return attempt.token;
    } catch {
      // Failures release reservations and retain no raw exception/definition.
      return refuse(signal?.aborted ? 'aborted' : 'source-unavailable');
    }
  }

  /** Release only this producer's pending reservation; never delete settled facts. */
  abandon(token: ReviewCaptureToken | null, reason: 'producer-failed' | 'aborted' = 'producer-failed'): void {
    if (!token) return;
    const attempt = this.retention.pending.get(token.runId);
    if (!attempt) return;
    if (attempt.token !== token) throw new Error('Unknown native Review producer capture');
    this.retention.fail(attempt, reason, reason === 'aborted' ? 'aborted' : 'failed');
  }

  finish(token: ReviewCaptureToken | null, report: ValidationReport): void {
    if (!token) return;
    const attempt = this.retention.pending.get(token.runId);
    if (!attempt || attempt.token !== token || !attempt.targets || !attempt.provenance) throw new Error('Unknown native Review producer capture');
    const targets = attempt.targets;
    const provenance = attempt.provenance;
    if (reviewValueFits(report) && !this.acceptsEvidence(report)) {
      this.retention.fail(attempt, this.credentialBound ? 'work-bound' : 'sensitive-input', 'refused'); return;
    }
    const targetIds = new Set(targets.map(x => x.model.id));
    if (report.source.kind !== provenance.producer || !reviewValueFits(report) || report.specificationResults.length > 256
      || report.modelInfo.some(x => !targetIds.has(x.modelId))
      || report.specificationResults.some(spec => spec.entityResults.some(x => !targetIds.has(x.modelId)))) {
      this.retention.fail(attempt, 'capture-bound', 'refused'); return;
    }
    const actualTargets = new Set(report.modelInfo.map(x => x.modelId));
    if (actualTargets.size !== targetIds.size || [...targetIds].some(id => !actualTargets.has(id))) {
      this.retention.fail(attempt, 'target-changed', 'refused'); return;
    }
    const facts = structuredClone(validationFindings({ report, stale: false }, targets.map(x => x.model)));
    if (targets.some(x => x.revision > 0)) for (const run of facts.runs) {
      // These native MCP inputs do not prove complete effective-overlay
      // attributes/properties. Preserve their native rows without inventing it.
      run.complete = false; run.incomplete.push({ code: 'partial-source' });
    }
    const coverage = report.specificationResults.map(spec => ({ specificationId: spec.specification.id,
      applicableCount: spec.applicableCount, passedCount: spec.passedCount, failedCount: spec.failedCount,
      detailRows: spec.entityResults.length }));
    attempt.provenance = { ...provenance, capturedAt: new Date().toISOString() };
    this.retention.complete(attempt, facts, coverage);
  }

  async read<T>(liveModels: () => readonly NativeReviewModel[], allowed: (modelId: string) => boolean, project: (result: NativeReviewResult) => T, requested: (modelId: string) => boolean = () => true): Promise<T> {
    const result: NativeReviewResult = { runs: [], findings: [], provenance: [], coverage: [], availability: 'not-run' };
    if (this.capacity === 0) { result.availability = 'unavailable'; result.refusal = 'work-bound'; }
    let sourceWork = 0;
    const hashes = new Map<object, string>();
    const pending: { capture: import('./capture-retention.js').SettledCapture; stale: boolean; replaced: boolean }[] = [];
    const retained = [...this.retention.settled.values()];
    for (const capture of retained) {
      // A scope change suppresses the WHOLE target envelope, including totals,
      // names and proof digests, even when the matching failure row is allowed.
      if (capture.targets.some(x => !allowed(x.model.id))) {
        result.availability = 'unavailable'; result.refusal = 'scope'; continue;
      }
      const selected = capture.targets.filter(target => requested(target.model.id));
      if (selected.length === 0) continue;
      if (selected.length !== capture.targets.length) {
        result.availability = 'unavailable'; result.refusal = 'scope'; continue;
      }
      let stale = false;
      let replaced = false;
      for (const target of capture.targets) {
        const live = liveModels().find(x => x.id === target.model.id);
        if (!live || live.owner !== target.model.owner || live.store !== target.model.store || live.source !== target.model.source
          || live.mutationView() !== target.view || (target.view?.getMutationRevision() ?? 0) !== target.revision) {
          stale = true;
          if (!live || live.owner !== target.model.owner || live.store !== target.model.store || live.source !== target.model.source) replaced = true;
          continue;
        }
        let hash = hashes.get(live.source);
        if (hash === undefined) {
          sourceWork += live.source.byteLength;
          if (sourceWork > 67_108_864 || !live.source.byteLength) {
            result.availability = 'unavailable'; result.refusal = 'work-bound'; stale = true; continue;
          }
          try { hash = await live.source.withMaterializedAsync(reviewSHA256); }
          catch { result.availability = 'unavailable'; result.refusal = 'source-unavailable'; stale = true; continue; }
          hashes.set(live.source, hash);
        }
        if (hash !== target.proof.sourceSHA256) { stale = true; replaced = true; }
      }
      pending.push({ capture, stale, replaced });
    }
    // No await follows this final live ownership/permission pass. Earlier
    // captures must also be checked after later captures have finished hashing.
    if (this.retention.settled.size !== retained.length
      || retained.some(capture => this.retention.settled.get(capture.attempt.token.runId) !== capture)) {
      return project({ runs: [], findings: [], provenance: [], coverage: [], availability: 'unavailable', refusal: 'capture-bound' });
    }
    if (retained.some(capture => capture.targets.some(target => !allowed(target.model.id)))) {
      result.availability = 'unavailable'; result.refusal = 'scope';
    }
    const current = liveModels();
    if (current.length > 64) return project({ runs: [], findings: [], provenance: [], coverage: [], availability: 'unavailable', refusal: 'work-bound' });
    for (const item of pending) {
      const { capture } = item;
      if (capture.targets.some(target => !allowed(target.model.id) || !requested(target.model.id))) {
        result.availability = 'unavailable'; result.refusal = 'scope'; continue;
      }
      const states = capture.targets.map(target => targetState(target, current));
      const stale = item.stale || states.some(state => state.stale);
      const replaced = item.replaced || states.some(state => state.replaced);
      const facts = structuredClone(capture.facts);
      if (capture.laterFailure) for (const run of facts.runs) {
        run.temporal = 'historical'; run.complete = false;
        run.incomplete.push({ code: 'check-error', detail: 'A later native producer attempt failed; these facts are earlier evidence' });
      }
      if (stale) for (const run of facts.runs) { run.complete = false; run.incomplete.push({ code: 'stale' }); }
      if (replaced) for (const finding of facts.findings) for (const element of finding.elements) element.nativeUnresolved = 'unmatched';
      for (const run of facts.runs) {
        const oldId = run.id; run.id = capture.attempt.token.runId;
        for (const finding of facts.findings) if (finding.run === run) finding.id = finding.id.replace(oldId, run.id);
      }
      for (const run of facts.runs) result.runs.push(run);
      for (const finding of facts.findings) result.findings.push(finding);
      result.provenance.push(structuredClone(capture.provenance));
      result.coverage.push({ runId: capture.attempt.token.runId, specifications: structuredClone(capture.coverage ?? []) });
      if (result.availability !== 'unavailable') result.availability = 'available';
    }
    const latest = this.retention.latest;
    if (latest && (latest.models.length === 0 || latest.models.every(model => allowed(model.id) && requested(model.id)))) {
      result.latestAttempt = { state: latest.outcome, ...(latest.refusal ? { refusal: latest.refusal } : {}),
        proof: latest.provenance ? structuredClone(latest.provenance) : null };
      if (latest.outcome === 'pending' || latest.refusal) {
        result.availability = 'unavailable'; result.refusal = latest.refusal ?? 'producer-pending';
      }
    } else {
      result.latestAttempt = null;
      if (latest?.models.some(model => requested(model.id))
        && latest.models.some(model => !allowed(model.id) || !requested(model.id))) {
        result.availability = 'unavailable'; result.refusal = 'scope';
      }
    }
    result.retention = { policy: 'latest-successful-native-context', limit: this.capacity,
      inventoryOmitted: this.retention.inventoryOmitted, omittedHistoricalRuns: null, captureRefusal: this.retention.captureRefusal };
    this.protect(result);
    return project(result);
  }
}
