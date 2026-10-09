/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { iterateEffectiveEntities } from '@ifc-lite/data';
import { effectiveMetadataRecord, extractStructuralOnDemand } from '@ifc-lite/parser';
import { collectReferencedEntityIds } from '@ifc-lite/export';
import type { ModelEditTarget } from '@/store/slices/mutation-modelling-records';
import { getEffectiveEntityIndex } from '../../../../../packages/export/src/effective-index.js';
import { effectiveCostReferenceOccurrences } from '../../../../../packages/sdk/src/cost-reference-scan.js';
import { CostEntityReader } from '../../../../../packages/parser/src/cost-reader.js';
import { CostUnitResolver } from '../../../../../packages/parser/src/cost-units.js';
import { createEffectiveRecordOverlay } from '../../../../../packages/sdk/src/effective-record-overlay.js';
import type { CostDiagnostic } from '../../../../../packages/parser/src/cost-types.js';
import { isRecord } from '@/lib/check-authoring/proposal-json';
import { structuralSnapshotWork } from './structural-graph-proposal';
export interface StructuralNativeRecord { expressId: number; type: string; attributes: unknown[] }
export interface StructuralSnapshot { modelId: string; selected: number[]; graph: ReturnType<typeof extractStructuralOnDemand>; declaredUnits: unknown[]; unitDiagnostics: CostDiagnostic[]; records: StructuralNativeRecord[]; incoming: Array<{ target: number; referrers: Array<{ expressId: number; count: number }> }> }
/** Reuse the exporter's effective reference closure, with a strict per-record read budget. */
export function structuralClosure(target: ModelEditTarget, roots: Set<number>): Set<number> {
  const index = getEffectiveEntityIndex(target.dataStore, target.view, true), seen = new Set<number>();
  return collectReferencedEntityIds(roots, target.dataStore.source, { ...index,
    get(id) { seen.add(id); if (seen.size > 200) throw new Error('The complete Structural record population exceeds 200'); const record = index.get(id); if (record && record.byteLength > 100000) throw new Error('A native Structural reference record exceeds the bounded review input'); return record; },
    has: id => index.has(id), refsOf: id => index.refsOf(id), refGroupsOf: (id, groups) => index.refGroupsOf(id, groups),
    effectiveType: (id, type) => index.effectiveType(id, type), hasSourceMutation: id => index.hasSourceMutation?.(id) ?? false,
  });
}
export function readStructuralSnapshot(target: ModelEditTarget, selected: readonly number[]): StructuralSnapshot {
  const { modelId, dataStore, view } = target;
  if (!dataStore.source.byteLength) throw new Error('The complete native Structural source is unavailable');
  const graph = extractStructuralOnDemand(dataStore, view);
  structuralSnapshotWork(graph);
  if (graph.loadsTruncated) throw new Error('The canonical Structural load reader reports truncated evidence');
  const unitDiagnostics: CostDiagnostic[] = [];
  // The canonical native unit resolver reads the same effective records as export; no unit algorithm is duplicated.
  const resolver = new CostUnitResolver(new CostEntityReader(dataStore, createEffectiveRecordOverlay(view, dataStore), unitDiagnostics), unitDiagnostics);
  const declaredUnits = [...resolver.Units.values()];
  const roots = new Set([...selected, ...declaredUnits.map(unit => unit.expressId)]), pending: unknown[] = [graph];
  while (pending.length) {
    const value = pending.pop();
    if (Array.isArray(value)) pending.push(...value);
    else if (isRecord(value)) { if (typeof value.expressId === 'number') roots.add(value.expressId); pending.push(...Object.values(value)); }
  }
  const candidates = new Set<number>();
  const structuralType = (type: string) => /^(IFCSTRUCTURAL|IFCBOUNDARY|IFCRELCONNECTSSTRUCTURAL)/.test(type.toUpperCase());
  // @raw-entity-enumeration-ok source type buckets seed candidates; the canonical effective iterator applies deletions, creations and retypes before any record is included.
  for (const [type, ids] of dataStore.entityIndex.byType) if (structuralType(type)) for (const id of ids) candidates.add(id);
  for (const row of iterateEffectiveEntities(dataStore, view, undefined, candidates)) if (structuralType(row.type)) roots.add(row.expressId);
  if (roots.size > 200) throw new Error('The complete native Structural candidate population exceeds 200');
  const ids = structuralClosure(target, roots);
  const incoming = [...effectiveCostReferenceOccurrences(dataStore, view, roots)].sort(([a], [b]) => a - b).map(([target, refs]) => ({ target, referrers: [...refs].sort(([a], [b]) => a - b).map(([expressId, count]) => ({ expressId, count })) }));
  for (const row of incoming) for (const ref of row.referrers) ids.add(ref.expressId);
  if (ids.size > 200) throw new Error('The complete Structural graph and referrers exceed 200 records');
  const records = [...ids].sort((a, b) => a - b).map(expressId => {
    const record = effectiveMetadataRecord(dataStore, expressId, view);
    if (!record || !record.type || record.type === 'Unknown') throw new Error(`Native Structural record #${expressId} is unreadable or deleted`);
    return { expressId, type: record.type, attributes: structuredClone(record.attributes) as unknown[] };
  });
  const snapshot = { modelId, selected: [...new Set(selected)].sort((a, b) => a - b), graph, declaredUnits, unitDiagnostics, records, incoming };
  structuralSnapshotWork(snapshot);
  if (JSON.stringify(snapshot).length > 70000) throw new Error('The complete native Structural graph exceeds the evidence text limit');
  return snapshot;
}
export function nativeStructuralEvidence(target: ModelEditTarget | null, selected: number) {
  if (!target?.dataStore.source.byteLength) return { status: 'unavailable-source', recordCount: null, expected: null };
  try { const expected = readStructuralSnapshot(target, [selected]); return { status: 'available', recordCount: expected.records.length, expected }; }
  catch (error) { console.warn('[Assistant] Complete native Structural evidence unavailable', error); return { status: 'unavailable-complete-graph', recordCount: null, expected: null }; }
}
export function nativeStructuralTransportEvidence(target: ModelEditTarget | null, selected: number) {
  const evidence = nativeStructuralEvidence(target, selected), json = evidence.expected ? JSON.stringify(evidence.expected) : null;
  return { status: evidence.status, recordCount: evidence.recordCount, expectedJsonParts: json ? Array.from({ length: Math.ceil(json.length / 1000) }, (_, index) => json.slice(index * 1000, (index + 1) * 1000)) : null };
}
