/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { SavedAnalysisRun, SavedRunModel } from './portable-analysis.js';
import type { SavedValidationReport } from './portable-saved-validation.js';
import type { PortableOwner } from './portable-native-owners.js';
import { isFullSourceSHA256 } from './portable-source-contract.js';
import { clashGlobalId } from './clash.js';

export type PortableBindingRefusal = 'source-identity-missing' | 'source-unmatched' | 'source-ambiguous'
  | 'identity-unavailable' | 'identity-unmatched' | 'identity-conflict' | 'model-edited' | 'edit-state-unknown' | 'scope-unknown' | 'unsupported-kind';
function source(hash: unknown, owners: readonly PortableOwner[], unavailable: ReadonlyMap<string, 'model-edited' | 'identity-unavailable'>): PortableOwner | PortableBindingRefusal {
  if (!isFullSourceSHA256(hash)) return 'source-identity-missing';
  const matches = owners.filter(owner => owner.sourceSHA256 === hash);
  return matches.length === 1 ? matches[0] : matches.length ? 'source-ambiguous' : unavailable.get(hash) ?? 'source-unmatched';
}
function modelScope(models: readonly SavedRunModel[], owners: readonly PortableOwner[], unavailable: ReadonlyMap<string, 'model-edited' | 'identity-unavailable'>) {
  const bound = new Map<string, PortableOwner>();
  const hashes = new Set<string>();
  for (const model of models) {
    const owner = source(model.sourceContentHash, owners, unavailable);
    if (typeof owner === 'string') return owner;
    if (hashes.has(owner.sourceSHA256)) return 'source-ambiguous' as const;
    hashes.add(owner.sourceSHA256); bound.set(model.key, owner);
  }
  return bound;
}
export function analysisBinding(saved: SavedAnalysisRun, owners: readonly PortableOwner[], unavailable: ReadonlyMap<string, 'model-edited' | 'identity-unavailable'> = new Map()): PortableBindingRefusal | null {
  if (saved.edited !== false) return saved.edited ? 'model-edited' : 'edit-state-unknown';
  if (saved.examined === null || !saved.models.length || new Set(saved.examined).size !== saved.examined.length
    || saved.examined.length !== saved.models.length || saved.examined.some(key => !saved.models.some(model => model.key === key))) return 'scope-unknown';
  const bound = modelScope([...saved.models, ...(saved.frame?.others ?? [])], owners, unavailable);
  if (typeof bound === 'string') return bound;
  if (saved.frame && saved.frame.openModels !== bound.size) return 'scope-unknown';
  if (saved.kind === 'validation') {
    for (const spec of saved.report.specificationResults) {
      for (const row of spec.entityResults) {
        const owner = bound.get(row.modelId);
        const actual = owner?.GlobalIds.get(row.expressId);
        if (!actual) return 'identity-unmatched';
        if (row.globalId && actual !== row.globalId) return 'identity-conflict';
      }
      for (const set of spec.setResults ?? []) for (const member of set.members) {
        if (!bound.get(member.modelId)?.GlobalIds.has(member.expressId)) return 'identity-unmatched';
      }
    }
  } else for (const clash of saved.result.clashes) for (const row of [clash.a, clash.b]) {
    const actual = bound.get(row.model)?.GlobalIds.get(row.expressId);
    if (!actual) return 'identity-unmatched';
    if (!row.key.startsWith('expressid:') && actual !== clashGlobalId(row)) return 'identity-conflict';
  }
  return null;
}
export function validationBinding(saved: SavedValidationReport, owners: readonly PortableOwner[], unavailable: ReadonlyMap<string, 'model-edited' | 'identity-unavailable'> = new Map()): PortableBindingRefusal | null {
  const scope = saved.snapshot.reportModels;
  if (!scope?.length) return 'scope-unknown';
  const hashes = new Set<string>();
  for (const model of scope) {
    const owner = source(model.sourceContentHash, owners, unavailable);
    if (typeof owner === 'string') return owner;
    if (hashes.has(owner.sourceSHA256)) return 'source-ambiguous';
    hashes.add(owner.sourceSHA256);
  }
  if (saved.snapshot.kind !== 'ids-report') return 'unsupported-kind';
  for (const row of saved.snapshot.elementEvidence?.rows ?? []) {
    const owner = source(row.modelContentHash, owners, unavailable);
    if (typeof owner === 'string') return owner;
    if (!hashes.has(owner.sourceSHA256)) return 'scope-unknown';
    if (row.GlobalId === null || !owner.identities.has(row.GlobalId)) return 'identity-unmatched';
  }
  return null;
}
