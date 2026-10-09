/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { createCostBackend, type CostGraphData } from '@ifc-lite/sdk';
import { effectiveMetadataRecord } from '@ifc-lite/parser';
import type { ModelEditTarget } from '@/store/slices/mutation-modelling-records';
import { effectiveCostReferenceOccurrences } from '../../../../../packages/sdk/src/cost-reference-scan.js';
import { isRecord } from '@/lib/check-authoring/proposal-json';
import { costSnapshotWork } from './cost-graph-proposal';
import { CostEntityReader } from '../../../../../packages/parser/src/cost-reader.js';
import { CostUnitResolver } from '../../../../../packages/parser/src/cost-units.js';
import { createEffectiveRecordOverlay } from '../../../../../packages/sdk/src/effective-record-overlay.js';
import type { CostUnitInfo, CostDiagnostic } from '../../../../../packages/parser/src/cost-types.js';

export interface CostNativeRecord { expressId: number; type: string; attributes: unknown[] }
export interface CostSnapshot {
  modelId: string;
  selected: number[];
  graph: CostGraphData;
  declaredUnits: CostUnitInfo[];
  unitDiagnostics: CostDiagnostic[];
  records: CostNativeRecord[];
  incoming: Array<{ target: number; referrers: Array<{ expressId: number; count: number }> }>;
}
export interface CostEvidence {
  status: 'available' | 'unavailable-source' | 'unavailable-complete-graph';
  recordCount: number | null;
  expected: CostSnapshot | null;
}
/** One complete canonical read, including native non-cost incoming refs that constrain deletion. */
export function readCostSnapshot(target: ModelEditTarget, selected: readonly number[]): CostSnapshot {
  const { modelId, dataStore, view } = target;
  if (!dataStore.source.byteLength) throw new Error('The complete native Cost source is unavailable');
  const graph = createCostBackend(() => ({ modelId, store: dataStore, mutationView: view })).data();
  costSnapshotWork(graph);
  // The graph reader legitimately omits units when no cost entity exists yet.
  // Its own native unit resolver supplies declared units for first-cost creation, with the same effective record overlay.
  const unitDiagnostics: CostDiagnostic[] = [];
  const unitReader = new CostUnitResolver(new CostEntityReader(dataStore, createEffectiveRecordOverlay(view, dataStore), unitDiagnostics), unitDiagnostics);
  const declaredUnits = [...unitReader.Units.values()];
  const ids = new Set([...selected, ...declaredUnits.map(unit => unit.expressId)]);
  const pending: unknown[] = [graph];
  while (pending.length) {
    const value = pending.pop();
    if (Array.isArray(value)) pending.push(...value);
    else if (isRecord(value)) {
      if (typeof value.expressId === 'number' && value.modelId === modelId) ids.add(value.expressId);
      pending.push(...Object.values(value));
    }
  }
  if (ids.size > 200) throw new Error('More than 200 native Cost and referenced records require review');
  const incoming = [...effectiveCostReferenceOccurrences(dataStore, view, ids)].sort(([a], [b]) => a - b)
    .map(([id, referrers]) => ({ target: id, referrers: [...referrers].sort(([a], [b]) => a - b).map(([expressId, count]) => ({ expressId, count })) }));
  for (const row of incoming) for (const ref of row.referrers) ids.add(ref.expressId);
  if (ids.size > 200) throw new Error('The complete incoming native Cost reference population exceeds 200 records');
  const records = [...ids].sort((a, b) => a - b).map(expressId => {
    const record = effectiveMetadataRecord(dataStore, expressId, view);
    if (!record || !record.type || record.type === 'Unknown') throw new Error(`Native Cost reference #${expressId} is deleted or unreadable`);
    return { expressId, type: record.type, attributes: structuredClone(record.attributes) as unknown[] };
  });
  const snapshot = { modelId, declaredUnits, unitDiagnostics, selected: [...new Set(selected)].sort((a, b) => a - b), graph, records, incoming };
  costSnapshotWork(snapshot);
  if (JSON.stringify(snapshot).length > 70000) throw new Error('The complete native Cost graph exceeds the evidence limit');
  return snapshot;
}
/** Unavailability is explicit; a source-empty or excessive graph never becomes an authoritative zero. */
export function nativeCostEvidence(target: ModelEditTarget | null, selected: number): CostEvidence {
  if (!target?.dataStore.source.byteLength) return { status: 'unavailable-source', recordCount: null, expected: null };
  try {
    const expected = readCostSnapshot(target, [selected]);
    return { status: 'available', recordCount: expected.records.length, expected };
  } catch (error) {
    console.warn('[Assistant] Complete native Cost evidence unavailable', error);
    return { status: 'unavailable-complete-graph', recordCount: null, expected: null };
  }
}

/** Native JSON chunks preserve exact expected records through the shared bounded evidence projector.
 * The projector still enforces total row/text/population limits; no truncated part can become a valid snapshot.
 */
export function nativeCostTransportEvidence(target: ModelEditTarget | null, selected: number) {
  const evidence = nativeCostEvidence(target, selected);
  const json = evidence.expected ? JSON.stringify(evidence.expected) : null;
  return { status: evidence.status, recordCount: evidence.recordCount,
    expectedJsonParts: json ? Array.from({ length: Math.ceil(json.length / 1000) }, (_, index) => json.slice(index * 1000, (index + 1) * 1000)) : null };
}
