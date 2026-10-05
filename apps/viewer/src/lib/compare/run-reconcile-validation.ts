/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Validation run reconciliation across a comparison's base and head (#6921).
 *
 * A finding is one failing entity result of one specification, identified
 * across revisions by `<specification id> <GlobalId>`. A base failure is
 * `resolved` only when the head run holds an explicit PASSING result for the
 * same specification and GlobalId. Absence — a capped run, passing entities
 * omitted, a specification that errored, an element no longer applicable or
 * deleted — is `notEvaluated`, never resolution.
 */

import type { EntityResult, SpecificationResult } from '@ifc-lite/ids';
import { emptyCounts, type CapturedRun, type Incompatibility, type ReconcileContext,
  type ReconciledFinding, type ReconcileOutcome } from './run-reconcile-types';

type ValidationRun = Extract<CapturedRun, { kind: 'validation' }>;

function sourceDigest(run: ValidationRun): string {
  const source = run.report.source;
  return source.kind === 'ids'
    ? JSON.stringify(['ids', source.document.specifications])
    : JSON.stringify(['rules', source.ruleSet.name, source.ruleSet.fileName ?? null]);
}

function sourceTitle(run: ValidationRun): string {
  const source = run.report.source;
  return source.kind === 'ids' ? source.document.info.title || 'IDS' : source.ruleSet.name;
}

function specDigest(spec: SpecificationResult): string {
  const s = spec.specification;
  return JSON.stringify([s.id, s.name, s.severity ?? 'error', s.ifcVersions ?? null]);
}

export function validationIncompatibilities(base: ValidationRun, head: ValidationRun, ctx: Pick<ReconcileContext, 'baseModelId' | 'headModelId'>): Incompatibility[] {
  const out: Incompatibility[] = [];
  if (!base.report.modelInfo.some(m => m.modelId === ctx.baseModelId)) out.push({ code: 'baseModelNotInRun' });
  if (!head.report.modelInfo.some(m => m.modelId === ctx.headModelId)) out.push({ code: 'headModelNotInRun' });
  if (base.report.source.kind !== head.report.source.kind || sourceDigest(base) !== sourceDigest(head)) {
    out.push({ code: 'sourceDiffers', detail: `${sourceTitle(base)} / ${sourceTitle(head)}` });
  }
  const a = new Map(base.report.specificationResults.map(spec => [spec.specification.id, specDigest(spec)]));
  const b = new Map(head.report.specificationResults.map(spec => [spec.specification.id, specDigest(spec)]));
  const differing = [...new Set([...a.keys(), ...b.keys()])].filter(id => a.get(id) !== b.get(id)).sort();
  if (differing.length) out.push({ code: 'specificationsDiffer', detail: differing.join(', ') });
  return out;
}

const failingSignature = (entity: EntityResult) => JSON.stringify(entity.requirementResults
  .filter(r => r.status === 'fail').map(r => [r.requirement.id, r.actualValue ?? null]).sort());

const entityLabel = (spec: SpecificationResult, entity: EntityResult) =>
  `${spec.specification.name}: ${entity.entityType} ${entity.globalId ?? ''}${entity.entityName ? ` (${entity.entityName})` : ''}`;

export function reconcileValidationRuns(base: ValidationRun, head: ValidationRun, ctx: ReconcileContext): ReconcileOutcome {
  const counts = emptyCounts();
  const findings: ReconciledFinding[] = [];
  const push = (finding: ReconciledFinding) => { counts[finding.state]++; findings.push(finding); };
  const headSpecs = new Map(head.report.specificationResults.map(spec => [spec.specification.id, spec]));
  let excluded = 0;
  let partial = false;
  for (const baseSpec of base.report.specificationResults) {
    const id = baseSpec.specification.id;
    const headSpec = headSpecs.get(id);
    const failures = new Map<string, EntityResult>();
    for (const entity of baseSpec.entityResults) {
      if (entity.modelId !== ctx.baseModelId || entity.passed) continue;
      if (entity.globalId) failures.set(entity.globalId, entity); else excluded++;
    }
    const current = new Map<string, EntityResult>();
    for (const entity of headSpec?.entityResults ?? []) {
      if (entity.modelId !== ctx.headModelId) continue;
      if (entity.globalId) current.set(entity.globalId, entity); else if (!entity.passed) excluded++;
    }
    const headCount = headSpec ? headSpec.entityResults.filter(e => e.modelId === ctx.headModelId).length : 0;
    // A run that evaluated fewer entities than it found applicable is partial.
    if (!headSpec || headSpec.error || headCount < headSpec.applicableCount) partial = true;
    for (const globalId of [...new Set([...failures.keys(), ...current.keys()])].sort()) {
      const before = failures.get(globalId), after = current.get(globalId);
      const identity = `${id} ${globalId}`;
      const occurrence = (e: EntityResult) => `${e.modelId}#${e.expressId}`;
      if (before && after && !after.passed) {
        const changed = failingSignature(before) !== failingSignature(after);
        push({ state: changed ? 'changed' : 'persisting', identity, baseOccurrence: occurrence(before), headOccurrence: occurrence(after),
          label: entityLabel(baseSpec, after), ...(changed ? { changes: ['failedRequirements'] } : {}) });
      } else if (before) {
        const reason = headSpec?.error ? 'specificationError' as const : !after ? 'entityNotEvaluated' as const : null;
        push(reason
          ? { state: 'notEvaluated', identity, baseOccurrence: occurrence(before), label: entityLabel(baseSpec, before), reason }
          : { state: 'resolved', identity, baseOccurrence: occurrence(before), ...(after ? { headOccurrence: occurrence(after) } : {}),
            label: entityLabel(baseSpec, before) });
      } else if (after && !after.passed && headSpec) {
        push({ state: 'new', identity, headOccurrence: occurrence(after), label: entityLabel(headSpec, after) });
      }
    }
  }
  return { ok: true, kind: 'validation', baseRunId: base.id, headRunId: head.id, counts, findings,
    partial: partial || counts.notEvaluated > 0, excluded };
}
