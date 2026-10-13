/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { SavedValidationReport } from './portable-saved-validation.js';
import type { SavedValidationElement } from './portable-validation-evidence.js';
import type { FindingLifecycle, FindingRun, FindingSourceResult, ReviewMessage, RunGap } from './types.js';
import { typeDisciplines } from './disciplines.js';

/** One projection of the actual saved failure rows. Re-examination and human
 * decisions remain with the native caller; importing alone supplies neither.
 */
export function savedValidationFacts<Message extends ReviewMessage = ReviewMessage>(saved: SavedValidationReport,
  options: { incomplete?: RunGap<Message>[];
    /** Host-verified full source and GUID proof; absent preserves legacy name-only handling. */
    identityAvailable?: (row: SavedValidationElement) => boolean;
    outcome?: (row: SavedValidationElement) => { lifecycle: FindingLifecycle; notes?: Message[] } | undefined } = {}): FindingSourceResult<Message> {
  const snapshot = saved.snapshot;
  if (snapshot.kind !== 'ids-report') return { runs: [], findings: [] };
  const captured = snapshot.elementEvidence;
  const run: FindingRun<Message> = { id: JSON.stringify(['saved-validation', saved.id]), source: 'validation', temporal: 'historical',
    label: snapshot.sourceName, capturedAt: snapshot.generatedAt, complete: false,
    models: snapshot.reportModels?.map(model => model.name) ?? [],
    incomplete: [...(options.incomplete ?? [{ code: 'partial-source' as const, detail: 'Imported history is not independent native execution.' }]),
      ...(captured?.gaps.map(detail => ({ code: 'partial-source' as const, detail })) ?? [])] };
  return { runs: [run], findings: (captured?.rows ?? []).map(row => {
    const outcome = options.outcome?.(row);
    const identityAvailable = !!row.GlobalId && (!!row.modelName || options.identityAvailable?.(row) === true);
    return { id: JSON.stringify([run.id, row.id]),
      lineage: JSON.stringify(['saved-validation', snapshot.sourceName, row.specificationId, row.modelName, row.GlobalId, row.id]),
      source: 'validation', run, elements: row.GlobalId ? [{ globalId: row.GlobalId, modelId: null, modelName: row.modelName,
        ifcType: row.ifcType, ...(row.Name !== undefined ? { name: row.Name } : {}),
        ...(!identityAvailable ? { nativeUnresolved: 'unmatched' as const } : {}) }] : [],
      nativeStatus: row.nativeStatus, title: row.title, detail: [...row.detail,
        ...(row.modelFingerprint ? [`source fingerprint ${row.modelFingerprint}`] : []),
        ...(!identityAvailable ? ['Saved durable identity unavailable'] : [])],
      ...(outcome?.notes ? { notes: outcome.notes } : {}),
      lifecycle: outcome?.lifecycle ?? 'not-evaluated', disciplines: typeDisciplines(row.ifcType), storeys: [],
      evidence: { kind: 'saved-validation', reportId: saved.id, rowId: row.id },
    };
  }) };
}
