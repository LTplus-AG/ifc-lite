/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #7091: saved failures remain historical until a native compatible run re-examines them. */
import type { SavedValidationReport } from '../../validation/reports/history';
import type { FindingRun, FindingSourceResult } from '../types';
import { typeDisciplines } from './disciplines';

export function savedValidationFindings(reports: readonly SavedValidationReport[]): FindingSourceResult {
  const result: FindingSourceResult = { runs: [], findings: [] };
  for (const saved of reports) {
    const snapshot = saved.snapshot;
    if (snapshot.kind !== 'ids-report') continue;
    const captured = snapshot.elementEvidence;
    const run: FindingRun = { id: JSON.stringify(['saved-validation', saved.id]), source: 'validation', temporal: 'historical',
      label: snapshot.sourceName, capturedAt: snapshot.generatedAt, complete: false,
      models: snapshot.reportModels?.map(model => model.name) ?? [],
      incomplete: [{ code: 'partial-source', detail: captured
        ? 'Saved failure evidence is historical; no compatible re-examination has confirmed absence'
        : 'This older count-only snapshot contains no saved element evidence' },
        ...(captured?.gaps.map(detail => ({ code: 'partial-source' as const, detail })) ?? [])] };
    result.runs.push(run);
    for (const row of captured?.rows ?? []) {
      result.findings.push({ id: JSON.stringify([run.id, row.id]),
        lineage: JSON.stringify(['saved-validation', snapshot.sourceName, row.specificationId, row.modelName, row.GlobalId, row.id]),
        source: 'validation', run, elements: row.GlobalId ? [{ globalId: row.GlobalId, modelId: null, modelName: row.modelName,
          ifcType: row.ifcType, ...(row.Name !== undefined ? { name: row.Name } : {}),
          ...(!row.modelName ? { nativeUnresolved: 'unmatched' as const } : {}) }] : [],
        nativeStatus: row.nativeStatus, title: row.title, detail: [...row.detail,
          ...(row.modelFingerprint ? [`source fingerprint ${row.modelFingerprint}`] : []),
          ...(!row.GlobalId || !row.modelName ? ['Saved durable identity unavailable'] : [])],
        lifecycle: 'not-evaluated', disciplines: typeDisciplines(row.ifcType), storeys: [],
        evidence: { kind: 'saved-validation', reportId: saved.id, rowId: row.id },
      });
    }
  }
  return result;
}
