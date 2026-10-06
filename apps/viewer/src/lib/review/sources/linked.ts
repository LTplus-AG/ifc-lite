/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Linked-record findings: semantic validation findings of the current record
 * document. Element identity comes only from the native semantic resolver
 * (its configured strategy, revision associations and model scope); a record
 * the resolver could not place is never re-matched here by GlobalId.
 * A partial document or a truncated report is an incomplete run.
 */

import type { Resolution, SemanticDocument, SemanticResource, ValidationFinding } from '@ifc-lite/semantic';
import type { FindingElement, FindingRun, FindingSourceResult, ReviewModel, RunGap } from '../types';

export interface LinkedFindingInput {
  document: SemanticDocument;
  findings: readonly ValidationFinding[];
  reportTruncated: boolean;
  retrievedAt: string | null;
  resolve: (resource: SemanticResource) => Resolution;
}

function elementOf(resource: SemanticResource | undefined, resolution: Resolution | null, models: readonly ReviewModel[]): FindingElement[] {
  const named = typeof resource?.GlobalId === 'string' ? resource.GlobalId : '';
  if (resolution?.status === 'resolved') {
    const model = models.find(candidate => candidate.id === resolution.ref.modelId);
    const globalId = model?.globalIdOf(resolution.ref.expressId) || named;
    return globalId ? [{ globalId, modelId: resolution.ref.modelId, modelName: model?.name ?? null }] : [];
  }
  if (!named) return [];
  return [{ globalId: named, modelId: null, modelName: null,
    nativeUnresolved: resolution?.status === 'ambiguous' ? 'ambiguous' : 'unmatched' }];
}

export function linkedFindings(input: LinkedFindingInput | null, models: readonly ReviewModel[]): FindingSourceResult {
  if (!input || input.findings.length === 0) return { runs: [], findings: [] };
  const incomplete: RunGap[] = [
    ...(input.document.completeness === 'partial' ? [{ code: 'partial-source' as const }] : []),
    ...(input.reportTruncated ? [{ code: 'truncated' as const }] : []),
  ];
  const run: FindingRun = { id: 'linked:current', source: 'linked', temporal: 'current', label: input.document.profile,
    capturedAt: input.retrievedAt, complete: incomplete.length === 0, incomplete, models: [] };
  const byId = new Map(input.document.resources.map(resource => [resource.id, resource]));
  const resolutions = new Map<string, Resolution | null>();
  const findings = input.findings.map((finding, index) => {
    const resource = byId.get(finding.resourceId);
    if (!resolutions.has(finding.resourceId)) resolutions.set(finding.resourceId, resource ? input.resolve(resource) : null);
    const elements = elementOf(resource, resolutions.get(finding.resourceId) ?? null, models);
    return { id: `${run.id}#${index}`, lineage: `linked|${finding.engine}|${finding.resourceId}|${finding.path}|${finding.message}`,
      source: 'linked' as const, run, elements, nativeStatus: finding.severity ?? 'Violation',
      title: finding.message, detail: [`${finding.engine} · ${finding.path}`, resource ? `${resource.type} ${resource.label}` : finding.resourceId],
      lifecycle: 'observed' as const, disciplines: [], storeys: [], evidence: { kind: 'linked' as const, resourceId: finding.resourceId } };
  });
  return { runs: [run], findings };
}
