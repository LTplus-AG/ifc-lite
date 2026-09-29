/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Portable saved-report contract and boundary validation (#6506). No model/runtime imports. */
import type { CompareReport } from './exportReport';

export interface SavedComparison {
  version: 1;
  id: string;
  name: string;
  savedAt: string;
  pair: { baseModelId: string; headModelId: string };
  geometryUnavailable: boolean;
  placementOnlyGeometry: boolean;
  keyProperty?: string;
  report: CompareReport;
}

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v: Record<string, unknown>, keys: string[]): boolean => keys.every((k) => typeof v[k] === 'string');
const count = (v: unknown): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const timestamp = (v: unknown): boolean => typeof v === 'string' && Number.isFinite(Date.parse(v));
const tally = (v: unknown): boolean => record(v) && ['added', 'deleted', 'modified'].every((k) => count(v[k]));
const states = ['added', 'deleted', 'modified', 'unchanged', 'matched'];
const matches = ['renamed', 'moved', 'reshaped', 'respecified', 'duplicated', 'deduplicated', 'ambiguous'];

/** The same boundary validates storage and embedded document snapshots. */
export function isSavedComparison(v: unknown): v is SavedComparison {
  if (!record(v) || v.version !== 1 || !strings(v, ['id']) || !v.id || typeof v.name !== 'string' || !v.name.trim() || !timestamp(v.savedAt)) return false;
  if (!record(v.pair) || !strings(v.pair, ['baseModelId', 'headModelId']) || !v.pair.baseModelId || !v.pair.headModelId || v.pair.baseModelId === v.pair.headModelId) return false;
  if (typeof v.geometryUnavailable !== 'boolean' || typeof v.placementOnlyGeometry !== 'boolean') return false;
  if (v.keyProperty !== undefined && typeof v.keyProperty !== 'string') return false;
  const r = v.report;
  if (!record(r) || !strings(r, ['baseModel', 'headModel', 'scope']) || !['data', 'geometry', 'both'].includes(String(r.scope)) || !timestamp(r.generatedAt)) return false;
  if (!Array.isArray(r.excludedTypes) || !r.excludedTypes.every((t: unknown) => typeof t === 'string')) return false;
  const counts = r.counts;
  if (!record(counts) || !['added', 'deleted', 'modified', 'matched', 'needsReview'].every((k) => count(counts[k])) || !tally(counts.products) || !tally(counts.typeObjects)) return false;
  return Array.isArray(r.rows) && r.rows.every((row: unknown) => record(row)
    && strings(row, ['globalId', 'name', 'ifcType', 'state', 'change', 'model']) && states.includes(String(row.state))
    && typeof row.movedDistance === 'number' && Number.isFinite(row.movedDistance) && row.movedDistance >= 0
    && (row.match === undefined || (typeof row.match === 'string' && matches.includes(row.match)))
    && ['matchedGlobalId', 'key'].every((k) => row[k] === undefined || typeof row[k] === 'string'));
}

export function comparisonSummary(saved: SavedComparison): string[] {
  const { report: r } = saved;
  const tallyText = (c: { added: number; deleted: number; modified: number }): string => `Added ${c.added}; deleted ${c.deleted}; modified ${c.modified}`;
  return [
    `Base: ${r.baseModel}; Head: ${r.headModel}`,
    `Report generated: ${r.generatedAt}; scope: ${r.scope}${saved.keyProperty ? `; key: ${saved.keyProperty}` : ''}`,
    `Products: ${tallyText(r.counts.products)}`,
    `Type objects: ${tallyText(r.counts.typeObjects)}; matched ${r.counts.matched}; needs review ${r.counts.needsReview}`,
    ...(r.excludedTypes.length ? [`Excluded IFC classes: ${r.excludedTypes.join(', ')}`] : []),
    ...(saved.geometryUnavailable ? ['Geometry unavailable: comparison used data only.'] : []),
    ...(saved.placementOnlyGeometry ? ['Geometry compared using placements only; shape changes are unavailable.'] : []),
  ];
}
