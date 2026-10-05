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
 * deleted — is `notEvaluated`, never resolution. The base side is held to
 * the same standard: a head failure is `new` only when the base run left no
 * gap for that specification or explicitly evaluated the element.
 *
 * Runs are compatible only when they checked the same content: the IDS
 * specifications, or the rule-set file and each rule as the runner recorded
 * them. A rules report whose content was not recorded is refused as unknown.
 */

import type { EntityResult, SpecificationResult } from '@ifc-lite/ids';
import { reportRuleSetOf } from '@/lib/validation/report-rule-set';
import { emptyCounts, type CapturedRun, type Incompatibility, type ReconcileContext,
  type ReconciledFinding, type ReconcileOutcome } from './run-reconcile-types';

type ValidationRun = Extract<CapturedRun, { kind: 'validation' }>;

/** What the run checked; null when a rules report's content was not recorded. */
function sourceDigest(run: ValidationRun): string | null {
  const source = run.report.source;
  if (source.kind === 'ids') return JSON.stringify(['ids', source.document.specifications]);
  const content = reportRuleSetOf(run.report);
  return content ? JSON.stringify(['rules', source.ruleSet.fileName ?? null, content.file]) : null;
}

function sourceTitle(run: ValidationRun): string {
  const source = run.report.source;
  return source.kind === 'ids' ? source.document.info.title || 'IDS' : source.ruleSet.name;
}

function specDigest(run: ValidationRun, spec: SpecificationResult): string {
  const rule = run.report.source.kind === 'rules' ? reportRuleSetOf(run.report)?.rules.get(spec.specification.id) ?? null : null;
  return JSON.stringify([spec.specification, rule]);
}

export function validationIncompatibilities(base: ValidationRun, head: ValidationRun, ctx: Pick<ReconcileContext, 'baseModelId' | 'headModelId'>): Incompatibility[] {
  const out: Incompatibility[] = [];
  if (!base.report.modelInfo.some(m => m.modelId === ctx.baseModelId)) out.push({ code: 'baseModelNotInRun' });
  if (!head.report.modelInfo.some(m => m.modelId === ctx.headModelId)) out.push({ code: 'headModelNotInRun' });
  const sources = [sourceDigest(base), sourceDigest(head)];
  if (sources.includes(null)) out.push({ code: 'sourceUnknown' });
  else if (base.report.source.kind !== head.report.source.kind || sources[0] !== sources[1]) {
    out.push({ code: 'sourceDiffers', detail: `${sourceTitle(base)} / ${sourceTitle(head)}` });
  }
  // Unknown rule content cannot be compared per specification either.
  if (sources.includes(null)) return out;
  const a = new Map(base.report.specificationResults.map(spec => [spec.specification.id, specDigest(base, spec)]));
  const b = new Map(head.report.specificationResults.map(spec => [spec.specification.id, specDigest(head, spec)]));
  const differing = [...new Set([...a.keys(), ...b.keys()])].filter(id => a.get(id) !== b.get(id)).sort();
  if (differing.length) out.push({ code: 'specificationsDiffer', detail: differing.join(', ') });
  return out;
}

const failingSignature = (entity: EntityResult) => JSON.stringify(entity.requirementResults
  .filter(r => r.status === 'fail').map(r => [r.requirement.id, r.actualValue ?? null]).sort());

const entityLabel = (spec: SpecificationResult, entity: EntityResult) =>
  `${spec.specification.name}: ${entity.entityType} ${entity.globalId ?? ''}${entity.entityName ? ` (${entity.entityName})` : ''}`;

/** A specification result that lists fewer entities than it found applicable, or that errored. */
const hasGap = (spec: SpecificationResult | undefined) => !spec || !!spec.error || spec.entityResults.length < spec.applicableCount;

/** One model's results of one specification by GlobalId; a GlobalId carried twice has no identity. */
function byGlobalId(spec: SpecificationResult | undefined, modelId: string) {
  const results = new Map<string, EntityResult>();
  const duplicated = new Set<string>();
  let unidentified = 0;
  for (const entity of spec?.entityResults ?? []) {
    if (entity.modelId !== modelId) continue;
    if (!entity.globalId) { if (!entity.passed) unidentified++; continue; }
    if (results.has(entity.globalId)) duplicated.add(entity.globalId); else results.set(entity.globalId, entity);
  }
  const failingOf = (globalId: string) => (spec?.entityResults ?? [])
    .filter(e => e.modelId === modelId && e.globalId === globalId && !e.passed).length;
  return { results, duplicated, unidentified, failingOf };
}

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
    const before = byGlobalId(baseSpec, ctx.baseModelId), after = byGlobalId(headSpec, ctx.headModelId);
    excluded += before.unidentified + after.unidentified;
    const baseGap = hasGap(baseSpec);
    // A run that evaluated fewer entities than it found applicable is partial, on either side.
    if (baseGap || hasGap(headSpec)) partial = true;
    const occurrence = (e: EntityResult) => `${e.modelId}#${e.expressId}`;
    for (const globalId of [...new Set([...before.results.keys(), ...after.results.keys()])].sort()) {
      if (before.duplicated.has(globalId) || after.duplicated.has(globalId)) {
        excluded += before.failingOf(globalId) + after.failingOf(globalId);
        continue;
      }
      const prev = before.results.get(globalId), next = after.results.get(globalId);
      const failedBefore = prev && !prev.passed ? prev : undefined;
      const identity = `${id} ${globalId}`;
      if (failedBefore && next && !next.passed) {
        const changed = failingSignature(failedBefore) !== failingSignature(next);
        push({ state: changed ? 'changed' : 'persisting', identity, baseOccurrence: occurrence(failedBefore), headOccurrence: occurrence(next),
          label: entityLabel(baseSpec, next), ...(changed ? { changes: ['failedRequirements'] } : {}) });
      } else if (failedBefore) {
        const reason = headSpec?.error ? 'specificationError' as const : !next ? 'entityNotEvaluated' as const : null;
        push(reason
          ? { state: 'notEvaluated', identity, baseOccurrence: occurrence(failedBefore), label: entityLabel(baseSpec, failedBefore), reason }
          : { state: 'resolved', identity, baseOccurrence: occurrence(failedBefore), ...(next ? { headOccurrence: occurrence(next) } : {}),
            label: entityLabel(baseSpec, failedBefore) });
      } else if (next && !next.passed && headSpec) {
        // Absent from a base run with a gap is not evidence the element passed there.
        push(!prev && baseGap
          ? { state: 'notEvaluated', identity, headOccurrence: occurrence(next), label: entityLabel(headSpec, next), reason: 'baseNotEvaluated' }
          : { state: 'new', identity, headOccurrence: occurrence(next), label: entityLabel(headSpec, next) });
      }
    }
  }
  return { ok: true, kind: 'validation', baseRunId: base.id, headRunId: head.id, counts, findings,
    partial: partial || counts.notEvaluated > 0, excluded };
}
