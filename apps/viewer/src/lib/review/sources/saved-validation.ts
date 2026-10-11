/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #7091: saved failures remain historical until a native compatible run re-examines them (#7371). */
import type { SavedValidationReport } from '../../validation/reports/history';
import { reexamineSavedValidation, type CurrentValidationRun, type RowReexamination } from '../../validation/reports/reexamine';
import type { FindingLifecycle, FindingRun, FindingSourceResult } from '../types';
import { typeDisciplines } from './disciplines';

/** A candidate is never a decision: the saved native status is kept verbatim either way. */
const LIFECYCLE: Record<RowReexamination['state'], FindingLifecycle> = {
  persisting: 'persistent', changed: 'persistent', resolved: 'no-longer-observed', notEvaluated: 'not-evaluated',
};
const outcomeText = (outcome: RowReexamination) => outcome.state === 'notEvaluated'
  ? `Current native re-examination: notEvaluated (${outcome.reason})` : `Current native re-examination: ${outcome.state}`;

export function savedValidationFindings(reports: readonly SavedValidationReport[], current: CurrentValidationRun | null = null): FindingSourceResult {
  const result: FindingSourceResult = { runs: [], findings: [] };
  for (const saved of reports) {
    const snapshot = saved.snapshot;
    if (snapshot.kind !== 'ids-report') continue;
    const captured = snapshot.elementEvidence;
    const reexamined = captured ? reexamineSavedValidation(snapshot, current) : null;
    const run: FindingRun = { id: JSON.stringify(['saved-validation', saved.id]), source: 'validation', temporal: 'historical',
      label: snapshot.sourceName, capturedAt: snapshot.generatedAt, complete: false,
      models: snapshot.reportModels?.map(model => model.name) ?? [],
      incomplete: [{ code: 'partial-source', detail: !captured ? 'This older count-only snapshot contains no saved element evidence'
        : reexamined?.compatible ? 'Saved evidence retains failure rows only; the current compatible native run re-examined them'
        : `Saved failure evidence is historical; no compatible re-examination has confirmed absence (${reexamined?.reasons.join(', ')})` },
        ...(captured?.gaps.map(detail => ({ code: 'partial-source' as const, detail })) ?? [])] };
    result.runs.push(run);
    for (const row of captured?.rows ?? []) {
      const outcome = reexamined?.compatible ? reexamined.rows.get(row.id) : undefined;
      result.findings.push({ id: JSON.stringify([run.id, row.id]),
        lineage: JSON.stringify(['saved-validation', snapshot.sourceName, row.specificationId, row.modelName, row.GlobalId, row.id]),
        source: 'validation', run, elements: row.GlobalId ? [{ globalId: row.GlobalId, modelId: null, modelName: row.modelName,
          ifcType: row.ifcType, ...(row.Name !== undefined ? { name: row.Name } : {}),
          ...(!row.modelName ? { nativeUnresolved: 'unmatched' as const } : {}) }] : [],
        nativeStatus: row.nativeStatus, title: row.title, detail: [...row.detail,
          ...(row.modelFingerprint ? [`source fingerprint ${row.modelFingerprint}`] : []),
          ...(!row.GlobalId || !row.modelName ? ['Saved durable identity unavailable'] : []),
          ...(outcome ? [outcomeText(outcome)] : [])],
        lifecycle: outcome ? LIFECYCLE[outcome.state] : 'not-evaluated', disciplines: typeDisciplines(row.ifcType), storeys: [],
        evidence: { kind: 'saved-validation', reportId: saved.id, rowId: row.id },
      });
    }
  }
  return result;
}
