/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ClashResult } from '@ifc-lite/clash';
import { clashFindings } from './clash.js';
import { validationFindings } from './validation.js';
import { savedValidationFacts } from './saved-validation.js';
import type { SavedAnalysisRun } from './portable-analysis.js';
import type { SavedValidationReport } from './portable-saved-validation.js';
import type { PortableOwner } from './portable-native-owners.js';
import type { FindingSourceResult, ReviewFinding, ReviewModel } from './types.js';

/** These models are aliases within the imported wire, not live model ids.
 * Only a verified full source hash binds them to actual columnar identities.
 */
function analysisModels(saved: SavedAnalysisRun, owners: readonly PortableOwner[]): ReviewModel[] {
  return saved.models.map(model => {
    const owner = owners.find(item => item.sourceSHA256 === model.sourceContentHash);
    return { id: model.key, name: owner?.model.name ?? model.name,
      ...(owner ? { sourceIdentity: owner.sourceSHA256 } : {}),
      expressIdOf: GlobalId => owner?.identities.get(GlobalId) ?? 0,
      globalIdOf: expressId => owner?.GlobalIds.get(expressId) ?? '',
      ...(owner?.model.storeyOf ? { storeyOf: (expressId: number) => owner.model.storeyOf?.(expressId) ?? null } : {}) };
  });
}

/** Preserve native evidence and statuses; import never attests a new run or
 * turns saved freshness/currentness into independent evaluation.
 */
function historical(result: FindingSourceResult, id: string, capturedAt: string): FindingSourceResult {
  const runs = result.runs.map(run => ({ ...run, id, capturedAt, temporal: 'historical' as const, complete: false,
    incomplete: [...run.incomplete, ...(run.incomplete.some(gap => gap.code === 'partial-source'
      && gap.detail === 'Imported history is not independent native execution.') ? [] : [{ code: 'partial-source' as const,
      detail: 'Imported history is not independent native execution.' }])] }));
  const findings = result.findings.map(finding => {
    const index = result.runs.indexOf(finding.run), run = runs[index];
    if (!run) throw new Error('Imported Review run ownership is unavailable');
    return { ...finding, id: JSON.stringify([id, finding.id]), run, lifecycle: 'not-evaluated' as const };
  });
  return { runs, findings };
}

function missingIdentity(finding: ReviewFinding, models: readonly ReviewModel[]): ReviewFinding {
  return { ...finding, elements: finding.elements.map(element => {
    const model = models.find(item => item.id === element.modelId);
    const expressId = model?.expressIdOf(element.globalId) ?? 0;
    const recorded = finding.evidence.kind === 'validation' ? finding.evidence.expressId : null;
    return model?.sourceIdentity && expressId > 0 && (recorded === null || recorded === expressId) ? { ...element }
      : { ...element, modelId: null, nativeUnresolved: 'unmatched' as const };
  }) };
}

/** Shared canonical adapters, with no mutation of the supplied decoded wire. */
export function projectPortableAnalysis(saved: SavedAnalysisRun, owners: readonly PortableOwner[]): FindingSourceResult {
  const models = analysisModels(saved, owners);
  let result: FindingSourceResult;
  if (saved.kind === 'validation') {
    result = validationFindings({ report: { ...saved.report, timestamp: new Date(saved.report.timestamp) }, stale: false }, models);
  } else {
    // The canonical baseline adapter consumes no renderer geometry. `ref`
    // retains the recorded local EXPRESS id; it is never an invented offset.
    const native: ClashResult = { ...saved.result, clashes: saved.result.clashes.map(clash => ({ ...clash,
      a: { ...clash.a, ref: clash.a.expressId }, b: { ...clash.b, ref: clash.b.expressId },
      distance: typeof clash.distance === 'number' ? clash.distance : Number(clash.distance) })) };
    result = clashFindings({ current: null, baseline: { result: native,
      modelNames: Object.fromEntries(saved.models.map(model => [model.key, model.name])), takenAt: Date.parse(saved.capturedAt) } }, models);
    // The baseline adapter intentionally emits no live model id. Rebind each
    // occurrence only via its original saved model key and full source proof.
    result.findings = result.findings.map((finding, index) => ({ ...finding,
      elements: finding.elements.map((element, side) => {
        const ref = side === 0 ? saved.result.clashes[index].a : saved.result.clashes[index].b;
        const model = models.find(item => item.id === ref.model);
        const actualGuid = model?.globalIdOf(ref.expressId) ?? '';
        const recordedGuid = ref.key.startsWith('expressid:') ? '' : element.globalId;
        return { ...element, globalId: recordedGuid || actualGuid, modelId: ref.model,
          ...(!actualGuid || (recordedGuid && recordedGuid !== actualGuid)
            ? { modelId: null, nativeUnresolved: 'unmatched' as const } : {}) };
      }) }));
  }
  result.findings = result.findings.map(finding => {
    const checked = missingIdentity(finding, models);
    return { ...checked, elements: checked.elements.map(element => {
      const savedModel = saved.models.find(model => model.key === element.modelId);
      const owner = owners.find(item => item.sourceSHA256 === savedModel?.sourceContentHash);
      return { ...element, modelId: owner?.model.id ?? null };
    }) };
  });
  return historical(result, JSON.stringify(['imported-analysis', saved.id]), saved.capturedAt);
}

/** Saved failure evidence keeps its recorded detail, gaps and identity. A
 * name/fingerprint match alone cannot bind an imported row to a live source.
 */
export function projectPortableValidation(saved: SavedValidationReport, owners: readonly PortableOwner[]): FindingSourceResult {
  const result = savedValidationFacts(saved, { identityAvailable: row => !!row.GlobalId
    && !!owners.find(owner => owner.sourceSHA256 === row.modelContentHash)?.identities.has(row.GlobalId) });
  if (saved.snapshot.kind !== 'ids-report') return result;
  const rows = saved.snapshot.elementEvidence?.rows ?? [];
  result.findings = result.findings.map((finding, index) => {
    const row = rows[index];
    const owner = row?.modelContentHash ? owners.find(item => item.sourceSHA256 === row.modelContentHash) : undefined;
    return { ...finding, elements: finding.elements.map(element => {
      if (!owner || !owner.identities.has(element.globalId)) return { ...element, modelId: null, nativeUnresolved: 'unmatched' as const };
      const bound = { ...element, modelId: owner.model.id, modelName: owner.model.name };
      // The legacy adapter's missing-name marker is not a native identity
      // failure. Full source/GUID proof binds independently of display names.
      delete bound.nativeUnresolved;
      return bound;
    }) };
  });
  return historical(result, JSON.stringify(['imported-saved-validation', saved.id]), saved.snapshot.generatedAt);
}
